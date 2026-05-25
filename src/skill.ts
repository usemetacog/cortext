import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { version } from '../package.json';

const SKILL_DIR = join(homedir(), '.claude', 'skills', 'cortext');
const SKILL_PATH = join(SKILL_DIR, 'SKILL.md');

// Embedded skill content — updated on every npx cortext run if the version differs.
// Backtick fences are escaped so the template literal stays valid.
const SKILL_CONTENT = `---
name: cortext
version: ${version}
description: |
  Claude Code prompt analytics. Reads ~/.claude/projects/ JSONL logs and reports
  behavioral patterns, harness health, efficiency signals, and cost breakdown.
  Use when: "show my usage", "how much have I spent", "token stats", "prompt analytics",
  "cost breakdown", "cortext".
allowed-tools:
  - Bash
triggers:
  - show my usage
  - token stats
  - cost breakdown
  - how much have I spent
  - prompt analytics
  - cortext
---

# /cortext — Claude Code Prompt Analytics

Run the cortext CLI and present the results inline.

\`\`\`bash
npx cortext
\`\`\`

After showing the output, briefly summarize the top signal (e.g. dominant prompt
pattern, correction rate, harness health grade, or biggest cost driver) in 1–2
sentences. If the user wants more detail, offer these subcommands:

- \`npx cortext metrics\` — token/cost breakdown, top projects, daily spend
- \`npx cortext review\` — AI coaching critique against their active goal
- \`npx cortext goal\` — set or change a coaching goal
- \`npx cortext quiz\` — quiz on the current git diff
- \`npx cortext --days 7\` — analyze a shorter window
- \`npx cortext --analyze\` — prompt improvement suggestions
`;

function installedVersion(): string | null {
  if (!existsSync(SKILL_PATH)) return null;
  try {
    const content = readFileSync(SKILL_PATH, 'utf-8');
    const match = content.match(/^version:\s*(.+)$/m);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * Silently writes (or updates) ~/.claude/skills/cortext/SKILL.md if the
 * installed version doesn't match the current package version. Called once at
 * startup — never surfaces errors to the user.
 */
export function installSkill(): void {
  try {
    if (installedVersion() === version) return;
    mkdirSync(SKILL_DIR, { recursive: true });
    writeFileSync(SKILL_PATH, SKILL_CONTENT, 'utf-8');
  } catch {
    // Skill install is best-effort. Never block the CLI on a file-write failure.
  }
}
