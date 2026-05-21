import type { ProjectData } from './reader';
import { extractUserText } from './reader';
import type {
  AnalysisResult,
  DailyUsage,
  ProjectStats,
  PromptCategory,
  RawEntry,
  SessionStats,
  UnreadMoment,
  Usage,
  UserPrompt,
} from './types';

// Pricing per million tokens (USD)
const MODEL_PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-4-7':           { input: 15,   output: 75,   cacheRead: 1.50,  cacheWrite: 18.75 },
  'claude-opus-4-6':           { input: 15,   output: 75,   cacheRead: 1.50,  cacheWrite: 18.75 },
  'claude-sonnet-4-6':         { input: 3,    output: 15,   cacheRead: 0.30,  cacheWrite: 3.75  },
  'claude-sonnet-4-5':         { input: 3,    output: 15,   cacheRead: 0.30,  cacheWrite: 3.75  },
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4,    cacheRead: 0.08,  cacheWrite: 1.00  },
  'claude-haiku-4-5':          { input: 0.80, output: 4,    cacheRead: 0.08,  cacheWrite: 1.00  },
};

const DEFAULT_PRICING = MODEL_PRICING['claude-sonnet-4-6'];

const PRODUCTIVE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const MIN_TOOL_CALLS = 5;

export function computeCost(model: string, usage: Usage): number {
  const p = MODEL_PRICING[model] ?? DEFAULT_PRICING;
  return (
    usage.input_tokens * p.input +
    usage.output_tokens * p.output +
    usage.cache_read_input_tokens * p.cacheRead +
    usage.cache_creation_input_tokens * p.cacheWrite
  ) / 1_000_000;
}

const CORRECTION_WORDS = /^(no[,. ]|wait[,. ]|actually[,. ]|that'?s (wrong|not|incorrect)|not what|wrong[,. ]|hmm[,. ]|ugh[,. ]|nope[,. ]|no no|no—|no–)/i;

// Short conversational replies that aren't standalone prompts
const CONVERSATIONAL = /^(yes|no|ok|okay|sure|sounds good|let'?s|continue|go ahead|agreed|great|perfect|thanks|cool|alright|got it|makes sense|i see|understood|yep|nope|hm|hmm|yup|right|exactly|correct|i agree|do it|proceed|done|nice|awesome|good|fine|works|that works|that'?s good|looks good|good job|well done|lgtm|ship it)\b/i;

const CATEGORY_PATTERNS: Array<[PromptCategory, RegExp]> = [
  ['fix',       /\b(fix|bug|error|broken|not work(?:ing)?|issue|problem|fail(?:ing)?|crash(?:ing)?|wrong|debug|doesn'?t work|isn'?t work(?:ing)?)\b/i],
  ['refactor',  /\b(refactor|clean(?:\s+up)?|improve|optimize|rename|reorganize|restructure|simplify|prettier|format)\b/i],
  ['implement', /\b(add|create|build|implement|make|write|generate|develop|set\s+up|setup|new feature|scaffold)\b/i],
  ['explain',   /\b(explain|how\s+does|what\s+is|what\s+does|describe|understand|why(?:\s+is|\s+does|\s+are)?|how\s+do|what\s+are|tell\s+me|walk\s+me)\b/i],
];

// Claude Code built-in commands and common skill names that users may type without /
const COMMAND_WORDS = new Set([
  'review', 'verify', 'browse', 'run', 'plan', 'cortext', 'learn', 'freeze',
  'unfreeze', 'ship', 'qa', 'guard', 'health', 'retro', 'investigate', 'init',
  'gstack', 'codex', 'canary', 'scrape', 'benchmark', 'autoplan',
  'clear', 'compact', 'doctor', 'help', 'model', 'config', 'memory', 'usage',
  'login', 'logout', 'cost', 'bug', 'status', 'ide', 'vim',
]);

function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return dp[m][n];
}

function isCommandLike(word: string): boolean {
  const lower = word.toLowerCase();
  if (COMMAND_WORDS.has(lower)) return true;
  // Fuzzy: within edit distance 1 for words >= 4 chars (catches "reviw", "browsse")
  if (lower.length >= 4) {
    for (const cmd of COMMAND_WORDS) {
      if (Math.abs(lower.length - cmd.length) <= 1 && editDistance(lower, cmd) === 1) return true;
    }
  }
  return false;
}

function isGarbled(text: string): boolean {
  const words = text.trim().split(/\s+/);
  if (words.length > 2) return false;
  for (const word of words) {
    if (word.length < 6) continue;
    if (/^[A-Z]+$/.test(word)) continue;   // likely an acronym (HTML, HTTP)
    if (/[\/\.]/.test(word)) continue;     // file path or URL token
    const lower = word.toLowerCase();
    if (!/[aeiou]/.test(lower)) return true;          // no vowels at all
    if (/[bcdfghjklmnpqrstvwxyz]{5,}/.test(lower)) return true; // implausible consonant run
  }
  return false;
}

export function classifyPrompt(text: string, priorAssistantText?: string): PromptCategory {
  const wordCount = text.trim().split(/\s+/).length;

  // Long messages (pastes, detailed context) are never vague
  if (wordCount > 200) {
    for (const [category, pattern] of CATEGORY_PATTERNS) {
      if (pattern.test(text)) return category;
    }
    return 'implement';
  }

  // Skip short conversational follow-ups from vague classification
  if (wordCount <= 8 && CONVERSATIONAL.test(text.trim())) return 'other';

  // Direct answer to a preceding assistant question is not vague
  if (priorAssistantText && assistantAskedQuestion(priorAssistantText)) return 'other';

  // Skill/command names typed without a slash, and garbled text, are not vague prompts
  if ((wordCount === 1 && isCommandLike(text.trim())) || isGarbled(text)) return 'other';

  // Short prompts need a concrete anchor (file path or inline code) to escape the
  // vague gate — "fix auth.ts" is unambiguous; "make it work" is not
  if (wordCount < 6) {
    const hasAnchor = /[\/\.][a-z]/i.test(text) || /`[^`]+`/.test(text);
    if (hasAnchor) {
      for (const [category, pattern] of CATEGORY_PATTERNS) {
        if (pattern.test(text)) return category;
      }
    }
    return 'vague';
  }

  for (const [category, pattern] of CATEGORY_PATTERNS) {
    if (pattern.test(text)) return category;
  }

  if (/\?$/.test(text.trim())) return 'question';
  if (wordCount < 10) return 'vague';
  return 'other';
}

// Detect when the prior assistant turn was a question or choice prompt,
// making a short user reply a direct answer rather than a vague prompt.
function assistantAskedQuestion(text: string): boolean {
  const trimmed = text.trimEnd();
  // Ends with a question mark (possibly inside markdown or parens)
  if (/\?\s*[)"'\`]?\s*$/.test(trimmed)) return true;
  // Presents an "X or Y?" choice even mid-sentence
  if (/ or /i.test(trimmed) && /\?/.test(trimmed)) return true;
  // Common decision-request phrases without a literal ?
  if (/\b(which (do you|would you|should (i|we))|do you want|yes or no|shall i|should i proceed|confirm|choose)\b/i.test(trimmed)) return true;
  return false;
}

export function vagueScore(
  text: string,
  ctx?: { turnIndex: number; priorUserWords: number; priorAssistantText?: string },
): number {
  const words = text.trim().split(/\s+/).length;
  // Long messages or conversational replies are never flagged
  if (words > 200 || CONVERSATIONAL.test(text.trim())) return 0;
  // Direct answer to a preceding assistant question is never vague
  if (ctx?.priorAssistantText && assistantAskedQuestion(ctx.priorAssistantText)) return 0;
  // Skill/command names and garbled text are not meaningful prompts to score
  const wordCount = text.trim().split(/\s+/).length;
  if ((wordCount === 1 && isCommandLike(text.trim())) || isGarbled(text)) return 0;
  let score = 0;
  if (words < 5)  score += 4;
  else if (words < 10) score += 2;
  else if (words < 15) score += 1;
  if (!/[\/\.][a-z]/i.test(text)) score += 1;            // no file path
  if (!/`[^`]+`/.test(text)) score += 1;                 // no inline code
  if (!/should|expected|want|need|instead/.test(text)) score += 1; // no expected outcome
  // Context discounts: short follow-ups in an established conversation are intentional
  if (ctx) {
    if (ctx.turnIndex > 0) score -= 1;        // not the session opener
    if (ctx.priorUserWords > 30) score -= 2;  // prior message established substantial context
  }
  return Math.max(0, score);
}

const SLASH_CMD = /^\/[a-zA-Z][a-zA-Z-]*/;

// Strict verification signal: only explicit test/check/verify language, not outcome words like "should"
const VERIFICATION_RE = /\b(run (the |all )?tests?|verify|check (that|it|the)\b|screenshot|expected output|failing test|make sure (it|the|that))\b/i;

export function hasVerificationCriteria(text: string): boolean {
  return VERIFICATION_RE.test(text);
}

// ── "Did you read my response?" detection ─────────────────────

const STOP_WORDS_SET = new Set([
  'the','a','an','is','are','was','were','it','in','on','at','to','for',
  'of','and','or','but','with','this','that','you','i','my','your',
  'how','why','when','where','can','do','did','does','have','has','had',
  'be','been','will','would','should','could','make','use','run','get',
  'set','need','want','also','just','like','from','they','their','which',
  'into','more','some','than','then','these','those','there','here','not',
]);

function keyTerms(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !STOP_WORDS_SET.has(w));
}

function questionTermOverlap(terms: string[], responseText: string): number {
  if (terms.length === 0) return 0;
  const lower = responseText.toLowerCase();
  return terms.filter(t => lower.includes(t)).length / terms.length;
}

const QUESTION_RE = /\?$|^(how|what|why|where|when|can|could|should|would|is|are|does|do|which)\b/i;

function extractMessageText(role: 'user' | 'assistant', text: string, entry: RawEntry, maxLen = 160): string {
  let raw: string;
  if (role === 'user') {
    raw = text;
  } else {
    const content = entry.message?.content;
    if (!content) return '';
    if (typeof content === 'string') {
      raw = content;
    } else {
      const blocks = content as Array<{ type: string; text?: string; name?: string }>;
      raw = blocks
        .filter(b => b.type === 'text')
        .map(b => b.text ?? '')
        .join('\n')
        .trim();
      if (!raw) {
        // Tool-only response — summarise what Claude invoked
        const tools = blocks.filter(b => b.type === 'tool_use').map(b => b.name).filter(Boolean);
        if (tools.length > 0) raw = `[used ${tools.join(', ')}]`;
      }
    }
  }
  if (!raw) return '';
  // Collapse newlines/extra whitespace so the snippet reads as a single flow
  raw = raw.replace(/\s+/g, ' ').trim();
  return raw.length > maxLen ? raw.slice(0, maxLen).trimEnd() + '…' : raw;
}

function median(arr: number[]): number | null {
  if (arr.length < 2) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export function analyze(projects: ProjectData[], days: number): AnalysisResult {
  const dailyMap = new Map<string, DailyUsage>();
  const projectStatsMap = new Map<string, ProjectStats>();
  const allPrompts: UserPrompt[] = [];
  const allUnreadMoments: UnreadMoment[] = [];
  const sessions = new Map<string, SessionStats>();
  const allToolCalls: string[] = [];
  const firstMessageWordCounts: number[] = [];
  const slashCommandMap = new Map<string, number>();

  for (const project of projects) {
    const sessionEntries = new Map<string, RawEntry[]>();

    // Group entries by session
    for (const entry of project.entries) {
      if (!entry.sessionId) continue;
      if (!sessionEntries.has(entry.sessionId)) {
        sessionEntries.set(entry.sessionId, []);
      }
      sessionEntries.get(entry.sessionId)!.push(entry);
    }

    for (const [sessionId, entries] of sessionEntries) {
      const sorted = entries
        .filter(e => e.timestamp)
        .sort((a, b) => new Date(a.timestamp!).getTime() - new Date(b.timestamp!).getTime());

      const sessionStat: SessionStats = {
        id: sessionId,
        projectName: project.name,
        startTime: sorted.length > 0 ? new Date(sorted[0].timestamp!) : new Date(),
        endTime: sorted.length > 0 ? new Date(sorted[sorted.length - 1].timestamp!) : new Date(),
        promptCount: 0,
        correctionCount: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
        costUSD: 0,
        model: 'claude-sonnet-4-6',
        outputRatio: null,
        medianVagueScore: null,
      };

      // Build ordered message sequence for correction detection
      const messageSequence: Array<{ role: 'user' | 'assistant'; text: string; entry: RawEntry }> = [];

      let sessionFirstUserMessageWords: number | null = null;
      let productiveToolCalls = 0;
      let totalSessionToolCalls = 0;
      const sessionPromptVagueScores: number[] = [];

      for (const entry of sorted) {
        if (entry.type === 'assistant' && entry.message?.usage) {
          const usage = entry.message.usage;
          const model = entry.message.model ?? 'claude-sonnet-4-6';
          sessionStat.model = model;
          sessionStat.totalInputTokens += usage.input_tokens || 0;
          sessionStat.totalOutputTokens += usage.output_tokens || 0;
          sessionStat.totalCacheReadTokens += usage.cache_read_input_tokens || 0;
          sessionStat.totalCacheCreationTokens += usage.cache_creation_input_tokens || 0;
          sessionStat.costUSD += computeCost(model, usage);

          // collect tool names from tool_use blocks
          if (Array.isArray(entry.message?.content)) {
            for (const block of entry.message.content as Array<{ type: string; name?: string }>) {
              if (block.type === 'tool_use' && block.name) {
                allToolCalls.push(block.name);
                if (!entry.isSidechain) {
                  totalSessionToolCalls++;
                  if (PRODUCTIVE_TOOLS.has(block.name)) productiveToolCalls++;
                }
              }
            }
          }

          const date = entry.timestamp!.slice(0, 10);
          const daily = dailyMap.get(date) ?? {
            date,
            outputTokens: 0,
            cost: 0,
            sessions: 0,
            messages: 0,
          };
          daily.outputTokens += usage.output_tokens || 0;
          daily.cost += computeCost(model, usage);
          daily.messages += 1;
          dailyMap.set(date, daily);

          messageSequence.push({ role: 'assistant', text: extractMessageText('assistant', '', entry, 3000), entry });
        }

        if (entry.type === 'user' && entry.message?.content) {
          const text = extractUserText(entry.message.content);
          if (text) {
            messageSequence.push({ role: 'user', text, entry });
            sessionStat.promptCount++;
            if (sessionFirstUserMessageWords === null) {
              sessionFirstUserMessageWords = text.split(/\s+/).length;
            }
            const slashMatch = text.trim().match(SLASH_CMD);
            if (slashMatch) {
              const cmd = slashMatch[0].toLowerCase();
              slashCommandMap.set(cmd, (slashCommandMap.get(cmd) ?? 0) + 1);
            }
          }
        }
      }

      // Detect corrections: user turn that follows assistant turn starting with correction words
      for (let i = 1; i < messageSequence.length; i++) {
        const cur = messageSequence[i];
        const prev = messageSequence[i - 1];
        if (cur.role === 'user' && prev.role === 'assistant' && CORRECTION_WORDS.test(cur.text)) {
          sessionStat.correctionCount++;
        }
      }

      // Detect "did you read my response?" moments
      for (let i = 1; i < messageSequence.length; i++) {
        const cur = messageSequence[i];
        const prev = messageSequence[i - 1];
        if (cur.role !== 'user' || prev.role !== 'assistant') continue;

        const followUp = cur.text.trim();
        const wc = followUp.split(/\s+/).length;
        if (wc < 2 || wc > 15) continue;
        if (!QUESTION_RE.test(followUp)) continue;

        const claudeText = extractMessageText('assistant', '', prev.entry, 3000);
        if (claudeText.length < 300) continue;

        const terms = keyTerms(followUp);
        if (terms.length < 2) continue;

        if (questionTermOverlap(terms, claudeText) >= 0.5) {
          allUnreadMoments.push({
            claudeText: claudeText.slice(0, 350).trimEnd() + (claudeText.length > 350 ? '…' : ''),
            userFollowUp: followUp,
            timestamp: cur.entry.timestamp ? new Date(cur.entry.timestamp) : new Date(),
            sessionId,
            projectName: project.name,
          });
        }
      }

      // Record user prompts (also collects context-aware vague scores)
      let userTurnIndex = 0;
      for (let i = 0; i < messageSequence.length; i++) {
        const msg = messageSequence[i];
        if (msg.role !== 'user') continue;

        const text = msg.text;
        const ts = msg.entry.timestamp ? new Date(msg.entry.timestamp) : new Date();
        const prevMsg = messageSequence[i - 1];
        const nextMsg = messageSequence[i + 1];
        const followedByCorrection =
          nextMsg?.role === 'user' && CORRECTION_WORDS.test(nextMsg.text);

        // look two ahead: user → assistant → user(correction)
        const afterAssistant = messageSequence[i + 2];
        const correctedAfterResponse =
          nextMsg?.role === 'assistant' &&
          afterAssistant?.role === 'user' &&
          CORRECTION_WORDS.test(afterAssistant.text);

        const contextBefore = prevMsg
          ? extractMessageText(prevMsg.role, prevMsg.text, prevMsg.entry)
          : undefined;
        const contextAfter = nextMsg
          ? extractMessageText(nextMsg.role, nextMsg.text, nextMsg.entry)
          : undefined;

        // Find the most recent prior user message word count for context discount
        let priorUserWords = 0;
        for (let j = i - 1; j >= 0; j--) {
          if (messageSequence[j].role === 'user') {
            priorUserWords = messageSequence[j].text.split(/\s+/).length;
            break;
          }
        }

        const priorAssistantText =
          prevMsg?.role === 'assistant' ? prevMsg.text : undefined;
        const ctx = { turnIndex: userTurnIndex, priorUserWords, priorAssistantText };
        const score = vagueScore(text, ctx);
        sessionPromptVagueScores.push(score);
        userTurnIndex++;

        const category = classifyPrompt(text, priorAssistantText);
        allPrompts.push({
          text,
          timestamp: ts,
          sessionId,
          projectName: project.name,
          wordCount: text.split(/\s+/).length,
          category,
          vagueScore: score,
          followedByCorrection: followedByCorrection || correctedAfterResponse,
          hasVerification: (category === 'implement' || category === 'fix') && hasVerificationCriteria(text),
          contextBefore: contextBefore || undefined,
          contextAfter: contextAfter || undefined,
        });
      }

      sessionStat.outputRatio =
        totalSessionToolCalls >= MIN_TOOL_CALLS
          ? productiveToolCalls / totalSessionToolCalls
          : null;

      const sortedVague = [...sessionPromptVagueScores].sort((a, b) => a - b);
      sessionStat.medianVagueScore =
        sortedVague.length > 0
          ? sortedVague[Math.floor(sortedVague.length / 2)]
          : null;

      if (sessionFirstUserMessageWords !== null) {
        firstMessageWordCounts.push(sessionFirstUserMessageWords);
      }

      if (sorted.length > 0) {
        const date = sorted[0].timestamp!.slice(0, 10);
        const daily = dailyMap.get(date) ?? {
          date,
          outputTokens: 0,
          cost: 0,
          sessions: 0,
          messages: 0,
        };
        daily.sessions += 1;
        dailyMap.set(date, daily);
      }

      sessions.set(sessionId, sessionStat);

      // Project stats
      const ps = projectStatsMap.get(project.name) ?? {
        name: project.name,
        sessions: 0,
        prompts: 0,
        cost: 0,
        cacheHitRate: 0,
      };
      ps.sessions += 1;
      ps.prompts += sessionStat.promptCount;
      ps.cost += sessionStat.costUSD;
      projectStatsMap.set(project.name, ps);
    }
  }

  // Compute per-project cache hit rates
  for (const project of projects) {
    let totalRead = 0, totalCreation = 0, totalInput = 0;
    for (const [, sess] of sessions) {
      if (sess.projectName === project.name) {
        totalRead += sess.totalCacheReadTokens;
        totalCreation += sess.totalCacheCreationTokens;
        totalInput += sess.totalInputTokens;
      }
    }
    const denom = totalRead + totalCreation + totalInput;
    const ps = projectStatsMap.get(project.name);
    if (ps) ps.cacheHitRate = denom > 0 ? totalRead / denom : 0;
  }

  // Aggregate totals
  let totalInputTokens = 0, totalOutputTokens = 0;
  let totalCacheReadTokens = 0, totalCacheCreationTokens = 0;
  let totalCost = 0;
  let totalCorrectionCount = 0;

  for (const [, sess] of sessions) {
    totalInputTokens += sess.totalInputTokens;
    totalOutputTokens += sess.totalOutputTokens;
    totalCacheReadTokens += sess.totalCacheReadTokens;
    totalCacheCreationTokens += sess.totalCacheCreationTokens;
    totalCost += sess.costUSD;
    totalCorrectionCount += sess.correctionCount;
  }

  const totalPromptTokenDenom = totalInputTokens + totalCacheReadTokens + totalCacheCreationTokens;
  const cacheHitRate = totalPromptTokenDenom > 0 ? totalCacheReadTokens / totalPromptTokenDenom : 0;

  // Use median word count to avoid paste-ins skewing the average
  const sortedWordCounts = [...allPrompts].map(p => p.wordCount).sort((a, b) => a - b);
  const avgPromptWords =
    sortedWordCounts.length > 0
      ? sortedWordCounts[Math.floor(sortedWordCounts.length / 2)]
      : 0;

  const correctionRate =
    sessions.size > 0
      ? Array.from(sessions.values()).filter(s => s.correctionCount > 0).length / sessions.size
      : 0;

  const promptCategories: Record<PromptCategory, number> = {
    fix: 0, implement: 0, explain: 0, refactor: 0, question: 0, vague: 0, other: 0,
  };
  for (const p of allPrompts) promptCategories[p.category]++;

  // Worst prompts: highest vague score, or followed by correction
  const worstPrompts = [...allPrompts]
    .filter(p => p.vagueScore >= 3 || p.followedByCorrection)
    .sort((a, b) => (b.vagueScore + (b.followedByCorrection ? 2 : 0)) - (a.vagueScore + (a.followedByCorrection ? 2 : 0)))
    .slice(0, 5);

  const unreadMoments = [...allUnreadMoments]
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
    .slice(0, 5);

  const dailyUsage = Array.from(dailyMap.values())
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-days);

  const projectStats = Array.from(projectStatsMap.values())
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 8);

  const toolsUsed = [...new Set(allToolCalls)].sort();
  const toolDiversity = toolsUsed.length;
  const totalToolCalls = allToolCalls.length;

  const sortedFirstMsgWords = [...firstMessageWordCounts].sort((a, b) => a - b);
  const medianFirstMessageWords =
    sortedFirstMsgWords.length > 0
      ? sortedFirstMsgWords[Math.floor(sortedFirstMsgWords.length / 2)]
      : 0;

  const scoredSessions = Array.from(sessions.values())
    .filter(s => s.outputRatio !== null && s.medianVagueScore !== null);

  const specificScores = scoredSessions
    .filter(s => s.medianVagueScore! < 3)
    .map(s => s.outputRatio!);
  const vagueScores = scoredSessions
    .filter(s => s.medianVagueScore! >= 3)
    .map(s => s.outputRatio!);

  const outputRatioByBucket = {
    specific: median(specificScores),
    vague: median(vagueScores),
    nSpecific: specificScores.length,
    nVague: vagueScores.length,
    nTotal: scoredSessions.length,
  };
  const medianOutputRatio = median(scoredSessions.map(s => s.outputRatio!));

  const actionablePrompts = allPrompts.filter(p => p.category === 'implement' || p.category === 'fix');
  const verificationRate = actionablePrompts.length > 0
    ? actionablePrompts.filter(p => p.hasVerification).length / actionablePrompts.length
    : 0;

  return {
    totalSessions: sessions.size,
    totalPrompts: allPrompts.length,
    totalCost,
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadTokens,
    totalCacheCreationTokens,
    cacheHitRate,
    avgPromptWords,
    correctionRate,
    promptCategories,
    dailyUsage,
    projectStats,
    worstPrompts,
    unreadMoments,
    daysAnalyzed: days,
    toolsUsed,
    toolDiversity,
    totalToolCalls,
    slashCommands: Object.fromEntries(slashCommandMap),
    medianFirstMessageWords,
    verificationRate,
    outputRatioByBucket,
    medianOutputRatio,
  };
}
