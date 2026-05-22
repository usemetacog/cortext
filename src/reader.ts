import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import type { RawEntry } from "./types";

const CLAUDE_DIR = join(homedir(), ".claude");
const PROJECTS_DIR =
  process.env.CORTEXT_DATA_DIR ?? join(CLAUDE_DIR, "projects");

export interface ProjectData {
  name: string;
  entries: RawEntry[];
}

export function readProjects(days: number, offsetDays = 0): ProjectData[] {
  if (!existsSync(PROJECTS_DIR)) {
    console.error("empty dir");
    return [];
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days - offsetDays);

  // When reading a prior period, we also need an upper bound
  const upperBound: Date | null = offsetDays > 0 ? (() => {
    const d = new Date();
    d.setDate(d.getDate() - offsetDays);
    return d;
  })() : null;

  const results: ProjectData[] = [];
  let projectDirs: string[];

  try {
    projectDirs = readdirSync(PROJECTS_DIR);
  } catch (err) {
    console.error(err);
    return [];
  }

  for (const dirName of projectDirs) {
    const projectDir = join(PROJECTS_DIR, dirName);
    try {
      if (!statSync(projectDir).isDirectory()) continue;
    } catch {
      continue;
    }

    const entries: RawEntry[] = [];
    let projectName = "";

    try {
      const files = readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));

      for (const file of files) {
        const content = readFileSync(join(projectDir, file), "utf-8");
        for (const line of content.split("\n")) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line) as RawEntry;
            // Use cwd to get the real project name
            if (!projectName && entry.cwd) {
              projectName = basename(entry.cwd);
            }
            // Filter to date range (entries without timestamps are included)
            const ts = entry.timestamp ? new Date(entry.timestamp) : null;
            const inWindow =
              !ts ||
              (ts >= cutoff && (upperBound === null || ts < upperBound));
            if (inWindow) {
              entries.push(entry);
            }
          } catch {
            // skip malformed JSON lines
          }
        }
      }
    } catch {
      continue;
    }

    if (entries.length === 0) continue;

    // Fall back to decoding dir name if no cwd found
    if (!projectName) {
      projectName = dirName.split("-").pop() ?? dirName;
    }

    results.push({ name: projectName, entries });
  }

  return results;
}

export function detectSubagentSessions(days: number, offsetDays = 0): number {
  // Re-evaluate at call time so CORTEXT_DATA_DIR can be overridden in tests
  const projectsDir = process.env.CORTEXT_DATA_DIR ?? join(homedir(), '.claude', 'projects');
  if (!existsSync(projectsDir)) return 0;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days - offsetDays);
  const upperBound: Date | null = offsetDays > 0
    ? (() => { const d = new Date(); d.setDate(d.getDate() - offsetDays); return d; })()
    : null;

  let count = 0;

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(projectsDir);
  } catch {
    return 0;
  }

  for (const dirName of projectDirs) {
    const projectDir = join(projectsDir, dirName);
    try {
      if (!statSync(projectDir).isDirectory()) continue;
    } catch {
      continue;
    }

    let files: string[];
    try {
      files = readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }

    for (const file of files) {
      const sessionId = file.slice(0, -'.jsonl'.length);
      try {
        const mtime = statSync(join(projectDir, file)).mtime;
        if (mtime < cutoff) continue;
        if (upperBound !== null && mtime >= upperBound) continue;
      } catch {
        continue;
      }
      const subagentDir = join(projectDir, sessionId, 'subagents');
      try {
        if (statSync(subagentDir).isDirectory() && readdirSync(subagentDir).length > 0) {
          count++;
        }
      } catch {
        // No subagents dir for this session — expected for most sessions
      }
    }
  }

  return count;
}

export function extractUserText(
  content: string | Array<{ type: string; text?: string }>,
): string | null {
  if (typeof content === "string") {
    const t = content.trim();
    // Skip slash-command XML wrappers and empty strings
    if (!t || t.startsWith("<")) return null;
    return t;
  }

  if (Array.isArray(content)) {
    const parts = content
      .filter((b) => b.type === "text" && b.text)
      .map((b) => (b.text ?? "").trim())
      .filter((t) => t && !t.startsWith("<"));
    return parts.length > 0 ? parts.join(" ") : null;
  }

  return null;
}
