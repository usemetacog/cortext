import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

const CLAUDE_DIR = path.join(homedir(), '.claude');

// ── Types ─────────────────────────────────────────────────────────

export interface ConfigAudit {
  hasRootClaudeMd: boolean;
  claudeMdWordCount: number | null;
  hasSubdirectoryClaudeMds: boolean; // TODO v2: traverse project subdirs
  hasHooks: {
    preToolUse: boolean;
    postToolUse: boolean;
    stop: boolean;
  };
  hasDenyPermissions: boolean;
  hasClaudeIgnore: boolean;
  mcpServerCount: number;
}

// Populated from JSONL analysis (30-day window).
// toolNamespaceCount uses result.toolDiversity as a proxy (global unique tool
// names across all sessions). v2 will replace this with per-session average.
export interface BehavioralProfile {
  subagentSessionCount: number;
  compactionEventCount: number;
  autoCompactionCount: number;
  manualCompactionCount: number;
  toolNamespaceCount: number;
}

export interface HarnessScore {
  config: ConfigAudit;
  behavioral: BehavioralProfile;
  configScore: number;      // 0-100
  behavioralScore: number;  // 0-100
  overall: number;          // Math.round(0.6 * configScore + 0.4 * behavioralScore)
  missingComponents: string[];
  strengths: string[];
}

// ── Config audit ──────────────────────────────────────────────────

function loadSettings(p: string): Record<string, unknown> {
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function auditConfig(cwd: string): ConfigAudit {
  const globalSettings = loadSettings(path.join(CLAUDE_DIR, 'settings.json'));
  const projectSettings = loadSettings(path.join(cwd, '.claude', 'settings.json'));
  // Project settings take precedence over global
  const merged = { ...globalSettings, ...projectSettings };

  const rootMdPath = path.join(cwd, 'CLAUDE.md');
  const globalMdPath = path.join(CLAUDE_DIR, 'CLAUDE.md');
  const mdPath = existsSync(rootMdPath) ? rootMdPath
               : existsSync(globalMdPath) ? globalMdPath
               : null;

  const hooks = (merged as any)?.hooks ?? {};
  // CC hook key casing is unverified (no hooks on dev machine) — use case-insensitive lookup
  const findHook = (key: string): boolean => {
    const lk = key.toLowerCase();
    const match = Object.keys(hooks).find(k => k.toLowerCase() === lk);
    return match ? Array.isArray(hooks[match]) && hooks[match].length > 0 : false;
  };

  return {
    hasRootClaudeMd: mdPath !== null,
    claudeMdWordCount: mdPath
      ? readFileSync(mdPath, 'utf8').split(/\s+/).filter(Boolean).length
      : null,
    hasSubdirectoryClaudeMds: false,
    hasHooks: {
      preToolUse: findHook('pretooluse'),
      postToolUse: findHook('posttooluse'),
      stop: findHook('stop'),
    },
    hasDenyPermissions:
      Array.isArray((merged as any)?.permissions?.deny) &&
      (merged as any).permissions.deny.length > 0,
    hasClaudeIgnore: existsSync(path.join(cwd, '.claudeignore')),
    mcpServerCount: Object.keys((merged as any)?.mcpServers ?? {}).length,
  };
}

// ── Scoring ───────────────────────────────────────────────────────

export function computeHarnessScore(
  config: ConfigAudit,
  behavioral: BehavioralProfile,
  totalSessions: number,
): HarnessScore {
  // Config score (max 100 pts) — rubric derived from Anthropic best practices docs
  let configScore = 0;

  if (config.hasRootClaudeMd) configScore += 25;
  if (config.claudeMdWordCount !== null) {
    if (config.claudeMdWordCount < 500) configScore += 15;
    else if (config.claudeMdWordCount <= 1500) configScore += 8; // yellow partial
    // > 1500: 0 pts (bloat)
  }
  if (config.hasHooks.stop) configScore += 20;
  if (config.hasHooks.preToolUse || config.hasHooks.postToolUse) configScore += 10;
  if (config.hasClaudeIgnore) configScore += 10;
  if (config.hasDenyPermissions) configScore += 10;
  if (config.mcpServerCount > 0) configScore += 10;

  // Behavioral score (max 100 pts)
  let behavioralScore = 0;

  if (totalSessions > 0) {
    const subagentRate = behavioral.subagentSessionCount / totalSessions;
    if (subagentRate > 0.20) behavioralScore += 50;
    else if (subagentRate >= 0.05) behavioralScore += 25; // yellow partial
  }
  // 0 compaction is informational (normal for short projects) — not penalized
  if (behavioral.compactionEventCount > 0) behavioralScore += 30;
  if (behavioral.toolNamespaceCount > 3) behavioralScore += 20;
  else if (behavioral.toolNamespaceCount >= 2) behavioralScore += 10; // yellow partial

  const overall = Math.round(0.6 * configScore + 0.4 * behavioralScore);

  const missingComponents: string[] = [];
  if (!config.hasHooks.stop) missingComponents.push('stop hook');
  if (!config.hasRootClaudeMd) missingComponents.push('CLAUDE.md');
  if (!config.hasClaudeIgnore) missingComponents.push('.claudeignore');

  const strengths: string[] = [];
  if (behavioral.subagentSessionCount > 0) strengths.push('subagent usage');
  if (behavioral.compactionEventCount > 0) strengths.push('context compaction');
  if (config.mcpServerCount > 0) strengths.push('MCP servers configured');

  return {
    config,
    behavioral,
    configScore,
    behavioralScore,
    overall,
    missingComponents,
    strengths,
  };
}
