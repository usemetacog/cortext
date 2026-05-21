import * as http from 'node:http';
import { exec } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type { AnalysisResult } from './types';
import type { WorstPromptData } from './renderer';

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open';
  exec(cmd + ' ' + url);
}

// Client-side JS (no template literals to avoid double-escaping in the outer template)
const CLIENT_JS = `
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function barRow(label, pct, valStr, colorClass) {
  return '<div class="bar-row">' +
    '<div class="bar-label" title="' + esc(label) + '">' + esc(label.length > 14 ? label.slice(0,12)+'…' : label) + '</div>' +
    '<div class="bar-track"><div class="bar-fill ' + (colorClass||'') + '" style="width:' + pct.toFixed(1) + '%"></div></div>' +
    '<div class="bar-val">' + esc(valStr) + '</div>' +
    '</div>';
}

async function init() {
  const res = await fetch('/api/data');
  const payload = await res.json();
  const result = payload.result;
  const wpd = payload.worstPromptData;
  const days = payload.days;

  document.getElementById('days-tag').textContent = 'Last ' + days + ' days';

  // Stat cards
  const cacheColor = result.cacheHitRate > 0.5 ? 'green' : '';
  document.getElementById('stat-cards').innerHTML =
    '<div class="stat-card"><div class="stat-label">API Equiv. Cost</div><div class="stat-value accent">$' + result.totalCost.toFixed(2) + '</div></div>' +
    '<div class="stat-card"><div class="stat-label">Sessions</div><div class="stat-value">' + result.totalSessions.toLocaleString() + '</div></div>' +
    '<div class="stat-card"><div class="stat-label">Prompts</div><div class="stat-value">' + result.totalPrompts.toLocaleString() + '</div></div>' +
    '<div class="stat-card"><div class="stat-label">Cache Hit Rate</div><div class="stat-value ' + cacheColor + '">' + (result.cacheHitRate * 100).toFixed(0) + '%</div></div>';

  // Daily spend chart
  var daily = result.dailyUsage || [];
  if (daily.length > 0) {
    var maxCost = daily.reduce(function(m, d) { return Math.max(m, d.cost); }, 0.001);
    var chartHtml = '';
    for (var i = 0; i < daily.length; i++) {
      var d = daily[i];
      var pct = Math.max((d.cost / maxCost) * 100, 2);
      var label = d.date.slice(5);
      chartHtml += '<div class="day-col">' +
        '<div class="day-bar-wrap" style="height:' + pct.toFixed(1) + '%">' +
        '<div class="day-tooltip">' + esc(d.date) + '<br>~$' + d.cost.toFixed(3) + ' API equiv.<br>' + d.sessions + ' session' + (d.sessions !== 1 ? 's' : '') + '</div>' +
        '</div>' +
        '<div class="day-label">' + esc(label) + '</div>' +
        '</div>';
    }
    document.getElementById('daily-chart').innerHTML = chartHtml;
  }

  // Prompt categories
  var catOrder = ['implement','fix','refactor','explain','question','vague','other'];
  var catColors = { fix:'green', implement:'accent', vague:'red' };
  var totalPrompts = catOrder.reduce(function(s, k) { return s + (result.promptCategories[k]||0); }, 0);
  var catHtml = '';
  for (var c = 0; c < catOrder.length; c++) {
    var cat = catOrder[c];
    var count = result.promptCategories[cat] || 0;
    if (count === 0) continue;
    var catPct = totalPrompts > 0 ? (count / totalPrompts) * 100 : 0;
    catHtml += barRow(cat, catPct, catPct.toFixed(0) + '%', catColors[cat] || '');
  }
  document.getElementById('categories-chart').innerHTML = catHtml || '<div style="color:var(--muted)">No data</div>';

  // Top projects
  var projects = (result.projectStats || []).slice(0, 6);
  var maxProj = projects.reduce(function(m, p) { return Math.max(m, p.cost); }, 0.001);
  var projHtml = '';
  for (var p = 0; p < projects.length; p++) {
    var proj = projects[p];
    var projPct = (proj.cost / maxProj) * 100;
    projHtml += barRow(proj.name, projPct, '~$' + proj.cost.toFixed(2), '');
  }
  document.getElementById('projects-chart').innerHTML = projHtml || '<div style="color:var(--muted)">No data</div>';

  // Efficiency signals
  var corrPct = (result.correctionRate * 100).toFixed(0);
  var corrCls = result.correctionRate > 0.15 ? 'bad' : result.correctionRate > 0.08 ? 'warn' : 'good';
  var wordCls = result.avgPromptWords < 15 ? 'warn' : '';
  document.getElementById('efficiency-signals').innerHTML =
    '<div class="signal-row"><span class="signal-name">Median prompt length</span><span class="signal-val ' + wordCls + '">' + result.avgPromptWords + ' words</span></div>' +
    '<div class="signal-row"><span class="signal-name">Correction rate</span><span class="signal-val ' + corrCls + '">' + corrPct + '%</span></div>' +
    '<div class="signal-row"><span class="signal-name">Tool diversity</span><span class="signal-val">' + (result.toolsUsed ? result.toolsUsed.length : 0) + ' tools</span></div>' +
    '<div class="signal-row"><span class="signal-name">Slash commands</span><span class="signal-val">' + Object.values(result.slashCommands ?? {}).reduce(function(a, b) { return a + b; }, 0) + '</span></div>' +
    (function() {
      var KEY_CMDS = ['/clear', '/plan', '/compact', '/rewind'];
      var cmds = result.slashCommands ?? {};
      var parts = KEY_CMDS.filter(function(c) { return cmds[c] > 0; }).map(function(c) { return c + ' \xd7' + cmds[c]; });
      return parts.length > 0 ? '<div class="signal-row"><span class="signal-name" style="font-size:0.85em;opacity:0.7">  breakdown</span><span class="signal-val" style="font-size:0.85em;opacity:0.7">' + parts.join('  ') + '</span></div>' : '';
    })() +
    '<div class="signal-row"><span class="signal-name">Median first-msg words</span><span class="signal-val">' + result.medianFirstMessageWords + '</span></div>' +
    (function() {
      var actionable = (result.promptCategories.implement || 0) + (result.promptCategories.fix || 0);
      if (actionable === 0) return '';
      var verPct = Math.round((result.verificationRate || 0) * 100);
      var verCls = verPct >= 50 ? 'good' : verPct < 20 ? 'bad' : 'warn';
      return '<div class="signal-row"><span class="signal-name">Verification rate</span><span class="signal-val ' + verCls + '">' + verPct + '%</span></div>';
    })();

  // Output ratio panel
  if (result.medianOutputRatio !== null && result.medianOutputRatio !== undefined) {
    document.getElementById('output-ratio-card').style.display = '';
    var orb = result.outputRatioByBucket;
    var orHtml = '<div class="signal-row"><span class="signal-name">Median output ratio</span><span class="signal-val">' + (result.medianOutputRatio * 100).toFixed(0) + '%</span></div>';
    if (orb.specific !== null && orb.vague !== null) {
      var maxBucket = Math.max(orb.specific, orb.vague, 0.001);
      var diff = orb.specific - orb.vague;
      var diffStr = (diff >= 0 ? '+' : '') + (diff * 100).toFixed(0) + '%';
      var diffCls = diff > 0.05 ? 'good' : diff < -0.05 ? 'bad' : '';
      orHtml += '<div style="margin-top:12px">' +
        '<div class="bucket-row"><div class="bucket-label">Specific (N=' + orb.nSpecific + ')</div>' +
        '<div class="bucket-bar-track"><div class="bucket-bar-fill" style="width:' + ((orb.specific/maxBucket)*100).toFixed(1) + '%;background:var(--green)"></div></div>' +
        '<div class="bucket-val">' + (orb.specific*100).toFixed(0) + '%</div></div>' +
        '<div class="bucket-row"><div class="bucket-label">Vague (N=' + orb.nVague + ')</div>' +
        '<div class="bucket-bar-track"><div class="bucket-bar-fill" style="width:' + ((orb.vague/maxBucket)*100).toFixed(1) + '%;background:var(--red)"></div></div>' +
        '<div class="bucket-val">' + (orb.vague*100).toFixed(0) + '%</div></div>' +
        '<div style="font-size:12px;color:var(--muted);margin-top:4px">Diff: <span class="signal-val ' + diffCls + '" style="font-size:12px">' + diffStr + '</span></div>' +
        '</div>';
    }
    document.getElementById('output-ratio-content').innerHTML = orHtml;
  }

  // "Did you read my response?" moments
  var unreadMoments = result.unreadMoments || [];
  if (unreadMoments.length > 0) {
    document.getElementById('unread-card').style.display = '';
    var unreadHtml = '';
    for (var u = 0; u < unreadMoments.length; u++) {
      var um = unreadMoments[u];
      if (u > 0) unreadHtml += '<div class="unread-divider"></div>';
      unreadHtml +=
        '<div class="ctx-label">Claude</div>' +
        '<div class="ctx-block">' + esc(um.claudeText) + '</div>' +
        '<div class="ctx-label you-label">You (follow-up)</div>' +
        '<div class="prompt-block">' + esc(um.userFollowUp) + '</div>' +
        '<div class="callout-text">&#x1F440; ' + esc(um.aiCallout || 'This was already covered in my response above.') + '</div>';
    }
    document.getElementById('unread-content').innerHTML = unreadHtml;
  }

  // Worst prompt
  if (wpd) {
    document.getElementById('worst-card').style.display = '';
    var prompt = wpd.prompt || {};
    var promptText = prompt.text || '';
    var heurText = wpd.heuristic || '';
    var rewriteText = wpd.rewrite && wpd.rewrite.rewrite ? wpd.rewrite.rewrite : '';
    var diagText = wpd.rewrite && wpd.rewrite.diagnosis ? wpd.rewrite.diagnosis : heurText;
    var ctxBefore = prompt.contextBefore || '';
    var ctxAfter = prompt.contextAfter || '';
    var afterLabel = prompt.followedByCorrection ? 'You (correction)' : 'Claude';
    var worstHtml = '';
    if (ctxBefore) {
      worstHtml +=
        '<div class="ctx-label">Claude</div>' +
        '<div class="ctx-block">' + esc(ctxBefore) + '</div>';
    }
    worstHtml +=
      '<div class="ctx-label you-label">You</div>' +
      '<div class="prompt-block">' + esc(promptText) + '</div>';
    if (ctxAfter) {
      worstHtml +=
        '<div class="ctx-label">' + esc(afterLabel) + '</div>' +
        '<div class="ctx-block">' + esc(ctxAfter) + '</div>';
    }
    if (diagText) {
      worstHtml += '<div style="margin-top:16px" class="prompt-label">Why it failed</div><div class="diagnosis-text">&#x26A0; ' + esc(diagText) + '</div>';
    }
    if (rewriteText) {
      worstHtml += '<div class="prompt-label">Suggested rewrite</div><div class="rewrite-text">' + esc(rewriteText) + '</div>';
    }
    document.getElementById('worst-content').innerHTML = worstHtml;
  }
}

init().catch(function(e) {
  document.getElementById('app').innerHTML = '<p style="color:var(--red);padding:32px">Error loading data: ' + esc(e.message || String(e)) + '</p>';
});
`;

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>cortext</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #0d1117;
      --card: #161b22;
      --border: #30363d;
      --accent: #58a6ff;
      --green: #3fb950;
      --yellow: #d29922;
      --red: #f85149;
      --text: #e6edf3;
      --muted: #8b949e;
    }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 14px;
      line-height: 1.5;
      min-height: 100vh;
    }
    header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 18px 32px;
      border-bottom: 1px solid var(--border);
    }
    header h1 {
      font-size: 18px;
      font-weight: 700;
      letter-spacing: -0.3px;
    }
    .tag {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 2px 10px;
      font-size: 12px;
      color: var(--muted);
    }
    #app {
      max-width: 1100px;
      margin: 0 auto;
      padding: 24px 32px;
      display: grid;
      gap: 16px;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 20px 24px;
    }
    .card-title {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.8px;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 16px;
    }
    .stat-cards {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
    }
    .stat-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px 20px;
    }
    .stat-label {
      font-size: 11px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.6px;
      margin-bottom: 6px;
    }
    .stat-value {
      font-size: 28px;
      font-weight: 700;
      line-height: 1;
    }
    .stat-value.accent { color: var(--accent); }
    .stat-value.green { color: var(--green); }

    /* Daily chart */
    .daily-outer {
      display: flex;
      align-items: flex-end;
      gap: 3px;
      height: 110px;
    }
    .day-col {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: flex-end;
      height: 100%;
      gap: 4px;
      position: relative;
    }
    .day-bar-wrap {
      width: 100%;
      background: var(--accent);
      border-radius: 3px 3px 0 0;
      min-height: 3px;
      position: relative;
      cursor: default;
    }
    .day-bar-wrap:hover { opacity: 0.75; }
    .day-bar-wrap:hover .day-tooltip { display: block; }
    .day-tooltip {
      display: none;
      position: absolute;
      bottom: calc(100% + 6px);
      left: 50%;
      transform: translateX(-50%);
      background: #2d333b;
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 6px 10px;
      font-size: 11px;
      color: var(--text);
      white-space: nowrap;
      z-index: 10;
      pointer-events: none;
    }
    .day-label {
      font-size: 9px;
      color: var(--muted);
      text-align: center;
    }

    /* Bar charts */
    .bar-row {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 8px;
    }
    .bar-row:last-child { margin-bottom: 0; }
    .bar-label {
      width: 80px;
      font-size: 12px;
      color: var(--muted);
      text-align: right;
      flex-shrink: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .bar-track {
      flex: 1;
      height: 14px;
      background: var(--bg);
      border-radius: 3px;
      overflow: hidden;
    }
    .bar-fill {
      height: 100%;
      border-radius: 3px;
      background: var(--accent);
    }
    .bar-fill.green { background: var(--green); }
    .bar-fill.red { background: var(--red); }
    .bar-val {
      width: 52px;
      font-size: 12px;
      color: var(--text);
      font-family: 'SF Mono', 'Fira Code', Consolas, monospace;
      text-align: right;
    }

    .two-col {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }

    /* Signal rows */
    .signal-row {
      display: flex;
      justify-content: space-between;
      padding: 8px 0;
      border-bottom: 1px solid var(--border);
    }
    .signal-row:last-child { border-bottom: none; }
    .signal-name { color: var(--muted); font-size: 13px; }
    .signal-val {
      font-family: 'SF Mono', 'Fira Code', Consolas, monospace;
      font-size: 13px;
    }
    .signal-val.good { color: var(--green); }
    .signal-val.warn { color: var(--yellow); }
    .signal-val.bad { color: var(--red); }

    /* Output ratio */
    .bucket-row {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 10px;
    }
    .bucket-label {
      width: 115px;
      font-size: 12px;
      color: var(--muted);
      flex-shrink: 0;
    }
    .bucket-bar-track {
      flex: 1;
      height: 18px;
      background: var(--bg);
      border-radius: 3px;
      overflow: hidden;
    }
    .bucket-bar-fill {
      height: 100%;
      border-radius: 3px;
    }
    .bucket-val {
      width: 40px;
      font-size: 12px;
      font-family: 'SF Mono', 'Fira Code', Consolas, monospace;
      text-align: right;
    }

    /* Worst prompt */
    .prompt-label {
      font-size: 11px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.6px;
      margin-bottom: 6px;
    }
    .ctx-label {
      font-size: 11px;
      font-weight: 600;
      color: var(--muted);
      margin-bottom: 4px;
      margin-top: 4px;
    }
    .ctx-label.you-label { color: var(--accent); }
    .ctx-block {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px 14px;
      font-size: 13px;
      color: var(--muted);
      white-space: pre-wrap;
      word-break: break-word;
      margin-bottom: 10px;
      max-height: 120px;
      overflow-y: auto;
      line-height: 1.5;
    }
    .prompt-block {
      background: rgba(88, 166, 255, 0.06);
      border: 1px solid rgba(88, 166, 255, 0.25);
      border-radius: 6px;
      padding: 12px 16px;
      font-family: 'SF Mono', 'Fira Code', Consolas, monospace;
      font-size: 12px;
      color: var(--text);
      white-space: pre-wrap;
      word-break: break-word;
      margin-bottom: 10px;
      max-height: 180px;
      overflow-y: auto;
    }
    .diagnosis-text {
      font-size: 13px;
      color: var(--yellow);
      margin-bottom: 14px;
      line-height: 1.5;
    }
    .rewrite-text {
      font-family: 'SF Mono', 'Fira Code', Consolas, monospace;
      font-size: 12px;
      color: var(--green);
      background: rgba(63, 185, 80, 0.07);
      border: 1px solid rgba(63, 185, 80, 0.2);
      border-radius: 6px;
      padding: 12px 16px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .unread-divider {
      border: none;
      border-top: 1px solid var(--border);
      margin: 18px 0;
    }
    .callout-text {
      font-size: 13px;
      color: var(--red);
      margin-top: 10px;
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <header>
    <h1>cortext</h1>
    <span class="tag" id="days-tag">Loading…</span>
  </header>
  <div id="app">
    <div class="stat-cards" id="stat-cards"></div>
    <div class="card">
      <div class="card-title">Daily API Cost</div>
      <div class="daily-outer" id="daily-chart"></div>
    </div>
    <div class="two-col">
      <div class="card">
        <div class="card-title">Prompt Categories</div>
        <div id="categories-chart"></div>
      </div>
      <div class="card">
        <div class="card-title">Top Projects by API Cost</div>
        <div id="projects-chart"></div>
      </div>
    </div>
    <div class="two-col">
      <div class="card">
        <div class="card-title">Efficiency Signals</div>
        <div id="efficiency-signals"></div>
      </div>
      <div class="card" id="output-ratio-card" style="display:none">
        <div class="card-title">Session Output Ratio</div>
        <div id="output-ratio-content"></div>
      </div>
    </div>
    <div class="card" id="unread-card" style="display:none">
      <div class="card-title">Did you read my response?</div>
      <div id="unread-content"></div>
    </div>
    <div class="card" id="worst-card" style="display:none">
      <div class="card-title">Worst Prompt This Week</div>
      <div id="worst-content"></div>
    </div>
  </div>
  <script>${CLIENT_JS}</script>
</body>
</html>`;

export function startWebServer(
  result: AnalysisResult,
  worstPromptData: WorstPromptData | undefined,
  days: number
): void {
  const payload = JSON.stringify({ result, worstPromptData, days });

  const server = http.createServer((req, res) => {
    if (req.url === '/api/data') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(payload);
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(HTML);
    }
  });

  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as AddressInfo;
    const url = 'http://localhost:' + port;
    console.log('\nDashboard running at ' + url + '  Press Ctrl+C to stop.\n');
    openBrowser(url);
  });
}
