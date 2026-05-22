# cortext

Reflection for your Claude Code prompts.

```
╔════════════════════════════════════════════════════════════╗
║ cortext  ·  reflection for your claude code prompts        ║
╠════════════════════════════════════════════════════════════╣
║ OVERVIEW                                                   ║
║ 30 days  ·  45 sessions  ·  481 prompts                    ║
║                                                            ║
║ Total spend:    $152.52       Cache hit rate:  97%         ║
║ Input tokens:   60k           Output tokens:   2.6M        ║
╠════════════════════════════════════════════════════════════╣
║ DAILY USAGE  (last 30 days)                                ║
║ May 11  ██████████████████   857k out   $50.01             ║
║ May 12  ███████░░░░░░░░░░░   357k out   $19.66             ║
╠════════════════════════════════════════════════════════════╣
║ PROMPT PATTERNS                                            ║
║ Question     ███░░░░░░░░░░░░░   18%    (86)                ║
║ Vague        ████░░░░░░░░░░░░   23%   (109)                ║
╠════════════════════════════════════════════════════════════╣
║ EFFICIENCY SIGNALS                                         ║
║ [!] 109 prompts were too short to be actionable            ║
║ [!] 8 sessions had correction turns                        ║
║ [✓] Excellent cache hit rate (97%)                         ║
╠════════════════════════════════════════════════════════════╣
║ HARNESS HEALTH                                 Score: 68/100 ║
║                                                            ║
║ Config                                                     ║
║   ✓ CLAUDE.md (312 words)                                  ║
║   ✗ stop hook                                              ║
║   ✗ pre/post tool hook                                     ║
║   ✓ .claudeignore                                          ║
║   ✓ deny permissions                                       ║
║   ✓ MCP servers (3)                                        ║
║                                                            ║
║ Behavioral                                                 ║
║   ✓ subagent sessions (12)                                 ║
║     └ output ratio 4.21 vs 2.87 single-agent  +47%        ║
║   ✓ compaction events (8  auto: 6 / manual: 2)             ║
║   ✓ tool diversity (5 namespaces)                          ║
╚════════════════════════════════════════════════════════════╝
```

## Why this matters
As AI tools level up, we should too. My hope is Cortext asks us to think, reflect, and action on what we observe and learn.

## Install

**Option 1 — npx (zero install):**

```bash
npx cortext
```

**Option 2 — Claude Code skill:**

If you use Claude Code, you can run cortext as a `/cortext` slash command directly in your session. Copy the skill file into your Claude skills directory:

```bash
mkdir -p ~/.claude/skills/cortext
curl -o ~/.claude/skills/cortext/SKILL.md \
  https://raw.githubusercontent.com/usemetacog/cortext/main/skill/SKILL.md
```

Then type `/cortext` in any Claude Code conversation to get your usage report inline.

## Usage

**CLI:**
```bash
npx cortext                   # last 30 days
npx cortext --days 7          # last 7 days
npx cortext --web             # open browser dashboard
npx cortext --analyze         # + AI prompt improvement (needs ANTHROPIC_API_KEY)
npx cortext review            # AI coaching report (needs ANTHROPIC_API_KEY + goal set)
npx cortext review --force    # regenerate review, bypassing 7-day cooldown
npx cortext --help
```

**Claude Code skill:**
```
/cortext
```

## What it shows

**Overview** — total spend, cache hit rate, token breakdown

**Daily usage** — bar chart of output tokens and cost per day

**Prompt patterns** — how your prompts break down across fix/debug, implement, explain, refactor, question, vague, and other categories

**Efficiency signals** — median prompt length, correction rate (sessions where you had to redirect Claude), and actionable flags

**Top projects by spend** — where your tokens are going

**Worst prompt** — the lowest-quality prompt from the period, with the message before and after it for context, plus an AI-generated rewrite

**Did you read my response?** — moments where your follow-up question asked about something Claude's previous response already covered; add `ANTHROPIC_API_KEY` for a one-line callout on each catch

**Harness health** — scored audit of how well your Claude Code setup follows Anthropic best practices (see below)

## Browser dashboard

```bash
npx cortext --web
```

Starts a local HTTP server and opens a dark-theme dashboard in your browser with the same data as the TUI: spend, daily usage, prompt categories, top projects, efficiency signals, worst prompt rewrite, and the "did you read my response?" section. No new dependencies — served directly from the CLI.

## AI prompt improvement

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npx cortext --analyze
```

Picks your 5 most vague or corrected prompts, sends them to `claude-sonnet-4-6`, and returns a diagnosis + improved version for each one.

## Coaching reviews

```bash
npx cortext goal    # set your goal/persona first
npx cortext review  # get a coaching report against that goal
```

Reviews are saved to `~/.cortext/reviews.json`. Running `npx cortext review` within 7 days of the last report shows the cached report instead of regenerating — so you have time to act on the feedback before measuring again. Use `--force` to bypass the cooldown:

```bash
npx cortext review --force
```

## Harness health

```bash
npx cortext   # harness health panel appears at the bottom of the TUI
```

Scores your Claude Code setup on a 0–100 scale, weighted 60% config / 40% behavioral, derived from [Anthropic's best practices](https://code.claude.com/docs/en/best-practices).

**Config signals** (read from `~/.claude/settings.json` + `.claude/settings.json`):

| Signal | Points |
|---|---|
| CLAUDE.md present | 25 |
| CLAUDE.md length < 500 words (focused) | 15 |
| Stop hook configured | 20 |
| Pre/post tool hook configured | 10 |
| `.claudeignore` present | 10 |
| Deny permissions list | 10 |
| MCP servers configured | 10 |

**Behavioral signals** (derived from your 30-day JSONL history):

| Signal | Points |
|---|---|
| Subagent sessions > 20% of total | 50 |
| Any compaction events | 30 |
| Tool diversity > 3 namespaces | 20 |

The panel also surfaces two correlations when enough data is present:
- **Subagent output ratio** — compares output tokens/prompt in subagent vs. single-agent sessions, showing whether subagents are returning more useful work
- **Context pressure vs. correction rate** — flags sessions that hit > 80k tokens and shows whether they had a higher correction rate than shorter sessions

## Data source

Reads from `~/.claude/projects/` — the local session store that Claude Code writes automatically. Nothing leaves your machine except when you explicitly use `--analyze`.

## Contributing

Open source under MIT. PRs welcome.

```bash
git clone https://github.com/usemetacog/cortext
cd cortext
npm install
npm run dev      # runs src/index.ts directly via tsx
npm run build    # bundles to dist/index.js
```
