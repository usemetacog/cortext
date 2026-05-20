# Roadmap

Gaps identified before the tool is genuinely useful to heavy Claude Code users.

---

## Open

### 2. No trend data — can't see improvement over time
The tool gives a snapshot, not a trajectory. There's no comparison to a prior period (e.g. "vague prompt rate: 28% → 19%"). The coaching review has a 7-day cooldown but no diff against the previous report. Behavior change requires visible movement.

### 4. API key gate blocks the most useful features
`--analyze` and `review` require `ANTHROPIC_API_KEY`. Subscription users don't have one readily available — they'd need to set up a separate API billing account. This locks out the features that differentiate cortext from a plain stats dashboard.

### 5. First-run experience has a hidden prerequisite
`npx cortext review` silently requires `npx cortext goal` to have been run first. New users hit an error with no helpful guidance. The onboarding flow is not self-directing.

---

## Done

### 3. Vague classifier misfires on expert users
Added context parameters to `vagueScore`: `-1` if the prompt is not the session opener, `-2` if the prior user message was >30 words. Moved vague score computation from the context-blind first pass into the `messageSequence` loop where turn index and prior message word count are available. Short follow-ups in established conversations no longer get flagged.

### 1. Cost display is misleading for subscription users
Relabeled all cost figures as "API equiv. cost" (TUI) and "API Equiv. Cost" / "API Cost" (web dashboard) throughout `renderer.ts` and `server.ts`. The `~$` prefix on per-day and per-project figures further signals estimation. The number remains — it's useful context — but the framing no longer implies the user was billed that amount.
