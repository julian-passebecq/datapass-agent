import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { AgentSessionSnapshot, TimelineEvent } from '../src/model';
// Load the workspace first: it owns the screen registry (extra/index imports every screen).
import { renderWorkspace, WsData } from '../src/render/workspace';
import { acquireLock, copyRaw, dayOf, rawAllowed, readIndex, sessionDayFile, writeArchiveDay } from '../src/archive/archive';
import { ARCHIVE_FEED, archivedOnly, readArchiveView, clearArchiveCache } from '../src/archive/reader';
import { ClaudeAdapter } from '../src/providers/claude/claude';
import { CodexAdapter } from '../src/providers/codex/codex';
import { SessionStore } from '../src/sessions/store';
import { scanBacklog } from '../src/feeds/backlog';
import { clearFeeds, setFeedValue } from '../src/render/extra/feeds';
import { parseJsonc } from '../scripts/archive';
import { FIXTURES, jpath, materialize, tmpDir } from './helpers';

const at = (y: number, m: number, d: number, h: number) => new Date(y, m - 1, d, h).getTime();
const DAY1 = at(2026, 10, 3, 3);
const DAY2 = at(2026, 10, 4, 3);
const DAY2B = at(2026, 10, 4, 15);

function snap(p: Partial<AgentSessionSnapshot> & { key: string }): AgentSessionSnapshot {
  const [provider, sessionId] = p.key.split(':') as ['claude' | 'codex', string];
  return { provider, sessionId, status: 'ENDED', statusReason: 'r', commits: [], changedFiles: [], tests: [], isWorker: false, counts: { tools: 0, commands: 0, fileEdits: 0, turns: 0 }, evidence: [], artifactPath: 'x', diagnostics: [], ...p };
}
const ev = (key: string, t: number, label: string): TimelineEvent => ({ at: t, type: 'PROCESS_ACTIVITY', label, provider: 'claude', sessionKey: key, kind: 'OBSERVED' });

const A = snap({ key: 'claude:a', title: 'Named A', evidence: [{ field: 'title', kind: 'OBSERVED', source: 'custom-title record' }], repository: 'D:/x/alpha', startedAt: DAY1 - 3600_000, lastActivityAt: DAY1 - 60_000, usage: { totalTokens: 100, outputTokens: 10, cachedInputTokens: 0 } });
const B = snap({ key: 'codex:b', title: 'first prompt text do not keep', repository: 'D:/x/beta', startedAt: DAY1 - 7200_000, lastActivityAt: DAY1 - 3600_000 });

const lines = (file: string) => fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));

test('archive: idempotent upsert within a day, unchanged sessions not rewritten on later days', () => {
  const dir = path.join(tmpDir('arch-upsert'), 'archive');
  const r1 = writeArchiveDay(dir, { sessions: [A, B], events: [ev('claude:a', DAY1 - 120_000, '$ npm test')], now: DAY2 });
  assert.equal(r1.written, 2);
  const r2 = writeArchiveDay(dir, { sessions: [A, B], events: [ev('claude:a', DAY1 - 120_000, '$ npm test')], now: DAY2B });
  assert.equal(r2.day, r1.day);
  const f = sessionDayFile(dir, dayOf(DAY2));
  assert.equal(lines(f).length, 2, 're-running the same day keeps one line per session');
  const A2 = { ...A, lastActivityAt: DAY2B - 1000, usage: { totalTokens: 500, outputTokens: 50, cachedInputTokens: 0 } };
  writeArchiveDay(dir, { sessions: [A2, B], events: [], now: DAY2B + 1000 });
  const after = lines(f);
  assert.equal(after.length, 2);
  assert.equal(after.find(x => x.key === 'claude:a').s.usage.totalTokens, 500, 'same-day line replaced');
  // next day, nothing changed → no new file
  const r3 = writeArchiveDay(dir, { sessions: [A2, B], events: [], now: at(2026, 10, 5, 3) });
  assert.equal(r3.written, 0);
  assert.equal(r3.unchanged, 2);
  assert.ok(!fs.existsSync(sessionDayFile(dir, '2026-10-05')));
  const idx = readIndex(dir);
  assert.deepEqual([idx.sessions['claude:a'].first, idx.sessions['claude:a'].last], ['2026-10-04', '2026-10-04']);
  const run = {
    runId: 'r1', sessionId: 'a', parentKey: 'claude:a', projectSlug: 'p', name: 'wave', phases: [{ title: 'build' }], status: 'done' as const, startedAt: DAY1, lastAt: DAY1 + 1,
    agents: [{ agentId: 'g1', label: 'coder', status: 'done' as const, statusBasis: 'x', tokens: 7, outputTokens: 2, calls: 1, tools: 1, toolErrors: 0, sessionKey: 'claude:g1', result: 'REPLY TEXT never kept' }],
  };
  writeArchiveDay(dir, { sessions: [], events: [], workflows: [run], now: DAY2 });
  writeArchiveDay(dir, { sessions: [], events: [], workflows: [run], now: DAY2B });
  const wf = lines(path.join(dir, 'workflows', `${dayOf(DAY2)}.jsonl`));
  assert.equal(wf.length, 1);
  assert.equal(wf[0].tokens, 7);
  assert.ok(!JSON.stringify(wf).includes('REPLY TEXT'), 'agent results are not archived');
  assert.ok(!fs.readdirSync(path.dirname(f)).some(n => n.endsWith('.tmp')), 'no temp file left');
});

test('archive: a session the provider deleted survives and shows in History as ARCHIVED', () => {
  clearFeeds();
  clearArchiveCache();
  const dir = path.join(tmpDir('arch-gone'), 'archive');
  writeArchiveDay(dir, { sessions: [A, B], events: [], now: DAY1 });
  const A2 = { ...A, lastActivityAt: DAY2 - 1000 };
  const r = writeArchiveDay(dir, { sessions: [A2], events: [], now: DAY2 }); // B's transcript is gone
  assert.equal(r.kept, 1);
  assert.equal(r.totalArchived, 2);
  assert.deepEqual(lines(sessionDayFile(dir, dayOf(DAY2))).map(x => x.key), ['claude:a']);
  const view = readArchiveView(dir);
  assert.deepEqual(view.sessions.map(s => s.key).sort(), ['claude:a', 'codex:b']);
  assert.equal(view.sessions.find(s => s.key === 'claude:a')!.day, dayOf(DAY2), 'latest line wins');
  const only = archivedOnly(view, [A2]);
  assert.deepEqual(only.map(x => x.s.key), ['codex:b']);
  assert.match(only[0].s.statusReason, /ARCHIVED: OBSERVED on 2026-10-03/);
  assert.ok(only[0].s.evidence.some(e => e.field === 'archive'));

  setFeedValue(ARCHIVE_FEED, view);
  const d: WsData = { sessions: [A2], providers: [], events: [], now: DAY2 + 3600_000, ternAvailable: false, git: { enabled: true } };
  const html = renderWorkspace(d, { view: 'history', opts: {} });
  assert.match(html, /ARCHIVED 2026-10-03/);
  assert.match(html, /From archive/);
  const off = renderWorkspace(d, { view: 'history', opts: { 'history.archive': 'off' } });
  assert.ok(!off.includes('ARCHIVED 2026-10-03'), 'toggle off hides archived sessions');
  const week = renderWorkspace(d, { view: 'history', opts: { 'history.view': 'week', 'history.pick': '2026-w40' } });
  assert.ok(week.length > 500);
  clearFeeds();
});

test('archive: no prompt or reply text from real provider fixtures; titles redacted; workflows and backlog snapshots', async () => {
  const home = tmpDir('arch-home');
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo);
  const vars = { __CWD__: jpath(repo), __HEAD__: '0'.repeat(40), __MISSING__: jpath(path.join(home, 'gone')) };
  materialize(path.join(FIXTURES, 'claude'), path.join(home, 'claude'), vars);
  materialize(path.join(FIXTURES, 'codex'), path.join(home, 'codex'), vars);
  const store = new SessionStore([new ClaudeAdapter(path.join(home, 'claude')), new CodexAdapter(path.join(home, 'codex'))], { historyDays: 3650, maxSessions: 100, idleMinutes: 10, git: false }, () => at(2026, 10, 5, 12));
  await store.refresh();
  const sessions = store.all();
  assert.ok(sessions.length >= 3, 'fixture sessions loaded');
  const leaky = snap({ key: 'claude:leak', title: 'token sk-ant-FAKEFAKEFAKEFAKE0000 here', evidence: [{ field: 'title', kind: 'OBSERVED', source: 'custom-title record' }], lastActivityAt: DAY1 });
  const dir = path.join(home, 'archive');
  const bl = await scanBacklog({ roots: [path.join(FIXTURES, 'backlog', 'repo')], now: DAY1 });
  writeArchiveDay(dir, { sessions: [...sessions, leaky], events: store.timeline(undefined, Number.MAX_SAFE_INTEGER), backlog: bl, now: DAY1 });
  store.dispose();
  const out = fs.readFileSync(sessionDayFile(dir, dayOf(DAY1)), 'utf8');
  for (const s of ['Implement the parser', 'Build the tern panel', 'sk-ant-FAKE', 'abcdefghijklmnopqrstuvwxyz0123']) assert.ok(!out.includes(s), `no "${s}" in the archive`);
  assert.match(out, /Parser work/, 'provider-named title kept');
  assert.match(out, /\[REDACTED\]/);
  const recs = lines(sessionDayFile(dir, dayOf(DAY1)));
  assert.ok(recs.some(r => r.events.length > 0), 'timeline events archived');
  assert.ok(recs.every(r => r.events.length <= 2000));
  const blFile = path.join(dir, 'backlog', `${dayOf(DAY1)}.json`);
  const blSnap = JSON.parse(fs.readFileSync(blFile, 'utf8'));
  assert.ok(blSnap.files.length > 0 && blSnap.files[0].items.length > 0);
  assert.deepEqual(readIndex(dir).backlogDays, [dayOf(DAY1)]);
});

test('archive: backlog items removed from a plan stay visible as ARCHIVED', async () => {
  clearFeeds();
  clearArchiveCache();
  const root = tmpDir('arch-bl');
  fs.mkdirSync(path.join(root, 'handoff'));
  const plan = path.join(root, 'handoff', 'PLAN.md');
  fs.writeFileSync(plan, '# Plan\n- [x] **GONE-1** closed and later removed\n- [ ] **KEEP-1** still here\n');
  const dir = path.join(tmpDir('arch-bl-out'), 'archive');
  writeArchiveDay(dir, { sessions: [], events: [], backlog: await scanBacklog({ roots: [root], now: DAY1 }), now: DAY1 });
  fs.writeFileSync(plan, '# Plan\n- [ ] **KEEP-1** still here\n');
  const now = await scanBacklog({ roots: [root], now: DAY2 });
  setFeedValue('backlog.plans', { report: now, extra: [] });
  setFeedValue(ARCHIVE_FEED, readArchiveView(dir));
  const s = snap({ key: 'claude:z', repository: root, lastActivityAt: DAY2 });
  const d: WsData = { sessions: [s], providers: [], events: [], now: DAY2, ternAvailable: false };
  const table = renderWorkspace(d, { view: 'backlog', opts: { 'backlog.view': 'table', 'backlog.state': 'all' } });
  assert.match(table, /GONE-1/);
  assert.match(table, /ARCHIVED 2026-10-03/);
  const off = renderWorkspace(d, { view: 'backlog', opts: { 'backlog.view': 'table', 'backlog.state': 'all', 'backlog.snap': 'off' } });
  assert.ok(!off.includes('GONE-1'));
  const board = renderWorkspace(d, { view: 'backlog', opts: { 'backlog.view': 'board', 'backlog.state': 'done' } });
  assert.match(board, /ARCHIVED 2026-10-03/);
  clearFeeds();
});

test('archive: raw copy gzips transcripts, skips auth / secret names and files outside the provider root, honours the cap', async () => {
  const home = tmpDir('arch-raw');
  const root = path.join(home, '.claude');
  fs.mkdirSync(path.join(root, 'projects', 'p'), { recursive: true });
  const ok = path.join(root, 'projects', 'p', 'sess.jsonl');
  fs.writeFileSync(ok, '{"type":"user"}\n'.repeat(50));
  const auth = path.join(root, 'auth.jsonl');
  const cred = path.join(root, '.credentials.json');
  const tok = path.join(root, 'projects', 'p', 'token-dump.jsonl');
  const outside = path.join(home, 'elsewhere.jsonl');
  for (const f of [auth, cred, tok, outside]) fs.writeFileSync(f, 'secret');
  assert.equal(rawAllowed({ provider: 'claude', root, file: auth }), false);
  assert.equal(rawAllowed({ provider: 'claude', root, file: cred }), false);
  assert.equal(rawAllowed({ provider: 'claude', root, file: outside }), false);
  const dir = path.join(home, 'archive');
  const srcs = [ok, auth, cred, tok, outside].map(file => ({ provider: 'claude', root, file }));
  const r = await copyRaw(dir, srcs, 1024 ** 3, DAY1);
  assert.equal(r.copied, 1);
  assert.equal(r.refused, 4);
  const gz = path.join(dir, 'raw', 'claude', 'projects', 'p', 'sess.jsonl.gz');
  assert.equal(zlib.gunzipSync(fs.readFileSync(gz)).toString(), fs.readFileSync(ok, 'utf8'));
  const names: string[] = [];
  const walk = (p: string) => { for (const e of fs.readdirSync(p, { withFileTypes: true })) e.isDirectory() ? walk(path.join(p, e.name)) : names.push(e.name); };
  walk(path.join(dir, 'raw'));
  assert.ok(!names.some(n => /auth|credential|token/.test(n)), names.join(','));
  const again = await copyRaw(dir, srcs, 1024 ** 3, DAY2);
  assert.equal(again.copied, 0);
  assert.equal(again.skipped, 1, 'unchanged file not copied twice');
  fs.appendFileSync(ok, '{"type":"assistant"}\n');
  const capped = await copyRaw(dir, srcs, 1, DAY2);
  assert.equal(capped.copied, 0);
  assert.equal(capped.capped, true, 'cap reached: grown file not recopied');
});

test('archive: lock blocks a second run; settings.json with comments parses', () => {
  const dir = path.join(tmpDir('arch-lock'), 'archive');
  const release = acquireLock(dir, Date.now());
  assert.throws(() => acquireLock(dir, Date.now()), /another archive run/);
  release();
  acquireLock(dir, Date.now())();
  const o = parseJsonc('{\n // c\n "agent.archive.dir": "D:\\\\x//y", /* b */ "a": [1,],\n}');
  assert.equal(o['agent.archive.dir'], 'D:\\x//y');
});
