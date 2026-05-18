import { readProjects } from './reader';
import { analyze } from './analyzer';
import { render } from './renderer';
import { analyzePrompts } from './suggester';

const USAGE = `
Usage: npx cortext [options]

Options:
  --days <n>     Analyze last n days (default: 30)
  --analyze      AI-powered prompt improvement (needs ANTHROPIC_API_KEY)
  --help         Show this help

Examples:
  npx cortext
  npx cortext --days 7
  npx cortext --analyze
`.trim();

function parseArgs(argv: string[]): { days: number; analyze: boolean; help: boolean } {
  const args = argv.slice(2);
  let days = 30;
  let analyze = false;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && args[i + 1]) {
      const n = parseInt(args[i + 1], 10);
      if (!isNaN(n) && n > 0) days = n;
      i++;
    } else if (args[i] === '--analyze') {
      analyze = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      help = true;
    }
  }

  return { days, analyze, help };
}

async function main(): Promise<void> {
  const { days, analyze: shouldAnalyze, help } = parseArgs(process.argv);

  if (help) {
    console.log(USAGE);
    return;
  }

  const projects = readProjects(days);

  if (projects.length === 0) {
    console.error(
      '\nNo Claude Code session data found in ~/.claude/projects/\n' +
      'Make sure you have Claude Code installed and have run at least one session.\n'
    );
    process.exit(1);
  }

  const result = analyze(projects, days);
  render(result);

  if (shouldAnalyze) {
    if (result.worstPrompts.length === 0) {
      console.log('\nNo vague or corrected prompts found — great job!\n');
    } else {
      await analyzePrompts(result.worstPrompts);
    }
  }
}

main().catch(err => {
  console.error('Error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
