# Roadmap

Gaps identified before the tool is genuinely useful to heavy Claude Code users.

---

## Open

### 6. No harness health visibility — prompt quality without environment quality is half the picture
cortext measures how you prompt but not whether your harness is set up to let you do your best work. CLAUDE.md structure, hooks, subagent usage, compaction patterns, and permission configuration all shape what Claude can do before a prompt fires. A high vagueness score looks different if your CLAUDE.md is 2000 words of noise. The two layers belong together.

Planned: `ConfigAudit` (reads `~/.claude/settings.json`, `CLAUDE.md`, `.claudeignore`) + `BehavioralProfile` (subagent sessions, compaction events from JSONL) → `HarnessScore` with `overall = 0.6×config + 0.4×behavioral`. New HARNESS HEALTH TUI panel. Source of truth: Anthropic harness design docs. Design: `~/.gstack/projects/usemetacog-cortext/nathanchiu-nate-harness-design-20260522-102745.md`

### 2. No trend data — can't see improvement over time
The tool gives a snapshot, not a trajectory. There's no comparison to a prior period (e.g. "vague prompt rate: 28% → 19%"). The coaching review has a 7-day cooldown but no diff against the previous report. Behavior change requires visible movement.



---

## Done

### 4. API key gate blocks the most useful features
Replaced terse `ANTHROPIC_API_KEY not set` errors in `coach.ts` and `suggester.ts` with contextual messages explaining the API/subscription distinction, linking to `console.anthropic.com`, and giving the exact export command and shell rc tip. Upgraded `heuristicDiagnosis` in `rewriter.ts` from passive "Missing: no file path" to prescriptive actionable fixes, so the no-key worst-prompt experience is genuinely useful.

### 5. First-run experience has a hidden prerequisite
`runGoalWizard` now returns `Goal | null`. `runReview` calls it inline when no goal is found, then continues straight into the review on success — no second command needed. The "run npx cortext review" hint is preserved when the wizard is invoked directly via `npx cortext goal`.

### 3. Vague classifier misfires on expert users
Added context parameters to `vagueScore`: `-1` if the prompt is not the session opener, `-2` if the prior user message was >30 words. Moved vague score computation from the context-blind first pass into the `messageSequence` loop where turn index and prior message word count are available. Short follow-ups in established conversations no longer get flagged.

### 1. Cost display is misleading for subscription users
Relabeled all cost figures as "API equiv. cost" (TUI) and "API Equiv. Cost" / "API Cost" (web dashboard) throughout `renderer.ts` and `server.ts`. The `~$` prefix on per-day and per-project figures further signals estimation. The number remains — it's useful context — but the framing no longer implies the user was billed that amount.
