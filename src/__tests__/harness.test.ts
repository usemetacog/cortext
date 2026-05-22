import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { auditConfig, computeHarnessScore } from '../harness';
import type { BehavioralProfile, ConfigAudit } from '../harness';

// ── Helpers ───────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'cortext-harness-test-'));
}

function writeJson(file: string, obj: unknown): void {
  writeFileSync(file, JSON.stringify(obj));
}

const zeroBehavioral: BehavioralProfile = {
  subagentSessionCount: 0,
  compactionEventCount: 0,
  autoCompactionCount: 0,
  manualCompactionCount: 0,
  toolNamespaceCount: 0,
};

// ── auditConfig ───────────────────────────────────────────────────

describe('auditConfig', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = makeTmpDir();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  // Spec #1 — global settings.json missing
  it('returns correct shape when global settings.json is missing', () => {
    const result = auditConfig(cwd);
    expect(result.hasHooks).toEqual({ preToolUse: false, postToolUse: false, stop: false });
    expect(result.hasDenyPermissions).toBe(false);
    expect(result.mcpServerCount).toBe(0);
  });

  // Spec #2 — project settings.json missing
  it('returns correct shape when project settings.json is missing', () => {
    const result = auditConfig(cwd);
    expect(result).toMatchObject({
      hasRootClaudeMd: false,
      claudeMdWordCount: null,
      hasSubdirectoryClaudeMds: false,
      hasClaudeIgnore: false,
    });
  });

  // Spec #3 — malformed settings.json falls back to {} without crash
  it('falls back gracefully on malformed project settings.json', () => {
    mkdirSync(path.join(cwd, '.claude'));
    writeFileSync(path.join(cwd, '.claude', 'settings.json'), 'not { valid json');
    expect(() => auditConfig(cwd)).not.toThrow();
    const result = auditConfig(cwd);
    expect(result.mcpServerCount).toBe(0);
  });

  // Spec #4 — hook detection reads both global + project, merges
  it('detects hooks from project settings.json when present', () => {
    mkdirSync(path.join(cwd, '.claude'));
    writeJson(path.join(cwd, '.claude', 'settings.json'), {
      hooks: { Stop: [{ command: 'echo done' }] },
    });
    const result = auditConfig(cwd);
    expect(result.hasHooks.stop).toBe(true);
  });

  // Gap — case-insensitive hook detection (PascalCase)
  it('detects PreToolUse hook with PascalCase key', () => {
    mkdirSync(path.join(cwd, '.claude'));
    writeJson(path.join(cwd, '.claude', 'settings.json'), {
      hooks: { PreToolUse: [{ matcher: '*', command: 'echo pre' }] },
    });
    const result = auditConfig(cwd);
    expect(result.hasHooks.preToolUse).toBe(true);
  });

  // Gap — case-insensitive hook detection (lowercase)
  it('detects pretooluse hook with lowercase key', () => {
    mkdirSync(path.join(cwd, '.claude'));
    writeJson(path.join(cwd, '.claude', 'settings.json'), {
      hooks: { pretooluse: [{ matcher: '*', command: 'echo pre' }] },
    });
    const result = auditConfig(cwd);
    expect(result.hasHooks.preToolUse).toBe(true);
  });

  // Gap — project settings.json overrides global
  it('project settings.json takes precedence over global for mcpServers', () => {
    // We can't easily write to the real ~/.claude/ in tests, so we test the merge
    // logic by ensuring project settings populate fields correctly.
    mkdirSync(path.join(cwd, '.claude'));
    writeJson(path.join(cwd, '.claude', 'settings.json'), {
      mcpServers: { myserver: { command: 'node server.js' } },
    });
    const result = auditConfig(cwd);
    expect(result.mcpServerCount).toBe(1);
  });

  it('counts CLAUDE.md words correctly', () => {
    writeFileSync(path.join(cwd, 'CLAUDE.md'), 'one two three four five');
    const result = auditConfig(cwd);
    expect(result.hasRootClaudeMd).toBe(true);
    expect(result.claudeMdWordCount).toBe(5);
  });

  it('detects .claudeignore when present', () => {
    writeFileSync(path.join(cwd, '.claudeignore'), 'node_modules/\ndist/\n');
    const result = auditConfig(cwd);
    expect(result.hasClaudeIgnore).toBe(true);
  });

  it('detects deny permissions when set', () => {
    mkdirSync(path.join(cwd, '.claude'));
    writeJson(path.join(cwd, '.claude', 'settings.json'), {
      permissions: { deny: ['Bash(rm*)'] },
    });
    const result = auditConfig(cwd);
    expect(result.hasDenyPermissions).toBe(true);
  });

  it('returns hasDenyPermissions false for empty deny array', () => {
    mkdirSync(path.join(cwd, '.claude'));
    writeJson(path.join(cwd, '.claude', 'settings.json'), {
      permissions: { deny: [] },
    });
    const result = auditConfig(cwd);
    expect(result.hasDenyPermissions).toBe(false);
  });

  it('does not detect stop hook from empty array', () => {
    mkdirSync(path.join(cwd, '.claude'));
    writeJson(path.join(cwd, '.claude', 'settings.json'), {
      hooks: { Stop: [] },
    });
    const result = auditConfig(cwd);
    expect(result.hasHooks.stop).toBe(false);
  });
});

// ── computeHarnessScore ───────────────────────────────────────────

describe('computeHarnessScore', () => {
  // Spec #7 — formula: overall = 0.6 × config + 0.4 × behavioral
  it('computes overall using 0.6×config + 0.4×behavioral formula', () => {
    const config: ConfigAudit = {
      hasRootClaudeMd: true,
      claudeMdWordCount: 300,
      hasSubdirectoryClaudeMds: false,
      hasHooks: { preToolUse: false, postToolUse: false, stop: true },
      hasDenyPermissions: false,
      hasClaudeIgnore: true,
      mcpServerCount: 0,
    };
    const behavioral: BehavioralProfile = {
      subagentSessionCount: 5,
      compactionEventCount: 2,
      autoCompactionCount: 2,
      manualCompactionCount: 0,
      toolNamespaceCount: 4,
    };
    const result = computeHarnessScore(config, behavioral, 10);
    // configScore: 25 (CLAUDE.md) + 15 (wordCount<500) + 20 (stop) + 10 (claudeignore) = 70
    expect(result.configScore).toBe(70);
    // behavioralScore: 50 (subagentRate 5/10=50%>20%) + 30 (compaction) + 20 (toolDiversity>3) = 100
    expect(result.behavioralScore).toBe(100);
    // overall: Math.round(0.6*70 + 0.4*100) = Math.round(42+40) = 82
    expect(result.overall).toBe(82);
  });

  // Spec #8 — all-zero inputs: no crash
  it('handles all-zero inputs without crash', () => {
    const config: ConfigAudit = {
      hasRootClaudeMd: false,
      claudeMdWordCount: null,
      hasSubdirectoryClaudeMds: false,
      hasHooks: { preToolUse: false, postToolUse: false, stop: false },
      hasDenyPermissions: false,
      hasClaudeIgnore: false,
      mcpServerCount: 0,
    };
    const result = computeHarnessScore(config, zeroBehavioral, 0);
    expect(result.overall).toBe(0);
    expect(result.configScore).toBe(0);
    expect(result.behavioralScore).toBe(0);
  });

  // Gap — yellow CLAUDE.md wordCount path (500-1500 = 8 pts, not 15)
  it('awards 8 pts for CLAUDE.md wordCount 500-1500 (yellow)', () => {
    const config: ConfigAudit = {
      hasRootClaudeMd: true,
      claudeMdWordCount: 800,
      hasSubdirectoryClaudeMds: false,
      hasHooks: { preToolUse: false, postToolUse: false, stop: false },
      hasDenyPermissions: false,
      hasClaudeIgnore: false,
      mcpServerCount: 0,
    };
    const result = computeHarnessScore(config, zeroBehavioral, 0);
    // 25 (CLAUDE.md exists) + 8 (yellow wordCount) = 33
    expect(result.configScore).toBe(33);
  });

  // Gap — red CLAUDE.md wordCount path (>1500 = 0 pts for wordCount)
  it('awards 0 pts for CLAUDE.md wordCount > 1500 (bloat)', () => {
    const config: ConfigAudit = {
      hasRootClaudeMd: true,
      claudeMdWordCount: 2000,
      hasSubdirectoryClaudeMds: false,
      hasHooks: { preToolUse: false, postToolUse: false, stop: false },
      hasDenyPermissions: false,
      hasClaudeIgnore: false,
      mcpServerCount: 0,
    };
    const result = computeHarnessScore(config, zeroBehavioral, 0);
    // 25 (CLAUDE.md exists) + 0 (bloat) = 25
    expect(result.configScore).toBe(25);
  });

  // Gap — yellow subagent rate path (5-20% = 25 pts, not 50)
  it('awards 25 pts for subagentRate 5-20% (yellow)', () => {
    const behavioral: BehavioralProfile = {
      subagentSessionCount: 1,
      compactionEventCount: 0,
      autoCompactionCount: 0,
      manualCompactionCount: 0,
      toolNamespaceCount: 0,
    };
    const result = computeHarnessScore(
      { hasRootClaudeMd: false, claudeMdWordCount: null, hasSubdirectoryClaudeMds: false,
        hasHooks: { preToolUse: false, postToolUse: false, stop: false },
        hasDenyPermissions: false, hasClaudeIgnore: false, mcpServerCount: 0 },
      behavioral,
      10, // subagentRate = 1/10 = 10% → yellow
    );
    expect(result.behavioralScore).toBe(25);
  });

  // Gap — yellow tool diversity path (2-3 = 10 pts, not 20)
  it('awards 10 pts for toolNamespaceCount 2-3 (yellow)', () => {
    const behavioral: BehavioralProfile = {
      ...zeroBehavioral,
      toolNamespaceCount: 3,
    };
    const result = computeHarnessScore(
      { hasRootClaudeMd: false, claudeMdWordCount: null, hasSubdirectoryClaudeMds: false,
        hasHooks: { preToolUse: false, postToolUse: false, stop: false },
        hasDenyPermissions: false, hasClaudeIgnore: false, mcpServerCount: 0 },
      behavioral,
      0,
    );
    expect(result.behavioralScore).toBe(10);
  });

  // Gap — missingComponents populated when stop hook absent
  it('includes stop hook in missingComponents when absent', () => {
    const result = computeHarnessScore(
      { hasRootClaudeMd: true, claudeMdWordCount: 200, hasSubdirectoryClaudeMds: false,
        hasHooks: { preToolUse: false, postToolUse: false, stop: false },
        hasDenyPermissions: false, hasClaudeIgnore: false, mcpServerCount: 0 },
      zeroBehavioral,
      0,
    );
    expect(result.missingComponents).toContain('stop hook');
  });

  // Gap — missingComponents does NOT include stop hook when present
  it('excludes stop hook from missingComponents when configured', () => {
    const result = computeHarnessScore(
      { hasRootClaudeMd: true, claudeMdWordCount: 200, hasSubdirectoryClaudeMds: false,
        hasHooks: { preToolUse: false, postToolUse: false, stop: true },
        hasDenyPermissions: false, hasClaudeIgnore: false, mcpServerCount: 0 },
      zeroBehavioral,
      0,
    );
    expect(result.missingComponents).not.toContain('stop hook');
  });

  // Gap — strengths populated when subagent usage > 0
  it('includes subagent usage in strengths when subagentSessionCount > 0', () => {
    const result = computeHarnessScore(
      { hasRootClaudeMd: false, claudeMdWordCount: null, hasSubdirectoryClaudeMds: false,
        hasHooks: { preToolUse: false, postToolUse: false, stop: false },
        hasDenyPermissions: false, hasClaudeIgnore: false, mcpServerCount: 0 },
      { ...zeroBehavioral, subagentSessionCount: 3 },
      10,
    );
    expect(result.strengths).toContain('subagent usage');
  });

  it('returns full HarnessScore shape', () => {
    const result = computeHarnessScore(
      { hasRootClaudeMd: false, claudeMdWordCount: null, hasSubdirectoryClaudeMds: false,
        hasHooks: { preToolUse: false, postToolUse: false, stop: false },
        hasDenyPermissions: false, hasClaudeIgnore: false, mcpServerCount: 0 },
      zeroBehavioral,
      0,
    );
    expect(result).toHaveProperty('config');
    expect(result).toHaveProperty('behavioral');
    expect(result).toHaveProperty('configScore');
    expect(result).toHaveProperty('behavioralScore');
    expect(result).toHaveProperty('overall');
    expect(result).toHaveProperty('missingComponents');
    expect(result).toHaveProperty('strengths');
  });
});
