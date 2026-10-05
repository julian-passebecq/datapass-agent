// Installed-VSIX qualification: installs the packaged VSIX into an isolated VS Code profile, launches VS Code with
// Playwright (_electron), opens every Agent surface, reloads, switches theme, and checks the extension host log.
// Usage: node scripts/smoke.mjs [screenshotsDir]
import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const vsix = path.join(root, 'agent-vscode-0.4.0.vsix');
const shots = path.resolve(process.argv[2] ?? path.join(root, '.smoke', 'screenshots'));
const codeDir = process.env.VSCODE_DIR ?? path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Microsoft VS Code');
const codeExe = path.join(codeDir, process.platform === 'win32' ? 'Code.exe' : 'code');
const base = path.join(root, '.smoke');
const userData = path.join(base, 'user-data');
const extDir = path.join(base, 'extensions');
const result = { checks: [], screenshots: [], errors: [] };
const check = (name, ok, detail = '') => {
  result.checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};

if (!fs.existsSync(vsix)) throw new Error('package the VSIX first (npm run package)');
fs.rmSync(base, { recursive: true, force: true });
fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
fs.mkdirSync(shots, { recursive: true });

const settings = theme => fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({
  'workbench.colorTheme': theme, 'workbench.startupEditor': 'none', 'telemetry.telemetryLevel': 'off', 'update.mode': 'none',
  'extensions.autoUpdate': false, 'security.workspace.trust.enabled': true, 'workbench.tips.enabled': false, 'window.restoreWindows': 'none',
  'chat.disableAIFeatures': true, 'workbench.secondarySideBar.defaultVisibility': 'hidden',
}, null, 2));
settings('Default Dark Modern');

// Same as bin/code.cmd, without cmd.exe quoting: run the CLI through Code's bundled node.
const cliJs = fs.readdirSync(codeDir).map(d => path.join(codeDir, d, 'resources', 'app', 'out', 'cli.js')).find(p => fs.existsSync(p)) ?? path.join(codeDir, 'resources', 'app', 'out', 'cli.js');
const install = execFileSync(codeExe, [cliJs, '--extensions-dir', extDir, '--user-data-dir', userData, '--install-extension', vsix, '--force'], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: '' } });
check('VSIX installs into isolated profile', /successfully installed/i.test(install), install.trim().split('\n').pop());

const workspace = root; // trusted folder; Agent only reads ~/.claude and ~/.codex
async function launch() {
  const app = await electron.launch({
    executablePath: codeExe,
    args: ['--extensions-dir', extDir, '--user-data-dir', userData, '--disable-gpu-sandbox', '--skip-release-notes', '--skip-welcome', '--disable-workspace-trust', '--new-window', workspace],
    timeout: 60_000,
  });
  const win = await app.firstWindow();
  await win.waitForSelector('.monaco-workbench', { timeout: 60_000 });
  await win.setViewportSize?.({ width: 1500, height: 950 }).catch(() => {});
  return { app, win };
}

async function webviewText(win, needle, timeout = 30_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    for (const f of win.frames()) {
      try {
        const txt = await f.evaluate(() => document.body?.textContent ?? '');
        if (txt.includes(needle)) return { frame: f, txt };
      } catch { /* detached */ }
    }
    await win.waitForTimeout(500);
  }
  return undefined;
}

async function shot(win, name) {
  const p = path.join(shots, `${name}.png`);
  await win.screenshot({ path: p });
  result.screenshots.push(path.basename(p));
}

/** Opens the Agent Workspace from the Cockpit button and walks its views. */
async function workspacePass(win, ck, theme, views) {
  await ck.frame.evaluate(() => document.querySelector('[data-cmd="openWorkspace"]')?.click());
  const ws = await webviewText(win, 'Live agents', 30_000);
  check(`${theme}: Agent Workspace opens (Overview)`, ws, ws ? '' : 'no workspace text');
  if (!ws) return;
  await runCommand(win, 'View: Toggle Primary Side Bar Visibility');
  await win.waitForTimeout(1500);
  // 'all': every screen in the rail (core + built add-on screens), heading = rail label without its badge.
  if (views === 'all') views = await ws.frame.evaluate(() => [...document.querySelectorAll('[data-nav].nav')].map(b => [b.dataset.nav, (b.childNodes[0]?.textContent ?? '').trim()]));
  check(`${theme}: rail lists ${views.length} screens`, views.length >= 10, String(views.length));
  for (const [i, [view, heading]] of views.entries()) {
    // Poll until the screen is on (the host may still be loading history after a reload); record latency.
    const t1 = Date.now();
    await ws.frame.evaluate(v => document.querySelector(`[data-nav="${v}"]`)?.click(), view);
    let txt = '';
    while (Date.now() - t1 < 20_000) {
      txt = await ws.frame.evaluate(() => document.querySelector('.mh h1')?.textContent ?? '');
      if (txt === heading) break;
      await win.waitForTimeout(250);
    }
    const ms = Date.now() - t1;
    await win.waitForTimeout(900); // let async feeds of this screen land before the screenshot
    // Feeds that are still loading show "Loading…": wait for them (up to 20 s) so the screenshot shows data.
    const tf = Date.now();
    while (Date.now() - tf < 20_000 && await ws.frame.evaluate(() => /Loading\b/.test(document.querySelector('main')?.innerText ?? ''))) await win.waitForTimeout(500);
    (result.feedMs ??= {})[`${theme}:${view}`] = Date.now() - tf;
    const body = await ws.frame.evaluate(() => (document.querySelector('main')?.innerText ?? '').length);
    (result.navMs ??= {})[`${theme}:${view}`] = ms;
    check(`${theme}: workspace view ${view}`, txt === heading && body > 40, `${txt} · ${body} chars · ${ms} ms`);
    await shot(win, `${theme === 'Dark' ? 1 : 2}${String(i).padStart(2, '0')}-workspace-${view}-${theme.toLowerCase()}`);
  }
  // Keyboard: "2" switches to Attention; "/" filter hides non-matching sessions.
  await ws.frame.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true })));
  await win.waitForTimeout(800);
  const third = await ws.frame.evaluate(() => ([...document.querySelectorAll('[data-nav].nav')][2]?.childNodes[0]?.textContent ?? '').trim());
  await ws.frame.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: '3', bubbles: true })));
  let h1 = '';
  for (const t2 = Date.now(); Date.now() - t2 < 15_000; await win.waitForTimeout(250)) {
    h1 = await ws.frame.evaluate(() => document.querySelector('.mh h1')?.textContent ?? '');
    if (h1 === third) break;
  }
  check(`${theme}: keyboard 3 opens the third screen (${third})`, h1 === third, h1);
  // Rail groups collapse and expand.
  const before = await ws.frame.evaluate(() => document.querySelectorAll('[data-nav].nav').length);
  await ws.frame.evaluate(() => [...document.querySelectorAll('.rg .railg')].pop()?.click());
  let after = before;
  for (const t3 = Date.now(); Date.now() - t3 < 10_000 && after === before; await win.waitForTimeout(250)) after = await ws.frame.evaluate(() => document.querySelectorAll('[data-nav].nav').length);
  await ws.frame.evaluate(() => document.querySelector('.rg.closed .railg')?.click());
  await win.waitForTimeout(1500);
  const again = await ws.frame.evaluate(() => document.querySelectorAll('[data-nav].nav').length);
  check(`${theme}: rail group collapses and expands`, after < before && again === before, `${before} → ${after} → ${again}`);
  const filt = await ws.frame.evaluate(() => {
    const q = document.getElementById('q');
    const all = document.querySelectorAll('main [data-select]').length;
    q.value = 'zzzz-no-such-session';
    q.dispatchEvent(new Event('input'));
    const hidden = document.querySelectorAll('main [data-select].hide').length;
    q.value = '';
    q.dispatchEvent(new Event('input'));
    return { all, hidden };
  });
  check(`${theme}: filter hides non-matching sessions`, filt.all > 0 && filt.hidden === filt.all, JSON.stringify(filt));
  await runCommand(win, 'View: Toggle Primary Side Bar Visibility');
  await win.waitForTimeout(800);
}

async function runCommand(win, label) {
  await win.keyboard.press('Escape');
  await win.keyboard.press('F1');
  await win.waitForSelector('.quick-input-widget input', { timeout: 10_000 });
  await win.keyboard.type(label);
  await win.waitForTimeout(600);
  await win.keyboard.press('Enter');
}

const t0 = Date.now();
let { app, win } = await launch();
try {
  const icon = win.locator('.activitybar [aria-label^="Agent"]').first();
  await icon.waitFor({ timeout: 30_000 });
  check('Activity Bar shows AGENT container', true);
  await icon.click();
  const cockpit = await webviewText(win, 'Ended today', 60_000);
  check('Cockpit renders', cockpit, cockpit ? `${Date.now() - t0}ms after launch` : 'no cockpit text');
  // Initial discovery reads every provider artifact and runs git correlation: on a busy machine with
  // ~500 MB of history it can take 30-60 s. Poll until sessions are counted instead of a fixed wait.
  let ck;
  for (const t1 = Date.now(); Date.now() - t1 < 120_000; await win.waitForTimeout(2000)) {
    ck = await webviewText(win, 'Ended today');
    const m = /(\d+)Active(\d+)Idle(?:(\d+)Needs input)?(\d+)Ended today/.exec(ck?.txt ?? '');
    if (m && Number(m[1]) + Number(m[2]) + Number(m[4]) > 0) break;
  }
  check('Cockpit shows Claude provider state', ck?.txt.includes('CLAUDE CODE') || ck?.txt.includes('Claude Code'));
  check('Cockpit shows Codex provider state', ck?.txt.includes('CODEX') || ck?.txt.includes('Codex'));
  const counts = /(\d+)Active(\d+)Idle(?:(\d+)Needs input)?(\d+)Ended today/.exec(ck?.txt ?? '');
  check('Cockpit lists at least one live session', counts && Number(counts[1]) + Number(counts[2]) > 0, counts ? `active=${counts[1]} idle=${counts[2]} endedToday=${counts[4]}` : '');
  result.cockpit = counts ? { active: +counts[1], idle: +counts[2], endedToday: +counts[4] } : undefined;
  await shot(win, '01-cockpit-dark');

  const rows = win.locator('.pane-body .monaco-list-row');
  check('Sessions view has rows', (await rows.count()) > 0, `${await rows.count()} rows`);

  const tl = await webviewText(win, 'All sessions', 30_000);
  const evCount = /(\d+) events/.exec(tl?.txt ?? '');
  check('Timeline renders', evCount && +evCount[1] > 0, evCount?.[0]);
  await shot(win, '02-sessions-timeline-dark');

  // Open the inspector from the first session row in the Cockpit webview.
  if (ck) {
    await ck.frame.evaluate(() => document.querySelector('[data-open]')?.click());
    const insp = await webviewText(win, 'EVIDENCE', 20_000) ?? await webviewText(win, 'Evidence', 5_000);
    check('Session inspector opens with evidence section', insp);
    await win.waitForTimeout(1500);
    await shot(win, '03-inspector-dark');
  }

  // Activity view (collapsed by default): expand it from its pane header, collapse Timeline to make room.
  await win.locator('.pane-header', { hasText: /^Timeline/ }).first().click().catch(() => {});
  await win.locator('.pane-header', { hasText: /^Activity/ }).first().click();
  const act = await webviewText(win, 'Last 7 days', 20_000);
  check('Activity view renders weekly table and session graph', act && /Session graph/.test(act.txt));
  await shot(win, '04-activity-dark');

  const ck2 = await webviewText(win, 'Open Agent workspace', 20_000);
  if (ck2) await workspacePass(win, ck2, 'Dark', 'all');
  else check('Dark: Agent Workspace opens (Overview)', false, 'cockpit button not found');

  // Reload window and confirm reactivation
  await win.evaluate(() => (document.activeElement instanceof HTMLElement) && document.activeElement.blur());
  await runCommand(win, 'Developer: Reload Window');
  await win.waitForTimeout(3000);
  await win.waitForSelector('.monaco-workbench', { timeout: 60_000 });
  // VS Code restores the Agent container after reload; clicking its icon again would hide the sidebar.
  let after = await webviewText(win, 'Ended today', 20_000);
  if (!after) {
    await win.locator('.activitybar [aria-label^="Agent"]').first().click().catch(() => {});
    after = await webviewText(win, 'Ended today', 40_000);
  }
  check('Reload: Agent reactivates and Cockpit renders', after);
  await shot(win, '05-after-reload-dark');
} catch (e) {
  result.errors.push(String(e?.stack ?? e));
  console.error(e);
  await shot(win, 'zz-error').catch(() => {});
} finally {
  await app.close().catch(() => {});
}

// Light theme pass
settings('Default Light Modern');
({ app, win } = await launch());
try {
  await win.locator('.activitybar [aria-label^="Agent"]').first().click();
  const ck = await webviewText(win, 'Ended today', 60_000);
  check('Light theme: Cockpit renders', ck);
  await win.waitForTimeout(6000);
  await shot(win, '06-cockpit-light');
  if (ck) {
    await ck.frame.evaluate(() => document.querySelector('[data-open]')?.click());
    await webviewText(win, 'Evidence', 20_000);
    await shot(win, '07-inspector-light');
    await workspacePass(win, ck, 'Light', 'all');
  }
} catch (e) {
  result.errors.push(String(e?.stack ?? e));
} finally {
  await app.close().catch(() => {});
}

// Extension host log: no errors from Agent
const logs = [];
(function walk(d) { for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/exthost.*\.log$|Agent\.log$|renderer\.log$/i.test(e.name)) logs.push(p); } })(path.join(userData, 'logs'));
const agentErrors = [];
const shutdownNoise = [];
let activated = [];
for (const l of logs) {
  const txt = fs.readFileSync(l, 'utf8');
  let terminating = false;
  for (const line of txt.split('\n')) {
    if (/Extension host terminating/.test(line)) terminating = true;
    if (/\[error\]/i.test(line) && /agent-vscode|juliandatapass|agent\./i.test(line)) {
      // VS Code cancels in-flight RPCs when the extension host is torn down for a reload; reported, not counted.
      if (terminating && /Canceled/.test(line)) shutdownNoise.push(line.slice(0, 200));
      else agentErrors.push(line.slice(0, 300));
    }
    if (/activated in \d+ms|initial discovery/.test(line)) activated.push(line.trim().slice(0, 200));
  }
}
check('Extension host: no Agent errors', agentErrors.length === 0, agentErrors.slice(0, 3).join(' || '));
check('Agent output log shows activation + discovery timing', activated.length > 0, activated.slice(0, 4).join(' || '));
result.activationLog = activated;
result.agentErrors = agentErrors;
result.shutdownCancellations = shutdownNoise;
if (shutdownNoise.length) console.log(`NOTE ${shutdownNoise.length} cancellation(s) logged while the extension host was terminating for reload`);
result.passed = result.checks.every(c => c.ok) && result.errors.length === 0;
fs.writeFileSync(path.join(shots, '..', 'smoke-result.json'), JSON.stringify(result, null, 2));
console.log(result.passed ? 'SMOKE PASS' : 'SMOKE FAIL');
process.exit(result.passed ? 0 : 1);
