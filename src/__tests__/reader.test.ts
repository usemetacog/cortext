import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { extractUserText, detectSubagentSessions } from '../reader';

describe('extractUserText', () => {
  it('returns trimmed text for plain strings', () => {
    expect(extractUserText('  hello world  ')).toBe('hello world');
  });

  it('returns null for empty string', () => {
    expect(extractUserText('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(extractUserText('   ')).toBeNull();
  });

  it('returns null for strings starting with <', () => {
    expect(extractUserText('<command>do something</command>')).toBeNull();
  });

  it('extracts text from array of text blocks', () => {
    expect(extractUserText([
      { type: 'text', text: 'fix the bug' },
    ])).toBe('fix the bug');
  });

  it('joins multiple text blocks', () => {
    expect(extractUserText([
      { type: 'text', text: 'hello' },
      { type: 'text', text: 'world' },
    ])).toBe('hello world');
  });

  it('filters out non-text blocks', () => {
    expect(extractUserText([
      { type: 'tool_result', text: 'ignored' },
      { type: 'text', text: 'keep this' },
    ])).toBe('keep this');
  });

  it('filters out blocks whose text starts with <', () => {
    expect(extractUserText([
      { type: 'text', text: '<command>slash</command>' },
      { type: 'text', text: 'real message' },
    ])).toBe('real message');
  });

  it('returns null for an empty array', () => {
    expect(extractUserText([])).toBeNull();
  });

  it('returns null when all blocks are filtered', () => {
    expect(extractUserText([
      { type: 'text', text: '<wrapped>' },
    ])).toBeNull();
  });
});

// ── detectSubagentSessions ────────────────────────────────────────

describe('detectSubagentSessions', () => {
  let projectsDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    projectsDir = mkdtempSync(path.join(tmpdir(), 'cortext-reader-test-'));
    originalEnv = process.env.CORTEXT_DATA_DIR;
    process.env.CORTEXT_DATA_DIR = projectsDir;
  });

  afterEach(() => {
    rmSync(projectsDir, { recursive: true, force: true });
    if (originalEnv === undefined) {
      delete process.env.CORTEXT_DATA_DIR;
    } else {
      process.env.CORTEXT_DATA_DIR = originalEnv;
    }
  });

  // Spec #5 — fixture with subagents/ dir returns count > 0
  it('counts a session that has a non-empty subagents/ directory', () => {
    const projectDir = path.join(projectsDir, '-Users-test-proj');
    mkdirSync(projectDir);
    const sessionId = 'abc-123';
    writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), '');
    mkdirSync(path.join(projectDir, sessionId, 'subagents'), { recursive: true });
    writeFileSync(path.join(projectDir, sessionId, 'subagents', 'agent-x.jsonl'), '');

    expect(detectSubagentSessions(30)).toBe(1);
  });

  // Gap — empty subagents/ dir does NOT count
  it('does not count a session with an empty subagents/ directory', () => {
    const projectDir = path.join(projectsDir, '-Users-test-proj');
    mkdirSync(projectDir);
    const sessionId = 'abc-456';
    writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), '');
    mkdirSync(path.join(projectDir, sessionId, 'subagents'), { recursive: true });
    // subagents/ dir is empty

    expect(detectSubagentSessions(30)).toBe(0);
  });

  // Gap — session with no subagents/ dir at all
  it('returns 0 when no session has a subagents/ directory', () => {
    const projectDir = path.join(projectsDir, '-Users-test-proj');
    mkdirSync(projectDir);
    writeFileSync(path.join(projectDir, 'session-1.jsonl'), '');
    writeFileSync(path.join(projectDir, 'session-2.jsonl'), '');

    expect(detectSubagentSessions(30)).toBe(0);
  });

  it('returns 0 when projects directory is empty', () => {
    expect(detectSubagentSessions(30)).toBe(0);
  });

  it('counts multiple sessions with subagents across multiple projects', () => {
    for (const proj of ['-Users-proj-a', '-Users-proj-b']) {
      const projectDir = path.join(projectsDir, proj);
      mkdirSync(projectDir);
      const sessionId = `session-${proj}`;
      writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), '');
      mkdirSync(path.join(projectDir, sessionId, 'subagents'), { recursive: true });
      writeFileSync(path.join(projectDir, sessionId, 'subagents', 'agent-1.jsonl'), '');
    }

    expect(detectSubagentSessions(30)).toBe(2);
  });

  it('does not mix up session IDs across project directories', () => {
    const projA = path.join(projectsDir, '-Users-proj-a');
    const projB = path.join(projectsDir, '-Users-proj-b');
    mkdirSync(projA);
    mkdirSync(projB);

    // projA: session with subagents
    writeFileSync(path.join(projA, 'session-1.jsonl'), '');
    mkdirSync(path.join(projA, 'session-1', 'subagents'), { recursive: true });
    writeFileSync(path.join(projA, 'session-1', 'subagents', 'agent.jsonl'), '');

    // projB: session without subagents
    writeFileSync(path.join(projB, 'session-1.jsonl'), '');

    expect(detectSubagentSessions(30)).toBe(1);
  });
});
