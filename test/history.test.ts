import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { AgentSessionSnapshot } from '../src/model';
// Load the workspace first: it owns the screen registry (extra/index imports every screen).
import { renderWorkspace, WsData } from '../src/render/workspace';
import { mergeWeek, rowsByWeek, sessionRows, shiftWeek, total, validateWeek, weekId, weekStartOf, weeklyMarkdown, daily, breakdown, HistRow } from '../src/activity/history';
import { readArchive, writeArchive, HISTORY_FEED, historyDir, defaultHistoryDir } from '../src/feeds/history';
import { historyView, historyCsv } from '../src/render/extra/history';
import { clearFeeds, setFeedValue } from '../src/render/extra/feeds';
import { tmpDir } from './helpers';

const at = (y: number, m: number, d: number, h: number, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();
const H = 3600_000;

function snap(p: Partial<AgentSessionSnapshot> & { key: string }): AgentSessionSnapshot {
  const [provider, sessionId] = p.key.split(':') as ['claude' | 'codex', string];
  return { provider, sessionId, status: 'ENDED', statusReason: 'r', commits: [], changedFiles: [], tests: [], isWorker: false, counts: { tools: 0, commands: 0, fileEdits: 0, turns: 0 }, evidence: [], artifactPath: 'x', diagnostics: [], ...p };
}

// Sunday 4 Oct 2026 22:00 → Monday 5 Oct 01:00 local: spans ISO weeks 2026-W40 and 2026-W41.
const SPAN = snap({
  key: 'claude:span', title: 'SECRET TITLE do not archive', repository: 'D:/x/alpha', model: 'claude-opus-5-5', effort: 'high',
  startedAt: at(2026, 10, 4, 22), lastActivityAt: at(2026, 10, 5, 1),
  usage: { totalTokens: 1000, outputTokens: 100, cachedInputTokens: 0 },
  facts: { calls: [[at(2026, 10, 4, 22, 30), 300, 30], [at(2026, 10, 5, 0, 30), 500, 50]], prompts: 3, activeMs: 2 * H },
  counts: { tools: 4, commands: 2, fileEdits: 2, turns: 1 }, changedFiles: ['a.ts'],
  commits: [{ sha: 'abc', at: at(2026, 10, 5, 0, 45), subject: 'feat', attribution: 'during-session' }],
});
const WORKER = snap({ key: 'claude:w1', repository: 'D:/x/alpha', isWorker: true, workerLabel: 'Explore · find', parentSessionId: 'claude:span', startedAt: at(2026, 10, 1, 9), lastActivityAt: at(2026, 10, 1, 10), usage: { totalTokens: 200, outputTokens: 20, cachedInputTokens: 0 } });
const CODEX = snap({ key: 'codex:c1', repository: 'D:/x/be<ta>&', model: 'gpt-6', startedAt: at(2026, 9, 29, 9), lastActivityAt: at(2026, 9, 29, 11), usage: { totalTokens: 400, outputTokens: 40, cachedInputTokens: 0 }, tests: [{ command: 'npm test', at: at(2026, 9, 29, 10), outcome: 'FAIL', source: 'provider-exit-code' }] });

test('history: ISO week ids round-trip, year edges and shifts', () => {
  assert.equal(weekId(at(2026, 10, 5, 12)), '2026-W41');
  assert.equal(weekId(at(2026, 10, 4, 23, 59)), '2026-W40', 'Sunday belongs to the week that started Monday');
  assert.equal(weekId(at(2026, 1, 1, 12)), '2026-W01', '1 Jan 2026 is a Thursday');
  assert.equal(weekId(at(2027, 1, 1, 12)), '2026-W53', '1 Jan 2027 is a Friday: still week 53 of 2026');
  assert.equal(weekId(at(2024, 12, 30, 12)), '2025-W01');
  assert.equal(weekStartOf('2026-W41'), at(2026, 10, 5, 0));
  assert.equal(weekStartOf('2025-W53'), undefined, '2025 has 52 ISO weeks');
  assert.equal(weekStartOf('nope'), undefined);
  assert.equal(shiftWeek('2026-W01', -1), '2025-W52');
  assert.equal(shiftWeek('2026-W52', 2), '2027-W01');
});

test('history: a session spanning two weeks splits tokens per call and counts in both weeks', () => {
  const rows = sessionRows(SPAN, true);
  assert.deepEqual([...rows.keys()].sort(), ['2026-W40', '2026-W41']);
  const w40 = rows.get('2026-W40')!, w41 = rows.get('2026-W41')!;
  assert.deepEqual(w40.d.tokens, [0, 0, 0, 0, 0, 0, 330]);
  assert.equal(w41.d.tokens![0], 550 + 120, 'second call + unrecorded remainder at the last activity');
  assert.equal(w40.d.sessions![6] + w41.d.sessions![0], 2);
  assert.equal(w41.d.commits![0], 1);
  assert.equal(w41.d.prompts![0], 3);
  assert.equal(w41.o, 'committed');
  assert.equal(w41.repo, 'alpha');
  assert.ok(!JSON.stringify([...rows.values()]).includes('SECRET'), 'no title in rows');
  const noGit = sessionRows(SPAN, false).get('2026-W41')!;
  assert.equal(noGit.d.commits, undefined, 'commits only counted when git was read');
  assert.equal(noGit.o, 'changed');
  assert.equal(noGit.g, 0);
});

test('history: merge keeps rows of earlier runs and git commits over a git-less run', () => {
  const src = { by: 'script' as const, git: true, days: 30, sessions: 3 };
  const first = mergeWeek('2026-W41', undefined, rowsByWeek([SPAN], true).get('2026-W41')!, src, 1);
  const other: HistRow = { k: 'codex:gone', p: 'codex', repo: 'old', o: 'nochange', g: 1, d: { sessions: [1, 0, 0, 0, 0, 0, 0], tokens: [5, 0, 0, 0, 0, 0, 0] } };
  const withGone = mergeWeek('2026-W41', first, [other], src, 2);
  assert.equal(withGone.rows.length, 2);
  assert.equal(withGone.kept, 1);
  const again = mergeWeek('2026-W41', withGone, rowsByWeek([SPAN], false).get('2026-W41')!, { ...src, by: 'workspace', git: false }, 3);
  const r = again.rows.find(x => x.k === SPAN.key)!;
  assert.equal(r.d.commits?.[0], 1, 'commits from the git run survive');
  assert.equal(r.o, 'committed');
  assert.equal(again.runs, 3);
  assert.equal(again.totals.tokens, 670 + 5);
  assert.equal(total(again.rows, 'sessions'), 2);
});

test('history: validation drops bad rows and recomputes rollups', () => {
  assert.equal(validateWeek({ schema: 2, week: '2026-W41', rows: [] }), undefined);
  assert.equal(validateWeek({ schema: 1, week: '2026-W99', rows: [] }), undefined);
  const w = validateWeek({
    schema: 1, week: '2026-W41', totals: { tokens: 999999 },
    rows: [
      { k: 'claude:a', p: 'claude', repo: 'r', o: 'changed', g: 1, d: { tokens: [1, 2, 3, 0, 0, 0, 0], bogus: [1, 1, 1, 1, 1, 1, 1], sessions: [1, 0, 0, 0, 0, 0, 0] } },
      { k: 'claude:b', p: 'gemini', repo: 'r', o: 'changed', d: {} },
      { k: 'claude:c', p: 'claude', repo: 'r', o: 'changed', d: { tokens: [1, 2] } },
      'junk',
    ],
  })!;
  assert.equal(w.rows.length, 2);
  assert.equal(w.totals.tokens, 6, 'totals never trusted from disk');
  assert.equal((w.rows[0].d as any).bogus, undefined);
  assert.equal(w.rows[1].d.tokens, undefined, 'a daily array must have 7 numbers');
});

test('history: archive write → read round-trip, markdown report, no prompt text, merge on second run', () => {
  const dir = path.join(tmpDir('hist'), 'history');
  const r = writeArchive(dir, [SPAN, WORKER, CODEX], { by: 'script', git: true, days: 3650 }, at(2026, 10, 5, 12));
  assert.deepEqual(r.weeks, ['2026-W40', '2026-W41']);
  const files = fs.readdirSync(dir).sort();
  assert.deepEqual(files, ['2026-W40.json', '2026-W40.md', '2026-W41.json', '2026-W41.md']);
  for (const f of files) assert.ok(!fs.readFileSync(path.join(dir, f), 'utf8').includes('SECRET'), `${f} holds no title`);
  const md = fs.readFileSync(path.join(dir, '2026-W41.md'), 'utf8');
  assert.match(md, /# Agent weekly audit · 2026-W41/);
  assert.match(md, /\| Tokens \| 670 \| 930 \|/);
  const a = readArchive(dir, 52);
  assert.equal(a.files, 2);
  assert.deepEqual(a.weeks.map(w => w.week), ['2026-W40', '2026-W41']);
  assert.deepEqual(a.reports.sort(), ['2026-W40', '2026-W41']);
  const w40 = a.weeks[0];
  assert.equal(total(w40.rows, 'tokens'), 330 + 200 + 400);
  assert.equal(total(w40.rows, 'tokens', true), 330 + 400, 'leads only');
  assert.deepEqual(daily(w40.rows, 'fail'), [0, 1, 0, 0, 0, 0, 0]);
  assert.deepEqual(breakdown(w40.rows, 'tokens', 'worker')[0], ['lead', 730]);
  // second run without the codex session (cleaned up by the provider): its row stays.
  writeArchive(dir, [SPAN], { by: 'script', git: true, days: 3650 }, at(2026, 10, 6, 12));
  const b = readArchive(dir, 52);
  assert.equal(b.weeks[0].rows.length, 3);
  assert.equal(b.weeks[0].kept, 2);
  assert.equal(b.weeks[0].runs, 2);
  // a malformed file is reported, not fatal; the cap keeps the newest weeks.
  fs.writeFileSync(path.join(dir, '2026-W39.json'), '{ nope');
  const c = readArchive(dir, 2);
  assert.deepEqual(c.weeks.map(w => w.week), ['2026-W40', '2026-W41']);
  assert.equal(readArchive(dir, 5).errors.length, 1);
  assert.equal(readArchive(path.join(dir, 'missing'), 5).exists, false);
  assert.equal(historyDir('relative/path'), defaultHistoryDir());
  assert.equal(historyDir(dir), path.normalize(dir));
  const csv = historyCsv(b.weeks, false).trim().split('\n');
  assert.equal(csv[0].split(',')[0], 'week');
  assert.equal(csv.length, 3);
});

test('history: weekly markdown escapes table cells and compares with the previous week', () => {
  const rows = rowsByWeek([CODEX, { ...SPAN, repository: 'D:/x/pipe|repo' }], true);
  const w40 = mergeWeek('2026-W40', undefined, rows.get('2026-W40')!, { by: 'script', git: true, days: 1, sessions: 2 }, 1);
  const w41 = mergeWeek('2026-W41', undefined, rows.get('2026-W41')!, { by: 'script', git: true, days: 1, sessions: 2 }, 1);
  const md = weeklyMarkdown(w41, w40);
  assert.ok(!md.includes('pipe|repo'));
  assert.match(md, /pipe repo/);
  assert.match(md, /2026-W40/);
});

function data(sessions: AgentSessionSnapshot[], now: number): WsData {
  return { sessions, providers: [], events: [], now, ternAvailable: false, git: { enabled: true } };
}

test('history screen: every view renders escaped from the archive plus loaded sessions', () => {
  clearFeeds();
  const dir = path.join(tmpDir('hist-ui'), 'history');
  writeArchive(dir, [WORKER, CODEX], { by: 'script', git: true, days: 3650 }, at(2026, 10, 5, 12));
  setFeedValue(HISTORY_FEED, readArchive(dir, 52));
  const d = data([SPAN], at(2026, 10, 7, 12));
  const views: Record<string, string>[] = [
    {}, { 'history.orient': 'rows', 'history.cmp': 'delta' }, { 'history.cmp': 'avg' },
    { 'history.view': 'trend' }, { 'history.view': 'trend', 'history.gran': 'day', 'history.chart': 'line', 'history.by': 'repo' },
    { 'history.view': 'trend', 'history.chart': 'bars', 'history.dir': 'horizontal', 'history.acc': 'cumulative' },
    { 'history.view': 'matrix', 'history.by': 'repo' }, { 'history.view': 'matrix', 'history.orient': 'rows', 'history.norm': 'share' },
    { 'history.view': 'week', 'history.pick': '2026-w40' }, { 'history.view': 'week' }, { 'history.view': 'week', 'history.pick': '2026-w30' },
    { 'history.who': 'leads', 'history.live': 'off', 'history.range': '52' },
  ];
  for (const opts of views) {
    const html = renderWorkspace(d, { view: 'history', opts });
    assert.ok(html.includes('class="hi"'), JSON.stringify(opts));
    assert.ok(!html.includes('be<ta>'), `repo name escaped (${JSON.stringify(opts)})`);
    assert.ok(!html.includes('<script'), 'no script');
  }
  const week = renderWorkspace(d, { view: 'history', opts: { 'history.view': 'week', 'history.pick': '2026-w40' } });
  assert.match(week, /be&lt;ta&gt;&amp;/);
  assert.match(week, /Open audit report/);
  assert.match(week, /data-select="claude:span"/, 'loaded sessions stay selectable');
  const sbs = renderWorkspace(d, { view: 'history', opts: {} });
  assert.match(sbs, /W41<sup>\+<\/sup>/, 'current week marked as including loaded sessions');
  const off = renderWorkspace(d, { view: 'history', opts: { 'history.live': 'off', 'history.view': 'week', 'history.pick': '2026-w41' } });
  assert.match(off, /No archived session for 2026-W41/);
});

test('history screen: empty archive explains how to fill it; actions validate their argument', async () => {
  clearFeeds();
  setFeedValue(HISTORY_FEED, readArchive(path.join(tmpDir('hist-empty'), 'none'), 52));
  const html = renderWorkspace(data([], at(2026, 10, 7, 12)), { view: 'history', opts: {} });
  assert.match(html, /No week file yet/);
  assert.match(html, /How the archive is filled/);
  assert.match(html, /data-act="build"/);
  const calls: string[] = [];
  const ctx: any = { copy: async (t: string) => calls.push(`copy:${t}`), info: (m: string) => calls.push(`info:${m}`), openFile: async (p: string) => calls.push(`open:${p}`), confirm: async () => false };
  await historyView.actions!.copy('rm -rf /', ctx);
  await historyView.actions!.report('../../etc', ctx);
  await historyView.actions!.build('all', ctx);
  assert.deepEqual(calls, [], 'invalid args ignored; build declined at the confirm');
  await historyView.actions!.copy('script', ctx);
  assert.match(calls[0], /^copy:npm run compile-tests && node out-test\/scripts\/weekly\.js$/);
  clearFeeds();
});
