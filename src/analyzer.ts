import type { ProjectData } from './reader';
import { extractUserText } from './reader';
import type {
  AnalysisResult,
  DailyUsage,
  ProjectStats,
  PromptCategory,
  RawEntry,
  SessionStats,
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

export function classifyPrompt(text: string): PromptCategory {
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

  if (wordCount < 6) return 'vague';

  for (const [category, pattern] of CATEGORY_PATTERNS) {
    if (pattern.test(text)) return category;
  }

  if (/\?$/.test(text.trim())) return 'question';
  if (wordCount < 10) return 'vague';
  return 'other';
}

export function vagueScore(text: string): number {
  const words = text.trim().split(/\s+/).length;
  // Long messages or conversational replies are never flagged
  if (words > 200 || CONVERSATIONAL.test(text.trim())) return 0;
  let score = 0;
  if (words < 5)  score += 4;
  else if (words < 10) score += 2;
  else if (words < 15) score += 1;
  if (!/[\/\.][a-z]/i.test(text)) score += 1;            // no file path
  if (!/`[^`]+`/.test(text)) score += 1;                 // no inline code
  if (!/should|expected|want|need|instead/.test(text)) score += 1; // no expected outcome
  return score;
}

const SLASH_CMD = /^\/[a-zA-Z][a-zA-Z-]*/;

export function analyze(projects: ProjectData[], days: number): AnalysisResult {
  const dailyMap = new Map<string, DailyUsage>();
  const projectStatsMap = new Map<string, ProjectStats>();
  const allPrompts: UserPrompt[] = [];
  const sessions = new Map<string, SessionStats>();
  const allToolCalls: string[] = [];
  const firstMessageWordCounts: number[] = [];
  let slashCommandCount = 0;

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
      };

      // Build ordered message sequence for correction detection
      const messageSequence: Array<{ role: 'user' | 'assistant'; text: string; entry: RawEntry }> = [];

      let sessionFirstUserMessageWords: number | null = null;

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

          messageSequence.push({ role: 'assistant', text: '', entry });
        }

        if (entry.type === 'user' && entry.message?.content) {
          const text = extractUserText(entry.message.content);
          if (text) {
            messageSequence.push({ role: 'user', text, entry });
            sessionStat.promptCount++;
            if (sessionFirstUserMessageWords === null) {
              sessionFirstUserMessageWords = text.split(/\s+/).length;
            }
            if (SLASH_CMD.test(text.trim())) {
              slashCommandCount++;
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

      // Record user prompts
      for (let i = 0; i < messageSequence.length; i++) {
        const msg = messageSequence[i];
        if (msg.role !== 'user') continue;

        const text = msg.text;
        const ts = msg.entry.timestamp ? new Date(msg.entry.timestamp) : new Date();
        const nextMsg = messageSequence[i + 1];
        const followedByCorrection =
          nextMsg?.role === 'user' && CORRECTION_WORDS.test(nextMsg.text);

        // look two ahead: user → assistant → user(correction)
        const afterAssistant = messageSequence[i + 2];
        const correctedAfterResponse =
          nextMsg?.role === 'assistant' &&
          afterAssistant?.role === 'user' &&
          CORRECTION_WORDS.test(afterAssistant.text);

        allPrompts.push({
          text,
          timestamp: ts,
          sessionId,
          projectName: project.name,
          wordCount: text.split(/\s+/).length,
          category: classifyPrompt(text),
          vagueScore: vagueScore(text),
          followedByCorrection: followedByCorrection || correctedAfterResponse,
        });
      }

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
    daysAnalyzed: days,
    toolsUsed,
    toolDiversity,
    totalToolCalls,
    slashCommandCount,
    medianFirstMessageWords,
  };
}
