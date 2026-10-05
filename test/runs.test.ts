import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AgentSessionSnapshot, TimelineEvent } from '../src/model';
// Load the workspace first: it owns the screen registry (extra/index imports every screen).
import '../src/render/workspace';
import type { WsData } from '../src/render/workspace';
import { bucketStarts, buildRuns, concurrency, hourGrid, parseTarget, runRows, summarize, tickLanes } from '../src/activity/runs';
import { dayAt } from '../src/activity/week';
import { runsView } from '../src/render/extra/runs';
import { clearFeeds, setFeedValue } from '../src/render/extra/feeds';

function snap(p: Partial<AgentSessionSnapshot>): AgentSessionSnapshot {
  return { key: 'claude:a', provider: 'claude', sessionId: 'a', status: 'ENDED', statusReason: 'r', commits: [], changedFiles: [], tests: [], isWorker: false, counts: { tools: 0, commands: 0, fileEdits: 0, turns: 0 }, evidence: [], artifactPath: 'x', diagnostics: [], ...p };
}
const at = (y: number, m: number, d: number, h: number, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();
const ev = (key: string, t: number): TimelineEvent => ({ at: t, type: 'PROCESS_ACTIVITY', label: 'x', provider: 'claude', sessionKey: key, kind: 'OBSERVED' });
const MIN = 60_000;
const NOW = at(2026, 10, 7, 15);
const label = (s: AgentSessionSnapshot) => s.repository ?? '(no repo)';

function fixture(): { sessions: AgentSessionSnapshot[]; events: TimelineEvent[] } {
  const t1 = at(2026, 10, 7, 9);
  const t2 = at(2026, 10, 7, 9, 30);
  const sessions = [
    snap({ key: 'claude:a', sessionId: 'a', repository: 'D:/r/alpha', startedAt: t1, lastActivityAt: t1 + 60 * MIN, commits: [{ sha: 'abc1234', at: t1 + 50 * MIN, subject: 'feat <x>', attribution: 'during-session' }] }),
    snap({ key: 'codex:b', provider: 'codex', sessionId: 'b', repository: 'D:/r/alpha', startedAt: t2, lastActivityAt: t2 + 20 * MIN, changedFiles: ['f.ts'] }),
    snap({ key: 'claude:c', sessionId: 'c', repository: 'D:/r/beta', startedAt: NOW - 20 * MIN, lastActivityAt: NOW - 2 * MIN, status: 'NEEDS_INPUT', title: '<script>alert(1)</script>' }),
    snap({ key: 'claude:w', sessionId: 'w', repository: 'D:/r/alpha', isWorker: true, parentSessionId: 'claude:a', startedAt: t1 + 5 * MIN, lastActivityAt: t1 + 15 * MIN }),
    snap({ key: 'claude:old', sessionId: 'old', repository: 'D:/r/gamma', startedAt: at(2026, 9, 1, 9), lastActivityAt: at(2026, 9, 1, 10) }),
  ];
  const events = [
    ...[0, 10, 20, 30, 40, 50, 60].map(m => ev('claude:a', t1 + m * MIN)),
    ...[0, 5, 10, 15, 20].map(m => ev('codex:b', t2 + m * MIN)),
    ...[20, 10, 2].map(m => ev('claude:c', NOW - m * MIN)),
  ];
  return { sessions, events };
}

test('buildRuns: one run per session in range, workers optional, outcome and spans', () => {
  const { sessions, events } = fixture();
  const from = dayAt(NOW, -13), to = dayAt(NOW, 1);
  const runs = buildRuns(sessions, events, { from, to, now: NOW, gapMs: 30 * MIN, workers: false, by: 'repo', label });
  assert.deepEqual(runs.map(r => r.key), ['claude:a', 'codex:b', 'claude:c']);
  const a = runs[0];
  assert.equal(a.outcome, 'committed');
  assert.equal(a.spans.length, 1);
  assert.equal(a.activeMs, 60 * MIN);
  assert.equal(runs[1].outcome, 'changed');
  assert.equal(runs[2].live, true);
  assert.equal(runs[2].waiting, true);
  assert.equal(runs[2].b, NOW, 'live run is open until now');
  const withW = buildRuns(sessions, events, { from, to, now: NOW, gapMs: 30 * MIN, workers: true });
  assert.equal(withW.length, 4);
  assert.equal(withW.find(r => r.key === 'claude:w')?.kind, 'INFERRED');
});

test('runRows groups per row with per-day counts and outcome mix', () => {
  const { sessions, events } = fixture();
  const from = dayAt(NOW, -13), to = dayAt(NOW, 1);
  const rows = runRows(buildRuns(sessions, events, { from, to, now: NOW, gapMs: 30 * MIN, workers: false, by: 'repo', label }), from, 14);
  assert.deepEqual(rows.map(r => r.key), ['D:/r/beta', 'D:/r/alpha']);
  const alpha = rows[1];
  assert.equal(alpha.runs.length, 2);
  assert.equal(alpha.perDay[13], 2);
  assert.equal(alpha.counts.committed, 1);
  assert.equal(alpha.counts.changed, 1);
  assert.equal(alpha.commits, 1);
});

test('concurrency: peak, mean and open per bucket; target summary', () => {
  const { sessions, events } = fixture();
  const from = dayAt(NOW), to = dayAt(NOW, 1);
  const runs = buildRuns(sessions, events, { from, to, now: NOW, gapMs: 30 * MIN, workers: false });
  const bk = concurrency(runs, from, to, 'hour', NOW);
  assert.equal(bk.length, 24);
  const nine = bk[9];
  assert.equal(nine.peak, 2, 'a and b overlap 09:30–09:50');
  assert.ok(nine.avg > 1 && nine.avg < 2, `mean ${nine.avg}`);
  assert.deepEqual(nine.keys.sort(), ['claude:a', 'codex:b']);
  assert.equal(bk[10].peak, 0, 'a ends exactly at 10:00: not active in the 10h bucket');
  assert.equal(bk[3].peak, 0);
  const s = summarize(bk, 1);
  assert.equal(s.peak, 2);
  assert.equal(s.peakAt, at(2026, 10, 7, 9));
  assert.equal(s.over, 1);
  assert.equal(summarize(bk, 0).over, 0);
  const grid = hourGrid(runs, NOW, 2);
  assert.equal(grid.length, 2);
  assert.equal(grid[1].day, dayAt(NOW));
  assert.equal(grid[1].cells[9].peak, 2);
});

test('bucketStarts aligns quarters, hours and days; tickLanes folds extra lanes', () => {
  const q = bucketStarts(at(2026, 10, 7, 9, 7), at(2026, 10, 7, 10), 'quarter');
  assert.equal(q[0], at(2026, 10, 7, 9, 0));
  assert.equal(q.length, 5);
  assert.equal(bucketStarts(at(2026, 10, 1, 5), at(2026, 10, 3, 0), 'day').length, 3);
  assert.deepEqual(tickLanes([{ a: 0, b: 10 }, { a: 5, b: 8 }, { a: 6, b: 9 }, { a: 11, b: 12 }], 2), [0, 1, 1, 0]);
});

test('parseTarget accepts positive numbers only', () => {
  assert.equal(parseTarget(4), 4);
  assert.equal(parseTarget('3'), 3);
  assert.equal(parseTarget(2.7), 2);
  assert.equal(parseTarget(-1), 0);
  assert.equal(parseTarget('x'), 0);
  assert.equal(parseTarget(undefined), 0);
  assert.equal(parseTarget(1000), 64);
});

test('runs screen renders every layout and chart, escaped, with target', () => {
  const { sessions, events } = fixture();
  const d: WsData = { sessions, providers: [], events, now: NOW, ternAvailable: false, timeline: () => events };
  clearFeeds();
  setFeedValue('runs.config', { target: 1 });
  const combos: Record<string, string>[] = [
    {},
    { 'runs.view': 'sequence', 'runs.chart': 'line' },
    { 'runs.view': 'grid', 'runs.chart': 'heat', 'runs.win': '7d', 'runs.range': '30d' },
    { 'runs.by': 'provider', 'runs.color': 'model', 'runs.gran': 'quarter', 'runs.workers': 'on' },
    { 'runs.win': '14d', 'runs.gran': 'day', 'runs.range': '7d', 'runs.sort': 'name' },
  ];
  for (const opts of combos) {
    const html = runsView.render(d, { view: 'runs', opts, selected: 'claude:a' });
    assert.ok(html.length > 500, JSON.stringify(opts));
    assert.ok(!html.includes('<script>'), 'escaped');
    assert.ok(html.includes('target'), 'target shown');
  }
  const html = runsView.render(d, { view: 'runs', selected: 'claude:a' });
  assert.ok(html.includes('data-select="claude:a"'));
  assert.ok(html.includes('rn-tk') && html.includes('sel'));
  assert.ok(html.includes('Waiting for you'));
  assert.match(html, /<b>2<small> \/ 1<\/small><\/b><span>Peak · 24h/);
  clearFeeds();
  const off = runsView.render(d, { view: 'runs' });
  assert.ok(off.includes('No target'));
  const empty = runsView.render({ ...d, sessions: [], events: [], timeline: () => [] }, { view: 'runs' });
  assert.ok(empty.includes('No session with recorded activity'));
});
