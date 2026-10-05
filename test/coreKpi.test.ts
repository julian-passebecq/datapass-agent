// Overview and Board KPI evidence titles, "≥" on durations with no recorded end (audit A6 P2-10 remainder).
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AgentSessionSnapshot, TimelineEvent } from '../src/model';
import { durTip, END_INFERRED_TIP, renderView, resultCard, WsData } from '../src/render/workspace';

const NOW = new Date(2026, 9, 7, 15).getTime();
const MIN = 60_000;

function snap(p: Partial<AgentSessionSnapshot>): AgentSessionSnapshot {
  return { key: 'claude:a', provider: 'claude', sessionId: 'a', title: 'task', repository: 'D:/PROJ/app', status: 'ENDED', statusReason: 'provider marked the session ended', commits: [], changedFiles: [], tests: [], isWorker: false, counts: { tools: 0, commands: 0, fileEdits: 0, turns: 0 }, evidence: [{ field: 'status', kind: 'OBSERVED', source: 'end record' }], artifactPath: 'x', diagnostics: [], ...p };
}
const ended = snap({ key: 'claude:e', startedAt: NOW - 120 * MIN, lastActivityAt: NOW - 100 * MIN, endedAt: NOW - 100 * MIN, tests: [{ at: NOW - 110 * MIN, command: 'npm test', outcome: 'PASS', source: 'provider-tool-error-flag' } as AgentSessionSnapshot['tests'][number]], usage: { totalTokens: 1000, costUSD: 0.5 } as AgentSessionSnapshot['usage'] });
const open = snap({ key: 'claude:o', statusReason: 'no live registry entry', startedAt: NOW - 90 * MIN, lastActivityAt: NOW - 60 * MIN, endedAt: undefined, evidence: [] });
const live = snap({ key: 'claude:l', status: 'RUNNING', statusReason: 'live registry: busy', startedAt: NOW - 30 * MIN, lastActivityAt: NOW - MIN, endedAt: undefined, evidence: [] });
const events: TimelineEvent[] = [];
const d: WsData = { sessions: [ended, open, live], providers: [], events, now: NOW, ternAvailable: false, timeline: () => events };
const KIND = /^(OBSERVED|DERIVED|INFERRED|UNKNOWN): \S/;

test('Overview: every KPI carries "<KIND>: <basis>"', () => {
  const html = renderView(d, { view: 'overview' }, 'overview');
  const kpis = [...html.matchAll(/<div class="kpi(?: [^"]*)?"([^>]*)>/g)];
  assert.ok(kpis.length >= 9, 'overview kpis rendered');
  for (const k of kpis) assert.match(k[1], /title="(OBSERVED|DERIVED|INFERRED|UNKNOWN): [^"]+"/, k[0]);
});

test('Board: every column count carries an evidence title', () => {
  const html = renderView(d, { view: 'board' }, 'board');
  const counts = [...html.matchAll(/<span class="n"([^>]*)>\d+<\/span>/g)];
  assert.equal(counts.length, 5);
  for (const c of counts) assert.match(c[1], /title="(OBSERVED|DERIVED|INFERRED|UNKNOWN): [^"]+"/, c[0]);
  // Card durations / end times carry their evidence too.
  const rights = [...html.matchAll(/<span class="right"([^>]*)>/g)];
  assert.ok(rights.length >= 3);
  for (const r of rights) assert.match(r[1], /title="(OBSERVED|DERIVED|INFERRED|UNKNOWN): [^"]+"/, r[0]);
});

test('durTip: live, observed end, inferred end', () => {
  assert.match(durTip(live), KIND);
  assert.match(durTip(ended), /^OBSERVED: /);
  assert.equal(durTip(open), END_INFERRED_TIP);
});

test('Result card: duration with no recorded end is a lower bound (≥)', () => {
  assert.match(resultCard(open, NOW), /Duration \(to last record\)<\/span><b><span title="DERIVED: [^"]+">≥ 30m/);
  assert.doesNotMatch(resultCard(ended, NOW), />≥ /);
  assert.doesNotMatch(resultCard(live, NOW), />≥ /);
});
