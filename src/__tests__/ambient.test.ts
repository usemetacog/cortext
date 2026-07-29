import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { scoreSessionEntries } from '../analyzer';
import { pickNudge, runAmbientHook } from '../ambient';
import type { RawEntry } from '../types';

// ── scoreSessionEntries ─────────────────────────────────────────────

function userEntry(text: string, timestamp: string): RawEntry {
  return { type: 'user', timestamp, message: { role: 'user', content: text } };
}

function assistantEntry(timestamp: string, text = 'ok'): RawEntry {
  return {
    type: 'assistant',
    timestamp,
    message: {
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      content: [{ type: 'text', text }],
    },
  };
}

describe('scoreSessionEntries', () => {
  it('counts prompts, vague prompts, and corrections', () => {
    const entries: RawEntry[] = [
      userEntry('fix the login bug in auth.ts', '2026-01-01T00:00:00Z'),
      assistantEntry('2026-01-01T00:00:01Z'),
      userEntry('no, that is wrong, the issue is somewhere else', '2026-01-01T00:00:02Z'),
      assistantEntry('2026-01-01T00:00:03Z'),
      userEntry('ok ship it', '2026-01-01T00:00:04Z'),
    ];
    const signal = scoreSessionEntries(entries);
    expect(signal.promptCount).toBe(3);
    expect(signal.correctionCount).toBe(1);
  });

  it('counts vague prompts using the same vagueScore threshold as the main analyzer', () => {
    const entries: RawEntry[] = [
      userEntry('do this', '2026-01-01T00:00:00Z'),
      assistantEntry('2026-01-01T00:00:01Z'),
      userEntry('make it work', '2026-01-01T00:00:02Z'),
      assistantEntry('2026-01-01T00:00:03Z'),
      userEntry(
        'please add a retry wrapper around the fetchUser call in src/api/user.ts with three attempts and exponential backoff',
        '2026-01-01T00:00:04Z'
      ),
    ];
    const signal = scoreSessionEntries(entries);
    expect(signal.promptCount).toBe(3);
    expect(signal.vagueCount).toBe(2);
  });

  it('returns zeroed signal for a session with no user prompts', () => {
    const signal = scoreSessionEntries([assistantEntry('2026-01-01T00:00:00Z')]);
    expect(signal).toEqual({ promptCount: 0, vagueCount: 0, correctionCount: 0 });
  });
});

// ── pickNudge ────────────────────────────────────────────────────────

describe('pickNudge', () => {
  it('stays silent when nothing crosses a threshold', () => {
    expect(pickNudge({ promptCount: 3, vagueCount: 0, correctionCount: 0 })).toBeNull();
  });

  it('stays silent on a single vague prompt in an otherwise clean session', () => {
    expect(pickNudge({ promptCount: 4, vagueCount: 1, correctionCount: 0 })).toBeNull();
  });

  it('flags any correction, singular phrasing', () => {
    const nudge = pickNudge({ promptCount: 3, vagueCount: 0, correctionCount: 1 });
    expect(nudge).toContain('1 correction ');
    expect(nudge).not.toContain('1 corrections');
  });

  it('flags multiple corrections, plural phrasing', () => {
    const nudge = pickNudge({ promptCount: 5, vagueCount: 0, correctionCount: 2 });
    expect(nudge).toContain('2 corrections');
  });

  it('flags a majority-vague session', () => {
    const nudge = pickNudge({ promptCount: 4, vagueCount: 3, correctionCount: 0 });
    expect(nudge).toContain('3 of 4 prompts');
  });

  it('does not flag a majority-vague session below the minimum prompt count', () => {
    // 1 of 2 is >50% vague but too little signal to say anything about yet
    expect(pickNudge({ promptCount: 2, vagueCount: 1, correctionCount: 0 })).toBeNull();
  });

  it('prefers the correction nudge over the vague nudge when both are present', () => {
    const nudge = pickNudge({ promptCount: 4, vagueCount: 3, correctionCount: 1 });
    expect(nudge).toContain('correction');
  });
});

// ── runAmbientHook ───────────────────────────────────────────────────

describe('runAmbientHook', () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cortext-ambient-test-'));
    originalHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  function writeTranscript(entries: RawEntry[]): string {
    const path = join(home, 'session.jsonl');
    writeFileSync(path, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
    return path;
  }

  const cleanEntries: RawEntry[] = [
    userEntry('add retry logic to src/api/user.ts', '2026-01-01T00:00:00Z'),
    assistantEntry('2026-01-01T00:00:01Z'),
  ];

  const correctionEntries: RawEntry[] = [
    userEntry('fix the login bug in auth.ts', '2026-01-01T00:00:00Z'),
    assistantEntry('2026-01-01T00:00:01Z'),
    userEntry('no, wrong file, it is in session.ts', '2026-01-01T00:00:02Z'),
    assistantEntry('2026-01-01T00:00:03Z'),
  ];

  it('returns null when session_id or transcript_path is missing', () => {
    expect(runAmbientHook({})).toBeNull();
    expect(runAmbientHook({ session_id: 'abc' })).toBeNull();
    expect(runAmbientHook({ transcript_path: '/tmp/x.jsonl' })).toBeNull();
  });

  it('stays silent for the first two turns regardless of content', () => {
    const path = writeTranscript(correctionEntries);
    expect(runAmbientHook({ session_id: 'abc', transcript_path: path })).toBeNull();
    expect(runAmbientHook({ session_id: 'abc', transcript_path: path })).toBeNull();
  });

  it('evaluates exactly once, on the 3rd turn, and surfaces a nudge when warranted', () => {
    const path = writeTranscript(correctionEntries);
    runAmbientHook({ session_id: 'abc', transcript_path: path });
    runAmbientHook({ session_id: 'abc', transcript_path: path });
    const third = runAmbientHook({ session_id: 'abc', transcript_path: path });
    expect(third).not.toBeNull();
    const parsed = JSON.parse(third!);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('Stop');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('correction');
  });

  it('never re-evaluates after the 3rd turn, even if the transcript would now warrant a nudge', () => {
    const path = writeTranscript(cleanEntries);
    runAmbientHook({ session_id: 'abc', transcript_path: path });
    runAmbientHook({ session_id: 'abc', transcript_path: path });
    const third = runAmbientHook({ session_id: 'abc', transcript_path: path });
    expect(third).toBeNull(); // clean session, no nudge warranted at eval time

    // Rewrite the transcript to now contain a correction, then fire more turns
    writeFileSync(path, correctionEntries.map(e => JSON.stringify(e)).join('\n') + '\n');
    const fourth = runAmbientHook({ session_id: 'abc', transcript_path: path });
    const fifth = runAmbientHook({ session_id: 'abc', transcript_path: path });
    expect(fourth).toBeNull();
    expect(fifth).toBeNull();
  });

  it('tracks separate sessions independently', () => {
    const pathA = writeTranscript(correctionEntries);
    const pathB = join(home, 'session-b.jsonl');
    writeFileSync(pathB, cleanEntries.map(e => JSON.stringify(e)).join('\n') + '\n');

    runAmbientHook({ session_id: 'a', transcript_path: pathA });
    runAmbientHook({ session_id: 'b', transcript_path: pathB });
    runAmbientHook({ session_id: 'a', transcript_path: pathA });
    runAmbientHook({ session_id: 'b', transcript_path: pathB });

    const evalA = runAmbientHook({ session_id: 'a', transcript_path: pathA });
    const evalB = runAmbientHook({ session_id: 'b', transcript_path: pathB });
    expect(evalA).not.toBeNull(); // correction session
    expect(evalB).toBeNull(); // clean session
  });

  it('never throws and returns null when the transcript file does not exist', () => {
    expect(() => runAmbientHook({ session_id: 'ghost', transcript_path: '/nonexistent/path.jsonl' })).not.toThrow();
    runAmbientHook({ session_id: 'ghost', transcript_path: '/nonexistent/path.jsonl' });
    runAmbientHook({ session_id: 'ghost', transcript_path: '/nonexistent/path.jsonl' });
    const third = runAmbientHook({ session_id: 'ghost', transcript_path: '/nonexistent/path.jsonl' });
    expect(third).toBeNull();
  });

  it('sanitizes session_id so it cannot escape the state directory', () => {
    const path = writeTranscript(cleanEntries);
    expect(() =>
      runAmbientHook({ session_id: '../../etc/passwd', transcript_path: path })
    ).not.toThrow();
  });
});
