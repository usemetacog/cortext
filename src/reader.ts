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

export function readProjects(days: number): ProjectData[] {
  if (!existsSync(PROJECTS_DIR)) {
    console.error("empty dir");
    return [];
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

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
            if (!entry.timestamp || new Date(entry.timestamp) >= cutoff) {
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
