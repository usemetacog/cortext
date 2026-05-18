import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { Goal, GoalArchetype } from './types';

const CORTEXT_DIR = join(homedir(), '.cortext');
const GOALS_FILE = join(CORTEXT_DIR, 'goals.json');

export const ARCHETYPES: GoalArchetype[] = [
  {
    id: 'staff-engineer',
    label: 'Staff Engineer',
    tagline: 'Precise, context-rich, minimal iteration',
    rubric: {
      specificity:
        'Every prompt includes file paths, error messages, or expected outcomes. No ambiguous asks.',
      ownership:
        'Pushes back on wrong output rather than accepting it. Defines acceptance criteria upfront.',
      toolDiversity:
        'Prompts unlock the full toolset — bash, file reads, web search, agent delegation.',
      frontloading:
        'First message in a session sets full context. Claude rarely needs to ask clarifying questions.',
      efficiency:
        'Gets to the right answer in ≤2 turns. Low correction rate. High value per dollar spent.',
    },
  },
  {
    id: 'tech-lead',
    label: 'Tech Lead',
    tagline: 'Strategic direction, systems thinking, delegates well',
    rubric: {
      specificity:
        'Prompts define scope and constraints, not just the task. Includes "don\'t do X" as often as "do Y".',
      ownership:
        'Sets technical direction explicitly. Challenges Claude\'s first proposal when it falls short.',
      toolDiversity:
        'Routinely uses agent delegation and multi-step workflows rather than one-shot asks.',
      frontloading:
        'Opens sessions with architectural context, not just the immediate task.',
      efficiency:
        'Avoids micro-managing — trusts Claude to fill in implementation details within clear constraints.',
    },
  },
  {
    id: 'product-visionary',
    label: 'Product Visionary',
    tagline: 'Opinionated, aesthetic-first, rejects mediocrity',
    rubric: {
      specificity:
        'Prompts articulate the *why* — what experience or outcome matters, not just the task.',
      ownership:
        'Actively rejects output that doesn\'t meet the bar. Iterates toward quality, not just completion.',
      toolDiversity:
        'Uses web search and external references to ground aesthetic decisions in real examples.',
      frontloading:
        'Sets the vision and standard upfront so Claude isn\'t guessing at taste.',
      efficiency:
        'Short prompt-to-great-output ratio. Doesn\'t settle for "good enough" at the cost of more turns.',
    },
  },
  {
    id: '10x-solo',
    label: '10x Solo Dev',
    tagline: 'Maximum autonomy, full tool leverage, no hand-holding',
    rubric: {
      specificity:
        'Prompts are dense — lots of context per word. Trusts Claude with implementation details.',
      ownership:
        'Ships fast. Doesn\'t over-correct or re-litigate Claude\'s choices without good reason.',
      toolDiversity:
        'Drives maximum tool diversity — bash, read, write, web, agents — across every session.',
      frontloading:
        'One strong opening prompt that lets Claude run autonomously through the session.',
      efficiency:
        'Extremely low correction rate. High output per dollar. Sessions are decisive.',
    },
  },
  {
    id: 'researcher',
    label: 'Researcher',
    tagline: 'Hypothesis-driven, depth over speed, exploratory',
    rubric: {
      specificity:
        'Prompts articulate the hypothesis or question being explored, not just "look at X".',
      ownership:
        'Probes Claude\'s reasoning. Asks for evidence, counter-examples, and confidence levels.',
      toolDiversity:
        'Heavy use of web search, file reads, and cross-referencing — not just bash execution.',
      frontloading:
        'Sets the research question and constraints before diving into execution.',
      efficiency:
        'Valued on insight per session, not speed. Tolerates longer sessions when depth warrants it.',
    },
  },
];

export function loadGoal(): Goal | null {
  if (!existsSync(GOALS_FILE)) return null;
  try {
    const raw = JSON.parse(readFileSync(GOALS_FILE, 'utf-8'));
    return (raw.active as Goal) ?? null;
  } catch {
    return null;
  }
}

export function saveGoal(goal: Goal): void {
  mkdirSync(CORTEXT_DIR, { recursive: true });
  let existing: { active?: Goal; history?: Goal[] } = {};
  if (existsSync(GOALS_FILE)) {
    try {
      existing = JSON.parse(readFileSync(GOALS_FILE, 'utf-8'));
    } catch {
      // ignore malformed file
    }
  }
  const history = existing.history ?? [];
  if (existing.active) {
    history.push({ ...existing.active });
  }
  writeFileSync(GOALS_FILE, JSON.stringify({ active: goal, history }, null, 2), 'utf-8');
}

export function clearGoal(): void {
  if (!existsSync(GOALS_FILE)) return;
  try {
    const existing = JSON.parse(readFileSync(GOALS_FILE, 'utf-8'));
    const history = existing.history ?? [];
    if (existing.active) history.push({ ...existing.active });
    writeFileSync(GOALS_FILE, JSON.stringify({ history }, null, 2), 'utf-8');
  } catch {
    // ignore
  }
}
