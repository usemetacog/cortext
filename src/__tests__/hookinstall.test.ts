import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { enableHook, disableHook, hookStatus } from '../hookinstall';

describe('hookinstall', () => {
  let home: string;
  let originalHome: string | undefined;
  let originalArgv1: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cortext-hookinstall-test-'));
    originalHome = process.env.HOME;
    process.env.HOME = home;
    originalArgv1 = process.argv[1];
    process.argv[1] = '/fake/path/to/cortext/dist/index.js';
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    process.argv[1] = originalArgv1;
    rmSync(home, { recursive: true, force: true });
  });

  function settingsPath(): string {
    return join(home, '.claude', 'settings.json');
  }

  it('reports disabled when no settings.json exists', () => {
    expect(hookStatus()).toEqual({ enabled: false, command: null });
  });

  it('enables the hook, creating settings.json if missing', () => {
    const { alreadyEnabled, command } = enableHook();
    expect(alreadyEnabled).toBe(false);
    expect(command).toBe('/fake/path/to/cortext/dist/index.js hook run');

    const settings = JSON.parse(readFileSync(settingsPath(), 'utf-8'));
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.Stop[0].hooks[0].command).toBe(command);
    expect(settings.hooks.Stop[0].matcher).toBeNull();

    expect(hookStatus()).toEqual({ enabled: true, command });
  });

  it('preserves unrelated settings and other hook types', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(
      settingsPath(),
      JSON.stringify({
        someOtherSetting: true,
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] },
      })
    );

    enableHook();

    const settings = JSON.parse(readFileSync(settingsPath(), 'utf-8'));
    expect(settings.someOtherSetting).toBe(true);
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.Stop).toHaveLength(1);
  });

  it('is idempotent — enabling twice does not create duplicate entries', () => {
    enableHook();
    const { alreadyEnabled } = enableHook();
    expect(alreadyEnabled).toBe(true);

    const settings = JSON.parse(readFileSync(settingsPath(), 'utf-8'));
    expect(settings.hooks.Stop).toHaveLength(1);
  });

  it('re-pins to a new path on re-enable without leaving a stale duplicate', () => {
    enableHook();
    process.argv[1] = '/new/upgraded/path/dist/index.js';
    const { command } = enableHook();

    const settings = JSON.parse(readFileSync(settingsPath(), 'utf-8'));
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.Stop[0].hooks[0].command).toBe('/new/upgraded/path/dist/index.js hook run');
    expect(command).toBe('/new/upgraded/path/dist/index.js hook run');
  });

  it('disables cleanly, removing the Stop key entirely if it becomes empty', () => {
    enableHook();
    const { wasEnabled } = disableHook();
    expect(wasEnabled).toBe(true);

    const settings = JSON.parse(readFileSync(settingsPath(), 'utf-8'));
    expect(settings.hooks).toBeUndefined(); // empty hooks object is pruned entirely
    expect(hookStatus()).toEqual({ enabled: false, command: null });
  });

  it('disable on an already-disabled hook reports wasEnabled: false and does not throw', () => {
    expect(() => disableHook()).not.toThrow();
    const { wasEnabled } = disableHook();
    expect(wasEnabled).toBe(false);
  });

  it('disabling preserves unrelated Stop hooks the user configured themselves', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(
      settingsPath(),
      JSON.stringify({
        hooks: { Stop: [{ matcher: null, hooks: [{ type: 'command', command: 'echo not-cortext' }] }] },
      })
    );

    enableHook();
    disableHook();

    const settings = JSON.parse(readFileSync(settingsPath(), 'utf-8'));
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.Stop[0].hooks[0].command).toBe('echo not-cortext');
  });
});
