import chalk from 'chalk';
import type { AnalysisResult, CoachReport, DailyUsage, Goal, PeriodDelta, PromptCategory, RewriteResult, UserPrompt } from './types';

export interface WorstPromptData {
  prompt: UserPrompt;
  rewrite: RewriteResult | null;
  heuristic: string;
}

const WIDTH = 62;
const INNER = WIDTH - 4; // inside the box borders + 2 spaces padding

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B\[[0-9;]*m/g;

function visibleLen(s: string): number {
  return s.replace(ANSI_RE, '').length;
}

function pad(s: string, n: number): string {
  const spaces = Math.max(0, n - visibleLen(s));
  return s + ' '.repeat(spaces);
}

function line(content: string): string {
  return `${chalk.dim('║')} ${pad(content, INNER)} ${chalk.dim('║')}`;
}

function divider(): string {
  return chalk.dim('╠' + '═'.repeat(WIDTH - 2) + '╣');
}

function top(): string {
  return chalk.dim('╔' + '═'.repeat(WIDTH - 2) + '╗');
}

function bottom(): string {
  return chalk.dim('╚' + '═'.repeat(WIDTH - 2) + '╝');
}

function blank(): string {
  return line('');
}

function header(text: string): string {
  return line(chalk.bold.white(text));
}

function sectionLabel(text: string): string {
  return line(chalk.bold.cyan(text));
}

function formatToken(n: number): string {
  if (!isFinite(n) || isNaN(n)) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'k';
  return n.toString();
}

function formatCost(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  return '$' + usd.toFixed(2);
}

function bar(fraction: number, maxWidth: number): string {
  const filled = Math.round(fraction * maxWidth);
  const empty = maxWidth - filled;
  return chalk.cyan('█'.repeat(filled)) + chalk.dim('░'.repeat(empty));
}

function pct(n: number): string {
  return (n * 100).toFixed(0) + '%';
}

const CATEGORY_LABELS: Record<PromptCategory, string> = {
  fix:       'Fix / Debug',
  implement: 'Implement  ',
  explain:   'Explain    ',
  refactor:  'Refactor   ',
  question:  'Question   ',
  vague:     'Vague      ',
  other:     'Other      ',
};

const CATEGORY_ORDER: PromptCategory[] = [
  'fix', 'implement', 'explain', 'refactor', 'question', 'vague', 'other',
];

// ── Period-over-period delta helpers ──────────────────────────

const NOISE_PP = 2;   // ±2pp considered unchanged
const NOISE_PCT = 5;  // ±5% considered unchanged for cost

/**
 * Format a delta tag like "▲ +12%" or "▼ -5pp" or "→ –"
 * higherIsBetter: true for cache hit rate (up = good), false for cost/vague/correction (down = good)
 */
function deltaTag(
  value: number | null,
  unit: 'pct' | 'pp',
  higherIsBetter: boolean,
  noiseThreshold: number,
): string {
  if (value === null) return chalk.dim('→ –');
  const absVal = Math.abs(value);
  if (absVal < noiseThreshold) return chalk.dim('→ –');

  const improved = higherIsBetter ? value > 0 : value < 0;
  const sign = value > 0 ? '+' : '';
  const formatted =
    unit === 'pct'
      ? `${sign}${Math.round(value)}%`
      : `${sign}${value.toFixed(0)}pp`;

  if (improved) {
    return chalk.green(`▼ ${formatted}`);
  } else {
    return chalk.red(`▲ ${formatted}`);
  }
}

export function render(result: AnalysisResult, worstPromptData?: WorstPromptData, evalInsight?: string | null, delta?: PeriodDelta): void {
  const lines: string[] = [];

  lines.push(top());
  lines.push(line(
    chalk.bold.white('cortext') +
    chalk.dim('  ·  ') +
    chalk.white('metacognition for your claude code prompts')
  ));
  lines.push(divider());

  // Overview
  lines.push(sectionLabel('OVERVIEW'));
  const sessionsStr  = `${result.totalSessions} sessions`;
  const promptsStr   = `${result.totalPrompts} prompts`;
  const daysStr      = `${result.daysAnalyzed} days`;
  lines.push(line(chalk.dim(`${daysStr}  ·  ${sessionsStr}  ·  ${promptsStr}`)));
  lines.push(blank());

  // Build delta tags when available
  const hasDelta = delta !== undefined;
  const costTag       = hasDelta ? deltaTag(delta!.costPct !== null ? delta!.costPct * 100 : null, 'pct', false, NOISE_PCT) : '';
  const cacheTag      = hasDelta ? deltaTag(delta!.cacheHitRatePp, 'pp', true, NOISE_PP) : '';
  const wordsTag      = hasDelta ? deltaTag(delta!.medianWordsDelta, 'pp', true, 2) : '';

  // Render overview metrics with optional delta tags inline
  const costLabel  = 'API equiv. cost:';
  const cacheLabel = 'Cache hit rate:';

  if (hasDelta) {
    // Each metric on its own line with delta tag
    lines.push(line(`${costLabel.padEnd(18)}${formatCost(result.totalCost).padEnd(10)}${costTag}`));
    lines.push(line(`${cacheLabel.padEnd(18)}${pct(result.cacheHitRate).padEnd(10)}${cacheTag}`));
    lines.push(line(`${'Median prompt len:'.padEnd(18)}${(Math.round(result.avgPromptWords) + ' words').padEnd(10)}${wordsTag}`));
  } else {
    lines.push(line(`${costLabel.padEnd(16)}${formatCost(result.totalCost).padEnd(14)}${cacheLabel.padEnd(17)}${pct(result.cacheHitRate)}`));
  }

  const inputLabel  = 'Input tokens:';
  const outputLabel = 'Output tokens:';
  lines.push(line(`${inputLabel.padEnd(16)}${formatToken(result.totalInputTokens).padEnd(14)}${outputLabel.padEnd(17)}${formatToken(result.totalOutputTokens)}`));

  lines.push(divider());

  // Daily usage
  if (result.dailyUsage.length > 0) {
    lines.push(sectionLabel('DAILY USAGE  (last ' + result.daysAnalyzed + ' days)'));

    const recent = result.dailyUsage.slice(-14);
    const maxCost = Math.max(...recent.map(d => d.cost), 0.001);
    const BAR_W = 18;

    for (const day of recent) {
      if (day.cost === 0 && day.outputTokens === 0) continue;
      const dateStr = formatDate(day.date);
      const b = bar(day.cost / maxCost, BAR_W);
      const costStr = formatCost(day.cost).padStart(7);
      const tokStr = formatToken(day.outputTokens).padStart(5);
      lines.push(line(`${dateStr}  ${b}  ${tokStr} out  ${costStr}`));
    }
    lines.push(divider());
  }

  // Prompt patterns
  if (result.totalPrompts > 0) {
    lines.push(sectionLabel('PROMPT PATTERNS'));

    const BAR_W = 16;
    for (const cat of CATEGORY_ORDER) {
      const count = result.promptCategories[cat];
      if (count === 0) continue;
      const fraction = count / result.totalPrompts;
      const label = CATEGORY_LABELS[cat];
      const b = bar(fraction, BAR_W);
      const pctStr = pct(fraction).padStart(4);
      const countStr = `(${count})`.padStart(6);
      lines.push(line(`${label}  ${b}  ${pctStr}  ${countStr}`));
    }
    lines.push(divider());
  }

  // Efficiency signals
  lines.push(sectionLabel('EFFICIENCY SIGNALS'));

  const avgWords = Math.round(result.avgPromptWords);
  lines.push(line(`Median prompt length:  ${chalk.white(avgWords + ' words')}`));
  lines.push(line(`Correction rate:    ${chalk.white(pct(result.correctionRate) + ' of sessions')}`));

  const slashTotal = Object.values(result.slashCommands).reduce((a, b) => a + b, 0);
  if (slashTotal > 0) {
    const KEY_CMDS = ['/clear', '/plan', '/compact', '/rewind'];
    const keyCounts = KEY_CMDS
      .map(cmd => ({ cmd, n: result.slashCommands[cmd] ?? 0 }))
      .filter(x => x.n > 0)
      .map(x => `${x.cmd} ×${x.n}`)
      .join('  ');
    const breakdown = keyCounts ? chalk.dim(`  (${keyCounts})`) : '';
    lines.push(line(`Slash commands:     ${chalk.white(String(slashTotal))}${breakdown}`));
  }

  const actionableTotal = (result.promptCategories.implement ?? 0) + (result.promptCategories.fix ?? 0);
  if (actionableTotal > 0) {
    const verifiedCount = Math.round(result.verificationRate * actionableTotal);
    lines.push(line(`Verification rate:  ${chalk.white(pct(result.verificationRate))} of implement/fix prompts  ${chalk.dim(`(${verifiedCount}/${actionableTotal})`)}`));
  }
  lines.push(blank());

  const vagueCount = result.promptCategories.vague;
  const correctedSessions = Math.round(result.correctionRate * result.totalSessions);

  if (vagueCount > 0) {
    lines.push(line(chalk.yellow(`[!] ${vagueCount} prompt${vagueCount !== 1 ? 's' : ''} may be too vague — no file path, code reference, or expected outcome`)));
  }
  if (correctedSessions > 0) {
    lines.push(line(chalk.yellow(`[!] ${correctedSessions} session${correctedSessions !== 1 ? 's' : ''} had correction turns`)));
  }
  if (actionableTotal >= 5 && result.verificationRate < 0.2) {
    lines.push(line(chalk.yellow(`[!] Only ${pct(result.verificationRate)} of implement/fix prompts include verification`)));
  } else if (actionableTotal >= 5 && result.verificationRate >= 0.5) {
    lines.push(line(chalk.green(`[✓] Verification criteria in ${pct(result.verificationRate)} of implement/fix prompts`)));
  }
  const clearCount = result.slashCommands['/clear'] ?? 0;
  if (clearCount > 0 && result.totalSessions > 0) {
    const clearPerSession = clearCount / result.totalSessions;
    if (clearPerSession >= 0.3) {
      lines.push(line(chalk.green(`[✓] Using /clear regularly (${clearCount}× across ${result.totalSessions} sessions)`)));
    }
  }
  if (result.cacheHitRate >= 0.8) {
    lines.push(line(chalk.green(`[✓] Excellent cache hit rate (${pct(result.cacheHitRate)})`)));
  } else if (result.cacheHitRate >= 0.5) {
    lines.push(line(chalk.yellow(`[~] Moderate cache hit rate (${pct(result.cacheHitRate)})`)));
  } else if (result.cacheHitRate > 0) {
    lines.push(line(chalk.red(`[!] Low cache hit rate (${pct(result.cacheHitRate)}) — short sessions`)));
  }
  if (avgWords >= 25) {
    lines.push(line(chalk.green(`[✓] Prompts are detailed on average (${avgWords} words)`)));
  }

  // Top projects by cost
  if (result.projectStats.length > 1) {
    lines.push(divider());
    lines.push(sectionLabel('TOP PROJECTS BY API COST'));

    const maxProjectCost = Math.max(...result.projectStats.map(p => p.cost), 0.001);
    const BAR_W = 20;
    for (const ps of result.projectStats.slice(0, 6)) {
      if (ps.cost === 0) continue;
      const nameStr = ps.name.slice(0, 14).padEnd(14);
      const costStr = formatCost(ps.cost).padStart(7);
      const b = bar(ps.cost / maxProjectCost, BAR_W);
      lines.push(line(`${nameStr}  ${costStr}  ${b}`));
    }
  }

  // Worst prompt rewrite section
  if (worstPromptData) {
    const { prompt, rewrite, heuristic } = worstPromptData;
    lines.push(divider());
    lines.push(sectionLabel('WORST PROMPT THIS WEEK'));
    lines.push(blank());

    const ts = prompt.timestamp.toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
    lines.push(line(chalk.dim(`${ts}  ·  ${prompt.projectName}`)));
    lines.push(blank());

    if (prompt.contextBefore) {
      lines.push(line(chalk.dim('Claude:')));
      for (const l of wrapText(prompt.contextBefore, INNER - 4)) {
        lines.push(line('  ' + chalk.dim(l)));
      }
      lines.push(blank());
    }

    lines.push(line(chalk.dim('You:')));
    for (const l of wrapText('"' + prompt.text + '"', INNER - 4)) {
      lines.push(line('  ' + chalk.white(l)));
    }
    lines.push(blank());

    if (prompt.contextAfter) {
      const afterLabel = prompt.followedByCorrection ? 'You (correction):' : 'Claude:';
      lines.push(line(chalk.dim(afterLabel)));
      for (const l of wrapText(prompt.contextAfter, INNER - 4)) {
        lines.push(line('  ' + chalk.dim(l)));
      }
      lines.push(blank());
    }

    if (rewrite) {
      lines.push(line(chalk.dim('Why it failed:')));
      for (const l of wrapText(rewrite.diagnosis, INNER - 4)) {
        lines.push(line('  ' + chalk.yellow(l)));
      }
      lines.push(blank());
      lines.push(line(chalk.dim('How it should read:')));
      for (const l of wrapText(rewrite.rewrite, INNER - 4)) {
        lines.push(line('  ' + chalk.cyan(l)));
      }
    } else {
      lines.push(line(chalk.dim('Why it failed:')));
      for (const l of wrapText(heuristic, INNER - 4)) {
        lines.push(line('  ' + chalk.yellow(l)));
      }
      lines.push(blank());
      lines.push(line(chalk.dim('Set ANTHROPIC_API_KEY to get an AI-powered rewrite.')));
    }
  }

  // "Did you read my response?" section
  if (result.unreadMoments && result.unreadMoments.length > 0) {
    lines.push(divider());
    lines.push(sectionLabel('DID YOU READ MY RESPONSE?'));
    lines.push(blank());

    for (let i = 0; i < result.unreadMoments.length; i++) {
      const moment = result.unreadMoments[i];
      if (i > 0) {
        lines.push(blank());
        lines.push(line(chalk.dim('·'.repeat(INNER))));
        lines.push(blank());
      }

      const ts = moment.timestamp.toLocaleString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit',
      });
      lines.push(line(chalk.dim(`${ts}  ·  ${moment.projectName}`)));
      lines.push(blank());

      lines.push(line(chalk.dim('Claude:')));
      for (const l of wrapText(moment.claudeText, INNER - 4)) {
        lines.push(line('  ' + chalk.dim(l)));
      }
      lines.push(blank());

      lines.push(line(chalk.dim('You:')));
      for (const l of wrapText('"' + moment.userFollowUp + '"', INNER - 4)) {
        lines.push(line('  ' + chalk.white(l)));
      }
      lines.push(blank());

      const callout = moment.aiCallout ?? 'This was already covered in my response above.';
      for (const l of wrapText(callout, INNER - 4)) {
        lines.push(line('  ' + chalk.red(l)));
      }
    }
  }

  // Session metrics
  if (result.medianOutputRatio !== null) {
    lines.push(divider());
    lines.push(sectionLabel('SESSION METRICS'));
    lines.push(line(`Median output ratio: ${result.medianOutputRatio.toFixed(2)} (write+edit share)`));

    const { specific, vague, nSpecific, nVague, nTotal } = result.outputRatioByBucket;

    if (specific !== null && vague !== null) {
      lines.push(blank());
      const diff = specific - vague;
      const diffStr = (diff >= 0 ? '+' : '') + diff.toFixed(2);
      lines.push(line(`Prompt specificity vs output (diff: ${diffStr}):`));
      const BAR_W = 12;
      const maxVal = Math.max(specific, vague, 0.001);
      lines.push(line(`  Specific (vague<3):  ${bar(specific / maxVal, BAR_W)} ${specific.toFixed(2)}`));
      lines.push(line(`  Vague    (vague>=3): ${bar(vague / maxVal, BAR_W)} ${vague.toFixed(2)}`));
    } else {
      lines.push(blank());
      lines.push(line(`  Specific (vague<3):  ${chalk.dim('—')}`));
      lines.push(line(`  Vague    (vague>=3): ${chalk.dim('—')}`));
    }

    lines.push(blank());
    lines.push(line(`N=${nTotal} sessions scored  (${nSpecific} specific / ${nVague} vague)`));
  }

  lines.push(divider());
  if (evalInsight) {
    lines.push(line(chalk.dim(evalInsight)));
    lines.push(blank());
  }
  lines.push(line(chalk.dim('Run  ') + chalk.white('npx cortext --analyze') + chalk.dim('  for AI prompt improvement')));
  lines.push(line(chalk.dim('Run  ') + chalk.white('npx cortext goal') + chalk.dim('       to set a coaching goal')));
  lines.push(bottom());

  console.log(lines.join('\n'));
}

export function renderAnalysisHeader(): void {
  console.log('');
  console.log(chalk.dim('╔' + '═'.repeat(WIDTH - 2) + '╗'));
  console.log(line(chalk.bold.magenta('AI PROMPT ANALYSIS') + chalk.dim('  ·  powered by claude-sonnet-4-6')));
  console.log(divider());
}

export function renderAnalysisEntry(index: number, original: string, diagnosis: string, rewritten: string): void {
  const idxStr = chalk.dim(`#${index}`);
  const origTrunc = original.length > 55 ? original.slice(0, 52) + '...' : original;
  console.log(line(`${idxStr}  ${chalk.white('"' + origTrunc + '"')}`));
  console.log(blank());

  const diagLines = wrapText(diagnosis, INNER - 4);
  console.log(line(chalk.dim('What\'s missing:')));
  for (const dl of diagLines) {
    console.log(line('  ' + chalk.gray(dl)));
  }
  console.log(blank());

  const rewriteLines = wrapText(rewritten, INNER - 4);
  console.log(line(chalk.dim('Better version:')));
  for (const rl of rewriteLines) {
    console.log(line('  ' + chalk.cyan(rl)));
  }
  console.log(divider());
}

export function renderAnalysisFooter(): void {
  console.log(line(chalk.dim('Tip: ') + chalk.white('Specificity = fewer correction turns, lower API cost')));
  console.log(chalk.dim('╚' + '═'.repeat(WIDTH - 2) + '╝'));
}

function wrapText(text: string, maxWidth: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if (current.length + word.length + 1 > maxWidth) {
      if (current) lines.push(current);
      current = word;
    } else {
      current = current ? current + ' ' + word : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function formatDate(dateStr: string): string {
  const [, month, day] = dateStr.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[parseInt(month) - 1]} ${day}`;
}

// ── Coaching report renderer ───────────────────────────────────

function gradeColor(grade: string): (s: string) => string {
  const letter = grade[0]?.toUpperCase() ?? 'C';
  if (letter === 'A') return chalk.green.bold;
  if (letter === 'B') return chalk.cyan.bold;
  if (letter === 'C') return chalk.yellow.bold;
  return chalk.red.bold;
}

function scoreBar(score: number): string {
  const filled = Math.round((score / 10) * 10);
  const empty = 10 - filled;
  let color: (s: string) => string;
  if (score >= 7) color = chalk.green;
  else if (score >= 4) color = chalk.yellow;
  else color = chalk.red;
  return color('█'.repeat(filled)) + chalk.dim('░'.repeat(empty));
}

export function renderCoachReport(report: CoachReport, goal: Goal, days: number): void {
  const out: string[] = [];

  out.push('');
  out.push(chalk.dim('╔' + '═'.repeat(WIDTH - 2) + '╗'));
  out.push(line(
    chalk.bold.magenta('COACHING REPORT') +
    chalk.dim('  ·  ') +
    chalk.white(goal.label) +
    chalk.dim(`  ·  last ${days} days`)
  ));
  out.push(divider());

  // Grade
  const coloredGrade = gradeColor(report.grade)(report.grade);
  out.push(line(chalk.bold('OVERALL GRADE: ') + coloredGrade));
  for (const l of wrapText(report.gradeReason, INNER - 2)) {
    out.push(line(chalk.dim('  ' + l)));
  }
  out.push(blank());
  out.push(divider());

  // Signal scores
  out.push(line(chalk.bold.cyan('SIGNAL SCORES') + chalk.dim(`  (vs. ${goal.label} rubric)`)));
  out.push(blank());

  const signals: Array<[string, keyof CoachReport['signalScores']]> = [
    ['Specificity  ', 'specificity'],
    ['Ownership    ', 'ownership'],
    ['Tool diversity', 'toolDiversity'],
    ['Front-loading', 'frontloading'],
    ['Efficiency   ', 'efficiency'],
    ['Ctx mgmt     ', 'contextManagement'],
    ['Verification ', 'verificationHabit'],
  ];

  for (const [label, key] of signals) {
    const signalData = report.signalScores[key];
    if (!signalData) continue;
    const { score, note } = signalData;
    const b = scoreBar(score);
    const scoreStr = `${score}/10`;
    out.push(line(`${chalk.dim(label)}  ${b}  ${scoreStr.padStart(4)}`));
    for (const l of wrapText(note, INNER - 4)) {
      out.push(line(chalk.dim('    ' + l)));
    }
  }

  out.push(divider());

  // Worst moments
  if (report.worstMoments.length > 0) {
    out.push(line(chalk.bold.cyan('THE MOMENTS YOU FELL SHORT')));
    out.push(blank());
    for (let i = 0; i < report.worstMoments.length; i++) {
      const { original, diagnosis, better } = report.worstMoments[i];
      const origTrunc = original.length > INNER - 6 ? original.slice(0, INNER - 9) + '...' : original;
      out.push(line(chalk.dim(`#${i + 1}`) + '  ' + chalk.white(`"${origTrunc}"`)));
      for (const l of wrapText(diagnosis, INNER - 4)) {
        out.push(line('    ' + chalk.yellow(l)));
      }
      out.push(line(chalk.dim('    Better:')));
      for (const l of wrapText(better, INNER - 6)) {
        out.push(line('      ' + chalk.cyan(l)));
      }
      if (i < report.worstMoments.length - 1) out.push(blank());
    }
    out.push(divider());
  }

  // What's working
  out.push(line(chalk.bold.cyan("WHAT'S WORKING")));
  for (const l of wrapText(report.whatIsWorking, INNER - 2)) {
    out.push(line('  ' + chalk.white(l)));
  }
  out.push(divider());

  // Honest gap
  out.push(line(chalk.bold.red('THE HONEST GAP')));
  for (const l of wrapText(report.honestGap, INNER - 2)) {
    out.push(line('  ' + chalk.white(l)));
  }

  out.push(chalk.dim('╚' + '═'.repeat(WIDTH - 2) + '╝'));
  out.push('');

  console.log(out.join('\n'));
}

export function renderGoalStatus(goal: Goal | null): void {
  console.log('');
  if (!goal) {
    console.log(chalk.dim('No active goal. Run ') + chalk.white('npx cortext goal') + chalk.dim(' to set one.'));
  } else {
    console.log(chalk.dim('Active goal: ') + chalk.white.bold(goal.label) + chalk.dim(` (set ${goal.createdAt})`));
    if (goal.customization) {
      console.log(chalk.dim('  "' + goal.customization + '"'));
    }
    console.log(chalk.dim('Run ') + chalk.white('npx cortext review') + chalk.dim(' to get your coaching report.'));
  }
  console.log('');
}
