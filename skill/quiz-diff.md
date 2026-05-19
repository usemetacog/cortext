---
name: quiz-diff
version: 1.0.0
description: |
  Quiz the user on their current git diff to verify they understand their own changes.
  Generates questions from the diff, grades answers semantically, stores pass/fail to
  ~/.cortext/quiz-log.jsonl. Use when: "quiz me on my diff", "quiz my changes",
  "quiz before commit", "/quiz-diff".
allowed-tools:
  - Bash
  - AskUserQuestion
triggers:
  - quiz me on my diff
  - quiz my changes
  - quiz before commit
  - quiz-diff
  - test my understanding of this diff
---

# /quiz-diff — Code Understanding Quiz

Quiz the user on their current git diff. You are the quizmaster AND the grader — no API key needed.

## Steps

### 1. Get the diff

```bash
git diff HEAD
```

If that's empty, try staged changes:
```bash
git diff --cached
```

If still empty, use the last commit:
```bash
git diff HEAD~1 HEAD
```

If there is truly no diff, tell the user and stop.

### 2. Check if already passed

```bash
DIFF=$(git diff HEAD 2>/dev/null || git diff --cached 2>/dev/null || git diff HEAD~1 HEAD 2>/dev/null)
HASH=$(echo "$DIFF" | shasum -a 256 | cut -c1-16)
grep -l "\"diffHash\":\"$HASH\"" ~/.cortext/quiz-log.jsonl 2>/dev/null | head -1
```

If a passing record exists for this hash, tell the user they already passed and stop.

### 3. Generate 5 questions from the diff

Based on the diff, create 5 questions that test:
- **WHY** a decision was made (not just what changed)
- **HOW** a specific mechanism works
- **WHAT** edge case is handled and why

Never ask trivial "what file changed" or "what line was added" questions.

### 4. Ask 3 questions via AskUserQuestion

Pick 3 of the 5 questions and ask them one at a time. Label them Q1, Q2, Q3.

For each question, after reading the answer, grade it yourself:
- **Pass**: answer shows genuine understanding, even if phrased differently
- **Fail**: vague, wrong, or "I don't know"

Keep a running tally.

### 5. Store result

After all 3 questions, compute the final pass/fail (need ≥ 2/3):

```bash
DIFF=$(git diff HEAD 2>/dev/null || git diff --cached 2>/dev/null || git diff HEAD~1 HEAD 2>/dev/null)
HASH=$(echo "$DIFF" | shasum -a 256 | cut -c1-16)
PASSED=<true or false>
SCORE=<number correct>
mkdir -p ~/.cortext
echo "{\"t\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"diffHash\":\"$HASH\",\"passed\":$PASSED,\"score\":$SCORE,\"questions\":3}" >> ~/.cortext/quiz-log.jsonl
```

### 6. Report

Show the score, brief feedback on each question, and:
- **Passed**: congratulate them; they're clear to commit.
- **Failed**: tell them specifically what they missed; suggest reviewing those parts of the diff before committing.
