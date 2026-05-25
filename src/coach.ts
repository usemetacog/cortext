import Anthropic from '@anthropic-ai/sdk';
import type { AnalysisResult, Goal, CoachReport, UserPrompt } from './types';
import { heuristicDiagnosis, heuristicBetter } from './rewriter';

function pct(n: number): string {
  return (n * 100).toFixed(0) + '%';
}

function buildSystemPrompt(goal: Goal): string {
  const { label, customization, rubric } = goal;
  const customCtx = customization
    ? `\n\nThe user added context about themselves: "${customization}"`
    : '';

  return `You are a brutally honest but ultimately helpful prompt coach. The user has set a goal: become a "${label}".${customCtx}

Rubric for this persona:
- Specificity: ${rubric.specificity}
- Ownership: ${rubric.ownership}
- Tool diversity: ${rubric.toolDiversity}
- Front-loading context: ${rubric.frontloading}
- Efficiency: ${rubric.efficiency}
- Context management: Uses /clear between unrelated tasks; avoids kitchen-sink sessions (many turns on unrelated topics); uses /plan before complex changes; doesn't let context fill with failed approaches.
- Verification habit: Includes explicit test/verify criteria in implement and fix prompts (e.g. "run tests after", "verify", "check that"). This is the single highest-leverage prompting habit per Claude Code best practices.

You will receive their real prompting stats and their actual worst prompts. Assess them against the rubric.

Rules:
- Be blunt. Name specific failures. Don't soften the truth or add filler praise.
- But be constructive — every criticism should point at what good looks like.
- Grade A through F (+ and - allowed). Don't give A unless genuinely earned. Most users are C or below.
- For each worst moment, show the original prompt, a one-sentence diagnosis, and a rewritten version that fits the persona.
- The honestGap is the single most important insight — the core mindset shift they need. Make it land.
- Keep notes tight — one or two sentences max per field.

Respond as raw JSON only. No markdown fences. Schema:
{
  "grade": "C+",
  "gradeReason": "one punchy sentence",
  "signalScores": {
    "specificity":        { "score": 1-10, "note": "one sentence" },
    "ownership":          { "score": 1-10, "note": "one sentence" },
    "toolDiversity":      { "score": 1-10, "note": "one sentence" },
    "frontloading":       { "score": 1-10, "note": "one sentence" },
    "efficiency":         { "score": 1-10, "note": "one sentence" },
    "contextManagement":  { "score": 1-10, "note": "one sentence" },
    "verificationHabit":  { "score": 1-10, "note": "one sentence" }
  },
  "worstMoments": [
    { "original": "...", "diagnosis": "one sentence", "better": "rewritten prompt" }
  ],
  "whatIsWorking": "one or two sentences, be specific",
  "honestGap": "the core insight, 2-3 sentences max"
}`;
}

function buildUserMessage(result: AnalysisResult): string {
  const vagueRate = result.totalPrompts > 0
    ? result.promptCategories.vague / result.totalPrompts
    : 0;

  const actionableTotal = (result.promptCategories.implement ?? 0) + (result.promptCategories.fix ?? 0);
  const clearCount = result.slashCommands['/clear'] ?? 0;
  const planCount = result.slashCommands['/plan'] ?? 0;
  const compactCount = result.slashCommands['/compact'] ?? 0;

  const lines: string[] = [
    `STATS (last ${result.daysAnalyzed} days):`,
    `- Sessions: ${result.totalSessions}, Prompts: ${result.totalPrompts}`,
    `- Correction rate: ${pct(result.correctionRate)} of sessions had correction turns`,
    `- Median prompt length: ${result.avgPromptWords} words`,
    `- Median first-message length: ${result.medianFirstMessageWords} words`,
    `- Vague prompts: ${pct(vagueRate)} (${result.promptCategories.vague} of ${result.totalPrompts})`,
    `- Tools used: ${result.toolDiversity} distinct tools — ${result.toolsUsed.join(', ') || 'none detected'}`,
    `- Total tool calls: ${result.totalToolCalls}`,
    `- Slash commands: ${Object.values(result.slashCommands).reduce((a, b) => a + b, 0)} total — /clear: ${clearCount}, /plan: ${planCount}, /compact: ${compactCount}, /rewind: ${result.slashCommands['/rewind'] ?? 0}`,
    `- Verification rate: ${pct(result.verificationRate)} of implement/fix prompts include explicit verify criteria (${actionableTotal} total implement/fix prompts)`,
    `- Cache hit rate: ${pct(result.cacheHitRate)}`,
    `- Total cost: $${result.totalCost.toFixed(2)}`,
    '',
    'WORST PROMPTS (most vague or led to correction):',
  ];

  if (result.worstPrompts.length === 0) {
    lines.push('  None flagged.');
  } else {
    for (const p of result.worstPrompts) {
      const ts = p.timestamp.toLocaleString('en-US', {
        weekday: 'short', hour: 'numeric', minute: '2-digit',
      });
      lines.push(
        `  "${p.text.slice(0, 200)}" ` +
        `[${ts}, ${p.projectName}, vague=${p.vagueScore}, correction=${p.followedByCorrection}, hasVerification=${p.hasVerification}]`
      );
    }
  }

  return lines.join('\n');
}

// ── Heuristic coach (no API key required) ──────────────────────

function scoreHigh(rate: number): number {
  if (rate >= 0.7) return 9;
  if (rate >= 0.5) return 7;
  if (rate >= 0.3) return 5;
  if (rate >= 0.1) return 3;
  return 2;
}

function scoreLow(rate: number): number {
  if (rate <= 0.05) return 9;
  if (rate <= 0.15) return 7;
  if (rate <= 0.25) return 5;
  if (rate <= 0.4) return 3;
  return 2;
}

function scoreWords(words: number): number {
  if (words >= 40) return 9;
  if (words >= 25) return 7;
  if (words >= 15) return 5;
  if (words >= 8) return 4;
  return 2;
}

function toGrade(avg: number): string {
  if (avg >= 8.5) return 'A';
  if (avg >= 7.5) return 'A-';
  if (avg >= 7.0) return 'B+';
  if (avg >= 6.5) return 'B';
  if (avg >= 6.0) return 'B-';
  if (avg >= 5.5) return 'C+';
  if (avg >= 5.0) return 'C';
  if (avg >= 4.5) return 'C-';
  if (avg >= 4.0) return 'D+';
  if (avg >= 3.5) return 'D';
  return 'F';
}

export function runHeuristicCoach(result: AnalysisResult, goal: Goal): CoachReport {
  const vagueRate = result.totalPrompts > 0
    ? result.promptCategories.vague / result.totalPrompts
    : 0;
  const clearRate = result.totalSessions > 0
    ? (result.slashCommands['/clear'] ?? 0) / result.totalSessions
    : 0;

  const specificityScore = scoreWords(result.avgPromptWords);
  const ownershipScore   = scoreLow(result.correctionRate);
  const toolScore        = (() => {
    const t = result.toolDiversity;
    if (t >= 8) return 9; if (t >= 5) return 7; if (t >= 3) return 5; if (t >= 1) return 3; return 1;
  })();
  const frontloadingScore    = scoreWords(result.medianFirstMessageWords);
  const efficiencyScore      = scoreLow((vagueRate + result.correctionRate) / 2);
  const ctxMgmtScore         = (() => {
    if (clearRate >= 0.4) return 9; if (clearRate >= 0.2) return 7;
    if (clearRate >= 0.1) return 5; if (clearRate >= 0.05) return 4; return 3;
  })();
  const verificationScore    = scoreHigh(result.verificationRate);

  const avg = (specificityScore + ownershipScore + toolScore + frontloadingScore +
               efficiencyScore + ctxMgmtScore + verificationScore) / 7;
  const grade = toGrade(avg);

  // Notes per signal
  const specificityNote =
    result.avgPromptWords < 10
      ? `Median prompt is ${result.avgPromptWords} words — too short to act on without guessing.`
      : result.avgPromptWords < 20
      ? `${result.avgPromptWords}-word median is workable but lean; add file paths and expected behaviors.`
      : `${result.avgPromptWords}-word median shows reasonable specificity.`;

  const ownershipNote =
    result.correctionRate > 0.3
      ? `${pct(result.correctionRate)} of sessions had correction turns — prompts are leaving too much to infer.`
      : result.correctionRate > 0.15
      ? `${pct(result.correctionRate)} correction rate is acceptable; room to improve.`
      : `${pct(result.correctionRate)} correction rate is solid — prompts are landing well.`;

  const toolNote =
    result.toolDiversity <= 2
      ? `Only ${result.toolDiversity} distinct tool namespace${result.toolDiversity === 1 ? '' : 's'} used — explore subagents, web search, and custom tools.`
      : result.toolDiversity <= 5
      ? `${result.toolDiversity} tools is a decent start; look for more opportunities to leverage Claude's capabilities.`
      : `${result.toolDiversity} tool namespaces shows good breadth.`;

  const frontloadNote =
    result.medianFirstMessageWords < 10
      ? `Median first message is ${result.medianFirstMessageWords} words — sessions start cold with no context.`
      : result.medianFirstMessageWords < 25
      ? `${result.medianFirstMessageWords}-word opening messages leave Claude with limited context upfront.`
      : `${result.medianFirstMessageWords}-word first messages are front-loading context well.`;

  const efficiencyNote =
    vagueRate > 0.3
      ? `${pct(vagueRate)} vague prompt rate is high — every prompt should state what file, what's wrong, and what success looks like.`
      : vagueRate > 0.15
      ? `${pct(vagueRate)} of prompts flagged as vague; watch for under-specified requests.`
      : `Low vague rate — prompts are generally actionable.`;

  const ctxNote =
    clearRate < 0.05
      ? `/clear used rarely (${result.slashCommands['/clear'] ?? 0}× in ${result.totalSessions} sessions) — context is likely bleeding between unrelated tasks.`
      : clearRate < 0.2
      ? `/clear used ${result.slashCommands['/clear'] ?? 0}× — consider using it more between unrelated tasks.`
      : `/clear used regularly — good habit of keeping context clean.`;

  const verifyNote =
    result.verificationRate < 0.1
      ? `Verification criteria in only ${pct(result.verificationRate)} of implement/fix prompts — adding "run tests after" or "verify that X" is the single highest-leverage habit.`
      : result.verificationRate < 0.3
      ? `${pct(result.verificationRate)} of actionable prompts include verify criteria — aim for 50%+.`
      : `${pct(result.verificationRate)} of actionable prompts include verification — above average.`;

  // Worst moments via heuristics — only include entries with a specific diagnosis.
  const worstMoments = result.worstPrompts.slice(0, 5).flatMap((p: UserPrompt) => {
    const diagnosis = heuristicDiagnosis(p);
    if (!diagnosis) return [];
    return [{ original: p.text, diagnosis, better: heuristicBetter(p) }];
  }).slice(0, 3);

  // Strengths & gaps
  const scores = { specificityScore, ownershipScore, toolScore, frontloadingScore, verificationScore, ctxMgmtScore };
  const strengthNames = [
    [scores.specificityScore,  'prompt specificity'],
    [scores.ownershipScore,    'low correction rate'],
    [scores.toolScore,         'tool diversity'],
    [scores.frontloadingScore, 'front-loading context'],
    [scores.verificationScore, 'verification habits'],
  ] as [number, string][];

  const goodStrengths = strengthNames.filter(([s]) => s >= 7).map(([, n]) => n);
  const weaknesses    = strengthNames.filter(([s]) => s <= 4).map(([, n]) => n);

  const whatIsWorking = goodStrengths.length > 0
    ? `Your ${goodStrengths.slice(0, 2).join(' and ')} ${goodStrengths.length === 1 ? 'is' : 'are'} solid. Keep it.`
    : 'The fundamentals are there — consistency across sessions is the next challenge.';

  const primaryGap = weaknesses[0] ?? 'verification habits';
  const gapSentence: Record<string, string> = {
    'prompt specificity':        'You\'re leaving too much for Claude to infer. Every prompt needs: what file to touch, what\'s broken or expected, and what success looks like.',
    'front-loading context':     'You\'re starting sessions without enough context. Open each session with the full picture so Claude can work autonomously without constant steering.',
    'verification habits':       'Every implement/fix prompt should end with how you\'ll verify the result — "run tests after", "check that X". This is the single habit that compounds fastest.',
    'low correction rate':       'Your prompts are generating enough corrections that you\'re spending more time redirecting than building. Be more specific upfront.',
    'tool diversity':            'You\'re not using the full range of tools available. Explore subagents, web search, and file operations to get more done per session.',
  };

  const honestGap = `Your biggest lever is ${primaryGap}. ${gapSentence[primaryGap] ?? `Work on ${primaryGap} — it\'s the gap between your current patterns and the ${goal.label} persona.`} Run \`npx cortext review\` again after a week to see if the numbers move.`;

  const gradeReason = avg >= 7
    ? `Solid fundamentals — ${weaknesses.length > 0 ? `focus on ${weaknesses[0]} to push higher` : 'keep it consistent'}.`
    : avg >= 5
    ? `Middle of the pack — clear levers to pull, starting with ${weaknesses[0] ?? 'specificity'}.`
    : `Below average across the board — ${weaknesses[0] ?? 'specificity'} is the most urgent fix.`;

  return {
    grade,
    gradeReason,
    signalScores: {
      specificity:       { score: specificityScore,   note: specificityNote },
      ownership:         { score: ownershipScore,     note: ownershipNote },
      toolDiversity:     { score: toolScore,          note: toolNote },
      frontloading:      { score: frontloadingScore,  note: frontloadNote },
      efficiency:        { score: efficiencyScore,    note: efficiencyNote },
      contextManagement: { score: ctxMgmtScore,       note: ctxNote },
      verificationHabit: { score: verificationScore,  note: verifyNote },
    },
    worstMoments,
    whatIsWorking,
    honestGap,
  };
}

export async function runCoach(result: AnalysisResult, goal: Goal): Promise<CoachReport | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Fall back to heuristic report — no API call required
    return runHeuristicCoach(result, goal);
  }

  const client = new Anthropic({ apiKey });

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: buildSystemPrompt(goal),
      messages: [{ role: 'user', content: buildUserMessage(result) }],
    });

    const text = response.content.find(b => b.type === 'text')?.text ?? '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in response');
    return JSON.parse(jsonMatch[0]) as CoachReport;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\nCoaching failed: ${msg}\n`);
    return null;
  }
}
