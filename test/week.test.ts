import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AgentSessionSnapshot, TimelineEvent } from '../src/model';
// Load the workspace first: it owns the screen registry (extra/index imports every screen).
import '../src/render/workspace';
import type { WsData } from '../src/render/workspace';
import { activeHours, daySummaries, dayStarts, peakConcurrency, spans, weekBlocks, weekStart } from '../src/activity/week';
import { weekView, colorOf } from '../src/render/extra/week';

function snap(p: Partial<AgentSessionSnapshot>): AgentSessionSnapshot {
  return { key: 'claude:a', provider: 'claude', sessionId: 'a', status: 'ENDED', statusReason: 'r', commits: [], changedFiles: [], tests: [], isWorker: false, counts: { tools: 0, commands: 0, fileEdits: 0, turns: 0 }, evidence: [], artifactPath: 'x', diagnostics: [], ...p };
}
const at = (y: number, m: number, d: number, h: number, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();
const ev = (key: string, t: number, label = 'x'): TimelineEvent => ({ at: t, type: 'PROCESS_ACTIVITY', label, provider: 'claude', sessionKey: key, kind: 'OBSERVED' });
const MIN = 60_000;

// Wednesday 7 Oct 2026, 15:00 local.
const NOW = at(2026, 10, 7, 15);

test('weekStart is local Monday midnight; offsets move by whole weeks', () => {
  const mon = weekStart(NOW);
  assert.equal(new Date(mon).getDay(), 1);
  assert.equal(new Date(mon).getDate(), 5);
  assert.equal(new Date(mon).getHours(), 0);
  assert.equal(new Date(weekStart(NOW, -1)).getDate(), 28);
  assert.equal(new Date(weekStart(at(2026, 10, 11, 23))).getDate(), 5, 'Sunday belongs to the week that started Monday');
  assert.equal(dayStarts(mon, 7).length, 8);
});

test('spans split at idle gaps; two points only are INFERRED; live extends to now', () => {
  const t0 = at(2026, 10, 6, 9);
  const s = spans([t0, t0 + 5 * MIN, t0 + 10 * MIN, t0 + 90 * MIN, t0 + 95 * MIN], 30 * MIN, false, NOW);
  assert.equal(s.length, 2);
  assert.deepEqual(s.map(x => x.kind), ['DERIVED', 'DERIVED']);
  assert.equal(s[0].b, t0 + 10 * MIN);
  const inf = spans([t0, t0 + 3 * 3600_000], 30 * MIN, false, NOW);
  assert.equal(inf.length, 1);
  assert.equal(inf[0].kind, 'INFERRED');
  const live = spans([NOW - 20 * MIN, NOW - 15 * MIN, NOW - 10 * MIN], 30 * MIN, true, NOW);
  assert.equal(live[0].b, NOW);
  const tiny = spans([t0, t0 + 1000, t0 + 2000], 30 * MIN, false, NOW);
  assert.equal(tiny[0].b - tiny[0].a, MIN, 'minimum visible length');
});

test('weekBlocks cut at midnight, place overlapping sessions in lanes, and attach commits and PR commands', () => {
  const from = weekStart(NOW);
  const a = snap({ key: 'claude:a', startedAt: at(2026, 10, 5, 22), lastActivityAt: at(2026, 10, 6, 1), commits: [{ sha: 'abc1234', at: at(2026, 10, 6, 0, 50), subject: 'fix', attribution: 'during-session' }] });
  const b = snap({ key: 'codex:b', provider: 'codex', startedAt: at(2026, 10, 5, 23), lastActivityAt: at(2026, 10, 5, 23, 40) });
  const events = [
    ...[0, 20, 40, 60, 80, 100, 120, 140, 160, 180].map(m => ev('claude:a', at(2026, 10, 5, 22) + m * MIN)),
    ev('claude:a', at(2026, 10, 6, 0, 55), 'gh pr create --fill'),
    ...[0, 10, 20, 30, 40].map(m => ev('codex:b', at(2026, 10, 5, 23) + m * MIN)),
  ];
  const blocks = weekBlocks([a, b], events, { from, days: 7, gapMs: 30 * MIN, now: NOW });
  const ab = blocks.filter(x => x.key === 'claude:a');
  assert.equal(ab.length, 2, 'split at midnight');
  assert.equal(ab[0].day, 0);
  assert.equal(ab[1].day, 1);
  assert.ok(ab[0].cutEnd && ab[1].cutStart);
  assert.equal(ab[1].commits.length, 1);
  assert.equal(ab[1].prs, 1);
  const mon = blocks.filter(x => x.day === 0);
  assert.equal(mon.length, 2);
  assert.ok(mon.every(x => x.lanes === 2));
  assert.deepEqual(mon.map(x => x.lane).sort(), [0, 1]);
  const sums = daySummaries(blocks, from, 7);
  assert.equal(sums[0].sessions, 2);
  assert.equal(sums[0].activeMs, 2 * 3600_000, 'union 22:00–24:00, overlap counted once');
  assert.equal(sums[0].peak, 2);
  assert.equal(sums[1].commits, 1);
  assert.equal(peakConcurrency([]), 0);
  const [h0, h1] = activeHours(blocks, dayStarts(from, 7));
  assert.ok(h0 === 0 && h1 === 24);
});

test('workers are hidden unless asked; sessions outside the range are skipped', () => {
  const from = weekStart(NOW);
  const w = snap({ key: 'claude:w', isWorker: true, startedAt: at(2026, 10, 6, 10), lastActivityAt: at(2026, 10, 6, 11) });
  const old = snap({ key: 'claude:o', startedAt: at(2026, 9, 1, 10), lastActivityAt: at(2026, 9, 1, 11) });
  assert.equal(weekBlocks([w, old], [], { from, days: 7, gapMs: 30 * MIN, now: NOW }).length, 0);
  assert.equal(weekBlocks([w], [], { from, days: 7, gapMs: 30 * MIN, now: NOW, workers: true }).length, 1);
});

function data(sessions: AgentSessionSnapshot[], events: TimelineEvent[] = []): WsData {
  return { sessions, providers: [], events, now: NOW, ternAvailable: false };
}

test('week screen renders both orientations and every range, escapes titles, marks live blocks', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const live = snap({ key: 'claude:l', title: evil, status: 'RUNNING', startedAt: NOW - 40 * MIN, lastActivityAt: NOW - MIN, repository: 'D:/PROJ/<b>repo' });
  const events = [0, 10, 20, 30, 39].map(m => ev('claude:l', NOW - 40 * MIN + m * MIN));
  const d = data([live], events);
  for (const range of ['week', 'work', 'day']) {
    for (const orient of ['vertical', 'horizontal']) {
      for (const color of ['repo', 'provider', 'model', 'outcome']) {
        const html = weekView.render(d, { view: 'week', opts: { 'week.range': range, 'week.orient': orient, 'week.color': color } });
        assert.ok(!html.includes('<img'), 'title escaped');
        assert.ok(!html.includes('<b>repo'), 'repo escaped');
        assert.ok(html.includes('data-select="claude:l"'));
        assert.ok(html.includes('wk-live'));
        assert.ok(html.includes('wk-now'));
      }
    }
  }
  const prev = weekView.render(d, { view: 'week', opts: { 'week.woff': '-1' } });
  assert.ok(prev.includes('No session activity'));
  assert.ok(prev.includes('data-opt="week.woff" data-val="-2"'));
  assert.equal(weekView.ready, true);
});

test('colorOf maps each dimension to a label', () => {
  const s = snap({ provider: 'codex', model: 'gpt-5-codex', repository: 'D:/PROJ/app' });
  assert.equal(colorOf(s, 'provider')[0], 'Codex');
  assert.equal(colorOf(s, 'repo')[0], 'app');
  assert.equal(colorOf(s, 'model')[0], 'gpt-5-codex');
  assert.equal(colorOf(snap({}), 'model')[0], 'model not recorded');
  assert.equal(colorOf(s, 'outcome')[0], 'No file change observed');
});
