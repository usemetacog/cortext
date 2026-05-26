# cortext

Claude Code prompt analytics CLI. Reads `~/.claude/projects/` JSONL, computes token/cost stats, renders a TUI dashboard.

## Commands
- `npm run build` — esbuild bundle → `dist/index.js`
- `npm run dev` — run via tsx (no build step)
- `npm test` — vitest

## Source of truth for new features

IMPORTANT: https://code.claude.com/docs/en/best-practices is the authoritative reference for what Claude Code users actually need. Before designing any new feature, check whether the docs describe a pattern, pain point, or workflow that the feature should address. New features should map to documented best practices — not hypothetical ones.

## Source of truth for user-facing suggestions

IMPORTANT: When generating suggestions, coaching feedback, prompt rewrites, or any user-facing advice (in `review`, `rewriter`, the goal system, or any future surface), the Claude Code best practices at https://code.claude.com/docs/en/best-practices must be the heaviest weight. Concrete examples from the docs (e.g. specific prompt structures, /clear usage, subagent delegation, CLAUDE.md tips) are preferred over generic advice. If a suggestion isn't grounded in these docs, it should not be the lead recommendation.

## Design System

Always read DESIGN.md before making any visual or UI changes to `src/renderer.ts`.
All color semantics, section ordering, bar valence, and layout decisions are defined there.
Do not deviate without explicit user approval.

Key rules derived from DESIGN.md:
- `chalk.cyan` is reserved for rewrite text only — never section labels or bars
- Section labels go inside the divider line via `namedDivider()`, not above content
- Bars accept a `valence` param — `vague` category is always `'warn'` (yellow fill)
- Behavioral Reads lead with no "YOUR READS" label above them
- Header is one line: `cortext · N days · N sessions · N prompts` (no tagline)

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
