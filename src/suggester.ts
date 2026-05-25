import Anthropic from '@anthropic-ai/sdk';
import type { UserPrompt } from './types';
import { renderAnalysisHeader, renderAnalysisEntry, renderAnalysisFooter } from './renderer';
import { heuristicDiagnosis, heuristicBetter } from './rewriter';

const SYSTEM_PROMPT = `You are a prompt quality coach for Claude Code users.
Your job is to analyze real prompts sent to Claude Code and explain what context is missing, then rewrite each prompt to be specific, actionable, and efficient.

Rules:
- Be direct and concise
- Focus on what information would eliminate ambiguity
- Rewrites should sound natural, not over-engineered
- Do not lecture — just diagnose and fix`;

interface PromptAnalysis {
  diagnosis: string;
  rewritten: string;
}

export async function analyzePrompts(prompts: UserPrompt[]): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    // Heuristic fallback — no API call required
    renderAnalysisHeader();
    let shown = 0;
    for (const p of prompts) {
      const diagnosis = heuristicDiagnosis(p);
      if (!diagnosis) continue;
      renderAnalysisEntry(shown + 1, p.text, diagnosis, heuristicBetter(p));
      shown++;
    }
    renderAnalysisFooter();
    console.log('  (Heuristic analysis — no API call made. Add ANTHROPIC_API_KEY for AI-powered rewrites.)');
    console.log('  https://console.anthropic.com\n');
    return;
  }

  const client = new Anthropic({ apiKey });

  renderAnalysisHeader();

  const promptList = prompts
    .map((p, i) => `Prompt ${i + 1}: "${p.text}"`)
    .join('\n');

  const userMessage = `Analyze these Claude Code prompts and for each one provide:
1. A 1-2 sentence diagnosis of what context is missing
2. A rewritten version that is specific and actionable

${promptList}

Respond as JSON array: [{"diagnosis": "...", "rewritten": "..."}, ...]`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });

    const text = response.content.find(b => b.type === 'text')?.text ?? '';

    // Extract JSON from the response
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array in response');

    const analyses = JSON.parse(jsonMatch[0]) as PromptAnalysis[];

    for (let i = 0; i < prompts.length; i++) {
      const analysis = analyses[i];
      if (!analysis) continue;
      renderAnalysisEntry(
        i + 1,
        prompts[i].text,
        analysis.diagnosis,
        analysis.rewritten
      );
    }

    renderAnalysisFooter();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\nAnalysis failed: ${msg}\n`);
  }
}
