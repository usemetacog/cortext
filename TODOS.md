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
