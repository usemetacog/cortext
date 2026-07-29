import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// Computed lazily (not module-load-time consts) so tests can override HOME
// per test rather than being stuck with whatever it was at import time.
function claudeDir(): string {
  return join(homedir(), '.claude');
}
function claudeSettingsPath(): string {
  return join(claudeDir(), 'settings.json');
}
function cortextDir(): string {
  return join(homedir(), '.cortext');
}
function markerPath(): string {
  return join(cortextDir(), 'hook-command.json');
}

interface HookEntry {
  type: string;
  command: string;
  timeout?: number;
}
interface HookGroup {
  matcher: string | null;
  hooks: HookEntry[];
}

function isCortextCommand(command: string | undefined): boolean {
  return !!command && command.includes('cortext') && command.trim().endsWith('hook run');
}

function loadSettings(): Record<string, any> {
  try {
    return JSON.parse(readFileSync(claudeSettingsPath(), 'utf-8'));
  } catch {
    return {};
  }
}

function saveSettings(settings: Record<string, any>): void {
  const dir = claudeDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(claudeSettingsPath(), JSON.stringify(settings, null, 2) + '\n');
}

function loadMarkerCommand(): string | null {
  try {
    const raw = JSON.parse(readFileSync(markerPath(), 'utf-8')) as { command?: string };
    return raw.command ?? null;
  } catch {
    return null;
  }
}

function saveMarkerCommand(command: string | null): void {
  try {
    const dir = cortextDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(markerPath(), JSON.stringify({ command }));
  } catch {
    // best-effort
  }
}

// The command points at the currently-running script's own resolved path
// (not `npx cortext`) — npx does registry/version checks on every
// invocation, which would put a network dependency on every single Stop
// event. A pinned absolute path is fast and fully local, at the cost of
// staying pinned to whatever version was active when `enable` last ran;
// re-run `hook enable` after upgrading to refresh it.
function resolvedCommand(): string {
  return `${process.argv[1]} hook run`;
}

export function enableHook(): { alreadyEnabled: boolean; command: string } {
  const command = resolvedCommand();
  const settings = loadSettings();
  settings.hooks = settings.hooks ?? {};
  const stopHooks: HookGroup[] = Array.isArray(settings.hooks.Stop) ? settings.hooks.Stop : [];

  const alreadyEnabled = stopHooks.some(g => g.hooks?.some(h => h.command === command));

  // Drop any prior cortext entry pointing at a *different* command (e.g.
  // after an upgrade moved the install path) so repeated `enable` calls
  // stay idempotent instead of piling up stale duplicates. Leave the list
  // untouched when the path hasn't changed — no-op enable should be a
  // true no-op, not a silent remove-and-reinsert.
  const prior = loadMarkerCommand();
  const cleaned = prior && prior !== command
    ? stopHooks.filter(g => !g.hooks?.some(h => h.command === prior))
    : stopHooks;

  if (!alreadyEnabled) {
    cleaned.push({ matcher: null, hooks: [{ type: 'command', command, timeout: 5 }] });
  }

  settings.hooks.Stop = cleaned;
  saveSettings(settings);
  saveMarkerCommand(command);
  return { alreadyEnabled, command };
}

export function disableHook(): { wasEnabled: boolean } {
  const settings = loadSettings();
  let wasEnabled = false;

  if (Array.isArray(settings.hooks?.Stop)) {
    const before = settings.hooks.Stop.length;
    settings.hooks.Stop = settings.hooks.Stop.filter(
      (g: HookGroup) => !g.hooks?.some(h => isCortextCommand(h.command))
    );
    wasEnabled = settings.hooks.Stop.length < before;
    if (settings.hooks.Stop.length === 0) delete settings.hooks.Stop;
    if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
    saveSettings(settings);
  }

  saveMarkerCommand(null);
  return { wasEnabled };
}

export function hookStatus(): { enabled: boolean; command: string | null } {
  const settings = loadSettings();
  const stopHooks: HookGroup[] = Array.isArray(settings.hooks?.Stop) ? settings.hooks.Stop : [];
  for (const g of stopHooks) {
    for (const h of g.hooks ?? []) {
      if (isCortextCommand(h.command)) return { enabled: true, command: h.command };
    }
  }
  return { enabled: false, command: null };
}
