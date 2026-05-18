---
name: cortext
version: 0.1.0
description: |
  Claude Code prompt analytics. Reads ~/.claude/projects/ JSONL logs and reports
  token usage, cost breakdown by project, and daily spend trends for the last 30 days.
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
---

# /cortext — Claude Code Usage Analytics

Run the following script, then present the output as a clean report in the conversation.

```bash
python3 << 'EOF'
import json, os, glob
from datetime import datetime, timedelta, timezone
from collections import defaultdict

PRICING = {
    'claude-opus-4-7':           {'input': 15,   'output': 75,   'cache_read': 1.50,  'cache_write': 18.75},
    'claude-opus-4-6':           {'input': 15,   'output': 75,   'cache_read': 1.50,  'cache_write': 18.75},
    'claude-sonnet-4-6':         {'input': 3,    'output': 15,   'cache_read': 0.30,  'cache_write': 3.75},
    'claude-sonnet-4-5':         {'input': 3,    'output': 15,   'cache_read': 0.30,  'cache_write': 3.75},
    'claude-haiku-4-5-20251001': {'input': 0.80, 'output': 4,    'cache_read': 0.08,  'cache_write': 1.00},
    'claude-haiku-4-5':          {'input': 0.80, 'output': 4,    'cache_read': 0.08,  'cache_write': 1.00},
}
DEFAULT = PRICING['claude-sonnet-4-6']

def compute_cost(model, u):
    p = PRICING.get(model, DEFAULT)
    return (
        u.get('input_tokens', 0) * p['input'] +
        u.get('output_tokens', 0) * p['output'] +
        u.get('cache_read_input_tokens', 0) * p['cache_read'] +
        u.get('cache_creation_input_tokens', 0) * p['cache_write']
    ) / 1_000_000

projects_dir = os.path.expanduser('~/.claude/projects')
cutoff = datetime.now(timezone.utc) - timedelta(days=30)

total_cost = 0
total_input = total_output = total_cache_read = total_cache_write = 0
by_project = defaultdict(lambda: {'cost': 0, 'output': 0, 'messages': 0})
by_day = defaultdict(lambda: {'cost': 0, 'messages': 0})

for jsonl in glob.glob(f'{projects_dir}/**/*.jsonl', recursive=True):
    with open(jsonl, errors='replace') as f:
        for line in f:
            try:
                e = json.loads(line)
            except Exception:
                continue
            if e.get('type') != 'assistant':
                continue
            msg = e.get('message', {})
            u = msg.get('usage')
            if not u:
                continue
            ts = e.get('timestamp', '')
            if not ts:
                continue
            try:
                t = datetime.fromisoformat(ts.replace('Z', '+00:00'))
            except Exception:
                continue
            if t < cutoff:
                continue

            model = msg.get('model', 'claude-sonnet-4-6')
            cwd = e.get('cwd', '')
            proj = os.path.basename(cwd) if cwd else os.path.basename(os.path.dirname(jsonl))
            c = compute_cost(model, u)
            date = ts[:10]

            total_cost += c
            total_input += u.get('input_tokens', 0)
            total_output += u.get('output_tokens', 0)
            total_cache_read += u.get('cache_read_input_tokens', 0)
            total_cache_write += u.get('cache_creation_input_tokens', 0)

            by_project[proj]['cost'] += c
            by_project[proj]['output'] += u.get('output_tokens', 0)
            by_project[proj]['messages'] += 1

            by_day[date]['cost'] += c
            by_day[date]['messages'] += 1

sep = '─' * 52
print(f"\n{sep}")
print(f"  Claude Code Usage  ·  Last 30 Days")
print(f"{sep}")
print(f"  Total cost:      ${total_cost:.4f}")
print(f"  Input tokens:    {total_input:>12,}")
print(f"  Output tokens:   {total_output:>12,}")
print(f"  Cache reads:     {total_cache_read:>12,}")
print(f"  Cache writes:    {total_cache_write:>12,}")

print(f"\n  Top Projects by Cost")
print(f"  {'─'*48}")
top = sorted(by_project.items(), key=lambda x: -x[1]['cost'])[:10]
for proj, s in top:
    pct = s['cost'] / total_cost * 100 if total_cost else 0
    print(f"  {proj[:28]:<28}  ${s['cost']:.4f}  {pct:4.1f}%")

print(f"\n  Daily Spend — Last 14 Days")
print(f"  {'─'*48}")
max_day_cost = max((s['cost'] for s in by_day.values()), default=1)
for day in sorted(by_day.keys())[-14:]:
    s = by_day[day]
    bar = '█' * max(1, int(s['cost'] / max_day_cost * 24))
    print(f"  {day}  {bar:<24}  ${s['cost']:.4f}  ({s['messages']} msgs)")

print(f"\n{sep}\n")
EOF
```

After running the script, summarize the key numbers (total cost, top project, busiest day) in 2–3 sentences. Offer to drill into a specific project or time range if the user wants more detail.
