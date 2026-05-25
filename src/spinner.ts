import chalk from 'chalk';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function createSpinner(text: string) {
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  const isTTY = process.stdout.isTTY;

  return {
    start() {
      if (!isTTY) return;
      process.stdout.write('\x1B[?25l'); // hide cursor
      timer = setInterval(() => {
        process.stdout.write(`\r${chalk.cyan(SPINNER_FRAMES[frame % SPINNER_FRAMES.length])} ${chalk.dim(text)}`);
        frame++;
      }, 80);
    },
    stop() {
      if (!isTTY) return;
      if (timer) clearInterval(timer);
      process.stdout.write('\r\x1B[K'); // clear line
      process.stdout.write('\x1B[?25h'); // show cursor
    },
  };
}
