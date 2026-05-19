import * as readline from 'readline';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import Anthropic from '@anthropic-ai/sdk';
import chalk from 'chalk';

const QUIZ_LOG_PATH = path.join(os.homedir(), '.cortext', 'quiz-log.jsonl');
const MIN_CORRECT = 2;
const QUESTIONS_TO_ASK = 3;

interface QuizRecord {
  t: string;
  diffHash: string;
  passed: boolean;
  score: number;
  questions: number;
  repo?: string;
}

interface QuizQuestion {
  question: string;
  expectedAnswer: string;
}

export function getDiff(staged: boolean): string {
  try {
    const cmd = staged ? 'git diff --cached' : 'git diff HEAD';
    const out = execSync(cmd, { encoding: 'utf8' });
    if (out.trim()) return out;
    // fallback: last commit
    return execSync('git diff HEAD~1 HEAD', { encoding: 'utf8' });
  } catch {
    return '';
  }
}

export function hashDiff(diff: string): string {
  return crypto.createHash('sha256').update(diff).digest('hex').slice(0, 16);
}

export function alreadyPassed(diffHash: string): boolean {
  try {
    return fs
      .readFileSync(QUIZ_LOG_PATH, 'utf8')
      .split('\n')
      .filter(l => l.trim())
      .some(l => {
        try {
          const r = JSON.parse(l) as QuizRecord;
          return r.diffHash === diffHash && r.passed;
        } catch {
          return false;
        }
      });
  } catch {
    return false;
  }
}

function writeRecord(record: QuizRecord): void {
  try {
    fs.mkdirSync(path.dirname(QUIZ_LOG_PATH), { recursive: true });
    fs.appendFileSync(QUIZ_LOG_PATH, JSON.stringify(record) + '\n');
  } catch {
    // non-fatal
  }
}

async function generateQuestions(diff: string, client: Anthropic): Promise<QuizQuestion[]> {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1200,
    system: `You are a code reviewer generating quiz questions from a git diff.
Generate exactly 5 questions that test understanding of the technical implementation.
Focus on: WHY a decision was made, HOW a specific mechanism works, WHAT edge case is handled.
Avoid trivial "what file changed" questions.
Respond as raw JSON only. No markdown fences. Schema: [{"question": "...", "expectedAnswer": "..."}]
Each expectedAnswer: 1-2 sentences capturing the key insight needed.`,
    messages: [{
      role: 'user',
      content: `Git diff:\n\`\`\`\n${diff.slice(0, 8000)}\n\`\`\``,
    }],
  });

  const text = response.content.find(b => b.type === 'text')?.text ?? '';
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('No questions generated');
  return JSON.parse(match[0]) as QuizQuestion[];
}

async function gradeAnswer(
  question: string,
  expectedAnswer: string,
  userAnswer: string,
  client: Anthropic,
): Promise<{ pass: boolean; feedback: string }> {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 150,
    system: `You grade quiz answers about code changes. Award a pass if the answer shows genuine understanding, even if phrased differently. Fail vague non-answers.
Respond as raw JSON only. No markdown fences. {"pass": true/false, "feedback": "one sentence"}`,
    messages: [{
      role: 'user',
      content: `Question: ${question}\nExpected understanding: ${expectedAnswer}\nUser's answer: ${userAnswer}`,
    }],
  });

  const text = response.content.find(b => b.type === 'text')?.text ?? '';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { pass: false, feedback: 'Could not grade.' };
  return JSON.parse(match[0]) as { pass: boolean; feedback: string };
}

function getRepo(): string | undefined {
  try {
    const remote = execSync('git remote get-url origin 2>/dev/null', { encoding: 'utf8' }).trim();
    return remote || undefined;
  } catch {
    return undefined;
  }
}

export async function runQuiz(staged: boolean): Promise<boolean> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error(chalk.red('\nANTHROPIC_API_KEY is required for the diff quiz.\n'));
    return false;
  }

  const diff = getDiff(staged);
  if (!diff.trim()) {
    console.log(chalk.dim('\nNo changes found to quiz on.\n'));
    return true;
  }

  const diffHash = hashDiff(diff);

  if (alreadyPassed(diffHash)) {
    console.log(chalk.green('\n✓ Already passed the quiz for this diff.\n'));
    return true;
  }

  const client = new Anthropic({ apiKey });
  console.log(chalk.dim('\nGenerating quiz from your diff…\n'));

  let questions: QuizQuestion[];
  try {
    questions = await generateQuestions(diff, client);
  } catch {
    console.error(chalk.red('Failed to generate questions. Check your API key and try again.'));
    return false;
  }

  // Pick QUESTIONS_TO_ASK at random
  const picked = [...questions].sort(() => Math.random() - 0.5).slice(0, QUESTIONS_TO_ASK);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => { console.log(''); rl.close(); process.exit(0); });
  const ask = (q: string): Promise<string> => new Promise(resolve => rl.question(q, resolve));

  console.log(chalk.bold.white('Diff Quiz') + chalk.dim(`  ·  answer ${MIN_CORRECT}/${QUESTIONS_TO_ASK} to pass\n`));

  let correct = 0;
  for (let i = 0; i < picked.length; i++) {
    const q = picked[i];
    console.log(chalk.cyan(`Q${i + 1}: ${q.question}`));
    const answer = (await ask(chalk.dim('  Your answer: '))).trim();
    console.log('');

    if (!answer) {
      console.log(chalk.dim('  Skipped.\n'));
      continue;
    }

    process.stdout.write(chalk.dim('  Grading…'));
    const { pass, feedback } = await gradeAnswer(q.question, q.expectedAnswer, answer, client);
    process.stdout.write('\r' + ' '.repeat(12) + '\r');

    if (pass) {
      correct++;
      console.log(chalk.green(`  ✓ ${feedback}\n`));
    } else {
      console.log(chalk.red(`  ✗ ${feedback}`));
      console.log(chalk.dim(`  Expected: ${q.expectedAnswer}\n`));
    }
  }

  rl.close();

  const passed = correct >= MIN_CORRECT;

  writeRecord({
    t: new Date().toISOString(),
    diffHash,
    passed,
    score: correct,
    questions: picked.length,
    repo: getRepo(),
  });

  if (passed) {
    console.log(chalk.green(`✓ Passed (${correct}/${picked.length}) — you understand your changes.\n`));
  } else {
    console.log(chalk.red(`✗ Failed (${correct}/${picked.length}) — review your diff and try again.\n`));
    console.log(chalk.dim('  Run: ') + chalk.white('npx cortext quiz') + chalk.dim(' to retry.\n'));
  }

  return passed;
}
