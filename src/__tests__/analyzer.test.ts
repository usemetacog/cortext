import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { classifyPrompt, vagueScore, computeCost, analyze, hasVerificationCriteria } from '../analyzer';
import type { ProjectData } from '../reader';

// ── classifyPrompt ────────────────────────────────────────────────

describe('classifyPrompt', () => {
  it('classifies fix prompts', () => {
    expect(classifyPrompt('fix the login bug in auth.ts')).toBe('fix');
    expect(classifyPrompt('the app is broken and crashing on startup')).toBe('fix');
  });

  it('classifies implement prompts', () => {
    expect(classifyPrompt('add OAuth support to the user service')).toBe('implement');
    expect(classifyPrompt('create a new endpoint for password reset')).toBe('implement');
  });

  it('classifies explain prompts', () => {
    expect(classifyPrompt('explain how the cache invalidation works')).toBe('explain');
    expect(classifyPrompt('what does the retry logic do here')).toBe('explain');
  });

  it('classifies refactor prompts', () => {
    expect(classifyPrompt('refactor the data access layer to use the repository pattern')).toBe('refactor');
    expect(classifyPrompt('clean up the duplicated code in the middleware')).toBe('refactor');
  });

  it('classifies question prompts by trailing ?', () => {
    expect(classifyPrompt('is this the right approach for rate limiting?')).toBe('question');
  });

  it('classifies short ambiguous prompts as vague', () => {
    expect(classifyPrompt('do this')).toBe('vague');
    expect(classifyPrompt('make it work')).toBe('vague');
  });

  it('does not classify short prompts with a concrete anchor as vague', () => {
    expect(classifyPrompt('fix auth.ts')).toBe('fix');
    expect(classifyPrompt('add `getUserById`')).toBe('implement');
    expect(classifyPrompt('refactor src/db.ts')).toBe('refactor');
  });

  it('still classifies short prompts without a concrete anchor as vague', () => {
    expect(classifyPrompt('make it work')).toBe('vague');
    expect(classifyPrompt('do this')).toBe('vague');
    expect(classifyPrompt('add login')).toBe('vague');
  });

  it('classifies direct answers to assistant questions as other, not vague', () => {
    expect(classifyPrompt('yes', 'Should I proceed with the refactor?')).toBe('other');
    expect(classifyPrompt('usage', 'Is it usage based or per seat?')).toBe('other');
    expect(classifyPrompt('do this', 'Which approach do you want?')).toBe('other');
  });

  it('classifies skill/command names typed without a slash as other', () => {
    expect(classifyPrompt('review')).toBe('other');
    expect(classifyPrompt('browse')).toBe('other');
    expect(classifyPrompt('cortext')).toBe('other');
    expect(classifyPrompt('verify')).toBe('other');
  });

  it('classifies near-miss command names as other', () => {
    expect(classifyPrompt('reviw')).toBe('other');   // edit distance 1 from "review"
    expect(classifyPrompt('browsse')).toBe('other'); // edit distance 1 from "browse"
  });

  it('classifies garbled single-word prompts as other', () => {
    expect(classifyPrompt('asdfjkl')).toBe('other');   // no vowels
    expect(classifyPrompt('sdfghjkl')).toBe('other');  // consecutive consonants
  });

  it('does not flag short acronyms or real words as garbled', () => {
    expect(classifyPrompt('HTML')).not.toBe('other'); // all-caps acronym
    expect(classifyPrompt('byte')).not.toBe('other'); // real word
  });

  it('classifies short conversational replies as other', () => {
    expect(classifyPrompt('ok')).toBe('other');
    expect(classifyPrompt('sounds good')).toBe('other');
    expect(classifyPrompt('looks good')).toBe('other');
  });

  it('classifies long messages by content, falling back to implement', () => {
    const longFix = 'fix ' + 'word '.repeat(200);
    expect(classifyPrompt(longFix)).toBe('fix');

    const longNoKeyword = 'word '.repeat(201);
    expect(classifyPrompt(longNoKeyword)).toBe('implement');
  });
});

// ── vagueScore ────────────────────────────────────────────────────

describe('vagueScore', () => {
  it('scores very short prompts (< 5 words) high', () => {
    // "do it" is conversational (returns 0); use a non-conversational short prompt
    expect(vagueScore('update the component')).toBeGreaterThanOrEqual(4);
  });

  it('scores short prompts (5–9 words) medium', () => {
    const score = vagueScore('please update the user settings page');
    expect(score).toBeGreaterThanOrEqual(2);
  });

  it('lowers score when a file path is present', () => {
    const withPath = vagueScore('update src/auth/login.ts to fix the issue');
    const withoutPath = vagueScore('update the file to fix the issue');
    expect(withPath).toBeLessThan(withoutPath);
  });

  it('lowers score when inline code is present', () => {
    const withCode = vagueScore('the `getUserById` function returns null unexpectedly');
    const withoutCode = vagueScore('the function returns null unexpectedly');
    expect(withCode).toBeLessThan(withoutCode);
  });

  it('lowers score when expected outcome is described', () => {
    // same word count and structure, only difference is presence of "should"
    const withOutcome = vagueScore('the button should submit the form but nothing happens when user clicks');
    const withoutOutcome = vagueScore('the button fails to submit the form and nothing happens when clicking');
    expect(withOutcome).toBeLessThan(withoutOutcome);
  });

  it('returns 0 for conversational replies', () => {
    expect(vagueScore('ok')).toBe(0);
    expect(vagueScore('sounds good')).toBe(0);
  });

  it('returns 0 for long messages', () => {
    expect(vagueScore('word '.repeat(201))).toBe(0);
  });

  it('returns 0 when prior assistant turn asked a question', () => {
    expect(vagueScore('yes', { turnIndex: 1, priorUserWords: 5, priorAssistantText: 'Do you want usage-based or per-seat pricing?' })).toBe(0);
    expect(vagueScore('usage', { turnIndex: 1, priorUserWords: 5, priorAssistantText: 'Is it usage based or per seat?' })).toBe(0);
    expect(vagueScore('no', { turnIndex: 1, priorUserWords: 5, priorAssistantText: 'Should I proceed with the refactor?' })).toBe(0);
  });

  it('still scores vague when prior assistant turn was not a question', () => {
    expect(vagueScore('update the component', { turnIndex: 1, priorUserWords: 5, priorAssistantText: 'Here is the updated file.' })).toBeGreaterThan(0);
  });
});

// ── hasVerificationCriteria ───────────────────────────────────────

describe('hasVerificationCriteria', () => {
  it('detects "run tests"', () => {
    expect(hasVerificationCriteria('add OAuth to src/auth.ts and run tests')).toBe(true);
    expect(hasVerificationCriteria('add OAuth to src/auth.ts and run the tests')).toBe(true);
    expect(hasVerificationCriteria('add OAuth to src/auth.ts and run all tests')).toBe(true);
  });

  it('detects "verify" and "check that/it/the"', () => {
    expect(hasVerificationCriteria('fix the login bug then verify it works')).toBe(true);
    expect(hasVerificationCriteria('implement the endpoint and check that it returns 200')).toBe(true);
    expect(hasVerificationCriteria('build the feature and check the output')).toBe(true);
  });

  it('detects "screenshot", "expected output", "failing test", "make sure"', () => {
    expect(hasVerificationCriteria('implement this design and take a screenshot')).toBe(true);
    expect(hasVerificationCriteria('fix the function so expected output matches')).toBe(true);
    expect(hasVerificationCriteria('write a failing test then fix it')).toBe(true);
    expect(hasVerificationCriteria('add the feature and make sure it works')).toBe(true);
  });

  it('does not flag outcome words that are not verification clauses', () => {
    expect(hasVerificationCriteria('the button should submit the form')).toBe(false);
    expect(hasVerificationCriteria('it needs to return null instead of throwing')).toBe(false);
    expect(hasVerificationCriteria('add a retry mechanism to the API client')).toBe(false);
  });
});

// ── computeCost ───────────────────────────────────────────────────

describe('computeCost', () => {
  const zeroUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

  it('returns 0 for zero usage', () => {
    expect(computeCost('claude-sonnet-4-6', zeroUsage)).toBe(0);
  });

  it('correctly prices opus input tokens ($15/M)', () => {
    const cost = computeCost('claude-opus-4-7', { ...zeroUsage, input_tokens: 1_000_000 });
    expect(cost).toBeCloseTo(15);
  });

  it('correctly prices sonnet output tokens ($15/M)', () => {
    const cost = computeCost('claude-sonnet-4-6', { ...zeroUsage, output_tokens: 1_000_000 });
    expect(cost).toBeCloseTo(15);
  });

  it('correctly prices haiku input tokens ($0.80/M)', () => {
    const cost = computeCost('claude-haiku-4-5', { ...zeroUsage, input_tokens: 1_000_000 });
    expect(cost).toBeCloseTo(0.8);
  });

  it('falls back to sonnet pricing for unknown models', () => {
    const unknown = computeCost('claude-unknown-model', { ...zeroUsage, input_tokens: 1_000_000 });
    const sonnet = computeCost('claude-sonnet-4-6', { ...zeroUsage, input_tokens: 1_000_000 });
    expect(unknown).toBe(sonnet);
  });

  it('accounts for cache read and cache creation tokens', () => {
    const cost = computeCost('claude-sonnet-4-6', {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(0.30 + 3.75);
  });
});

// ── analyze (integration) ─────────────────────────────────────────

function makeEntry(
  type: 'user' | 'assistant',
  sessionId: string,
  content: string,
  usage?: { input_tokens: number; output_tokens: number },
  timestamp?: string,
): ReturnType<() => ProjectData['entries'][number]> {
  const ts = timestamp ?? new Date().toISOString();
  if (type === 'user') {
    return { type, sessionId, timestamp: ts, message: { content } };
  }
  return {
    type,
    sessionId,
    timestamp: ts,
    message: {
      model: 'claude-sonnet-4-6',
      usage: {
        input_tokens: usage?.input_tokens ?? 100,
        output_tokens: usage?.output_tokens ?? 50,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  };
}

function makeAssistantWithTools(
  sessionId: string,
  toolNames: string[],
  timestamp?: string,
): ProjectData['entries'][number] {
  const ts = timestamp ?? new Date().toISOString();
  return {
    type: 'assistant',
    sessionId,
    timestamp: ts,
    message: {
      model: 'claude-sonnet-4-6',
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      content: toolNames.map(name => ({ type: 'tool_use', name })),
    },
  };
}

describe('analyze', () => {
  it('returns zeroed result for empty projects', () => {
    const result = analyze([], 30);
    expect(result.totalSessions).toBe(0);
    expect(result.totalPrompts).toBe(0);
    expect(result.totalCost).toBe(0);
    expect(result.worstPrompts).toHaveLength(0);
  });

  it('counts sessions and prompts correctly', () => {
    const project: ProjectData = {
      name: 'test',
      dir: '',
      entries: [
        makeEntry('user', 's1', 'fix the login bug in auth.ts so it stops throwing 401'),
        makeEntry('assistant', 's1', ''),
        makeEntry('user', 's1', 'add a retry mechanism to the API client in src/client.ts'),
        makeEntry('assistant', 's1', ''),
      ],
    };
    const result = analyze([project], 30);
    expect(result.totalSessions).toBe(1);
    expect(result.totalPrompts).toBe(2);
  });

  it('sums token usage from assistant entries', () => {
    const project: ProjectData = {
      name: 'test',
      dir: '',
      entries: [
        makeEntry('user', 's1', 'explain the retry logic'),
        makeEntry('assistant', 's1', '', { input_tokens: 1000, output_tokens: 500 }),
      ],
    };
    const result = analyze([project], 30);
    expect(result.totalInputTokens).toBe(1000);
    expect(result.totalOutputTokens).toBe(500);
  });

  it('computes verificationRate only over implement+fix prompts', () => {
    const project: ProjectData = {
      name: 'test',
      dir: '',
      entries: [
        // implement with verification → counts
        makeEntry('user', 's1', 'add OAuth to src/auth.ts and run the tests'),
        makeEntry('assistant', 's1', ''),
        // implement without verification → counts, no flag
        makeEntry('user', 's1', 'add a retry mechanism to the API client in src/client.ts'),
        makeEntry('assistant', 's1', ''),
        // fix with verification → counts
        makeEntry('user', 's1', 'fix the login bug in src/auth.ts and verify it returns 200'),
        makeEntry('assistant', 's1', ''),
        // explain — not actionable, excluded from rate
        makeEntry('user', 's1', 'explain how the cache invalidation works'),
        makeEntry('assistant', 's1', ''),
      ],
    };
    const result = analyze([project], 30);
    // 3 actionable prompts (2 implement + 1 fix), 2 have verification
    expect(result.verificationRate).toBeCloseTo(2 / 3);
  });

  it('detects correction turns', () => {
    const project: ProjectData = {
      name: 'test',
      dir: '',
      entries: [
        makeEntry('user', 's1', 'update the config file'),
        makeEntry('assistant', 's1', ''),
        makeEntry('user', 's1', 'no wait, I meant the production config not staging'),
        makeEntry('assistant', 's1', ''),
      ],
    };
    const result = analyze([project], 30);
    // The first prompt should be flagged as followed by correction
    const corrected = result.worstPrompts.find(p => p.followedByCorrection);
    expect(corrected).toBeDefined();
  });

  it('includes high-vague-score prompts in worstPrompts', () => {
    const project: ProjectData = {
      name: 'test',
      dir: '',
      entries: [
        makeEntry('user', 's1', 'fix it'),
        makeEntry('assistant', 's1', ''),
      ],
    };
    const result = analyze([project], 30);
    expect(result.worstPrompts.length).toBeGreaterThan(0);
    expect(result.worstPrompts[0].vagueScore).toBeGreaterThanOrEqual(3);
  });

  it('builds slashCommands map with per-command counts', () => {
    const project: ProjectData = {
      name: 'test',
      dir: '',
      entries: [
        makeEntry('user', 's1', '/clear'),
        makeEntry('assistant', 's1', ''),
        makeEntry('user', 's1', '/clear'),
        makeEntry('assistant', 's1', ''),
        makeEntry('user', 's1', '/plan add OAuth to src/auth.ts'),
        makeEntry('assistant', 's1', ''),
        makeEntry('user', 's1', 'fix the login bug in src/auth.ts'),
        makeEntry('assistant', 's1', ''),
      ],
    };
    const result = analyze([project], 30);
    expect(result.slashCommands['/clear']).toBe(2);
    expect(result.slashCommands['/plan']).toBe(1);
    expect(result.slashCommands['/compact']).toBeUndefined();
    // non-slash prompt should not appear
    expect(Object.keys(result.slashCommands)).not.toContain('fix');
  });

  it('aggregates stats across multiple projects', () => {
    const p1: ProjectData = {
      name: 'project-a',
      dir: '',
      entries: [
        makeEntry('user', 's1', 'add login feature to src/auth.ts module here'),
        makeEntry('assistant', 's1', '', { input_tokens: 500, output_tokens: 200 }),
      ],
    };
    const p2: ProjectData = {
      name: 'project-b',
      dir: '',
      entries: [
        makeEntry('user', 's2', 'fix the crash in the payment service module'),
        makeEntry('assistant', 's2', '', { input_tokens: 300, output_tokens: 100 }),
      ],
    };
    const result = analyze([p1, p2], 30);
    expect(result.totalSessions).toBe(2);
    expect(result.totalPrompts).toBe(2);
    expect(result.totalInputTokens).toBe(800);
  });
});

// ── output ratio metrics ─────────────────────────────────────────

describe('output ratio metrics', () => {
  it('medianOutputRatio is null when no session reaches MIN_TOOL_CALLS', () => {
    const project: ProjectData = {
      name: 'test',
      dir: '',
      entries: [
        makeEntry('user', 's1', 'fix the auth bug in src/auth.ts'),
        makeAssistantWithTools('s1', ['Read', 'Bash', 'Bash']), // 3 calls < 5
      ],
    };
    const result = analyze([project], 30);
    expect(result.medianOutputRatio).toBeNull();
    expect(result.outputRatioByBucket.specific).toBeNull();
    expect(result.outputRatioByBucket.vague).toBeNull();
    expect(result.outputRatioByBucket.nTotal).toBe(0);
  });

  it('outputRatio reflects write+edit ratio when session has >= 5 tool calls', () => {
    const t = (offset: number) => new Date(Date.now() + offset * 1000).toISOString();
    const project: ProjectData = {
      name: 'test',
      dir: '',
      entries: [
        // Two sessions with 2/5 = 0.4 productive ratio each → overall median 0.4
        makeEntry('user', 's1', 'add `getUserById` to src/users.ts — should return null instead of throwing', undefined, t(0)),
        makeAssistantWithTools('s1', ['Read', 'Read', 'Read', 'Write', 'Write'], t(1)),
        makeEntry('user', 's2', 'add `getUserById` to src/users.ts — should return null instead of throwing', undefined, t(2)),
        makeAssistantWithTools('s2', ['Read', 'Read', 'Read', 'Write', 'Write'], t(3)),
      ],
    };
    const result = analyze([project], 30);
    expect(result.medianOutputRatio).toBeCloseTo(0.4);
  });

  it('outputRatioByBucket is null when a bucket has fewer than 2 sessions', () => {
    const project: ProjectData = {
      name: 'test',
      dir: '',
      entries: [
        makeEntry('user', 's1', 'add `getUserById` to src/users.ts — should return null instead of throwing'),
        makeAssistantWithTools('s1', ['Read', 'Read', 'Edit', 'Write', 'Bash']),
      ],
    };
    const result = analyze([project], 30);
    expect(result.outputRatioByBucket.specific).toBeNull();
    expect(result.outputRatioByBucket.vague).toBeNull();
  });

  it('outputRatioByBucket has non-null medians with >= 2 sessions per bucket', () => {
    const t = (offset: number) => new Date(Date.now() + offset * 1000).toISOString();
    const project: ProjectData = {
      name: 'test',
      dir: '',
      entries: [
        // Specific session 1: detailed prompt (vagueScore < 3), productive tools
        makeEntry('user', 's1', 'add `getUserById` to src/users.ts — should return null instead of throwing', undefined, t(0)),
        makeAssistantWithTools('s1', ['Read', 'Edit', 'Write', 'Bash', 'Bash'], t(1)),
        // Specific session 2: detailed prompt (vagueScore < 3), productive tools
        makeEntry('user', 's2', 'fix the 401 error in src/auth.ts — should return 200 after valid login instead', undefined, t(2)),
        makeAssistantWithTools('s2', ['Read', 'Write', 'Write', 'Bash', 'Read'], t(3)),
        // Vague session 1: short prompt (vagueScore >= 3), no productive tools
        makeEntry('user', 's3', 'fix it', undefined, t(4)),
        makeAssistantWithTools('s3', ['Read', 'Read', 'Bash', 'Bash', 'Bash'], t(5)),
        // Vague session 2: short prompt (vagueScore >= 3), no productive tools
        makeEntry('user', 's4', 'update stuff', undefined, t(6)),
        makeAssistantWithTools('s4', ['Bash', 'Bash', 'Bash', 'Bash', 'Read'], t(7)),
      ],
    };
    const result = analyze([project], 30);
    expect(result.outputRatioByBucket.specific).not.toBeNull();
    expect(result.outputRatioByBucket.vague).not.toBeNull();
    // Specific sessions have Edit/Write calls; vague sessions have only Bash/Read
    expect(result.outputRatioByBucket.specific!).toBeGreaterThan(result.outputRatioByBucket.vague!);
    expect(result.outputRatioByBucket.nSpecific).toBe(2);
    expect(result.outputRatioByBucket.nVague).toBe(2);
    expect(result.outputRatioByBucket.nTotal).toBe(4);
  });

  it('medianVagueScore excludes sessions with no user prompts from bucket aggregation', () => {
    const project: ProjectData = {
      name: 'test',
      dir: '',
      entries: [
        // Session with no user message — should not appear in scoredSessions
        makeAssistantWithTools('s1', ['Write', 'Write', 'Write', 'Write', 'Write']),
      ],
    };
    const result = analyze([project], 30);
    expect(result.medianOutputRatio).toBeNull();
    expect(result.outputRatioByBucket.nTotal).toBe(0);
  });
});

// ── contextPressureCorrelation ────────────────────────────────

describe('contextPressureCorrelation', () => {
  it('returns null when no sessions exceed 80k input tokens', () => {
    const project: ProjectData = {
      name: 'test',
      dir: '',
      entries: [
        makeEntry('user', 's1', 'fix the auth bug in src/auth.ts'),
        makeEntry('assistant', 's1', '', { input_tokens: 1_000, output_tokens: 50 }),
      ],
    };
    const result = analyze([project], 30);
    expect(result.contextPressureCorrelation).toBeNull();
  });

  it('detects pressure sessions and computes correction rates', () => {
    const t = (offset: number) => new Date(Date.now() + offset * 1000).toISOString();
    const project: ProjectData = {
      name: 'test',
      dir: '',
      entries: [
        // Pressure session with a correction turn
        makeEntry('user', 's1', 'implement this feature in src/api.ts', undefined, t(0)),
        makeEntry('assistant', 's1', '', { input_tokens: 90_000, output_tokens: 50 }, t(1)),
        makeEntry('user', 's1', 'no wait, I meant the other approach', undefined, t(2)),
        makeEntry('assistant', 's1', '', { input_tokens: 1_000, output_tokens: 50 }, t(3)),
        // Pressure session without correction
        makeEntry('user', 's2', 'add OAuth to src/auth.ts', undefined, t(4)),
        makeEntry('assistant', 's2', '', { input_tokens: 85_000, output_tokens: 50 }, t(5)),
        // Normal sessions without correction
        makeEntry('user', 's3', 'explain the cache invalidation pattern', undefined, t(6)),
        makeEntry('assistant', 's3', '', { input_tokens: 1_000, output_tokens: 50 }, t(7)),
        makeEntry('user', 's4', 'explain the retry logic in src/client.ts', undefined, t(8)),
        makeEntry('assistant', 's4', '', { input_tokens: 2_000, output_tokens: 50 }, t(9)),
      ],
    };
    const result = analyze([project], 30);
    expect(result.contextPressureCorrelation).not.toBeNull();
    const cp = result.contextPressureCorrelation!;
    // s1 totalInputTokens = 90_000 + 1_000 = 91_000 > 80k; s2 = 85_000 > 80k
    expect(cp.pressureSessions).toBe(2);
    expect(cp.normalSessions).toBe(2);
    // 1 of 2 pressure sessions had a correction → 0.5
    expect(cp.pressureCorrectionRate).toBeCloseTo(0.5);
    // 0 of 2 normal sessions had corrections → 0
    expect(cp.normalCorrectionRate).toBeCloseTo(0);
  });

  it('pressureCorrectionRate is null when only one pressure session exists', () => {
    const project: ProjectData = {
      name: 'test',
      dir: '',
      entries: [
        makeEntry('user', 's1', 'add feature to src/api.ts'),
        makeEntry('assistant', 's1', '', { input_tokens: 90_000, output_tokens: 50 }),
      ],
    };
    const result = analyze([project], 30);
    // pressureSessions = 1, so contextPressureCorrelation is non-null (pressureSessions >= 1)
    // but pressureCorrectionRate is null (requires >= 2 pressure sessions)
    expect(result.contextPressureCorrelation).not.toBeNull();
    expect(result.contextPressureCorrelation!.pressureCorrectionRate).toBeNull();
  });
});

// ── subagentCorrelation ───────────────────────────────────────

describe('subagentCorrelation', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cortext-subagent-correlation-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when fewer than 3 sessions have outputRatio data', () => {
    const project: ProjectData = {
      name: 'test',
      dir: '',
      entries: [
        makeEntry('user', 's1', 'fix the bug in src/auth.ts'),
        makeAssistantWithTools('s1', ['Read', 'Write', 'Write', 'Write', 'Write']),
        makeEntry('user', 's2', 'add a feature to src/api.ts'),
        makeAssistantWithTools('s2', ['Read', 'Edit', 'Write', 'Bash', 'Write']),
      ],
    };
    const result = analyze([project], 30);
    // Only 2 sessions with outputRatio — below the MIN_CORRELATION_SESSIONS threshold of 3
    expect(result.subagentCorrelation).toBeNull();
  });

  it('is non-null with 3+ scored sessions and provides singleAgentOutputRatio', () => {
    const t = (offset: number) => new Date(Date.now() + offset * 1000).toISOString();
    const project: ProjectData = {
      name: 'test',
      dir: '',
      entries: [
        makeEntry('user', 's1', 'fix auth bug in src/auth.ts', undefined, t(0)),
        makeAssistantWithTools('s1', ['Read', 'Bash', 'Bash', 'Bash', 'Read'], t(1)),
        makeEntry('user', 's2', 'explain the retry logic in src/client.ts', undefined, t(2)),
        makeAssistantWithTools('s2', ['Read', 'Bash', 'Bash', 'Read', 'Bash'], t(3)),
        makeEntry('user', 's3', 'add OAuth to src/auth.ts', undefined, t(4)),
        makeAssistantWithTools('s3', ['Read', 'Read', 'Bash', 'Bash', 'Bash'], t(5)),
      ],
    };
    const result = analyze([project], 30);
    expect(result.subagentCorrelation).not.toBeNull();
    // No subagent dirs → all sessions are single-agent
    expect(result.subagentCorrelation!.subagentSessions).toBe(0);
    expect(result.subagentCorrelation!.singleAgentSessions).toBe(3);
    expect(result.subagentCorrelation!.subagentOutputRatio).toBeNull(); // no subagent sessions
    expect(result.subagentCorrelation!.singleAgentOutputRatio).not.toBeNull();
  });

  it('tags sessions with subagent dirs and computes subagentOutputRatio', () => {
    const s1 = 's-sub1';
    const s2 = 's-sub2';
    const s3 = 's-normal';
    mkdirSync(join(tmpDir, s1, 'subagents'), { recursive: true });
    writeFileSync(join(tmpDir, s1, 'subagents', 'agent-1.jsonl'), '');
    mkdirSync(join(tmpDir, s2, 'subagents'), { recursive: true });
    writeFileSync(join(tmpDir, s2, 'subagents', 'agent-1.jsonl'), '');

    const t = (offset: number) => new Date(Date.now() + offset * 1000).toISOString();
    const project: ProjectData = {
      name: 'test',
      dir: tmpDir,
      entries: [
        // Subagent session 1: 4/5 productive = 0.8
        makeEntry('user', s1, 'implement OAuth in src/auth.ts', undefined, t(0)),
        makeAssistantWithTools(s1, ['Read', 'Write', 'Write', 'Write', 'Write'], t(1)),
        // Subagent session 2: 3/5 productive = 0.6 → median([0.8, 0.6]) = 0.8
        makeEntry('user', s2, 'add feature to src/api.ts', undefined, t(2)),
        makeAssistantWithTools(s2, ['Read', 'Write', 'Write', 'Edit', 'Bash'], t(3)),
        // Normal session: 0/5 productive = 0.0
        makeEntry('user', s3, 'explain the retry logic in src/client.ts', undefined, t(4)),
        makeAssistantWithTools(s3, ['Read', 'Bash', 'Bash', 'Read', 'Bash'], t(5)),
      ],
    };
    const result = analyze([project], 30);
    expect(result.subagentCorrelation).not.toBeNull();
    const sc = result.subagentCorrelation!;
    expect(sc.subagentSessions).toBe(2);
    expect(sc.singleAgentSessions).toBe(1);
    // median([0.8, 0.6]) → sorted [0.6, 0.8], index 1 = 0.8
    expect(sc.subagentOutputRatio).toBeCloseTo(0.8);
    // median([0.0]) → null (requires >= 2 elements)
    expect(sc.singleAgentOutputRatio).toBeNull();
  });
});
