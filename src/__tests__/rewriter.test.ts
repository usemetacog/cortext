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
    ...overrides,
  };
}

describe('heuristicDiagnosis', () => {
  it('flags very short prompts as too short to be actionable', () => {
    const result = heuristicDiagnosis(makePrompt({ text: 'do it', wordCount: 2 }));
    expect(result).toContain('too short to be actionable');
  });

  it('flags 5–9 word prompts as too brief', () => {
    const text = 'please update the settings page now';
    const result = heuristicDiagnosis(makePrompt({ text, wordCount: 6 }));
    expect(result).toContain('too brief');
  });

  it('flags missing file path', () => {
    const result = heuristicDiagnosis(makePrompt({ text: 'fix the function that returns null', wordCount: 7 }));
    expect(result).toContain('no file path');
  });

  it('does not flag file path when one is present', () => {
    const text = 'fix the function in src/auth/login.ts that returns null sometimes';
    const result = heuristicDiagnosis(makePrompt({ text, wordCount: 12 }));
    expect(result).not.toContain('no file path');
  });

  it('flags missing code reference', () => {
    const text = 'fix the function that returns null in the auth module today';
    const result = heuristicDiagnosis(makePrompt({ text, wordCount: 11 }));
    expect(result).toContain('no code reference');
  });

  it('does not flag code reference when backtick code is present', () => {
    const text = 'fix `getUserById` which returns null in the auth module here';
    const result = heuristicDiagnosis(makePrompt({ text, wordCount: 11 }));
    expect(result).not.toContain('no code reference');
  });

  it('flags missing expected outcome', () => {
    const text = 'the button does not respond when the user clicks on it here';
    const result = heuristicDiagnosis(makePrompt({ text, wordCount: 13 }));
    expect(result).toContain('no expected outcome');
  });

  it('does not flag expected outcome when outcome words are present', () => {
    const text = 'the button should submit the form but nothing happens when clicked';
    const result = heuristicDiagnosis(makePrompt({ text, wordCount: 12 }));
    expect(result).not.toContain('no expected outcome');
  });

  it('flags correction turns', () => {
    const result = heuristicDiagnosis(makePrompt({
      text: 'fix the login flow in src/auth.ts with `handleLogin` — should redirect on success',
      wordCount: 15,
      followedByCorrection: true,
    }));
    expect(result).toContain('led directly to a correction turn');
  });

  it('does not flag structural issues for git/deployment operations', () => {
    // "commit this" has no file path, code ref, or expected outcome — but it's a git op
    const commitDiag = heuristicDiagnosis(makePrompt({ text: 'commit this', wordCount: 2 }));
    expect(commitDiag).not.toContain('no file path');
    expect(commitDiag).not.toContain('no code reference');
    expect(commitDiag).not.toContain('no expected outcome');
    expect(commitDiag).not.toContain('too short to be actionable');

    const pushDiag = heuristicDiagnosis(makePrompt({ text: 'can we commit it?', wordCount: 4 }));
    expect(pushDiag).not.toContain('no file path');
    expect(pushDiag).not.toContain('no code reference');
  });

  it('produces a correction-specific diagnosis for git ops that caused corrections', () => {
    const result = heuristicDiagnosis(makePrompt({
      text: 'commit this',
      wordCount: 2,
      followedByCorrection: true,
    }));
    expect(result).toContain('correction');
    expect(result).not.toContain('no file path');
  });

  it('returns fallback message when no issues found', () => {
    const text = 'fix `handleLogin` in src/auth.ts — it should redirect to /dashboard but returns 401';
    const result = heuristicDiagnosis(makePrompt({
      text,
      wordCount: 15,
      followedByCorrection: false,
    }));
    expect(result).toBe('Prompt was flagged — review manually.');
  });
});
