// Per-KPI evidence titles and "≥" duration bounds (audit A6 P2-10, A3 P2-11 / P2-15).
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AgentSessionSnapshot, TimelineEvent } from '../src/model';
// Load the workspace first: it owns the screen registry (extra/index imports every screen).
import '../src/render/workspace';
import type { WsData, WsState } from '../src/render/workspace';
import { aliveInferred, endObserved, transitions } from '../src/activity/audit';
import { weekView, openEnd } from '../src/render/extra/week';
import { exploreView, atLeast } from '../src/render/extra/explore';
import { healthView } from '../src/render/extra/health';
import type { WeekBlock } from '../src/activity/week';

const at = (y: number, m: number, d: number, h: number, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();
const NOW = at(2026, 10, 7, 15);
const MIN = 60_000;

function snap(p: Partial<AgentSessionSnapshot>): AgentSessionSnapshot {
  return { key: 'claude:a', provider: 'claude', sessionId: 'a', title: 'task', repository: 'D:/PROJ/app', status: 'ENDED', statusReason: 'provider marked the session ended', commits: [], changedFiles: [], tests: [], isWorker: false, counts: { tools: 0, commands: 0, fileEdits: 0, turns: 0 }, evidence: [{ field: 'status', kind: 'OBSERVED', source: 'end record' }], artifactPath: 'x', diagnostics: [], ...p };
}
const ev = (key: string, t: number): TimelineEvent => ({ at: t, type: 'PROCESS_ACTIVITY', label: 'x', provider: 'claude', sessionKey: key, kind: 'OBSERVED' });

const ended = snap({ key: 'claude:e', startedAt: NOW - 120 * MIN, lastActivityAt: NOW - 100 * MIN, endedAt: NOW - 100 * MIN });
const open = snap({ key: 'claude:o', status: 'ENDED', statusReason: 'no live registry entry', startedAt: NOW - 90 * MIN, lastActivityAt: NOW - 60 * MIN, endedAt: undefined, evidence: [] });
const events = [ev('claude:e', NOW - 120 * MIN), ev('claude:e', NOW - 110 * MIN), ev('claude:e', NOW - 100 * MIN), ev('claude:o', NOW - 90 * MIN), ev('claude:o', NOW - 75 * MIN), ev('claude:o', NOW - 60 * MIN)];

/** Every element with class "kpi" carries a title "<KIND>: <basis>". */
function assertKpiTitles(html: string, screen: string): void {
  const kpis = [...html.matchAll(/<div class="kpi(?: [^"]*)?"([^>]*)>/g)];
  assert.ok(kpis.length >= 3, `${screen}: kpis rendered`);
  for (const k of kpis) assert.match(k[1], /title="(OBSERVED|DERIVED|INFERRED|UNKNOWN): [^"]+"/, `${screen}: ${k[0]}`);
}

test('endObserved: only a provider-recorded end counts', () => {
  assert.equal(endObserved(ended), true);
  assert.equal(endObserved(open), false);
  assert.equal(endObserved(snap({ status: 'RUNNING', endedAt: undefined })), false);
});

test('Week: every KPI has an evidence title; open-ended durations shown with ≥', () => {
  const d: WsData = { sessions: [ended, open], providers: [], events, now: NOW, ternAvailable: false, timeline: () => events };
  const st: WsState = { view: 'week', opts: { 'week.range': 'day' } };
  const html = weekView.render(d, st);
  assertKpiTitles(html, 'week');
  assert.match(html, /<b>≥ [^<]+<\/b><span>Agent time/);
  assert.match(html, /ends at the last recorded activity/);
  // Only the observed-end session: no ≥.
  const only = weekView.render({ ...d, sessions: [ended] }, st);
  assert.doesNotMatch(only, /<b>≥ [^<]+<\/b><span>Agent time/);

  const b = { key: 'claude:o', day: 0, a: NOW - 90 * MIN, b: NOW - 60 * MIN, kind: 'DERIVED', lane: 0, lanes: 1, live: false, cutStart: false, cutEnd: false, commits: [], tests: [], prs: 0 } as WeekBlock;
  assert.equal(openEnd(open, b), true);
  assert.equal(openEnd(open, { ...b, b: NOW - 80 * MIN }), false, 'an earlier block of the session ends at an observed later activity');
  assert.equal(openEnd(ended, { ...b, key: 'claude:e' }), false);
  assert.equal(openEnd(ended, { ...b, live: true }), true);
});

test('Explore: KPI titles, active time marked ≥ when a session has no recorded end', () => {
  const d: WsData = { sessions: [ended, open], providers: [], events, now: NOW, ternAvailable: false, timeline: () => events };
  const html = exploreView.render(d, { view: 'explore', opts: { 'explore.metric': 'active', 'explore.chart': 'table', 'explore.period': '24h' } });
  assertKpiTitles(html, 'explore');
  assert.match(html, /<b>≥ /);
  const by = new Map([ended, open].map(s => [s.key, s]));
  assert.equal(atLeast('active', ['claude:e'], by), '');
  assert.equal(atLeast('active', ['claude:e', 'claude:o'], by), '≥ ');
  assert.equal(atLeast('commits', ['claude:o'], by), '');
});

test('Health: every KPI has an evidence title', () => {
  const live = snap({ key: 'claude:l', status: 'RUNNING', statusReason: 'live registry: busy', startedAt: NOW - 30 * MIN, lastActivityAt: NOW - MIN, endedAt: undefined });
  const d: WsData = { sessions: [ended, live], providers: [], events, now: NOW, ternAvailable: false, timeline: () => events };
  assertKpiTitles(healthView.render(d, { view: 'health' }), 'health');
});

test('Audit: alive-check transitions carry an "(inferred)" suffix', () => {
  const pid = snap({ key: 'claude:p', status: 'IDLE', statusReason: 'live registry: idle', endedAt: undefined, lastActivityAt: NOW - 2 * MIN, evidence: [{ field: 'status.alive', kind: 'INFERRED', source: 'registry pid answers a signal-0 check' }] });
  const gone = snap({ key: 'claude:g', status: 'ENDED', statusReason: 'no live registry entry', endedAt: NOW - 5 * MIN, lastActivityAt: NOW - 5 * MIN, evidence: [] });
  const noEnd = snap({ key: 'claude:n', status: 'ENDED', statusReason: 'no live registry entry', endedAt: undefined, lastActivityAt: NOW - 7 * MIN, evidence: [] });
  const r = transitions([pid, gone, noEnd, ended], [], { now: NOW });
  assert.equal(aliveInferred(pid), true);
  assert.match(r.find(x => x.key === 'claude:p' && x.kind === 'idle')!.label, /\(inferred\)$/);
  const g = r.find(x => x.key === 'claude:g' && x.kind === 'ended')!;
  assert.equal(g.evidence, 'INFERRED');
  assert.match(g.label, /\(inferred\)$/);
  assert.match(r.find(x => x.key === 'claude:n' && x.kind === 'ended')!.label, /\(inferred\)$/);
  assert.doesNotMatch(r.find(x => x.key === 'claude:e' && x.kind === 'ended')!.label, /inferred/);
});
