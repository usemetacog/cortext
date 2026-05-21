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
