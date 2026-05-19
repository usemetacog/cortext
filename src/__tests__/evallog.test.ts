import { describe, it, expect } from 'vitest';
import {
  filterPendingShownEvents,
  computeInsightFromOutcomes,
} from '../evallog';
import type { EvalEvent, OutcomeCheckEvent, RewriteShownEvent } from '../evallog';

const DAY_MS = 86_400_000;

function makeShown(overrides: Partial<RewriteShownEvent> = {}): RewriteShownEvent {
  return {
    t: new Date().toISOString(),
    type: 'rewrite_shown',
    promptHash: 'abc123',
    vagueScore: 4,
    followedByCorrection: true,
    correctionRateSnapshot: 0.4,
    vagueRateSnapshot: 0.2,
    ...overrides,
  };
}

function makeOutcome(forHash: string, delta = -0.1): OutcomeCheckEvent {
  return {
    t: new Date().toISOString(),
    type: 'outcome_check',
    forHash,
    daysElapsed: 5,
    correctionRateDelta: delta,
    vagueRateDelta: -0.05,
  };
}

describe('filterPendingShownEvents', () => {
  it('excludes events less than 3 days old', () => {
    const now = Date.now();
    const recent = makeShown({ t: new Date(now - 1 * DAY_MS).toISOString() });
    expect(filterPendingShownEvents([recent], now)).toHaveLength(0);
  });

  it('includes events between 3 and 21 days old', () => {
    const now = Date.now();
    const valid = makeShown({ t: new Date(now - 7 * DAY_MS).toISOString() });
    expect(filterPendingShownEvents([valid], now)).toHaveLength(1);
  });

  it('excludes events older than 21 days', () => {
    const now = Date.now();
    const stale = makeShown({ t: new Date(now - 25 * DAY_MS).toISOString() });
    expect(filterPendingShownEvents([stale], now)).toHaveLength(0);
  });

  it('excludes shown events that already have a matching outcome_check', () => {
    const now = Date.now();
    const shown = makeShown({ promptHash: 'xyz', t: new Date(now - 7 * DAY_MS).toISOString() });
    const outcome = makeOutcome('xyz');
    const events: EvalEvent[] = [shown, outcome];
    expect(filterPendingShownEvents(events, now)).toHaveLength(0);
  });

  it('does not exclude a shown event when outcome is for a different hash', () => {
    const now = Date.now();
    const shown = makeShown({ promptHash: 'aaa', t: new Date(now - 7 * DAY_MS).toISOString() });
    const outcome = makeOutcome('bbb');
    const events: EvalEvent[] = [shown, outcome];
    expect(filterPendingShownEvents(events, now)).toHaveLength(1);
  });
});

describe('computeInsightFromOutcomes', () => {
  it('returns null when fewer than 5 outcomes', () => {
    const outcomes = Array.from({ length: 4 }, () => makeOutcome('h', -0.2));
    expect(computeInsightFromOutcomes(outcomes)).toBeNull();
  });

  it('returns null when average delta is below noise threshold', () => {
    const outcomes = Array.from({ length: 6 }, () => makeOutcome('h', -0.02));
    expect(computeInsightFromOutcomes(outcomes)).toBeNull();
  });

  it('returns improved message when correction rate dropped significantly', () => {
    const outcomes = Array.from({ length: 6 }, () => makeOutcome('h', -0.2));
    const result = computeInsightFromOutcomes(outcomes);
    expect(result).toMatch(/improved/);
    expect(result).toMatch(/n=6/);
  });

  it('returns worsened message when correction rate rose significantly', () => {
    const outcomes = Array.from({ length: 6 }, () => makeOutcome('h', 0.15));
    const result = computeInsightFromOutcomes(outcomes);
    expect(result).toMatch(/worsened/);
  });
});
