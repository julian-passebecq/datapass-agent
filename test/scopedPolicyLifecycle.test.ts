import { test, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import * as ts from 'typescript';
import { cockpitFixture } from './cockpitFixture';
import { localHost } from '../src/cockpit/facade';
import { repoId } from '../src/cockpit/policy';

async function scopedFixture(t: TestContext) {
  const fixture = await cockpitFixture(), commands = new Map<string, Function>();
  const nativePanels: any[] = [], listeners = new Set<Function>();
  let refreshes = 0;
  const store = {
    all: () => fixture.snapshots, adapters: [fixture.adapter], version: 1,
    opts: { historyDays: 30, git: false }, providerStates: [],
    timeline: () => [], gitProgress: { done: 0, total: 0 },
    onDidChange(fn: Function) { listeners.add(fn); return { dispose() { listeners.delete(fn); } }; },
    refresh() { refreshes++; throw new Error('Policy changes must not refresh provider sources'); },
  };
  const vscode = {
    ThemeIcon: class {}, ViewColumn: { Active: 1 },
    commands: {
      registerCommand(id: string, fn: Function) { commands.set(id, fn); return { dispose() { commands.delete(id); } }; },
      executeCommand(id: string, ...args: unknown[]) { return commands.get(id)!(...args); },
    },
    window: {
      createWebviewPanel() {
        const callbacks: { message?: Function; visibility?: Function; dispose?: Function } = {};
        const messages: { html: string }[] = [];
        const panel = {
          visible: true, active: true, title: 'Agent', iconPath: undefined as unknown, disposed: false,
          messages, callbacks,
          webview: {
            options: {}, cspSource: 'self', html: '',
            onDidReceiveMessage(fn: Function) { callbacks.message = fn; },
            postMessage(message: { html: string }) { messages.push(message); return Promise.resolve(true); },
          },
          onDidChangeViewState(fn: Function) { callbacks.visibility = fn; },
          onDidDispose(fn: Function) { callbacks.dispose = fn; },
          reveal() {},
          dispose() { if (!panel.disposed) { panel.disposed = true; callbacks.dispose?.(); } },
        };
        nativePanels.push(panel); return panel;
      },
      async showQuickPick(items: unknown[], options: { canPickMany?: boolean }) { return options.canPickMany ? [items[0]] : items[0]; },
      async showInputBox(options: { title: string }) { return options.title === 'Organization ID' ? 'local' : 'fixture'; },
      showInformationMessage() {},
    },
    workspace: { isTrusted: false, getConfiguration() { return { get(_key: string, fallback: unknown) { return fallback; } }; } },
  };
  function load(name: string, replacements: Record<string, unknown>) {
    const source = fs.readFileSync(path.resolve(__dirname, '../../src/ui/' + name + '.ts'), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const localRequire = createRequire(path.resolve(__dirname, '../src/ui/' + name + '.js'));
    const module = { exports: {} as any };
    new Function('require', 'module', 'exports', compiled)((id: string) => id === 'vscode' ? vscode : replacements[id] ?? localRequire(id), module, module.exports);
    return module.exports;
  }
  // Keep both real UI classes, facade, policy and renderers. Only the public host
  // surface, feed pumping and clock are simulated; no store notification is sent.
  const feedRequire = createRequire(path.resolve(__dirname, '../src/ui/workspace.js'));
  const workspace = load('workspace', { '../render/extra/feeds': { ...feedRequire('../render/extra/feeds'), pump() {} } });
  const cockpit = load('cockpit', { './workspace': workspace });
  const subscriptions: { dispose(): void }[] = [];
  const facade = cockpit.registerCockpit({ subscriptions, globalState: { async update() {} } }, store, () => false, () => {}, () => ({}));
  t.after(() => {
    for (const subscription of subscriptions) subscription.dispose();
    t.mock.timers.reset();
    fs.rmSync(fixture.temp, { recursive: true, force: true });
  });
  const review = () => vscode.commands.executeCommand('agent.reviewCockpitScope');
  const revoke = () => vscode.commands.executeCommand('agent.revokeCockpitScopes');
  const open = async () => {
    const reply = await facade.api.getScopes(), scope = reply.data[0];
    const context = { organizationId: 'local', privacyDomainId: 'fixture', projectId: 'fixture', repoId: repoId(fixture.repo), hostId: localHost().hostId, worktreeId: null, revision: null, selectedItemId: fixture.snapshots[0].key, returnToken: 'pm:fixture' };
    assert.equal((await facade.api.revealContext({ requestId: 'panel:policy', scope, context })).state, 'OK');
    const panel = nativePanels.at(-1); panel.callbacks.message({ type: 'ready', key: '' });
    assert.match(panel.messages.at(-1).html, /data-cmd="returnToPm"/);
    return { panel, scope, epoch: reply.epoch };
  };
  return { review, revoke, open, facade, store, listeners, nativePanels, refreshes: () => refreshes };
}

function invalid(panel: any) {
  const html = panel.messages.at(-1).html;
  assert.match(html, /class="context-bridge" role="alert"/);
  assert.match(html, /reviewed source grant changed or was revoked/);
  assert.match(html, /<h2>Reviewed scope is no longer valid<\/h2>/);
  assert.doesNotMatch(html, /data-cmd="(?:returnToPm|copyReturnToken|openScopedLens)"/);
}

test('actual revoke command invalidates visible scoped panels through the coalesced scheduler without a store event', async t => {
  const f = await scopedFixture(t); await f.review();
  const first = await f.open(), second = await f.open();
  const counts = [first, second].map(x => x.panel.messages.length);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await f.revoke(); await f.revoke();
  assert.deepEqual((await f.facade.api.getScopes()).data, []);
  assert.equal((await f.facade.api.getSummary({ requestId: 'old:policy', scope: first.scope, epoch: first.epoch })).state, 'DENIED');
  t.mock.timers.tick(299);
  assert.deepEqual([first, second].map(x => x.panel.messages.length), counts);
  t.mock.timers.tick(1);
  for (const [index, { panel }] of [first, second].entries()) { invalid(panel); assert.equal(panel.messages.length, counts[index] + 1); }
  await f.revoke(); t.mock.timers.tick(300);
  assert.deepEqual([first, second].map(x => x.panel.messages.length), counts.map(count => count + 1), 'unchanged invalid panels are not rendered again');
  assert.equal(f.store.version, 1); assert.equal(f.refreshes(), 0);
});

test('actual re-review invalidates old scoped panels and only fresh navigation receives the new grant', async t => {
  const f = await scopedFixture(t); await f.review(); const old = await f.open();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await f.review();
  assert.equal((await f.facade.api.getSummary({ requestId: 'old:review', scope: old.scope, epoch: old.epoch })).state, 'DENIED');
  t.mock.timers.tick(300); invalid(old.panel);
  const fresh = await f.open(); assert.ok(fresh.epoch > old.epoch);
  assert.match(fresh.panel.messages.at(-1).html, /data-cmd="returnToPm"/);
  invalid(old.panel);
  assert.equal(f.store.version, 1); assert.equal(f.refreshes(), 0);
});

test('policy notifications preserve hidden-panel and disposal behavior without provider refresh', async t => {
  const f = await scopedFixture(t); await f.review();
  const hidden = await f.open(), closed = await f.open();
  hidden.panel.visible = false;
  const hiddenCount = hidden.panel.messages.length, closedCount = closed.panel.messages.length, subscriptions = f.listeners.size;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await f.revoke(); closed.panel.dispose();
  assert.equal(f.listeners.size, subscriptions - 1, 'closed scoped panel unsubscribes');
  t.mock.timers.tick(300);
  assert.equal(hidden.panel.messages.length, hiddenCount); assert.equal(closed.panel.messages.length, closedCount, 'disposal cancels the queued render');
  await f.review(); t.mock.timers.tick(300);
  assert.equal(hidden.panel.messages.length, hiddenCount); assert.equal(closed.panel.messages.length, closedCount);
  hidden.panel.visible = true; hidden.panel.callbacks.visibility({ webviewPanel: hidden.panel }); invalid(hidden.panel);
  assert.equal(f.store.version, 1); assert.equal(f.refreshes(), 0);
});
