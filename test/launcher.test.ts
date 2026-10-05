import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as os from 'os';
// Load the workspace first: screens import it and it imports the screen registry (cycle).
import '../src/render/workspace';
import { AgentSessionSnapshot } from '../src/model';
import {
  addOwned, Allow, buildResume, buildStart, clearOwned, decodePick, encodePick, folderChoices, folderKey, joinTokens, listOwned,
  modelChoices, profileChoices, specOf, takeOwned, terminalName,
} from '../src/activity/launcher';
import { launcherView } from '../src/render/extra/launcher';
import { clearFeeds, setFeedValue } from '../src/render/extra/feeds';
import type { ActCtx } from '../src/render/extra/kit';
import { WsData } from '../src/render/workspace';

const NOW = Date.parse('2026-10-05T12:00:00Z');
const ROOT = os.tmpdir();
const REPO = ROOT + (ROOT.includes('\\') ? '\\' : '/') + 'repo-a';

function snap(p: Partial<AgentSessionSnapshot>): AgentSessionSnapshot {
  return { key: 'claude:aaaaaaaa-1111', provider: 'claude', sessionId: 'aaaaaaaa-1111', status: 'ENDED', statusReason: 'r', commits: [], changedFiles: [], tests: [], isWorker: false, counts: { tools: 0, commands: 0, fileEdits: 0, turns: 0 }, evidence: [], artifactPath: 'x', diagnostics: [], lastActivityAt: NOW - 3600_000, cwd: REPO, repository: REPO, ...p };
}

const SESSIONS = [
  snap({ model: 'claude-opus-5-5' }),
  snap({ key: 'codex:bbbbbbbb-2222', provider: 'codex', sessionId: 'bbbbbbbb-2222', model: 'gpt-5.1-codex', facts: { modelTokens: { 'gpt-5.1-codex': 10, '<synthetic>': 1, 'Bad Name; rm': 2 } } }),
];

function allow(): Allow {
  return { models: modelChoices(SESSIONS), profiles: profileChoices(['fast', 'Deep Work', 'review']), folders: folderChoices(SESSIONS, []) };
}

test('joinTokens refuses anything that would need shell quoting', () => {
  assert.equal(joinTokens(['claude', '--model', 'opus']), 'claude --model opus');
  for (const bad of ['a b', 'x;y', '$(id)', '`id`', 'a&b', 'a|b', '"q"', "'q'", 'a>b', '%PATH%', 'a!b', '', 'a\nb'])
    assert.throws(() => joinTokens(['claude', bad]), /unsafe token/, bad);
});

test('folderKey is stable, case and slash insensitive on Windows-like paths', () => {
  assert.match(folderKey('D:\\PROJ\\x'), /^f[0-9a-f]{8}$/);
  if (process.platform === 'win32') assert.equal(folderKey('D:\\PROJ\\x'), folderKey('d:/proj/x/'));
  assert.notEqual(folderKey('D:/PROJ/x'), folderKey('D:/PROJ/y'));
});

test('folderChoices merges sessions and workspace folders, drops junk', () => {
  const f = folderChoices([...SESSIONS, snap({ repository: undefined, cwd: 'relative/path' })], [REPO, ROOT]);
  assert.equal(f.length, 2);
  assert.equal(f.find(x => x.path === REPO)?.from, 'both');
  assert.equal(f.find(x => x.path === REPO)?.sessions, 2);
  assert.equal(f.find(x => x.path === ROOT)?.from, 'workspace');
});

test('modelChoices: defaults first, then models seen, invalid names skipped', () => {
  const m = modelChoices(SESSIONS);
  assert.deepEqual(m.claude.slice(0, 3), ['opus', 'sonnet', 'haiku']);
  assert.ok(m.claude.includes('claude-opus-5-5'));
  assert.ok(m.codex.includes('gpt-5.1-codex'));
  assert.ok(!m.codex.some(x => x.includes('synthetic') || x.includes(' ')));
  assert.deepEqual(profileChoices(['fast', 'Deep Work', 'fast', 'x;y']), ['fast']);
});

test('buildStart: Claude flags, never bypassPermissions', () => {
  const a = allow();
  const b = buildStart({ provider: 'claude', cwd: REPO, model: 'opus', effort: 'high', mode: 'acceptEdits' }, a);
  assert.ok(b.ok);
  assert.equal(b.ok && b.command, 'claude --model opus --effort high --permission-mode acceptEdits');
  assert.equal(b.ok && b.cwd, REPO);
  const plain = buildStart({ provider: 'claude', cwd: REPO, mode: 'default' }, a);
  assert.equal(plain.ok && plain.command, 'claude');
  assert.equal(buildStart({ provider: 'claude', cwd: REPO, mode: 'bypassPermissions' as never }, a).ok, false);
  assert.equal(buildStart({ provider: 'claude', cwd: REPO, model: 'evil;rm', mode: 'default' }, a).ok, false);
  assert.equal(buildStart({ provider: 'claude', cwd: REPO, effort: 'ultra', mode: 'default' }, a).ok, false);
  assert.equal(buildStart({ provider: 'claude', cwd: ROOT, mode: 'default' }, a).ok, false, 'folder must be in the list');
  assert.equal(buildStart({ provider: 'claude', cwd: REPO, profile: 'fast', mode: 'default' }, a).ok, false);
});

test('buildStart: Codex profile, model, effort and sandbox mapping', () => {
  const a = allow();
  const b = buildStart({ provider: 'codex', cwd: REPO, model: 'gpt-5.1-codex', effort: 'high', profile: 'fast', mode: 'plan' }, a);
  assert.equal(b.ok && b.command, 'codex --profile fast --model gpt-5.1-codex -c model_reasoning_effort=high --sandbox read-only --ask-for-approval on-request');
  const e = buildStart({ provider: 'codex', cwd: REPO, mode: 'acceptEdits' }, a);
  assert.equal(e.ok && e.command, 'codex --sandbox workspace-write --ask-for-approval on-request');
  assert.ok(!(e.ok && /danger|never|bypass/.test(e.command)));
  assert.equal(buildStart({ provider: 'codex', cwd: REPO, profile: 'Deep Work', mode: 'default' }, a).ok, false);
});

test('buildResume validates the id and folder', () => {
  assert.equal(buildResume(SESSIONS[0]).ok && (buildResume(SESSIONS[0]) as { command: string }).command, 'claude --resume aaaaaaaa-1111');
  const cx = buildResume(SESSIONS[1]);
  assert.equal(cx.ok && cx.command, 'codex resume bbbbbbbb-2222');
  assert.equal(buildResume(snap({ sessionId: 'abc; rm -rf /' })).ok, false);
  assert.equal(buildResume(snap({ sessionId: 'short' })).ok, false);
  assert.equal(buildResume(snap({ cwd: undefined, repository: undefined })).ok, false);
  assert.equal(buildResume(undefined).ok, false);
});

test('pick encoding round-trips and maps lowercase modes', () => {
  const a = allow();
  const p = { provider: 'claude' as const, folder: a.folders[0].key, model: 'opus', effort: 'default', profile: 'none', mode: 'acceptedits' };
  const back = decodePick(encodePick(p));
  assert.deepEqual(back, p);
  const s = specOf(back!, a);
  assert.ok(!('error' in s));
  assert.deepEqual(s, { provider: 'claude', cwd: REPO, model: 'opus', effort: undefined, profile: undefined, mode: 'acceptEdits' });
  assert.equal(decodePick('claude|x'), undefined);
  assert.equal(decodePick('bash|a|b|c|d|e'), undefined);
  assert.ok('error' in specOf({ ...p, mode: 'bypasspermissions' }, a));
  assert.ok('error' in specOf({ ...p, folder: 'f00000000' }, a));
});

test('owned terminal registry only closes its own ids', () => {
  clearOwned();
  addOwned({ id: 't1', name: 'n', cwd: REPO, command: 'claude', provider: 'claude', at: NOW });
  assert.equal(takeOwned('other'), undefined);
  assert.equal(takeOwned('t1')?.id, 't1');
  assert.equal(listOwned().length, 0);
  assert.equal(terminalName('codex', 'D:\\PROJ\\repo\\'), 'Agent · Codex · repo');
});

function fakeCtx(confirm: boolean) {
  const log: string[] = [];
  const ctx: ActCtx = {
    openFile: async () => {}, revealInOs: async () => {}, openUrl: async () => {}, copy: async t => void log.push(`copy:${t}`), info: m => void log.push(`info:${m}`),
    confirm: async m => (log.push(`confirm:${m}`), confirm), saveText: async () => undefined,
    openTerminal: (name, cwd, command) => (log.push(`open:${cwd}:${command}`), 'tid1'), closeTerminal: id => void log.push(`close:${id}`),
    runCommand: async () => undefined, refreshFeeds: () => {}, sessions: () => SESSIONS,
  };
  return { ctx, log };
}

test('screen renders escaped, actions confirm before opening a terminal', async () => {
  clearFeeds();
  clearOwned();
  setFeedValue('launcher.env', { workspace: [], profiles: ['fast'], missing: [] });
  const d: WsData = { sessions: SESSIONS, providers: [], events: [], now: NOW, ternAvailable: false };
  const html = launcherView.render(d, { view: 'launcher', selected: 'codex:bbbbbbbb-2222', opts: { 'launcher.claude.model': 'opus' } });
  assert.ok(launcherView.ready);
  assert.match(html, /claude --model opus/);
  assert.match(html, /codex resume bbbbbbbb-2222/);
  assert.ok(!html.includes('<script'));
  const arg = encodePick({ provider: 'claude', folder: folderKey(REPO), model: 'opus', effort: 'high', profile: 'none', mode: 'plan' });
  const no = fakeCtx(false);
  await launcherView.actions!.start(arg, no.ctx);
  assert.ok(no.log.some(l => l.startsWith('confirm:')) && !no.log.some(l => l.startsWith('open:')));
  const yes = fakeCtx(true);
  await launcherView.actions!.start(arg, yes.ctx);
  assert.ok(yes.log.includes(`open:${REPO}:claude --model opus --effort high --permission-mode plan`));
  assert.equal(listOwned().length, 1);
  await launcherView.actions!.resume('codex:bbbbbbbb-2222', yes.ctx);
  assert.ok(yes.log.includes(`open:${REPO}:codex resume bbbbbbbb-2222`));
  await launcherView.actions!.close('not-ours', yes.ctx);
  assert.ok(!yes.log.some(l => l.startsWith('close:')));
  await launcherView.actions!.close('tid1', yes.ctx);
  assert.ok(yes.log.includes('close:tid1'));
  const bad = fakeCtx(true);
  await launcherView.actions!.start('claude|' + folderKey(REPO) + '|evil;rm|default|none|default', bad.ctx);
  assert.ok(!bad.log.some(l => l.startsWith('open:')));
  clearOwned();
  clearFeeds();
});
