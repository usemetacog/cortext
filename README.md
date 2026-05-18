# cortext

Metacognition for your Claude Code prompts.

```
╔════════════════════════════════════════════════════════════╗
║ cortext  ·  metacognition for your claude code prompts     ║
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
╚════════════════════════════════════════════════════════════╝
```

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
npx cortext --analyze         # + AI prompt improvement (needs ANTHROPIC_API_KEY)
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

## AI prompt improvement

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npx cortext --analyze
```

Picks your 5 most vague or corrected prompts, sends them to `claude-sonnet-4-6`, and returns a diagnosis + improved version for each one.

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
