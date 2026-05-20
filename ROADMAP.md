# Roadmap

Gaps identified before the tool is genuinely useful to heavy Claude Code users.

---

## Open

### 2. No trend data — can't see improvement over time
The tool gives a snapshot, not a trajectory. There's no comparison to a prior period (e.g. "vague prompt rate: 28% → 19%"). The coaching review has a 7-day cooldown but no diff against the previous report. Behavior change requires visible movement.

### 3. Vague classifier misfires on expert users
The word-count heuristic doesn't account for conversational context. A power user typing "do it" after 20 turns of rich back-and-forth is being efficient, not vague. False positives on the worst-prompt list undermine trust in all the other signals.

### 4. API key gate blocks the most useful features
`--analyze` and `review` require `ANTHROPIC_API_KEY`. Subscription users don't have one readily available — they'd need to set up a separate API billing account. This locks out the features that differentiate cortext from a plain stats dashboard.

### 5. First-run experience has a hidden prerequisite
`npx cortext review` silently requires `npx cortext goal` to have been run first. New users hit an error with no helpful guidance. The onboarding flow is not self-directing.

---

## Done

### 1. Cost display is misleading for subscription users
Relabeled all cost figures as "API equiv. cost" (TUI) and "API Equiv. Cost" / "API Cost" (web dashboard) throughout `renderer.ts` and `server.ts`. The `~$` prefix on per-day and per-project figures further signals estimation. The number remains — it's useful context — but the framing no longer implies the user was billed that amount.
