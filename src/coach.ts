import Anthropic from '@anthropic-ai/sdk';
import type { AnalysisResult, Goal, CoachReport } from './types';

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
    "specificity":   { "score": 1-10, "note": "one sentence" },
    "ownership":     { "score": 1-10, "note": "one sentence" },
    "toolDiversity": { "score": 1-10, "note": "one sentence" },
    "frontloading":  { "score": 1-10, "note": "one sentence" },
    "efficiency":    { "score": 1-10, "note": "one sentence" }
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

  const lines: string[] = [
    `STATS (last ${result.daysAnalyzed} days):`,
    `- Sessions: ${result.totalSessions}, Prompts: ${result.totalPrompts}`,
    `- Correction rate: ${pct(result.correctionRate)} of sessions had correction turns`,
    `- Median prompt length: ${result.avgPromptWords} words`,
    `- Median first-message length: ${result.medianFirstMessageWords} words`,
    `- Vague prompts: ${pct(vagueRate)} (${result.promptCategories.vague} of ${result.totalPrompts})`,
    `- Tools used: ${result.toolDiversity} distinct tools — ${result.toolsUsed.join(', ') || 'none detected'}`,
    `- Total tool calls: ${result.totalToolCalls}`,
    `- Slash command usage in prompts: ${result.slashCommandCount}`,
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
        `[${ts}, ${p.projectName}, vague=${p.vagueScore}, correction=${p.followedByCorrection}]`
      );
    }
  }

  return lines.join('\n');
}

export async function runCoach(result: AnalysisResult, goal: Goal): Promise<CoachReport | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('\nThis feature calls the Anthropic API — separate from your Claude Code subscription.');
    console.error('\nGet a free key at: https://console.anthropic.com  (free tier covers review usage)');
    console.error('\nThen run:');
    console.error('  export ANTHROPIC_API_KEY=sk-ant-...');
    console.error('  npx cortext review');
    console.error('\nTo make it permanent: add the export line to your ~/.zshrc or ~/.bashrc\n');
    process.exit(1);
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
