import { describe, it, expect } from 'vitest';
import { heuristicDiagnosis } from '../rewriter';
import type { UserPrompt } from '../types';

function makePrompt(overrides: Partial<UserPrompt>): UserPrompt {
  return {
    text: 'fix it',
    timestamp: new Date(),
    sessionId: 's1',
    projectName: 'test',
    wordCount: 2,
    category: 'vague',
    vagueScore: 5,
    followedByCorrection: false,
    hasVerification: false,
    ...overrides,
  };
}

describe('heuristicDiagnosis', () => {
  it('returns null for system artifacts like [Request interrupted by user]', () => {
    const result = heuristicDiagnosis(makePrompt({ text: '[Request interrupted by user]', wordCount: 4 }));
    expect(result).toBeNull();
  });

  it('flags very short prompts with a specific, prompt-anchored diagnosis', () => {
    const result = heuristicDiagnosis(makePrompt({ text: 'do it', wordCount: 2 }));
    expect(result).not.toBeNull();
    expect(result).toContain('2 words');
    expect(result).toContain('"do it"');
  });

  it('flags vague pronoun references in short prompts', () => {
    const text = 'whats the conversation ?';
    const result = heuristicDiagnosis(makePrompt({ text, wordCount: 4 }));
    expect(result).not.toBeNull();
    expect(result).toContain('"the conversation"');
    expect(result).toContain('no referent');
  });

  it('flags vague "the issue" references', () => {
    const text = 'what was the issue?';
    const result = heuristicDiagnosis(makePrompt({ text, wordCount: 4 }));
    expect(result).not.toBeNull();
    expect(result).toContain('"the issue"');
  });

  it('flags prompts that are missing a file path when borderline short', () => {
    const text = 'fix the bug in auth module';
    const result = heuristicDiagnosis(makePrompt({ text, wordCount: 6 }));
    expect(result).not.toBeNull();
  });

  it('returns null for well-formed prompts with file path, symbol, and outcome', () => {
    const text = 'fix `handleLogin` in src/auth.ts — it should redirect to /dashboard but returns 401';
    const result = heuristicDiagnosis(makePrompt({ text, wordCount: 15, followedByCorrection: false }));
    expect(result).toBeNull();
  });

  it('returns null for git ops that did NOT cause a correction', () => {
    const commitDiag = heuristicDiagnosis(makePrompt({ text: 'commit this', wordCount: 2 }));
    expect(commitDiag).toBeNull();

    const pushDiag = heuristicDiagnosis(makePrompt({ text: 'can we commit it?', wordCount: 4 }));
    expect(pushDiag).toBeNull();
  });

  it('produces a correction-specific diagnosis for git ops that caused corrections', () => {
    const result = heuristicDiagnosis(makePrompt({
      text: 'commit this',
      wordCount: 2,
      followedByCorrection: true,
    }));
    expect(result).not.toBeNull();
    expect(result).toContain('correction');
    expect(result).not.toContain('no file path');
  });

  it('flags correction turns with a prompt-specific message', () => {
    const result = heuristicDiagnosis(makePrompt({
      text: 'fix the login flow in src/auth.ts with `handleLogin` — should redirect on success',
      wordCount: 15,
      followedByCorrection: true,
    }));
    expect(result).not.toBeNull();
    expect(result).toContain('correction');
  });

  it('never produces the old generic checklist phrasing', () => {
    const prompts = [
      makePrompt({ text: 'do it', wordCount: 2 }),
      makePrompt({ text: 'please update the settings page now', wordCount: 6 }),
      makePrompt({ text: 'fix the function that returns null', wordCount: 7 }),
    ];
    for (const p of prompts) {
      const result = heuristicDiagnosis(p);
      if (result !== null) {
        expect(result).not.toContain('Several issues:');
        expect(result).not.toContain('no file path');
        expect(result).not.toContain('no code reference');
        expect(result).not.toContain('no expected outcome');
        expect(result).not.toBe('Prompt was flagged — review manually.');
      }
    }
  });
});
