import * as readline from 'readline';
import { existsSync } from 'fs';
import { execFileSync } from 'child_process';
import Anthropic from '@anthropic-ai/sdk';
import chalk from 'chalk';
import { createSpinner } from './spinner';
import { version } from '../package.json';
import { readProjects, detectSubagentSessions } from './reader';
import { analyze } from './analyzer';
import { renderBehavior, renderMetrics, renderCoachReport, generateBehavioralAssumptions } from './renderer';
import { auditConfig, computeHarnessScore } from './harness';
import type { HarnessScore, BehavioralProfile } from './harness';
import type { WorstPromptData, BehavioralRead } from './renderer';
import { analyzePrompts } from './suggester';
import { runInteractive } from './interactive';
import { ARCHETYPES, loadGoal, saveGoal } from './goals';
import { runCoach } from './coach';
import { saveReview, loadLatestReview, daysSinceLastReview, isInCooldown, COOLDOWN_DAYS } from './reviews';
import { generateRewrite, heuristicDiagnosis, hashPrompt } from './rewriter';
import { logRewriteShown, checkAndLogOutcomes, loadOutcomeInsight } from './evallog';
import { generateUnreadCallout } from './unread';
import { startWebServer } from './server';
import { runQuiz } from './quiz';
import { installSkill } from './skill';
import type { Goal, GoalRubric, PeriodDelta } from './types';


const USAGE = `
Usage: npx cortext [command] [options]

Commands:
  run               Behavioral analysis — prompt patterns, efficiency signals, harness health (default)
  metrics           Token/cost breakdown — spend, cache hit rate, daily usage, top projects
  goal              Set a coaching goal (interactive wizard)
  review            Run a coaching critique against your active goal
                    Works without an API key (heuristic mode); add ANTHROPIC_API_KEY for AI coaching
  quiz              Quiz yourself on your current git diff (needs ANTHROPIC_API_KEY)

Options:
  --days <n>        Analyze last n days (default: 30)
  --force           Regenerate review even if one was run in the last 7 days
  --staged          Quiz on staged changes only (default: all uncommitted changes)
  --web             Open browser dashboard
  --analyze         Prompt improvement suggestions (heuristic without key; AI with ANTHROPIC_API_KEY)
  --interactive     Chat with Claude about your stats (needs ANTHROPIC_API_KEY)
  --help            Show this help

Note: ANTHROPIC_API_KEY is a separate Anthropic API key, not your Claude Pro/Max subscription.
      Get one free at: https://console.anthropic.com

Examples:
  npx cortext
  npx cortext run
  npx cortext metrics
  npx cortext metrics --days 7
  npx cortext quiz
  npx cortext quiz --staged
  npx cortext goal
  npx cortext review
  npx cortext review --days 7
  npx cortext review --force
  npx cortext --analyze
`.trim();

function ask(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise(resolve => rl.question(prompt, resolve));
}

async function deriveCustomRubric(description: string): Promise<GoalRubric> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Fallback rubric if no API key
    return {
      specificity: `Prompts are specific and actionable toward: ${description}`,
      ownership: 'Takes clear ownership of direction; pushes back when output misses the mark.',
      toolDiversity: 'Leverages the full range of available tools rather than defaulting to text-only.',
      frontloading: 'Opens sessions with full context so Claude can act autonomously.',
      efficiency: 'Achieves the goal with minimal back-and-forth and low correction rate.',
    };
  }

  const client = new Anthropic({ apiKey });
  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      system: `You generate a prompting rubric for a user who wants to prompt Claude Code like a specific persona or achieve a specific goal.
Respond as raw JSON only. No markdown fences. Schema:
{
  "specificity": "one sentence describing what specificity looks like for this persona",
  "ownership": "one sentence describing ownership behavior",
  "toolDiversity": "one sentence describing tool usage expectations",
  "frontloading": "one sentence describing how context is set upfront",
  "efficiency": "one sentence describing efficiency expectations"
}`,
      messages: [{
        role: 'user',
        content: `The user's goal: "${description}"`,
      }],
    });
    const text = response.content.find(b => b.type === 'text')?.text ?? '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('no JSON');
    return JSON.parse(jsonMatch[0]) as GoalRubric;
  } catch {
    return {
      specificity: `Prompts are specific and actionable toward: ${description}`,
      ownership: 'Takes clear ownership of direction; pushes back when output misses the mark.',
      toolDiversity: 'Leverages the full range of available tools rather than defaulting to text-only.',
      frontloading: 'Opens sessions with full context so Claude can act autonomously.',
      efficiency: 'Achieves the goal with minimal back-and-forth and low correction rate.',
    };
  }
}

function parseExplanationsJSON(text: string): string[] | null {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]) as { explanations?: unknown };
    return Array.isArray(parsed.explanations) ? (parsed.explanations as string[]) : null;
  } catch {
    return null;
  }
}

async function generateReadExplanations(assumptions: string[], goal: Goal | null): Promise<string[] | null> {
  if (assumptions.length === 0) return null;

  const personaLabel = goal ? goal.label : 'a high-agency, high-taste operator';
  const rubricLines = goal?.rubric
    ? Object.entries(goal.rubric).map(([k, v]) => `${k}: ${v}`).join('\n')
    : null;

  const SYSTEM = `You are a blunt prompting coach. For each observed pattern, write ONE sentence (max 15 words) explaining why it helps or hurts the user's stated goal. Be specific to the goal — no generic advice. No hedging.

Respond as raw JSON only. No markdown fences.
Schema: { "explanations": ["≤15-word sentence", "≤15-word sentence", "≤15-word sentence"] }`;

  const USER = `Goal: ${personaLabel}${rubricLines ? `\n\nRubric:\n${rubricLines}` : ''}

Observed patterns:
${assumptions.map((a, i) => `${i + 1}. ${a}`).join('\n')}`;

  // Path 1 — direct Anthropic API key
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    try {
      const client = new Anthropic({ apiKey });
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        system: SYSTEM,
        messages: [{ role: 'user', content: USER }],
      });
      const text = response.content.find(b => b.type === 'text')?.text ?? '';
      const result = parseExplanationsJSON(text);
      if (result) return result;
    } catch {
      // fall through to CLI
    }
  }

  // Path 2 — claude CLI (Pro/Max subscription)
  try {
    const raw = execFileSync(
      'claude',
      ['-p', '--system-prompt', SYSTEM, '--output-format', 'json',
       '--no-session-persistence', '--model', 'haiku'],
      { input: USER, encoding: 'utf-8', timeout: 30000 }
    ) as string;
    const outer = JSON.parse(raw) as { result?: string };
    return parseExplanationsJSON(outer.result ?? '');
  } catch {
    return null;
  }
}

async function runGoalWizard(): Promise<Goal | null> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => { console.log('\n'); rl.close(); process.exit(0); });

  console.log('');
  console.log(chalk.bold.white('Set a coaching goal'));
  console.log(chalk.dim('cortext will score your prompts against this persona and give blunt feedback.'));
  console.log('');

  console.log(chalk.dim('Archetypes:'));
  for (let i = 0; i < ARCHETYPES.length; i++) {
    const a = ARCHETYPES[i];
    console.log(`  ${chalk.white(String(i + 1))}. ${chalk.bold(a.label)}  ${chalk.dim(a.tagline)}`);
  }
  console.log(`  ${chalk.white(String(ARCHETYPES.length + 1))}. ${chalk.bold('Custom')}  ${chalk.dim('Define your own')}`);
  console.log('');

  let choiceStr: string;
  while (true) {
    choiceStr = (await ask(rl, chalk.cyan(`Pick 1–${ARCHETYPES.length + 1}: `))).trim();
    const n = parseInt(choiceStr, 10);
    if (!isNaN(n) && n >= 1 && n <= ARCHETYPES.length + 1) break;
    console.log(chalk.dim(`  Enter a number between 1 and ${ARCHETYPES.length + 1}`));
  }

  const choiceIdx = parseInt(choiceStr, 10) - 1;
  const isCustom = choiceIdx === ARCHETYPES.length;

  let goal: Goal;

  if (isCustom) {
    const description = (await ask(rl, chalk.cyan('Describe your goal (e.g. "prompt like Steve Jobs"): '))).trim();
    if (!description) {
      console.log(chalk.dim('\nNo input — goal not saved.\n'));
      rl.close();
      return null;
    }
    console.log(chalk.dim('\nDeriving rubric…'));
    const rubric = await deriveCustomRubric(description);
    goal = {
      archetypeId: 'custom',
      label: description,
      rubric,
      createdAt: new Date().toISOString().slice(0, 10),
    };
  } else {
    const archetype = ARCHETYPES[choiceIdx];
    const customization = (
      await ask(rl, chalk.cyan(`Optional — add context about yourself (or press Enter to skip): `))
    ).trim();
    goal = {
      archetypeId: archetype.id,
      label: archetype.label,
      customization: customization || undefined,
      rubric: archetype.rubric,
      createdAt: new Date().toISOString().slice(0, 10),
    };
  }

  saveGoal(goal);
  console.log('');
  console.log(chalk.green('✓') + ' Goal set: ' + chalk.white.bold(goal.label));
  if (goal.customization) console.log(chalk.dim('  "' + goal.customization + '"'));
  console.log('');

  rl.close();
  return goal;
}

async function runReview(days: number, force: boolean): Promise<void> {
  let goal = loadGoal();
  if (!goal) {
    console.log('');
    console.log(chalk.yellow('No goal set yet — let\'s do that now.'));
    goal = await runGoalWizard();
    if (!goal) return;
    console.log(chalk.dim('Running your first review…\n'));
  }

  const hasApiKey = !!process.env.ANTHROPIC_API_KEY;

  // Only enforce cooldown for AI reviews (no cost to run heuristic reviews)
  if (hasApiKey && !force && isInCooldown()) {
    const age = daysSinceLastReview()!;
    const daysLeft = COOLDOWN_DAYS - age;
    const latest = loadLatestReview()!;
    console.log('');
    console.log(chalk.yellow(`Review generated ${age === 0 ? 'today' : `${age} day${age === 1 ? '' : 's'} ago`}.`));
    console.log(chalk.dim(`Come back in ${daysLeft} day${daysLeft === 1 ? '' : 's'} to see if your patterns have improved.`));
    console.log('');
    console.log(chalk.dim('Showing your last report:'));
    renderCoachReport(latest.report, goal, latest.daysAnalyzed);
    console.log(chalk.dim('To regenerate now, run: ') + chalk.white('npx cortext review --force'));
    console.log('');
    return;
  }

  const reviewSpinner = createSpinner('Running coaching report…');
  reviewSpinner.start();

  const projects = readProjects(days);
  if (projects.length === 0) {
    reviewSpinner.stop();
    console.error('\nNo Claude Code session data found in ~/.claude/projects/\n');
    process.exit(1);
  }

  const result = analyze(projects, days);
  const report = await runCoach(result, goal);
  reviewSpinner.stop();

  if (report) {
    // Only persist AI-generated reviews (they enforce the cooldown; heuristic reviews are free)
    if (hasApiKey) saveReview(report, goal, days);
    renderCoachReport(report, goal, days);
    if (!hasApiKey) {
      console.log('');
      console.log(chalk.dim('  Heuristic report — scored from your stats, no API call made.'));
      console.log(chalk.dim('  For AI-powered coaching, add an Anthropic API key (separate from Claude Pro/Max):'));
      console.log(chalk.dim('  https://console.anthropic.com → export ANTHROPIC_API_KEY=sk-ant-...'));
      console.log('');
    }
  }
}

interface ParsedArgs {
  command: 'dashboard' | 'goal' | 'review' | 'quiz' | 'metrics';
  days: number;
  analyze: boolean;
  interactive: boolean;
  force: boolean;
  help: boolean;
  web: boolean;
  staged: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  let command: ParsedArgs['command'] = 'dashboard';
  let days = 30;
  let analyze = false;
  let interactive = false;
  let force = false;
  let help = false;
  let web = false;
  let staged = false;

  let i = 0;

  // check for subcommand first
  if (args[0] === 'goal') {
    command = 'goal';
    i = 1;
  } else if (args[0] === 'review') {
    command = 'review';
    i = 1;
  } else if (args[0] === 'quiz') {
    command = 'quiz';
    i = 1;
  } else if (args[0] === 'metrics') {
    command = 'metrics';
    i = 1;
  } else if (args[0] === 'run') {
    command = 'dashboard';
    i = 1;
  }

  for (; i < args.length; i++) {
    if (args[i] === '--days' && args[i + 1]) {
      const n = parseInt(args[i + 1], 10);
      if (!isNaN(n) && n > 0) days = n;
      i++;
    } else if (args[i] === '--analyze') {
      analyze = true;
    } else if (args[i] === '--interactive') {
      interactive = true;
    } else if (args[i] === '--force') {
      force = true;
    } else if (args[i] === '--staged') {
      staged = true;
    } else if (args[i] === '--web') {
      web = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      help = true;
    }
  }

  return { command, days, analyze, interactive, force, help, web, staged };
}

async function main(): Promise<void> {
  const { command, days, analyze: shouldAnalyze, interactive: shouldInteract, force, help, web: shouldWeb, staged } = parseArgs(process.argv);

  // Keep the Claude Code skill in sync with this version — silent, best-effort.
  installSkill();

  console.log(chalk.dim(`cortext v${version}`));

  // Start spinner immediately after version line for every command
  const startupSpinner = createSpinner('Loading…');
  startupSpinner.start();

  if (help) {
    startupSpinner.stop();
    console.log(USAGE);
    return;
  }

  if (command === 'goal') {
    startupSpinner.stop();
    const g = await runGoalWizard();
    if (g) console.log(chalk.dim('Run ') + chalk.white('npx cortext review') + chalk.dim(' to get your first coaching report.\n'));
    return;
  }

  if (command === 'review') {
    startupSpinner.stop();
    await runReview(days, force);
    return;
  }

  if (command === 'quiz') {
    startupSpinner.stop();
    const passed = await runQuiz(staged);
    process.exit(passed ? 0 : 1);
  }

  if (command === 'metrics') {
    const spinner = startupSpinner;

    const projects = readProjects(days);
    if (projects.length === 0) {
      spinner.stop();
      console.error(
        '\nNo Claude Code session data found in ~/.claude/projects/\n' +
        'Make sure you have Claude Code installed and have run at least one session.\n'
      );
      process.exit(1);
    }

    const result = analyze(projects, days);
    const priorProjects = readProjects(days, days);
    const priorResult = priorProjects.length > 0 ? analyze(priorProjects, days) : null;

    const MIN_PRIOR_SESSIONS = 10;
    let delta: PeriodDelta | undefined;
    if (priorResult && priorResult.totalSessions >= MIN_PRIOR_SESSIONS) {
      delta = {
        costPct: priorResult.totalCost > 0
          ? (result.totalCost - priorResult.totalCost) / priorResult.totalCost
          : null,
        cacheHitRatePp: (result.cacheHitRate - priorResult.cacheHitRate) * 100,
        medianWordsDelta: result.avgPromptWords - priorResult.avgPromptWords,
        priorSessions: priorResult.totalSessions,
        vagueRatePp: null,
        correctionRatePp: null,
      };
    } else {
      delta = {
        costPct: null,
        cacheHitRatePp: null,
        medianWordsDelta: null,
        priorSessions: priorResult?.totalSessions ?? 0,
        vagueRatePp: null,
        correctionRatePp: null,
      };
    }

    spinner.stop();
    renderMetrics(result, delta);
    return;
  }

  // default: dashboard
  const spinner = startupSpinner;

  const projects = readProjects(days);

  if (projects.length === 0) {
    spinner.stop();
    console.error(
      '\nNo Claude Code session data found in ~/.claude/projects/\n' +
      'Make sure you have Claude Code installed and have run at least one session.\n'
    );
    process.exit(1);
  }

  const result = analyze(projects, days);

  // Prior-period delta for trend-aware behavioral reads
  const priorProjects = readProjects(days, days);
  const priorResult = priorProjects.length > 0 ? analyze(priorProjects, days) : null;
  const MIN_PRIOR_SESSIONS = 10;
  const behaviorDelta: PeriodDelta | undefined = (priorResult && priorResult.totalSessions >= MIN_PRIOR_SESSIONS)
    ? {
        costPct: null,
        cacheHitRatePp: null,
        medianWordsDelta: null,
        priorSessions: priorResult.totalSessions,
        vagueRatePp: ((result.promptCategories.vague / (result.totalPrompts || 1)) -
                      (priorResult.promptCategories.vague / (priorResult.totalPrompts || 1))) * 100,
        correctionRatePp: (result.correctionRate - priorResult.correctionRate) * 100,
      }
    : undefined;

  // Harness health assembly
  // Prefer the directory cortext is invoked from; fall back to the top project
  // only when the current directory doesn't look like a project (no CLAUDE.md
  // and no .claude/ subdir), e.g. when running from ~/ or /tmp.
  const cwdLooksLikeProject =
    existsSync(`${process.cwd()}/CLAUDE.md`) ||
    existsSync(`${process.cwd()}/.claude`);
  let projectCwd = process.cwd();
  if (!cwdLooksLikeProject) {
    const topProject = [...result.projectStats].sort((a, b) => b.sessions - a.sessions)[0];
    if (topProject) {
      const pd = projects.find(p => p.name === topProject.name);
      const cwdEntry = pd?.entries.find(e => e.cwd);
      if (cwdEntry?.cwd) projectCwd = cwdEntry.cwd;
    }
  }
  const configAudit = auditConfig(projectCwd);
  const behavioralProfile: BehavioralProfile = {
    subagentSessionCount: detectSubagentSessions(days),
    compactionEventCount: result.compactionEventCount,
    autoCompactionCount: result.autoCompactionCount,
    manualCompactionCount: result.manualCompactionCount,
    toolNamespaceCount: result.toolDiversity,
  };
  const harnessScore: HarnessScore = computeHarnessScore(configAudit, behavioralProfile, result.totalSessions);

  const vagueRate = result.promptCategories.vague / (result.totalPrompts || 1);
  checkAndLogOutcomes(result.correctionRate, vagueRate);

  // HIDDEN: worst prompt of the week — scope too large, revisit later
  const worstPromptData: WorstPromptData | undefined = undefined;

  if (result.unreadMoments.length > 0 && process.env.ANTHROPIC_API_KEY) {
    for (const moment of result.unreadMoments) {
      moment.aiCallout = await generateUnreadCallout(moment) ?? undefined;
    }
  }

  // Behavioral reads — heuristic always, LLM explanations if API key present
  const goal = loadGoal();
  const baseReads = generateBehavioralAssumptions(result, goal ?? null, behaviorDelta);
  let reads: BehavioralRead[] | undefined;
  if (baseReads.length > 0) {
    const explanations = await generateReadExplanations(baseReads.map(r => r.text), goal ?? null);
    reads = baseReads.map((r, i) => ({
      ...r,
      explanation: explanations?.[i],
    }));
  }

  spinner.stop();

  if (shouldWeb) {
    startWebServer(result, worstPromptData, days);
    return;
  }

  renderBehavior(result, worstPromptData, loadOutcomeInsight(), goal, harnessScore, reads);

  if (shouldAnalyze) {
    if (result.worstPrompts.length === 0) {
      console.log('\nNo vague or corrected prompts found — great job!\n');
    } else {
      await analyzePrompts(result.worstPrompts);
    }
  }

  if (shouldInteract) {
    await runInteractive(result);
  }
}

main().catch(err => {
  console.error('Error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
