export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface ContentBlock {
  type: string;
  text?: string;
  name?: string; // tool name for type === 'tool_use'
}

export interface RawEntry {
  type: string;
  uuid?: string;
  timestamp?: string;
  sessionId?: string;
  parentUuid?: string;
  isSidechain?: boolean;
  cwd?: string;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
    model?: string;
    usage?: Usage;
  };
}

export type PromptCategory =
  | 'fix'
  | 'implement'
  | 'explain'
  | 'refactor'
  | 'question'
  | 'vague'
  | 'other';

export interface UserPrompt {
  text: string;
  timestamp: Date;
  sessionId: string;
  projectName: string;
  wordCount: number;
  category: PromptCategory;
  vagueScore: number;
  followedByCorrection: boolean;
  contextBefore?: string; // truncated message immediately before this prompt
  contextAfter?: string;  // truncated message immediately after this prompt
}

export interface SessionStats {
  id: string;
  projectName: string;
  startTime: Date;
  endTime: Date;
  promptCount: number;
  correctionCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  costUSD: number;
  model: string;
  outputRatio: number | null; // write+edit share; null if < MIN_TOOL_CALLS
  medianVagueScore: number | null;   // null when session has no user prompts
}

export interface DailyUsage {
  date: string;
  outputTokens: number;
  cost: number;
  sessions: number;
  messages: number;
}

export interface ProjectStats {
  name: string;
  sessions: number;
  prompts: number;
  cost: number;
  cacheHitRate: number;
}

export interface AnalysisResult {
  totalSessions: number;
  totalPrompts: number;
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  cacheHitRate: number;
  avgPromptWords: number;
  correctionRate: number;
  promptCategories: Record<PromptCategory, number>;
  dailyUsage: DailyUsage[];
  projectStats: ProjectStats[];
  worstPrompts: UserPrompt[];
  unreadMoments: UnreadMoment[];
  daysAnalyzed: number;
  // tool & skill signals
  toolsUsed: string[];
  toolDiversity: number;
  totalToolCalls: number;
  slashCommandCount: number;
  medianFirstMessageWords: number;
  // output ratio metrics
  outputRatioByBucket: {
    specific: number | null; // median outputRatio where medianVagueScore < 3; null if N < 2
    vague: number | null;    // median outputRatio where medianVagueScore >= 3; null if N < 2
    nSpecific: number;
    nVague: number;
    nTotal: number;
  };
  medianOutputRatio: number | null; // overall median across all scored sessions
}

// ── Unread response moments ────────────────────────────────────

export interface UnreadMoment {
  claudeText: string;
  userFollowUp: string;
  aiCallout?: string;
  timestamp: Date;
  sessionId: string;
  projectName: string;
}

// ── Worst prompt rewrite ───────────────────────────────────────

export interface RewriteResult {
  diagnosis: string;
  rewrite: string;
}

// ── Goal system ────────────────────────────────────────────────

export interface GoalRubric {
  specificity: string;
  ownership: string;
  toolDiversity: string;
  frontloading: string;
  efficiency: string;
}

export interface GoalArchetype {
  id: string;
  label: string;
  tagline: string;
  rubric: GoalRubric;
}

export interface Goal {
  archetypeId: string;
  label: string;
  customization?: string;
  rubric: GoalRubric;
  createdAt: string;
}

// ── Coach report ───────────────────────────────────────────────

export interface SignalScore {
  score: number; // 1-10
  note: string;
}

export interface CoachReport {
  grade: string;
  gradeReason: string;
  signalScores: {
    specificity: SignalScore;
    ownership: SignalScore;
    toolDiversity: SignalScore;
    frontloading: SignalScore;
    efficiency: SignalScore;
  };
  worstMoments: Array<{
    original: string;
    diagnosis: string;
    better: string;
  }>;
  whatIsWorking: string;
  honestGap: string;
}
