import Anthropic from '@anthropic-ai/sdk';
import * as readline from 'readline';
import chalk from 'chalk';
import type { AnalysisResult } from './types';

const WIDTH = 62;
const INNER = WIDTH - 4;

function boxLine(content: string): string {
  return chalk.dim('║') + ' ' + content.slice(0, INNER).padEnd(INNER) + ' ' + chalk.dim('║');
}

function buildSystemPrompt(result: AnalysisResult): string {
  const worstPromptsText =
    result.worstPrompts.length > 0
      ? result.worstPrompts
          .map(
            (p, i) =>
              `  ${i + 1}. "${p.text.slice(0, 120)}" ` +
              `(vague score: ${p.vagueScore}, led to correction: ${p.followedByCorrection}, project: ${p.projectName})`
          )
          .join('\n')
      : '  None found';

  const catLines = Object.entries(result.promptCategories)
    .filter(([, count]) => count > 0)
    .map(([cat, count]) => `  - ${cat}: ${count}`)
    .join('\n');

  const projectLines = result.projectStats
    .slice(0, 5)
    .map(p => `  - ${p.name}: $${p.cost.toFixed(2)}`)
    .join('\n');

  return `You are a prompt quality coach helping a Claude Code user understand and improve their prompting habits.

You have access to their real usage data from the last ${result.daysAnalyzed} days:

STATS:
- Sessions: ${result.totalSessions}, Prompts: ${result.totalPrompts}
- Total cost: $${result.totalCost.toFixed(2)}, Cache hit rate: ${(result.cacheHitRate * 100).toFixed(0)}%
- Median prompt length: ${result.avgPromptWords} words
- Correction rate: ${(result.correctionRate * 100).toFixed(0)}% of sessions had correction turns

PROMPT BREAKDOWN:
${catLines}

THEIR WORST PROMPTS (most vague or followed by a correction turn):
${worstPromptsText}

TOP PROJECTS BY SPEND:
${projectLines}

When answering:
- Reference their actual data and real prompt examples where relevant
- For prompt rewrites, show the original then the improved version
- Stay under 200 words unless the user asks for more detail
- Be direct — diagnose, fix, move on`;
}

function ask(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise(resolve => rl.question(prompt, resolve));
}

export async function runInteractive(result: AnalysisResult): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('\nANTHROPIC_API_KEY not set. Export it to use --interactive.\n');
    process.exit(1);
  }

  const client = new Anthropic({ apiKey });
  const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  const systemPrompt = buildSystemPrompt(result);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  rl.on('SIGINT', () => {
    console.log(chalk.dim('\n\nGoodbye.\n'));
    rl.close();
    process.exit(0);
  });

  console.log('');
  console.log(chalk.dim('╔' + '═'.repeat(WIDTH - 2) + '╗'));
  console.log(boxLine(chalk.bold.magenta('INTERACTIVE MODE') + chalk.dim('  ·  ask anything about your stats')));
  console.log(boxLine(chalk.dim('Type exit to quit, or Ctrl+C')));
  console.log(chalk.dim('╚' + '═'.repeat(WIDTH - 2) + '╝'));
  console.log('');

  while (true) {
    let input: string;
    try {
      input = await ask(rl, chalk.cyan('you › '));
    } catch {
      break;
    }

    const trimmed = input.trim();
    if (!trimmed) continue;
    if (trimmed === 'exit' || trimmed === 'quit') {
      console.log(chalk.dim('\nGoodbye.\n'));
      rl.close();
      break;
    }

    history.push({ role: 'user', content: trimmed });
    console.log('');
    process.stdout.write(chalk.dim('claude › '));

    try {
      const stream = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 512,
        system: systemPrompt,
        messages: history,
        stream: true,
      });

      let fullResponse = '';
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          process.stdout.write(event.delta.text);
          fullResponse += event.delta.text;
        }
      }

      console.log('\n');
      history.push({ role: 'assistant', content: fullResponse });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`\nError: ${msg}\n`));
    }
  }
}
