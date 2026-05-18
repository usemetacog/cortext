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

function hashPrompt(text: string): string {
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

export function heuristicDiagnosis(prompt: UserPrompt): string {
  const text = prompt.text;
  const issues: string[] = [];

  if (prompt.wordCount < 5) issues.push('too short to be actionable');
  else if (prompt.wordCount < 10) issues.push('too brief — missing context');

  if (!/[\/\.][a-z]/i.test(text)) issues.push('no file path');
  if (!/`[^`]+`/.test(text)) issues.push('no code reference');
  if (!/should|expected|want|need|instead/.test(text)) issues.push('no expected outcome');
  if (prompt.followedByCorrection) issues.push('led directly to a correction turn');

  if (issues.length === 0) return 'Prompt was flagged — review manually.';
  return 'Missing: ' + issues.join(', ') + '.';
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
