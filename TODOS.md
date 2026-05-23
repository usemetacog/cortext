# TODOS

## Harness Health v2

### TODO-1: Per-session tool namespace average for behavioral scoring
**What:** Replace global `toolDiversity` proxy with per-session unique tool name average in `BehavioralProfile.toolNamespaceCount`.

**Why:** The v1 proxy (global unique tools across all sessions) overstates diversity for users who use many tools but never in the same session. The behavioral score awards 20 pts for `toolNamespaceCount > 3` — that threshold means different things depending on how the count is computed.

**Pros:** Scoring reflects actual session behavior. Can be calibrated meaningfully after v1 ships and real data is observed.

**Cons:** Requires adding a per-session `Set<string>` inside the `analyze()` loop, a new `avgToolNamesPerSession` field on `AnalysisResult`, and updating the mapping in `index.ts`.

**Context:** Consciously deferred during /plan-eng-review on 2026-05-22 because v1 thresholds are directional heuristics. Revisit after v1 ships and real scores are observed.

**Files:** `src/analyzer.ts`, `src/types.ts`, `src/harness.ts`

**Depends on:** v1 harness health feature shipping first.

## Persona Coaching v2

### TODO-2: Multi-persona tracking
**What:** Support tracking alignment toward multiple simultaneously declared personas (e.g., "product wizard" AND "design engineer" at once).

**Why:** Some users are growing in two directions simultaneously. Forcing a single persona declaration creates false conflict for dual-track users who want to see "product wizard: 62%, design engineer: 38%."

**Pros:** Unlocks the full generality of the coaching frame; users see a multi-dimensional growth picture rather than a single score.

**Cons:** TUI layout complexity increases; alignment scores become a vector not a scalar; threshold tuning doubles; `computeAlignmentTrajectory()` must run once per declared persona.

**Context:** Explicitly deferred in persona coaching design doc (nathanchiu-main-design-20260523-100403.md §Open Questions #3). v1 architecture uses a single `archetypeId` in `Goal`. Supporting multi-persona requires either an `archetypeIds: string[]` array or a separate `secondaryPersonas` field on `Goal` in `types.ts`. Surfaced during /plan-eng-review on 2026-05-23.

**Files:** `src/types.ts`, `src/goals.ts`, `src/analyzer.ts`, `src/renderer.ts`

**Depends on:** v1 persona coaching feature (Step 1–7 in design doc) shipping first.

### TODO-3: MCP/Operator persona archetype
**What:** Add an `operator` or `mcp-orchestrator` archetype to `src/personas.ts` for users who work primarily through MCP tool integrations.

**Why:** MCP power users have a distinct behavioral signature (high `mcp__<server>__<tool>` use, low raw Bash/Write ratio) that the current fingerprint table cannot detect. Without this archetype, MCP-heavy users score low on all existing fingerprints and get misleading coaching.

**Pros:** Closes the gap for a growing user segment as MCP integrations expand in Claude Code.

**Cons:** Requires extending `computePersonaAlignment()` to handle `mcp__*` tool name prefix patterns (regex match) rather than exact string matching.

**Context:** Explicitly deferred in design doc (nathanchiu-main-design-20260523-100403.md) — footnote under fingerprint table: "Operator persona (MCP-heavy) deferred to v2." Surfaced during /plan-eng-review on 2026-05-23.

**Files:** `src/personas.ts`, `src/analyzer.ts`, `src/goals.ts`

**Depends on:** v1 persona coaching feature shipping first; `computePersonaAlignment()` must be refactored to support pattern-based tool name matching.

### TODO-4: Human annotation on journal entries (--note flag)
**What:** Add an optional `--note "text"` argument to `cortext --session-score` so users can annotate a session with a free-text note explaining unusual scores.

**Why:** Sometimes a low score has a reason ("I was interrupted," "this was a quick hotfix"). Without notes, the coaching history has no context for outliers.

**Pros:** Makes the behavioral journal conversational; outliers become understandable rather than confusing.

**Cons:** Requires extending JournalEntry schema; user-facing note storage increases privacy surface slightly (notes are text, not just tool names).

**Context:** Deferred from /plan-ceo-review cherry-pick ceremony on 2026-05-23. Approach C (behavioral journal) was accepted; this was the next natural extension. The JournalEntry schema should already have a `note?: string` optional field as of v1 to make this a non-breaking v1.1 addition.

**Files:** `src/types.ts` (JournalEntry), `src/reader.ts` (writeJournalEntry), `src/index.ts` (--session-score --note flag), `src/renderer.ts` (show note in top-3 exemplary sessions display)

**Depends on:** v1 journal implementation shipping first.

### TODO-5: Persona drift detection
**What:** After 30 days of activity, if the user's behavior has shifted significantly (new anti-signals appearing, high-signal tools disappearing), prompt them to confirm or update their declared persona.

**Why:** Users evolve. A developer who declared "10x-solo" in January may have joined a team by March and shifted to "tech-lead" patterns. Without drift detection, the coaching feedback becomes stale and misleading.

**Pros:** Keeps the coaching loop relevant over time; makes persona feel like a living declaration rather than a one-time setup.

**Cons:** Requires computing anti-signal rate over time + a prompt mechanism; adds complexity to the trajectory computation.

**Context:** Deferred from /plan-ceo-review cherry-pick ceremony on 2026-05-23. The journal backfill and trajectory are the foundation; drift detection reads from the same data.

**Files:** `src/analyzer.ts` (anti-signal rate computation), `src/renderer.ts` (drift prompt in TUI), `src/index.ts` (prompt handling)

**Depends on:** v1 journal + trajectory implementation.

### TODO-6: Score explanation mode (--explain flag)
**What:** Add a `cortext --session-score {id} --explain` flag that shows the exact JSONL tool calls that triggered (or failed to trigger) each persona signal.

**Why:** Users need to understand WHY a session scored 2/5. Showing "ExitPlanMode: not found in session" + "WebSearch: found 3 times" builds trust in the scoring system and makes it debuggable.

**Pros:** Directly addresses the "black box" concern about behavioral fingerprints; essential for dogfood debugging.

**Cons:** Only useful for power users and debugging; not needed for the core coaching UX.

**Context:** Deferred from /plan-ceo-review cherry-pick ceremony on 2026-05-23. Good for the dogfood phase (Step 7 in the design doc) where fingerprint accuracy is being validated.

**Files:** `src/index.ts` (--explain flag), `src/analyzer.ts` (computePersonaAlignment verbose mode)

**Depends on:** v1 --session-score command and computePersonaAlignment implementation.

### TODO-7: Journal schema versioning
**What:** Add `schemaVersion: number` field (starting at `1`) to `JournalEntry` interface and ensure the journal reader skips or gracefully handles entries from unknown schema versions.

**Why:** The journal is the first write surface in cortext. Adding v2 fields (notes, tags, drift flags) without version tracking requires inspecting every field's presence individually. Schema versioning makes future migrations trivial.

**Pros:** One-line addition to JournalEntry; reader-side version check is 3 lines; prevents silent data errors when fields are added or changed in future versions.

**Cons:** One extra field per journal line (negligible overhead).

**Context:** Surfaced during /plan-ceo-review Section 10 (long-term trajectory review) on 2026-05-23. The v1 journal is the right moment to establish versioning — retrofitting it after entries exist requires a migration.

**Files:** `src/types.ts` (JournalEntry), `src/reader.ts` (readJournal version check)

**Depends on:** v1 journal implementation shipping first.
