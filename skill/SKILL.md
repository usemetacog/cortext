---
name: cortext
version: 0.13.0
description: |
  Claude Code prompt analytics. Reads ~/.claude/projects/ JSONL logs and reports
  behavioral patterns, harness health, efficiency signals, and cost breakdown.
  Use when: "show my usage", "how much have I spent", "token stats", "prompt analytics",
  "cost breakdown", "cortext".
allowed-tools:
  - Bash
triggers:
  - show my usage
  - token stats
  - cost breakdown
  - how much have I spent
  - prompt analytics
  - cortext
---

# /cortext — Claude Code Prompt Analytics

Run the cortext CLI and present the results inline.

```bash
npx cortext
```

After showing the output, briefly summarize the top signal (e.g. dominant prompt
pattern, correction rate, harness health grade, or biggest cost driver) in 1–2
sentences. If the user wants more detail, offer these subcommands:

- `npx cortext metrics` — token/cost breakdown, top projects, daily spend
- `npx cortext review` — AI coaching critique against their active goal
- `npx cortext goal` — set or change a coaching goal
- `npx cortext quiz` — quiz on the current git diff
- `npx cortext --days 7` — analyze a shorter window
- `npx cortext --analyze` — prompt improvement suggestions
