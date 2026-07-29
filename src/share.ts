import { writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { exec } from 'child_process';

export interface ShareCardData {
  version: string;
  days: number;
  totalSessions: number;
  totalPrompts: number;
  totalCost: number;
  cacheHitRate: number; // 0-1
  harnessScore: number | null; // 0-100
  topRead: { text: string; valence?: 'good' | 'warn' | 'bad' } | null;
  goalLabel: string | null;
}

function openBrowser(target: string): void {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open';
  exec(cmd + ' ' + JSON.stringify(target));
}

// Card is drawn entirely on a <canvas> — the canvas IS the shareable image,
// so "what you see" and "what downloads" are always the same pixels.
function buildClientScript(data: ShareCardData): string {
  const scoreColor = data.harnessScore === null ? '#8b949e'
    : data.harnessScore >= 70 ? '#3fb950'
    : data.harnessScore >= 40 ? '#d29922'
    : '#f85149';

  const readColor = data.topRead?.valence === 'bad' ? '#f85149'
    : data.topRead?.valence === 'warn' ? '#d29922'
    : '#3fb950';
  const readIcon = data.topRead?.valence === 'bad' || data.topRead?.valence === 'warn' ? '▸' : '✓';

  return `
const W = 1200, H = 630;
const canvas = document.getElementById('card');
canvas.width = W; canvas.height = H;
const ctx = canvas.getContext('2d');

function draw() {
  // background
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, W, H);

  // card panel
  const pad = 48;
  ctx.fillStyle = '#161b22';
  ctx.strokeStyle = '#30363d';
  ctx.lineWidth = 1;
  roundRect(pad, pad, W - pad * 2, H - pad * 2, 10);
  ctx.fill();
  ctx.stroke();

  // corner marks (industrial-forensics motif, echoes the box-drawing TUI)
  drawCorners(pad, pad, W - pad * 2, H - pad * 2);

  const left = pad + 44;
  let y = pad + 56;

  // wordmark + period
  ctx.fillStyle = '#e6edf3';
  ctx.font = '700 26px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('cortext', left, y);
  const wmWidth = ctx.measureText('cortext').width;
  ctx.fillStyle = '#8b949e';
  ctx.font = '400 15px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText('  ·  ' + ${JSON.stringify(data.days)} + ' days  ·  ' + ${JSON.stringify(data.totalSessions)} + ' sessions  ·  ' + ${JSON.stringify(data.totalPrompts)} + ' prompts', left + wmWidth, y);

  y += 72;

  // hero: harness score
  ${data.harnessScore === null ? '' : `
  ctx.fillStyle = '#8b949e';
  ctx.font = '600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText('HARNESS HEALTH', left, y);
  y += 66;
  ctx.fillStyle = ${JSON.stringify(scoreColor)};
  ctx.font = '700 84px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText(${JSON.stringify(String(data.harnessScore))}, left, y);
  const scoreW = ctx.measureText(${JSON.stringify(String(data.harnessScore))}).width;
  ctx.fillStyle = '#8b949e';
  ctx.font = '400 22px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText('/100', left + scoreW + 8, y);
  y += 28;
  `}

  // stat grid (right column)
  const statX = W - pad - 380;
  const stats = [
    ['API EQUIV. COST', '$' + ${JSON.stringify(data.totalCost.toFixed(2))}, '#58a6ff'],
    ['CACHE HIT RATE', ${JSON.stringify(Math.round(data.cacheHitRate * 100) + '%')}, ${data.cacheHitRate > 0.5 ? "'#3fb950'" : "'#e6edf3'"}],
  ];
  let sy = pad + 70;
  for (const [label, value, color] of stats) {
    ctx.fillStyle = '#8b949e';
    ctx.font = '600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText(label, statX, sy);
    ctx.fillStyle = color;
    ctx.font = '700 30px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText(value, statX, sy + 38);
    sy += 88;
  }

  // top read — sits directly below the hero, not glued to the card floor
  ${data.topRead ? `
  const readY = ${data.harnessScore === null ? 'pad + 220' : 'y + 90'};
  ctx.fillStyle = ${JSON.stringify(readColor)};
  ctx.font = '700 20px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText(${JSON.stringify(readIcon)}, left, readY);
  ctx.font = '400 19px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  wrapText(${JSON.stringify(data.topRead.text)}, left + 30, readY, W - pad * 2 - 74, 26);
  ` : ''}

  // footer
  ctx.fillStyle = '#8b949e';
  ctx.font = '400 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  const footer = 'npx cortext' + ${JSON.stringify(data.goalLabel ? '   ·   for ' + data.goalLabel : '')};
  ctx.fillText(footer, left, H - pad - 24);
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawCorners(x, y, w, h) {
  const len = 18;
  ctx.strokeStyle = '#8b949e';
  ctx.lineWidth = 2;
  const marks = [
    [[x, y + len], [x, y], [x + len, y]],
    [[x + w - len, y], [x + w, y], [x + w, y + len]],
    [[x, y + h - len], [x, y + h], [x + len, y + h]],
    [[x + w - len, y + h], [x + w, y + h], [x + w, y + h - len]],
  ];
  for (const m of marks) {
    ctx.beginPath();
    ctx.moveTo(m[0][0], m[0][1]);
    ctx.lineTo(m[1][0], m[1][1]);
    ctx.lineTo(m[2][0], m[2][1]);
    ctx.stroke();
  }
}

function wrapText(text, x, y, maxWidth, lineHeight) {
  const words = text.split(' ');
  let line = '';
  let ly = y;
  let lines = 0;
  for (let i = 0; i < words.length && lines < 2; i++) {
    const test = line + words[i] + ' ';
    if (ctx.measureText(test).width > maxWidth && line !== '') {
      ctx.fillText(line, x, ly);
      line = words[i] + ' ';
      ly += lineHeight;
      lines++;
    } else {
      line = test;
    }
  }
  if (lines < 2) ctx.fillText(line, x, ly);
}

draw();

document.getElementById('download').addEventListener('click', function() {
  const a = document.createElement('a');
  a.download = 'cortext-share.png';
  a.href = canvas.toDataURL('image/png');
  a.click();
});

document.getElementById('copy').addEventListener('click', async function() {
  const status = document.getElementById('copy-status');
  try {
    const blob = await new Promise(function(resolve) { canvas.toBlob(resolve, 'image/png'); });
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    status.textContent = 'Copied!';
  } catch (e) {
    status.textContent = 'Copy not supported — use Download instead';
  }
  setTimeout(function() { status.textContent = ''; }, 2500);
});
`;
}

function buildHtml(data: ShareCardData): string {
  const script = buildClientScript(data);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>cortext · share card</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #010409;
    color: #e6edf3;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 20px;
    padding: 32px;
  }
  canvas {
    max-width: 100%;
    height: auto;
    border-radius: 10px;
    box-shadow: 0 12px 40px rgba(0,0,0,0.5);
  }
  .controls { display: flex; align-items: center; gap: 12px; }
  button {
    background: #21262d;
    color: #e6edf3;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 10px 18px;
    font-size: 14px;
    cursor: pointer;
  }
  button:hover { background: #30363d; }
  button#download { background: #1f6feb; border-color: #1f6feb; }
  button#download:hover { background: #388bfd; }
  #copy-status { font-size: 13px; color: #8b949e; }
</style>
</head>
<body>
  <canvas id="card"></canvas>
  <div class="controls">
    <button id="download">Download PNG</button>
    <button id="copy">Copy Image</button>
    <span id="copy-status"></span>
  </div>
  <script>${script}</script>
</body>
</html>`;
}

export function openShareCard(data: ShareCardData): string {
  const html = buildHtml(data);
  const file = path.join(tmpdir(), `cortext-share-${Date.now()}.html`);
  writeFileSync(file, html, 'utf-8');
  openBrowser(`file://${file}`);
  return file;
}

// exported for tests
export { buildHtml as __buildHtml };
