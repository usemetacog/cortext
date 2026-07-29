import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { RawEntry } from './types';
import { scoreSessionEntries, type SessionSignal } from './analyzer';

// Computed lazily (not a module-load-time const) so tests can override HOME
// per test rather than being stuck with whatever it was at import time.
function stateDir(): string {
  return join(homedir(), '.cortext', 'ambient');
}

// Below this many assistant turns, a session hasn't produced enough signal
// to say anything useful yet — and firing early is the annoying version of
// this feature. Evaluate exactly once, the first time the gate is crossed.
const MIN_TURNS_BEFORE_EVAL = 3;

export interface StopHookPayload {
  session_id?: string;
  transcript_path?: string;
}

interface SessionState {
  turnCount: number;
  evaluated: boolean;
}

function statePath(sessionId: string): string {
  // session_id comes from Claude Code, not user input we need to sanitize
  // against injection — but strip path separators defensively regardless.
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '');
  return join(stateDir(), `${safe}.json`);
}

function loadState(sessionId: string): SessionState {
  try {
    const raw = readFileSync(statePath(sessionId), 'utf-8');
    return JSON.parse(raw) as SessionState;
  } catch {
    return { turnCount: 0, evaluated: false };
  }
}

function saveState(sessionId: string, state: SessionState): void {
  try {
    const dir = stateDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(statePath(sessionId), JSON.stringify(state));
  } catch {
    // Best-effort — if we can't persist state, worst case is re-evaluating
    // next session start, not a crash or a blocked Stop.
  }
}

function readTranscript(transcriptPath: string): RawEntry[] {
  const content = readFileSync(transcriptPath, 'utf-8');
  const entries: RawEntry[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as RawEntry);
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}

// Silent unless something crosses a real threshold — this is the whole
// point. A tool that comments on every session stops being a mirror and
// starts being a backseat driver.
export function pickNudge(signal: SessionSignal): string | null {
  if (signal.correctionCount >= 1) {
    return `${signal.correctionCount} correction${signal.correctionCount > 1 ? 's' : ''} this session — Claude backtracked after your feedback. Run \`npx cortext\` for the full read.`;
  }
  if (signal.promptCount >= 3 && signal.vagueCount / signal.promptCount > 0.5) {
    return `${signal.vagueCount} of ${signal.promptCount} prompts this session read as vague — more upfront specificity cuts the back-and-forth. Run \`npx cortext\` for the full read.`;
  }
  return null;
}

// Returns the JSON to print to stdout, or null to print nothing.
// Never throws — any failure here must never block the Stop event.
export function runAmbientHook(payload: StopHookPayload): string | null {
  try {
    const sessionId = payload.session_id;
    const transcriptPath = payload.transcript_path;
    if (!sessionId || !transcriptPath) return null;

    const state = loadState(sessionId);
    state.turnCount += 1;

    if (state.evaluated || state.turnCount < MIN_TURNS_BEFORE_EVAL) {
      saveState(sessionId, state);
      return null;
    }

    state.evaluated = true;
    saveState(sessionId, state);

    const entries = readTranscript(transcriptPath);
    const signal = scoreSessionEntries(entries);
    const nudge = pickNudge(signal);
    if (!nudge) return null;

    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'Stop',
        additionalContext: nudge,
      },
    });
  } catch {
    return null;
  }
}
