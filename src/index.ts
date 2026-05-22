import * as readline from 'readline';
import { existsSync } from 'fs';
import Anthropic from '@anthropic-ai/sdk';
import chalk from 'chalk';
import { readProjects, detectSubagentSessions } from './reader';
import { analyze } from './analyzer';
import { render, renderCoachReport } from './renderer';
import { auditConfig, computeHarnessScore } from './harness';
import type { HarnessScore, BehavioralProfile } from './harness';
import type { WorstPromptData } from './renderer';
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
import type { Goal, GoalRubric, PeriodDelta } from './types';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function createSpinner(text: string) {
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  const isTTY = process.stdout.isTTY;

  return {
    start() {
      if (!isTTY) return;
      process.stdout.write('\x1B[?25l'); // hide cursor
      timer = setInterval(() => {
        process.stdout.write(`\r${chalk.cyan(SPINNER_FRAMES[frame % SPINNER_FRAMES.length])} ${chalk.dim(text)}`);
        frame++;
      }, 80);
    },
    stop() {
      if (!isTTY) return;
      if (timer) clearInterval(timer);
      process.stdout.write('\r\x1B[K'); // clear line
      process.stdout.write('\x1B[?25h'); // show cursor
    },
  };
}

const USAGE = `
Usage: npx cortext [command] [options]

Commands:
  goal              Set a coaching goal (interactive wizard)
  review            Run a coaching critique against your active goal
  quiz              Quiz yourself on your current git diff (needs ANTHROPIC_API_KEY)

Options:
  --days <n>        Analyze last n days (default: 30)
  --force           Regenerate review even if one was run in the last 7 days
  --staged          Quiz on staged changes only (default: all uncommitted changes)
  --web             Open browser dashboard
  --analyze         AI-powered prompt improvement (needs ANTHROPIC_API_KEY)
  --interactive     Chat with Claude about your stats (needs ANTHROPIC_API_KEY)
  --help            Show this help

Examples:
  npx cortext
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

  if (!force && isInCooldown()) {
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

  console.log(chalk.dim(`\nRunning coaching report for "${goal.label}" over the last ${days} days…\n`));

  const projects = readProjects(days);
  if (projects.length === 0) {
    console.error('\nNo Claude Code session data found in ~/.claude/projects/\n');
    process.exit(1);
  }

  const result = analyze(projects, days);
  const report = await runCoach(result, goal);
  if (report) {
    saveReview(report, goal, days);
    renderCoachReport(report, goal, days);
  }
}

interface ParsedArgs {
  command: 'dashboard' | 'goal' | 'review' | 'quiz';
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

  if (help) {
    console.log(USAGE);
    return;
  }

  if (command === 'goal') {
    const g = await runGoalWizard();
    if (g) console.log(chalk.dim('Run ') + chalk.white('npx cortext review') + chalk.dim(' to get your first coaching report.\n'));
    return;
  }

  if (command === 'review') {
    await runReview(days, force);
    return;
  }

  if (command === 'quiz') {
    const passed = await runQuiz(staged);
    process.exit(passed ? 0 : 1);
  }

  // default: dashboard
  const spinner = createSpinner('Loading cortext…');
  spinner.start();

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

  // Compute prior period for period-over-period deltas
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
    };
  } else {
    delta = {
      costPct: null,
      cacheHitRatePp: null,
      medianWordsDelta: null,
      priorSessions: priorResult?.totalSessions ?? 0,
    };
  }

  const vagueRate = result.promptCategories.vague / (result.totalPrompts || 1);
  checkAndLogOutcomes(result.correctionRate, vagueRate);

  // HIDDEN: worst prompt of the week — scope too large, revisit later
  const worstPromptData: WorstPromptData | undefined = undefined;

  if (result.unreadMoments.length > 0 && process.env.ANTHROPIC_API_KEY) {
    for (const moment of result.unreadMoments) {
      moment.aiCallout = await generateUnreadCallout(moment) ?? undefined;
    }
  }

  spinner.stop();

  if (shouldWeb) {
    startWebServer(result, worstPromptData, days);
    return;
  }

  const goal = loadGoal();
  render(result, worstPromptData, loadOutcomeInsight(), delta, goal, harnessScore);

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
