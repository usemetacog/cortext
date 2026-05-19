import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const EVAL_LOG_PATH = path.join(os.homedir(), '.cortext', 'eval-log.jsonl');

const MIN_DAYS = 3;
const MAX_DAYS = 21;
const MIN_OUTCOMES_FOR_INSIGHT = 5;
const NOISE_THRESHOLD = 0.05;

export interface RewriteShownEvent {
  t: string;
  type: 'rewrite_shown';
  promptHash: string;
  vagueScore: number;
  followedByCorrection: boolean;
  correctionRateSnapshot: number;
  vagueRateSnapshot: number;
}

export interface OutcomeCheckEvent {
  t: string;
  type: 'outcome_check';
  forHash: string;
  daysElapsed: number;
  correctionRateDelta: number;
  vagueRateDelta: number;
}

export type EvalEvent = RewriteShownEvent | OutcomeCheckEvent;

function appendEvent(event: EvalEvent): void {
  try {
    fs.mkdirSync(path.dirname(EVAL_LOG_PATH), { recursive: true });
    fs.appendFileSync(EVAL_LOG_PATH, JSON.stringify(event) + '\n');
  } catch {
    // non-fatal
  }
}

function loadEvents(): EvalEvent[] {
  try {
    return fs.readFileSync(EVAL_LOG_PATH, 'utf8')
      .split('\n')
      .filter(l => l.trim())
      .map(l => JSON.parse(l) as EvalEvent);
  } catch {
    return [];
  }
}

// exported for testing
export function filterPendingShownEvents(events: EvalEvent[], now: number): RewriteShownEvent[] {
  const checkedHashes = new Set(
    events
      .filter((e): e is OutcomeCheckEvent => e.type === 'outcome_check')
      .map(e => e.forHash)
  );

  return events.filter((e): e is RewriteShownEvent => {
    if (e.type !== 'rewrite_shown') return false;
    if (checkedHashes.has(e.promptHash)) return false;
    const ageDays = (now - new Date(e.t).getTime()) / 86_400_000;
    return ageDays >= MIN_DAYS && ageDays <= MAX_DAYS;
  });
}

// exported for testing
export function computeInsightFromOutcomes(outcomes: OutcomeCheckEvent[]): string | null {
  if (outcomes.length < MIN_OUTCOMES_FOR_INSIGHT) return null;
  const avg = outcomes.reduce((sum, e) => sum + e.correctionRateDelta, 0) / outcomes.length;
  if (Math.abs(avg) < NOISE_THRESHOLD) return null;
  const direction = avg < 0 ? 'improved' : 'worsened';
  const pct = Math.abs(avg * 100).toFixed(0);
  return `Eval: correction rate ${direction} ${pct}% after rewrites (n=${outcomes.length})`;
}

export function logRewriteShown(
  promptHash: string,
  vagueScore: number,
  followedByCorrection: boolean,
  correctionRate: number,
  vagueRate: number,
): void {
  appendEvent({
    t: new Date().toISOString(),
    type: 'rewrite_shown',
    promptHash,
    vagueScore,
    followedByCorrection,
    correctionRateSnapshot: correctionRate,
    vagueRateSnapshot: vagueRate,
  });
}

export function checkAndLogOutcomes(
  currentCorrectionRate: number,
  currentVagueRate: number,
): OutcomeCheckEvent[] {
  const events = loadEvents();
  const now = Date.now();
  const pending = filterPendingShownEvents(events, now);

  const outcomes: OutcomeCheckEvent[] = pending.map(shown => ({
    t: new Date().toISOString(),
    type: 'outcome_check' as const,
    forHash: shown.promptHash,
    daysElapsed: Math.round((now - new Date(shown.t).getTime()) / 86_400_000),
    correctionRateDelta: currentCorrectionRate - shown.correctionRateSnapshot,
    vagueRateDelta: currentVagueRate - shown.vagueRateSnapshot,
  }));

  for (const outcome of outcomes) appendEvent(outcome);
  return outcomes;
}

export function loadOutcomeInsight(): string | null {
  const events = loadEvents();
  const outcomes = events.filter((e): e is OutcomeCheckEvent => e.type === 'outcome_check');
  return computeInsightFromOutcomes(outcomes);
}
