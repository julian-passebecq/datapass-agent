// Installed-VSIX qualification: installs the packaged VSIX into an isolated VS Code profile, launches VS Code with
// Playwright (_electron), opens every Agent surface, reloads, switches theme, and checks the extension host log.
// Usage: node scripts/smoke.mjs [screenshotsDir] [--fixture-home]
// --fixture-home: run against a synthetic Claude/Codex home built from test/fixtures (scripts/smoke-fixture.mjs) in a
// temp dir instead of the real ~/.claude and ~/.codex history; CI runners have no agent history of their own.
import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildFixtureHome } from './smoke-fixture.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const vsix = path.join(root, `agent-vscode-${JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version}.vsix`);
const args = process.argv.slice(2);
const fixtureHome = args.includes('--fixture-home');
const shots = path.resolve(args.find(a => !a.startsWith('--')) ?? path.join(root, '.smoke', 'screenshots'));
const codeDir = process.env.VSCODE_DIR ?? path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Microsoft VS Code');
const codeExe = path.join(codeDir, process.platform === 'win32' ? 'Code.exe' : 'code');
// A fresh isolated profile avoids stale state and Windows locks from earlier runs.
fs.mkdirSync(path.join(root, '.smoke'), { recursive: true });
const base = fs.mkdtempSync(path.join(root, '.smoke', 'run-'));
const userData = path.join(base, 'user-data');
const extDir = path.join(base, 'extensions');
const result = { checks: [], screenshots: [], errors: [] };
const check = (name, ok, detail = '') => {
  result.checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};

if (!fs.existsSync(vsix)) throw new Error('package the VSIX first (npm run package)');
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
// Synthetic home (--fixture-home): rebuilt before each launch so its newest record is always a minute old.
const homeDir = fixtureHome ? fs.mkdtempSync(path.join(os.tmpdir(), 'agent-smoke-home-')) : undefined;
const homeEnv = () => (homeDir ? { ...process.env, ...buildFixtureHome(homeDir, { cwd: workspace }) } : undefined);
if (homeDir) console.log(`Fixture home: ${homeDir}`);
async function launch() {
  const app = await electron.launch({
    executablePath: codeExe,
    args: ['--extensions-dir', extDir, '--user-data-dir', userData, '--disable-gpu-sandbox', '--skip-release-notes', '--skip-welcome', '--disable-workspace-trust', '--new-window', workspace],
    timeout: 60_000,
    ...(homeDir ? { env: homeEnv() } : {}),
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

/** True while the visible screen shows a loading marker or loading text (case-insensitive, ending in an ellipsis). */
const LOADING = () => !!document.querySelector('main [data-loading]') || /\b(loading|scanning|reading)\b[^\n]{0,120}(…|\.\.\.)/i.test(document.querySelector('main')?.innerText ?? '');

/** Narrow windows (600, 700 and 900 px): every rail screen must fit without a horizontal page scrollbar (tables scroll inside). */
const NARROW_WIDTHS = [600, 700, 900];
async function narrowPass(app, win, ws, theme, views, px) {
  const before = await app.evaluate(({ BrowserWindow }, w0) => {
    const w = BrowserWindow.getAllWindows()[0];
    const s = w.getSize();
    if (w.isMaximized()) w.unmaximize();
    w.setSize(w0, s[1]);
    return s;
  }, px);
  // launch() pins a 1500 px viewport (Playwright emulation), which wins over the window size: narrow it too.
  await win.setViewportSize?.({ width: px, height: 950 }).catch(() => {});
  await win.waitForTimeout(1500);
  const over = [];
  let width = 0;
  for (const [view, heading] of views) {
    await ws.frame.evaluate(v => document.querySelector(`[data-nav="${v}"]`)?.click(), view);
    for (const t = Date.now(); Date.now() - t < 10_000; await win.waitForTimeout(250)) if ((await ws.frame.evaluate(() => document.querySelector('.mh h1')?.textContent ?? '')) === heading) break;
    await win.waitForTimeout(400);
    const r = await ws.frame.evaluate(() => ({ w: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth }));
    width = r.w;
    if (r.sw > r.w + 1) over.push(`${view} +${r.sw - r.w}px`);
    if (view === 'overview' || view === 'changes' || view === 'board') await shot(win, `9-narrow${px === 700 ? '' : px}-${view}-${theme.toLowerCase()}`);
  }
  (result.narrowPasses ??= []).push({ window: px, webview: width, overflow: over });
  if (px === 700) result.narrow = { window: 700, webview: width, overflow: over };
  // The webview must really be narrower than the window, or the pass proves nothing.
  check(`${theme}: ${px} px window, no horizontal page overflow on ${views.length} screens`, over.length === 0 && width > 0 && width < px, over.join(', ') || `webview ${width} px`);
  await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].setSize(s[0], s[1]), before);
  await win.setViewportSize?.({ width: 1500, height: 950 }).catch(() => {});
  await win.waitForTimeout(1000);
}

/** Panes screen: the 2 x 2 and 1 + 2 layouts render every cell without a render error; the layout is restored after. */
async function panesPass(win, ws, theme, views) {
  if (!views.some(([v]) => v === 'panes')) { check(`${theme}: Panes screen in the rail`, false, 'no panes entry'); return; }
  await ws.frame.evaluate(() => document.querySelector('[data-nav="panes"]')?.click());
  for (const t = Date.now(); Date.now() - t < 10_000; await win.waitForTimeout(250)) if (await ws.frame.evaluate(() => !!document.querySelector('main .pn'))) break;
  const initial = await ws.frame.evaluate(() => /pn-(\S+)/.exec(document.querySelector('main .pn')?.className ?? '')?.[1] ?? '');
  const out = {};
  for (const [layout, label, n] of [['2x2', '2 x 2', 4], ['1p2', '1 + 2', 3]]) {
    await ws.frame.evaluate(l => document.querySelector(`[data-opt="panes.layout"][data-val="${l}"]`)?.click(), layout);
    let cells = [];
    for (const t = Date.now(); Date.now() - t < 15_000; await win.waitForTimeout(250)) {
      cells = await ws.frame.evaluate(l => document.querySelector(`main .pn.pn-${l}`) ? [...document.querySelectorAll('main .pn > .pn-c')].map(c => ({
        name: c.getAttribute('aria-label') ?? '',
        chars: (c.querySelector('.pn-b')?.innerText ?? '').trim().length,
        failed: /This screen failed to render/.test(c.querySelector('.pn-b')?.textContent ?? ''),
        h: Math.round(c.getBoundingClientRect().height),
      })) : [], layout);
      if (cells.length === n && cells.every(c => c.chars > 0 && !c.failed)) break;
    }
    await win.waitForTimeout(600);
    out[layout] = cells;
    const bad = cells.filter(c => c.failed || c.chars === 0 || c.h < 40).map(c => `${c.name}${c.failed ? ' failed' : c.chars === 0 ? ' empty' : ` ${c.h}px`}`);
    check(`${theme}: Panes ${label} renders ${n} panes without error`, cells.length === n && bad.length === 0, `${cells.length} panes${bad.length ? ': ' + bad.join(', ') : ' · ' + cells.map(c => `${c.name} ${c.chars} chars`).join(', ')}`);
    await shot(win, `9-panes-${layout}-${theme.toLowerCase()}`);
  }
  result.panes = out;
  if (initial && initial !== '1p2') await ws.frame.evaluate(l => document.querySelector(`[data-opt="panes.layout"][data-val="${l}"]`)?.click(), initial);
  await win.waitForTimeout(500);
}

/** Opens the Agent Workspace from the Cockpit button and walks its views. */
async function workspacePass(app, win, ck, theme, views) {
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
    // Feeds still loading show a [data-loading] marker or "Loading… / Scanning… / Reading…": wait for them (up to 20 s)
    // so the screenshot shows data; screens still loading after that are recorded, not failed.
    const tf = Date.now();
    let still = true;
    while ((still = await ws.frame.evaluate(LOADING)) && Date.now() - tf < 20_000) await win.waitForTimeout(500);
    (result.feedMs ??= {})[`${theme}:${view}`] = Date.now() - tf;
    if (still) (result.loadingTimeouts ??= []).push(`${theme}:${view}`);
    const body = await ws.frame.evaluate(() => (document.querySelector('main')?.innerText ?? '').length);
    (result.navMs ??= {})[`${theme}:${view}`] = ms;
    check(`${theme}: workspace view ${view}`, txt === heading && body > 40, `${txt} · ${body} chars · ${ms} ms`);
    await shot(win, `${theme === 'Dark' ? 1 : 2}${String(i).padStart(2, '0')}-workspace-${view}-${theme.toLowerCase()}`);
  }
  if (theme === 'Dark') {
    for (const px of NARROW_WIDTHS) await narrowPass(app, win, ws, theme, views, px);
    await panesPass(win, ws, theme, views);
  }
  // Keyboard: digits map to fixed screens (the rail shows the digit); "/" filter hides non-matching sessions.
  // Real keys require this editor's public control to own focus. Dispatching on document bypasses
  // the focus boundary (and does not model a user's keyboard target).
  await ws.frame.locator('.nav.on').click();
  check(`${theme}: numbered keyboard target owns webview focus`, await ws.frame.evaluate(() => document.hasFocus()));
  await ws.frame.locator('.nav.on').press('1');
  await win.waitForTimeout(800);
  const third = await ws.frame.evaluate(() => (document.querySelector('.nav[aria-keyshortcuts="3"]')?.childNodes[0]?.textContent ?? '').trim());
  await ws.frame.locator('.nav.on').press('3');
  let h1 = '';
  for (const t2 = Date.now(); Date.now() - t2 < 15_000; await win.waitForTimeout(250)) {
    h1 = await ws.frame.evaluate(() => document.querySelector('.mh h1')?.textContent ?? '');
    if (h1 === third) break;
  }
  check(`${theme}: keyboard 3 opens the screen numbered 3 in the rail (${third})`, !!third && h1 === third, h1);
  // The public VS Code shortcut follows the same fixed mapping, with the Agent editor focused.
  await ws.frame.locator('.nav.on').click();
  await win.keyboard.press('Control+Alt+1');
  await ws.frame.waitForFunction(() => document.querySelector('.mh h1')?.textContent === 'Overview', undefined, { timeout: 15_000 }).catch(() => {});
  check(`${theme}: public numbered shortcut 1 targets the active Agent editor`, await ws.frame.evaluate(() => document.querySelector('.mh h1')?.textContent === 'Overview'));
  await ws.frame.locator('.nav.on').click();
  await win.keyboard.press('Control+Alt+3');
  await ws.frame.waitForFunction(() => document.querySelector('.mh h1')?.textContent === 'Live', undefined, { timeout: 15_000 }).catch(() => {});
  check(`${theme}: public numbered shortcut 3 targets the active Agent editor`, await ws.frame.evaluate(() => document.querySelector('.mh h1')?.textContent === 'Live'));
  // Rail groups collapse and expand.
  const before = await ws.frame.evaluate(() => document.querySelectorAll('[data-nav].nav').length);
  // The active screen's group deliberately stays expanded, so choose an independent group.
  const group = await ws.frame.evaluate(() => [...document.querySelectorAll('.rg:not(.closed)')].find(g => !g.querySelector('.nav.on'))?.querySelector('.railg')?.dataset.opt);
  check(`${theme}: an inactive rail group is available for collapse`, !!group);
  if (group) await ws.frame.locator(`.railg[data-opt="${group}"]`).click();
  let after = before;
  for (const t3 = Date.now(); Date.now() - t3 < 10_000 && after === before; await win.waitForTimeout(250)) after = await ws.frame.evaluate(() => document.querySelectorAll('[data-nav].nav').length);
  if (group) await ws.frame.locator(`.rg.closed .railg[data-opt="${group}"]`).click();
  await win.waitForTimeout(1500);
  const again = await ws.frame.evaluate(() => document.querySelectorAll('[data-nav].nav').length);
  check(`${theme}: rail group collapses and expands`, after < before && again === before, `${before} → ${after} → ${again}`);
  await ws.frame.locator('#q').fill('');
  await ws.frame.locator('#q').press('1');
  await win.keyboard.press('Control+Alt+1');
  await win.waitForTimeout(800);
  check(`${theme}: typing and numbered shortcut in the filter retain the current screen`, await ws.frame.evaluate(() => document.querySelector('.mh h1')?.textContent === 'Live' && document.getElementById('q')?.value === '1'));
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

// Analyzer is the default 0.8 pane; legacy views start collapsed.
async function openLegacyViews(win) {
  for (const title of ['Cockpit', 'Sessions', 'Timeline']) {
    const header = win.locator('.pane-header', { hasText: new RegExp(`^${title}`) }).first();
    if (await header.getAttribute('aria-expanded') === 'false') await header.click();
  }
}

async function closeHost(app) {
  // On Windows the editor can exit after reload while the launcher pipe stays open.
  let timer;
  try {
    await Promise.race([
      app.close().catch(() => {}),
      new Promise(resolve => { timer = setTimeout(resolve, 10_000); }),
    ]);
  } finally { clearTimeout(timer); }
}

const t0 = Date.now();
let { app, win } = await launch();
try {
  const icon = win.locator('.activitybar [aria-label^="Agent"]').first();
  await icon.waitFor({ timeout: 30_000 });
  check('Activity Bar shows AGENT container', true);
  await icon.click();
  await openLegacyViews(win);
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
  if (ck2) await workspacePass(app, win, ck2, 'Dark', 'all');
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
  await closeHost(app);
}

// Light theme pass
settings('Default Light Modern');
({ app, win } = await launch());
try {
  if (!await win.locator('.pane-header', { hasText: /^Cockpit/ }).first().isVisible())
    await win.locator('.activitybar [aria-label^="Agent"]').first().click();
  await openLegacyViews(win);
  const ck = await webviewText(win, 'Ended today', 60_000);
  check('Light theme: Cockpit renders', ck);
  await win.waitForTimeout(6000);
  await shot(win, '06-cockpit-light');
  if (ck) {
    await ck.frame.evaluate(() => document.querySelector('[data-open]')?.click());
    await webviewText(win, 'Evidence', 20_000);
    await shot(win, '07-inspector-light');
    await workspacePass(app, win, ck, 'Light', 'all');
  }
} catch (e) {
  result.errors.push(String(e?.stack ?? e));
} finally {
  await closeHost(app);
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
if (result.loadingTimeouts?.length) console.log(`NOTE still loading after 20 s: ${result.loadingTimeouts.join(', ')}`);
result.fixtureHome = !!homeDir;
if (homeDir) fs.rmSync(homeDir, { recursive: true, force: true, maxRetries: 3 });
result.passed = result.checks.every(c => c.ok) && result.errors.length === 0;
fs.writeFileSync(path.join(shots, '..', 'smoke-result.json'), JSON.stringify(result, null, 2));
console.log(result.passed ? 'SMOKE PASS' : 'SMOKE FAIL');
process.exit(result.passed ? 0 : 1);
