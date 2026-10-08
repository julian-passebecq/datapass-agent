// Finite installed flow: synthetic scope review, compact controls, and a same-host facade consumer.
import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildFixtureHome } from './smoke-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version;
const codeDir = process.env.VSCODE_DIR ?? path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Microsoft VS Code');
const exe = path.join(codeDir, 'Code.exe');
const cli = fs.readdirSync(codeDir).map(d => path.join(codeDir, d, 'resources', 'app', 'out', 'cli.js')).find(p => fs.existsSync(p)) ?? path.join(codeDir, 'resources', 'app', 'out', 'cli.js');
fs.mkdirSync(path.join(root, '.smoke'), { recursive: true });
const base = fs.mkdtempSync(path.join(root, '.smoke', 'night4-')), profile = path.join(base, 'profile'), extensions = path.join(base, 'extensions'), home = path.join(base, 'home');
const vsixSha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, `agent-vscode-${version}.vsix`))).digest('hex');
const result = { schema: 'datapass.agent-installed-qualification/1', version, sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), vsixSha256, checks: [], artifacts: [], privateHistory: 'not read; synthetic home only' };
const check = (id, ok, detail = '') => { result.checks.push({ id, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${detail}`); if (!ok) throw new Error(id + ': ' + detail); };
fs.mkdirSync(path.join(profile, 'User'), { recursive: true }); fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(path.join(profile, 'User', 'settings.json'), JSON.stringify({ 'workbench.startupEditor': 'none', 'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoUpdate': false, 'workbench.tips.enabled': false, 'chat.disableAIFeatures': true, 'agent.catalog.cliProbes': false }));
const env = { ...process.env, ...buildFixtureHome(home, { cwd: root }) }; delete env.ELECTRON_RUN_AS_NODE;
const installed = execFileSync(exe, [cli, '--extensions-dir', extensions, '--user-data-dir', profile, '--install-extension', path.join(root, `agent-vscode-${version}.vsix`), '--force'], { encoding: 'utf8', env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true });
check('isolated-vsix-install', /successfully installed/i.test(installed));
const driver = path.join(extensions, 'night4.agent-consumer-1.0.0'); fs.mkdirSync(driver, { recursive: true });
fs.writeFileSync(path.join(driver, 'package.json'), JSON.stringify({ name: 'agent-consumer', publisher: 'night4', version: '1.0.0', engines: { vscode: '^1.95.0' }, main: './extension.cjs', activationEvents: ['onStartupFinished'], contributes: { commands: [{ command: 'night4.probe', title: 'NIGHT4: Probe installed Agent contract' }] } }));
const probePath = path.join(base, 'contract-probe.json');
fs.writeFileSync(path.join(driver, 'extension.cjs'), `const vscode=require('vscode'),fs=require('fs');exports.activate=ctx=>ctx.subscriptions.push(vscode.commands.registerCommand('night4.probe',async()=>{try{const api=await vscode.extensions.getExtension('juliandatapass.agent-vscode').activate();const cockpit=api.cockpitV1;const scopes=await cockpit.getScopes();if(!scopes.data.length)throw Error('No reviewed scope');const scope=scopes.data[0],r={requestId:'installed-probe',scope};const summary=await cockpit.getSummary(r),configuration=await cockpit.getProviderConfiguration({...r,provider:'codex'});const denial=await cockpit.getSummary({...r,scope:{...scope,organizationIds:['unapproved-client']}});const reveal=await cockpit.reveal({...r,target:{kind:'project',id:scope.projectIds[0]}});fs.writeFileSync(${JSON.stringify(probePath)},JSON.stringify({legacy:['store','openWorkspace','installed','activationMs','getDevelopmentObservations'].every(k=>k in api),major:cockpit.major,scopes,summary,configuration,denial,reveal},null,2));}catch(e){fs.writeFileSync(${JSON.stringify(probePath)},JSON.stringify({error:String(e.stack||e)}));}}));`);
let app;
async function command(win, title) {
  await win.keyboard.press('Escape'); await win.keyboard.press('F1');
  const input = win.locator('.quick-input-box input'); await input.waitFor({ state: 'visible', timeout: 15000 });
  await input.fill('>' + title); await win.waitForTimeout(400); await win.keyboard.press('Enter');
}
async function frameContaining(win, text, timeout = 30000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    for (const frame of win.frames()) {
      try { if ((await frame.locator('body').innerText()).includes(text)) return frame; } catch {}
    }
    await win.waitForTimeout(250);
  }
  throw new Error('Webview not found: ' + text);
}
try {
  app = await electron.launch({ executablePath: exe, args: ['--extensions-dir', extensions, '--user-data-dir', profile, '--extensionDevelopmentPath', driver, '--disable-gpu-sandbox', '--skip-release-notes', '--skip-welcome', '--disable-workspace-trust', '--new-window', root], env, timeout: 60000 });
  const win = await app.firstWindow(); await win.waitForSelector('.monaco-workbench', { timeout: 60000 });
  await win.setViewportSize({ width: 1200, height: 850 });
  await command(win, 'Agent: Open Compact');
  let frame = await frameContaining(win, 'All observed locally');
  await frame.locator('.compact-session').first().waitFor({ state: 'visible', timeout: 30000 }); check('standalone-compact-observes-fixture', await frame.locator('.compact-session').count() > 1);
  for (const view of ['factory', 'backlog', 'metrics', 'attention', 'live']) {
    await frame.locator(`[data-opt="compact-view"][data-val="${view}"]`).click(); await win.waitForTimeout(500);
    check('compact-view-' + view, await frame.locator('.agent-compact').innerText().then(t => t.length > 60));
  }
  await frame.locator('.compact-session').first().click(); await win.waitForTimeout(300);
  await frame.locator('[data-opt="compact-scope"][data-val="session"]').click(); await win.waitForTimeout(500);
  check('session-drilldown-selection', await frame.locator('.compact-session').count() >= 1);
  await frame.locator('[data-opt="compact-scope"][data-val="all"]').click();
  await command(win, 'Agent: Review Cockpit Scope');
  await win.locator('.quick-input-list .monaco-list-row').first().waitFor({ state: 'visible' });
  const row = win.locator('.quick-input-list .monaco-list-row').first();
  await row.locator('.monaco-checkbox').click();
  console.log('Scope checkbox: ' + await row.locator('.monaco-checkbox').getAttribute('aria-checked'));
  await win.locator('.quick-input-box input').focus(); await win.keyboard.press('Enter');
  for (const value of ['fixture', 'local', 'fixture']) {
    const input = win.locator('.quick-input-box input'); await input.waitFor({ state: 'visible' }); await input.fill(value); await win.keyboard.press('Enter'); await win.waitForTimeout(250);
  }
  await win.locator('.quick-input-list .monaco-list-row').filter({ hasText: 'Observation and sanitized provider configuration' }).first().click(); await win.waitForTimeout(400);
  await command(win, 'NIGHT4: Probe installed Agent contract');
  for (const end = Date.now() + 30000; Date.now() < end && !fs.existsSync(probePath);) await win.waitForTimeout(250);
  check('installed-consumer-reply', fs.existsSync(probePath)); const probe = JSON.parse(fs.readFileSync(probePath)); check('installed-contract-no-error', !probe.error, probe.error ?? '');
  check('legacy-api-preserved', probe.legacy); check('facade-v1', probe.major === 1); check('scoped-summary', probe.summary.data.sessions.length === 1); check('cross-org-denial', probe.denial.state === 'DENIED'); check('sanitized-config-reply', probe.configuration.state === 'PARTIAL'); check('same-host-scoped-navigation', probe.reveal.data.opened);
  frame = await frameContaining(win, 'Recorded roots and worker links');
  await win.setViewportSize({ width: 600, height: 850 }); await win.waitForTimeout(500);
  await win.screenshot({ path: path.join(base, 'compact-narrow.png') }); result.artifacts.push('compact-narrow.png');
  const width = await frame.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, offenders: [...document.querySelectorAll('.agent-compact *')].filter(e => e.getBoundingClientRect().right > document.documentElement.clientWidth).slice(0, 6).map(e => e.className) })); check('compact-narrow-no-page-overflow', width.scroll <= width.width + 1, JSON.stringify(width));
  await command(win, 'Preferences: Color Theme'); await win.locator('.quick-input-box input').fill('Default Light Modern'); await win.waitForTimeout(300); await win.keyboard.press('Enter'); await win.waitForTimeout(500);
  await win.screenshot({ path: path.join(base, 'compact-light.png') }); result.artifacts.push('compact-light.png'); check('light-theme-flow', await frame.locator('.agent-compact').isVisible());
  result.artifacts.push('contract-probe.json');
} catch (error) { result.error = String(error.stack ?? error); process.exitCode = 1; console.error(result.error); }
finally { if (app) await app.close(); fs.writeFileSync(path.join(base, 'qualification.json'), JSON.stringify(result, null, 2)); fs.writeFileSync(path.join(root, '.datapass', 'night4', 'installed-latest.json'), JSON.stringify({ base, ...result }, null, 2)); console.log('Evidence: ' + base); }
