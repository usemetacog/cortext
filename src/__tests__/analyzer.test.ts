import { describe, it, expect } from 'vitest';
import { classifyPrompt, vagueScore, computeCost, analyze } from '../analyzer';
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
      entries: [
        makeEntry('user', 's1', 'explain the retry logic'),
        makeEntry('assistant', 's1', '', { input_tokens: 1000, output_tokens: 500 }),
      ],
    };
    const result = analyze([project], 30);
    expect(result.totalInputTokens).toBe(1000);
    expect(result.totalOutputTokens).toBe(500);
  });

  it('detects correction turns', () => {
    const project: ProjectData = {
      name: 'test',
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
      entries: [
        makeEntry('user', 's1', 'fix it'),
        makeEntry('assistant', 's1', ''),
      ],
    };
    const result = analyze([project], 30);
    expect(result.worstPrompts.length).toBeGreaterThan(0);
    expect(result.worstPrompts[0].vagueScore).toBeGreaterThanOrEqual(3);
  });

  it('aggregates stats across multiple projects', () => {
    const p1: ProjectData = {
      name: 'project-a',
      entries: [
        makeEntry('user', 's1', 'add login feature to src/auth.ts module here'),
        makeEntry('assistant', 's1', '', { input_tokens: 500, output_tokens: 200 }),
      ],
    };
    const p2: ProjectData = {
      name: 'project-b',
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

// ── effectiveness scoring ─────────────────────────────────────────

describe('effectiveness scoring', () => {
  it('medianEffectivenessScore is null when no session reaches MIN_TOOL_CALLS', () => {
    const project: ProjectData = {
      name: 'test',
      entries: [
        makeEntry('user', 's1', 'fix the auth bug in src/auth.ts'),
        makeAssistantWithTools('s1', ['Read', 'Bash', 'Bash']), // 3 calls < 5
      ],
    };
    const result = analyze([project], 30);
    expect(result.medianEffectivenessScore).toBeNull();
    expect(result.effectivenessByBucket.specific).toBeNull();
    expect(result.effectivenessByBucket.vague).toBeNull();
    expect(result.effectivenessByBucket.nTotal).toBe(0);
  });

  it('effectivenessScore reflects write+edit ratio when session has >= 5 tool calls', () => {
    const t = (offset: number) => new Date(Date.now() + offset * 1000).toISOString();
    const project: ProjectData = {
      name: 'test',
      entries: [
        // Two sessions with 2/5 = 0.4 productive ratio each → overall median 0.4
        makeEntry('user', 's1', 'add `getUserById` to src/users.ts — should return null instead of throwing', undefined, t(0)),
        makeAssistantWithTools('s1', ['Read', 'Read', 'Read', 'Write', 'Write'], t(1)),
        makeEntry('user', 's2', 'add `getUserById` to src/users.ts — should return null instead of throwing', undefined, t(2)),
        makeAssistantWithTools('s2', ['Read', 'Read', 'Read', 'Write', 'Write'], t(3)),
      ],
    };
    const result = analyze([project], 30);
    expect(result.medianEffectivenessScore).toBeCloseTo(0.4);
  });

  it('effectivenessByBucket is null when a bucket has fewer than 2 sessions', () => {
    const project: ProjectData = {
      name: 'test',
      entries: [
        makeEntry('user', 's1', 'add `getUserById` to src/users.ts — should return null instead of throwing'),
        makeAssistantWithTools('s1', ['Read', 'Read', 'Edit', 'Write', 'Bash']),
      ],
    };
    const result = analyze([project], 30);
    expect(result.effectivenessByBucket.specific).toBeNull();
    expect(result.effectivenessByBucket.vague).toBeNull();
  });

  it('effectivenessByBucket has non-null medians with >= 2 sessions per bucket', () => {
    const t = (offset: number) => new Date(Date.now() + offset * 1000).toISOString();
    const project: ProjectData = {
      name: 'test',
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
    expect(result.effectivenessByBucket.specific).not.toBeNull();
    expect(result.effectivenessByBucket.vague).not.toBeNull();
    // Specific sessions have Edit/Write calls; vague sessions have only Bash/Read
    expect(result.effectivenessByBucket.specific!).toBeGreaterThan(result.effectivenessByBucket.vague!);
    expect(result.effectivenessByBucket.nSpecific).toBe(2);
    expect(result.effectivenessByBucket.nVague).toBe(2);
    expect(result.effectivenessByBucket.nTotal).toBe(4);
  });

  it('medianVagueScore excludes sessions with no user prompts from bucket aggregation', () => {
    const project: ProjectData = {
      name: 'test',
      entries: [
        // Session with no user message — should not appear in scoredSessions
        makeAssistantWithTools('s1', ['Write', 'Write', 'Write', 'Write', 'Write']),
      ],
    };
    const result = analyze([project], 30);
    expect(result.medianEffectivenessScore).toBeNull();
    expect(result.effectivenessByBucket.nTotal).toBe(0);
  });
});
