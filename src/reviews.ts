import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { CoachReport, Goal } from './types';

const CORTEXT_DIR = join(homedir(), '.cortext');
const REVIEWS_FILE = join(CORTEXT_DIR, 'reviews.json');

const COOLDOWN_DAYS = 7;

export interface SavedReview {
  generatedAt: string; // ISO date string
  goalLabel: string;
  goalArchetypeId: string;
  daysAnalyzed: number;
  report: CoachReport;
}

interface ReviewsStore {
  latest?: SavedReview;
  history: SavedReview[];
}

function load(): ReviewsStore {
  if (!existsSync(REVIEWS_FILE)) return { history: [] };
  try {
    return JSON.parse(readFileSync(REVIEWS_FILE, 'utf-8')) as ReviewsStore;
  } catch {
    return { history: [] };
  }
}

export function loadLatestReview(): SavedReview | null {
  return load().latest ?? null;
}

export function saveReview(report: CoachReport, goal: Goal, daysAnalyzed: number): void {
  mkdirSync(CORTEXT_DIR, { recursive: true });
  const store = load();
  const entry: SavedReview = {
    generatedAt: new Date().toISOString(),
    goalLabel: goal.label,
    goalArchetypeId: goal.archetypeId,
    daysAnalyzed,
    report,
  };
  if (store.latest) store.history.push(store.latest);
  store.latest = entry;
  writeFileSync(REVIEWS_FILE, JSON.stringify(store, null, 2), 'utf-8');
}

// Returns days since the latest review, or null if none exists.
export function daysSinceLastReview(): number | null {
  const latest = loadLatestReview();
  if (!latest) return null;
  const ms = Date.now() - new Date(latest.generatedAt).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

export function isInCooldown(): boolean {
  const days = daysSinceLastReview();
  return days !== null && days < COOLDOWN_DAYS;
}

export { COOLDOWN_DAYS };
