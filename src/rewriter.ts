import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import type { RewriteResult, UserPrompt } from './types';

const CACHE_PATH = path.join(os.homedir(), '.cortext', 'rewrite-cache.json');
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface CacheEntry extends RewriteResult {
  promptHash: string;
  cachedAt: string;
}

export function hashPrompt(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function loadCache(): CacheEntry[] {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')) as CacheEntry[];
  } catch {
    return [];
  }
}

function saveCache(entries: CacheEntry[]): void {
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(entries, null, 2));
  } catch {
    // non-fatal
  }
}

function getCached(text: string): RewriteResult | null {
  const hash = hashPrompt(text);
  const entry = loadCache().find(e => e.promptHash === hash);
  if (!entry) return null;
  if (Date.now() - new Date(entry.cachedAt).getTime() > CACHE_TTL_MS) return null;
  return { diagnosis: entry.diagnosis, rewrite: entry.rewrite };
}

function setCache(text: string, result: RewriteResult): void {
  const hash = hashPrompt(text);
  const cutoff = new Date(Date.now() - CACHE_TTL_MS).toISOString();
  const fresh = loadCache().filter(e => e.promptHash !== hash && e.cachedAt > cutoff);
  fresh.push({ promptHash: hash, ...result, cachedAt: new Date().toISOString() });
  saveCache(fresh);
}

// Git and deployment commands don't need file paths, code refs, or expected
// outcomes — they operate on current repo state. Only flag them if there was
// a correction turn (which may indicate branch/staging confusion).
const GIT_OP_RE = /\b(commit|push|pull|merge|rebase|stash|fetch|cherry.?pick|amend|squash|tag|deploy|release|publish|rollback|revert)\b/i;

function isGitOp(text: string, wordCount: number): boolean {
  return wordCount <= 10 && GIT_OP_RE.test(text);
}

export function heuristicDiagnosis(prompt: UserPrompt): string {
  const text = prompt.text;
  const fixes: string[] = [];

  // Git/deployment operations are contextually complete — skip structural checks.
  // The only actionable diagnosis is if they caused a correction turn.
  if (isGitOp(text, prompt.wordCount)) {
    if (prompt.followedByCorrection) {
      return 'Led to a correction — confirm staged files, branch, and commit message before issuing the command.';
    }
    return 'Prompt was flagged — review manually.';
  }

  if (prompt.wordCount < 5) fixes.push(`too short to be actionable at ${prompt.wordCount} words — Claude had to infer your intent`);
  else if (prompt.wordCount < 10) fixes.push('too brief to act on without guessing');

  if (!/[\/\.][a-z]/i.test(text)) fixes.push('no file path — add it so Claude knows exactly what to touch');
  if (!/`[^`]+`/.test(text)) fixes.push('no code reference — include the relevant symbol or snippet in backticks');
  if (!/should|expected|want|need|instead/.test(text)) fixes.push('no expected outcome — state it: "should X", "expected Y", or "instead of Z"');
  if (prompt.followedByCorrection) fixes.push('led directly to a correction turn — the prompt left too much to interpretation');

  if (fixes.length === 0) return 'Prompt was flagged — review manually.';
  return fixes.length === 1
    ? fixes[0] + '.'
    : 'Several issues: ' + fixes.join('; ') + '.';
}

export function heuristicBetter(prompt: UserPrompt): string {
  const text = prompt.text;

  // Git/deployment operations don't need file paths or expected outcomes.
  // If they caused a correction, the fix is checking pre-conditions, not adding structure.
  if (isGitOp(text, prompt.wordCount)) {
    const verb = text.match(GIT_OP_RE)?.[0]?.toLowerCase() ?? 'command';
    if (verb === 'commit') return `${text} [ensure the right files are staged and the message is clear]`;
    if (verb === 'push') return `${text} [confirm you're on the right branch first]`;
    if (verb === 'merge') return `${text} [specify source and target branch if ambiguous]`;
    if (verb === 'deploy' || verb === 'release' || verb === 'publish') return `${text} [confirm environment and that tests pass]`;
    return `${text} [verify repo state is correct before running]`;
  }

  const needsFile = !/[\/\.][a-z]/i.test(text);
  const needsOutcome = !/should|expected|want|need|instead|make it|so that/.test(text);
  const needsVerify = !prompt.hasVerification;

  const parts: string[] = [];

  if (needsFile) {
    parts.push(`In [path/to/file.ts], ${text.length > 40 ? text.slice(0, 40) + '...' : text}`);
  } else {
    parts.push(text.slice(0, 80) + (text.length > 80 ? '...' : ''));
  }

  if (needsOutcome) {
    parts.push('Expected: [what success looks like — the specific behavior or output you want].');
  }

  if (needsVerify) {
    parts.push('Verify by running [tests / checking that X works as expected].');
  }

  if (parts.length === 1 && !needsFile && !needsOutcome && !needsVerify) {
    return '[Prompt structure is reasonable — focus on adding explicit verification criteria]';
  }

  return parts.join(' ');
}

export async function generateRewrite(prompt: UserPrompt): Promise<RewriteResult | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const cached = getCached(prompt.text);
  if (cached) return cached;

  const client = new Anthropic({ apiKey });

  const context = [
    prompt.followedByCorrection
      ? 'This prompt caused an immediate correction turn (the user had to redirect Claude right after).'
      : null,
    prompt.vagueScore >= 4 ? `Vagueness score: ${prompt.vagueScore}/7 (high).` : null,
  ].filter(Boolean).join(' ');

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      system: `You are a ruthlessly specific prompt coach for Claude Code users.

Given a weak prompt a developer sent to Claude Code, do two things:
1. diagnosis: One crisp sentence naming the exact failure mode. Be specific about what's absent from THIS prompt (e.g. "No file path, no error message, and no expected behavior — Claude had to guess all three.").
2. rewrite: Rewrite it as a senior engineer would. Make it concrete. Use [brackets] for parts the user should fill in if the original is too vague to reconstruct. Show the shape of a good prompt: file, what's broken, what's expected, what to do.

Respond as raw JSON only. No markdown fences. {"diagnosis": "...", "rewrite": "..."}`,
      messages: [{
        role: 'user',
        content: `Prompt: "${prompt.text}"${context ? '\nContext: ' + context : ''}`,
      }],
    });

    const text = response.content.find(b => b.type === 'text')?.text ?? '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const result = JSON.parse(jsonMatch[0]) as RewriteResult;
    setCache(prompt.text, result);
    return result;
  } catch {
    return null;
  }
}
