# Design System — cortext

## Product Context
- **What this is:** CLI analytics tool that reflects Claude Code usage back at the developer — behavioral reads, prompt quality signals, cost/token breakdown, harness health
- **Who it's for:** Claude Code power users who run it daily and want honest feedback on how they're prompting
- **Space/industry:** Developer tooling, AI productivity, CLI analytics
- **Project type:** Terminal UI (TUI) — fixed-width box-drawing characters, ANSI color via chalk

## The Memorable Thing

> "This is a mirror, not a dashboard."

The output confronts you with a fact about yourself. It does not flatter. Chrome recedes; data surfaces. The product does not explain itself on every run.

## Aesthetic Direction
- **Direction:** Industrial Forensics — the visual language of instruments and ledgers. A terminal that grew up.
- **Decoration level:** Minimal — color weight and case do all the work. No decorative characters or padding for aesthetics.
- **Mood:** Precise, slightly cold, honest.

---

## Semantic Color System

The cardinal rule: **color encodes meaning, never hierarchy or decoration.** Each chalk call has exactly one role.

| chalk call | Semantic role | Used for |
|---|---|---|
| `chalk.dim` | Chrome | Borders (`║ ╔ ╠`), dividers, section labels, timestamps, metadata, footer commands, secondary explanations |
| `chalk.white` | Primary data | Counts, costs, percentages, session counts, project names |
| `chalk.bold` / `chalk.bold.white` | Emphasis | The one number that matters most in a section. Use sparingly. |
| `chalk.green` | Positive signal | Good cache rate, low correction rate, passing harness checks |
| `chalk.red` | Bad signal | High correction rate, failing harness checks, regressions, `▸` on bad reads |
| `chalk.yellow` | Watch signal | Moderate warnings, elevated vague rate, things to monitor |
| `chalk.cyan` | Rewrite text only | The rewritten prompt in WORST PROMPT and AI analysis output. **One role, nowhere else.** |

**Anti-patterns to avoid:**
- `chalk.cyan` on section labels, bar fills, or any structural element
- `chalk.bold.cyan` for anything other than transitional legacy — migrate to `chalk.dim` (label) or `chalk.white` (data)
- Color on any element that doesn't carry information — decoration is not permitted

---

## Information Hierarchy (section order)

Sections appear in this order. The rationale is mirror-first: what's most confrontational leads.

1. **Header** — product name + stats. One line. No tagline.
2. **Behavioral Reads** — no section label. First content after divider. The reads ARE the product.
3. **Prompt Patterns** — bars with valence-encoded fill color
4. **Efficiency Signals** — inline lines; color carries signal (no `[!]`/`[✓]` notation)
5. **Week in Review**
6. **Worst Prompt**
7. **Did You Read My Response?**
8. **Session Metrics**
9. **Goal Progress**
10. **Harness Health**
11. **Footer commands** — grouped, all dim

---

## Header

```
╔════════════════════════════════════════════════════════════╗
║ cortext  ·  30 days  ·  45 sessions  ·  481 prompts        ║
╠══ reads ═══════════════════════════════════════════════════╣
```

- **Drop the tagline.** "metacognition for your claude code prompts" is chrome — it explains the product to users who already know what it is. Remove it.
- Stats on the same line as the product name.
- First section label is built into the first divider.

Implementation:
```typescript
lines.push(top());
lines.push(line(
  chalk.bold.white('cortext') +
  chalk.dim(`  ·  ${result.daysAnalyzed} days  ·  ${result.totalSessions} sessions  ·  ${result.totalPrompts} prompts`)
));
lines.push(namedDivider('reads'));
```

---

## Section Labels

Section labels absorb into the divider line. They are dim, lowercase, no bold.

```typescript
function namedDivider(label: string): string {
  // ╠══ label ══════...══╣
  const inner = WIDTH - 2; // between ╠ and ╣
  const prefix = '══ ' + label + ' ';
  const fill = Math.max(0, inner - prefix.length);
  return chalk.dim('╠' + prefix + '═'.repeat(fill) + '╣');
}
```

**Rendered example:**
```
╠══ prompt patterns ═════════════════════════════════════════╣
╠══ efficiency signals ══════════════════════════════════════╣
╠══ harness health ══════════════════════════════════════════╣
```

**Why:** A label above content is an announcement. A label in the divider is a separator — it orients without interrupting.

Unnamed dividers (major structural breaks) keep the existing `divider()` call.

---

## Behavioral Reads — Lead With No Label

The reads appear immediately after the `╠══ reads ═══╣` divider with no "YOUR READS" header above them.

```
╠══ reads ═══════════════════════════════════════════════════╣
║                                                            ║
║  ▸  23% corrections — redirecting more than directing      ║
║                                                            ║
║  ▸  18% vague — ambiguity costs turns every time           ║
║                                                            ║
║  ✓  97% cache hit rate                                     ║
║                                                            ║
```

- `▸` in the valence color (red for bad, yellow for warn)
- `✓` in green for positive reads
- Text in the same valence color as the icon
- Blank lines between reads

The persona/goal label ("for high-agency, high-taste operator") moves to a dim line at the **bottom** of the reads section, if a goal is set. It no longer appears before the reads.

```typescript
// After all reads are rendered, if goal exists:
if (goal) {
  lines.push(line(chalk.dim(`  for  ${goal.label}`)));
}
```

---

## Bar Charts

Bars encode valence through fill color.

```typescript
function bar(
  fraction: number,
  maxWidth: number,
  valence: 'warn' | 'neutral' | 'positive' = 'neutral'
): string {
  const filled = Math.round(fraction * maxWidth);
  const empty = maxWidth - filled;
  const fillColor =
    valence === 'warn'     ? chalk.yellow :
    valence === 'positive' ? chalk.green  :
                             chalk.white;
  return fillColor('█'.repeat(filled)) + chalk.dim('░'.repeat(empty));
}
```

**Valence mapping for prompt categories:**

| Category | Valence |
|---|---|
| `vague` | `'warn'` always |
| `question` | `'warn'` if rate > 20%, else `'neutral'` |
| `fix` | `'neutral'` |
| `implement` | `'positive'` |
| `explain` | `'neutral'` |
| `refactor` | `'neutral'` |
| `other` | `'neutral'` |

A high vague bar renders yellow and looks like a warning without requiring a `[!]` label. The data speaks.

---

## Efficiency Signals — Drop `[!]`/`[✓]` Notation

Replace bracket notation with color-only signals. The bracket is punctuation doing work that color should do.

```
before:  [!] 109 prompts were too short to be actionable
after:   109 prompts too short — add outcome + constraints upfront

before:  [✓] Excellent cache hit rate (97%)
after:   97% cache hit rate
```

The `chalk.yellow` / `chalk.green` / `chalk.red` on the line itself carries the signal. No bracket needed.

---

## Spacing

- **Box width:** 62 characters (`WIDTH = 62`)
- **Between reads:** one blank line
- **Between bar rows:** no blank lines (dense = intentional)
- **Before named dividers:** no extra blank line — the divider is the separator
- **Section breathing room:** sections that contain narrative content (WORST PROMPT, READS) get a blank line after the divider before content starts

---

## Motion

Terminal output is static. No motion.

Exception: the spinner on loading/analysis commands (`src/spinner.ts`). Keep as-is.

---

## Decisions Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-05-25 | CLI-first surface | cortext is a terminal tool; web UI is aspirational, not the primary surface |
| 2026-05-25 | Semantic color system — cyan reserved for rewrite text only | cyan was overloaded on labels, bars, and analysis output simultaneously; stripping it to one role gives it meaning |
| 2026-05-25 | Section labels absorbed into divider lines | Labels above content are announcements; labels in dividers orient without interrupting |
| 2026-05-25 | Behavioral Reads lead with no "YOUR READS" header | The reads are the product; labeling them adds chrome before content, diluting the mirror effect |
| 2026-05-25 | Bars encode valence via fill color | A high vague bar should look like a warning without a `[!]` label — data speaks through color |
| 2026-05-25 | Drop tagline from header | "metacognition for your claude code prompts" is chrome; stats on the header line are more useful on every run |
| 2026-05-25 | Drop `[!]`/`[✓]` bracket notation | Color carries signal; bracket notation is redundant punctuation |
