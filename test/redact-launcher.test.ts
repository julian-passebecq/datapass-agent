import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as os from 'os';
// Load the workspace first: screens import it and it imports the screen registry (cycle).
import '../src/render/workspace';
import { AgentSessionSnapshot } from '../src/model';
import { clearOwned, encodePick, folderKey } from '../src/activity/launcher';
import { launcherView, setTrustProbe } from '../src/render/extra/launcher';
import { clearFeeds, setFeedValue } from '../src/render/extra/feeds';
import type { ActCtx } from '../src/render/extra/kit';
import { WsData } from '../src/render/workspace';

const NOW = Date.parse('2026-10-05T12:00:00Z');
const ROOT = os.tmpdir();
const REPO = ROOT + (ROOT.includes('\\') ? '\\' : '/') + 'repo-a';
const S: AgentSessionSnapshot = { key: 'claude:aaaaaaaa-1111', provider: 'claude', sessionId: 'aaaaaaaa-1111', status: 'ENDED', statusReason: 'r', commits: [], changedFiles: [], tests: [], isWorker: false, counts: { tools: 0, commands: 0, fileEdits: 0, turns: 0 }, evidence: [], artifactPath: 'x', diagnostics: [], lastActivityAt: NOW - 3600_000, cwd: REPO, repository: REPO, model: 'claude-opus-5-5' };

function fakeCtx() {
  const log: string[] = [];
  const ctx: ActCtx = {
    openFile: async () => {}, revealInOs: async () => {}, openUrl: async () => {}, copy: async t => void log.push(`copy:${t}`), info: m => void log.push(`info:${m}`),
    confirm: async m => (log.push(`confirm:${m}`), true), saveText: async () => undefined,
    openTerminal: (_n, cwd, command) => (log.push(`open:${cwd}:${command}`), 'tid1'), closeTerminal: id => void log.push(`close:${id}`),
    runCommand: async () => undefined, refreshFeeds: () => {}, sessions: () => [S],
  };
  return { ctx, log };
}

test('launcher: labelled as the only screen that starts sessions; untrusted workspace never starts or resumes', async () => {
  clearFeeds();
  clearOwned();
  setFeedValue('launcher.env', { workspace: [], profiles: [], missing: [] });
  const d: WsData = { sessions: [S], providers: [], events: [], now: NOW, ternAvailable: false };
  const arg = encodePick({ provider: 'claude', folder: folderKey(REPO), model: 'default', effort: 'default', profile: 'none', mode: 'default' });
  try {
    assert.match(launcherView.hint, /only screen that starts provider sessions/);
    const html = launcherView.render(d, { view: 'launcher' });
    assert.match(html, /EXPERIMENTAL · the only Agent screen that starts provider sessions/);
    assert.ok(!html.includes('not trusted'));

    setTrustProbe(() => false);
    assert.match(launcherView.render(d, { view: 'launcher' }), /disabled: this workspace is not trusted/);
    const u = fakeCtx();
    await launcherView.actions!.start(arg, u.ctx);
    await launcherView.actions!.resume(S.key, u.ctx);
    assert.ok(!u.log.some(l => l.startsWith('confirm:') || l.startsWith('open:')), u.log.join('\n'));
    assert.equal(u.log.filter(l => l.includes('trusted workspace')).length, 2);
    await launcherView.actions!.copy(arg, u.ctx);
    assert.ok(u.log.some(l => l.startsWith('copy:claude')), 'copying the command stays available');

    setTrustProbe(() => true);
    const t = fakeCtx();
    await launcherView.actions!.start(arg, t.ctx);
    assert.ok(t.log.some(l => l.startsWith('confirm:')) && t.log.some(l => l.startsWith('open:')), 'trusted: confirm, then start');
  } finally {
    setTrustProbe(() => true);
    clearOwned();
    clearFeeds();
  }
});
