import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AgentSessionSnapshot, EventType, TimelineEvent } from '../src/model';
// Load the workspace before the screen module (the screen imports workspace helpers; workspace imports the registry).
import { renderWorkspace, WsData } from '../src/render/workspace';
import { dwell, loopStats, machine, statusPath, workPath, workState } from '../src/activity/lifecycle';
import { edgeKind, lifecycleView, renderLifecycle, sessTok } from '../src/render/extra/lifecycle';
import { T } from './helpers';

const NOW = T('2026-10-05T12:00:00Z');
const M = 60_000;

function mk(p: Partial<AgentSessionSnapshot> & { key: string }): AgentSessionSnapshot {
  const [provider, sessionId] = p.key.split(':') as ['claude' | 'codex', string];
  return { provider, sessionId, status: 'ENDED', statusReason: 'test', commits: [], changedFiles: [], tests: [], isWorker: false, counts: { tools: 0, commands: 0, fileEdits: 0, turns: 0 }, evidence: [], artifactPath: '', diagnostics: [], startedAt: NOW - 120 * M, lastActivityAt: NOW - 60 * M, ...p };
}
const ev = (key: string, at: number, type: EventType, label: string, kind: TimelineEvent['kind'] = 'OBSERVED'): TimelineEvent => ({ at, type, label, provider: key.startsWith('codex') ? 'codex' : 'claude', sessionKey: key, kind });

const A = 'claude:aaaa-1111';
const a = mk({ key: A, title: 'fix <b>bug</b>', lastActivityAt: NOW - 68 * M, endedAt: NOW - 67 * M, facts: { toolCounts: { Read: 3, Edit: 2, Bash: 4 } } });
const aEv: TimelineEvent[] = [
  ev(A, NOW - 120 * M, 'SESSION_STARTED', 'session started'),
  ev(A, NOW - 119 * M, 'TOOL_ACTIVITY', 'Read'),
  ev(A, NOW - 118 * M, 'TOOL_ACTIVITY', 'Grep'),
  ev(A, NOW - 117 * M, 'FILE_CHANGE', 'edited a.ts'),
  ev(A, NOW - 116 * M, 'TEST', 'FAIL npm test'),
  ev(A, NOW - 115 * M, 'FILE_CHANGE', 'edited a.ts'),
  ev(A, NOW - 114 * M, 'TEST', 'PASS npm test'),
  ev(A, NOW - 113 * M, 'GIT_CHANGE', 'git commit command run'),
  ev(A, NOW - 113 * M, 'COMMIT', 'abc1234 fix', 'DERIVED'),
  // 40 min gap → idle, then a second prompt
  ev(A, NOW - 73 * M, 'SESSION_ACTIVITY', 'user turn'),
  ev(A, NOW - 72 * M, 'PROCESS_ACTIVITY', '$ git status'),
  ev(A, NOW - 71 * M, 'PROCESS_ACTIVITY', '$ npm run build'),
  ev(A, NOW - 68 * M, 'TOOL_ACTIVITY', 'TodoWrite'),
];
const B = 'codex:bbbb-2222';
const b = mk({ key: B, status: 'NEEDS_INPUT', startedAt: NOW - 30 * M, lastActivityAt: NOW - 10 * M });
const bEv: TimelineEvent[] = [
  ev(B, NOW - 30 * M, 'SESSION_ACTIVITY', 'turn started'),
  ev(B, NOW - 25 * M, 'FILE_CHANGE', 'update x.ts'),
  ev(B, NOW - 10 * M, 'SESSION_ACTIVITY', 'turn completed'),
];
const C = 'claude:cccc-3333';
const c = mk({ key: C, status: 'RUNNING', startedAt: NOW - 5 * M, lastActivityAt: NOW - M, isWorker: true, workerLabel: 'coder', parentSessionId: A });
const events = [...aEv, ...bEv, ev(C, NOW - 2 * M, 'FILE_CHANGE', 'edited c.ts')];

test('workState classifies events', () => {
  assert.equal(workState(ev(A, 0, 'TOOL_ACTIVITY', 'Grep'))?.state, 'read');
  assert.equal(workState(ev(A, 0, 'TOOL_ACTIVITY', 'TodoWrite')), undefined);
  assert.equal(workState(ev(A, 0, 'PROCESS_ACTIVITY', '$ rg foo src'))?.state, 'read');
  assert.equal(workState(ev(A, 0, 'PROCESS_ACTIVITY', '$ npm run build')), undefined);
  assert.equal(workState(ev(A, 0, 'TEST', 'FAIL npm test'))?.state, 'fail');
  assert.equal(workState(ev(A, 0, 'TEST', 'UNKNOWN npm test'))?.state, 'test');
  assert.equal(workState(ev(B, 0, 'SESSION_ACTIVITY', 'turn completed'))?.state, 'reply');
  assert.equal(workState(ev(A, 0, 'SESSION_ACTIVITY', 'context compacted')), undefined);
});

test('statusPath: started → running ⇄ idle → ended with evidence', () => {
  const p = statusPath(a, events, { now: NOW });
  assert.deepEqual(p.map(v => v.state), ['STARTED', 'RUNNING', 'IDLE', 'RUNNING', 'ENDED']);
  assert.equal(p[0].evidence, 'OBSERVED');
  assert.equal(p[1].evidence, 'INFERRED', 'RUNNING from a record timestamp is inferred');
  assert.equal(p[2].evidence, 'INFERRED');
  assert.equal(p[2].at, NOW - 113 * M);
  assert.equal(p[4].at, NOW - 67 * M);
  assert.equal(p[4].until, undefined);
  const pb = statusPath(b, events, { now: NOW });
  assert.deepEqual(pb.map(v => v.state), ['STARTED', 'RUNNING', 'IDLE', 'RUNNING', 'NEEDS_INPUT']);
  assert.equal(pb[pb.length - 1].until, NOW);
  const pc = statusPath(c, events, { now: NOW });
  assert.deepEqual(pc.map(v => v.state), ['STARTED', 'RUNNING']);
  assert.equal(pc[0].evidence, 'DERIVED');
  assert.deepEqual(statusPath(mk({ key: 'claude:none', startedAt: undefined, lastActivityAt: undefined }), [], { now: NOW }), []);
});

test('workPath and loop stats', () => {
  const p = workPath(a, events);
  assert.deepEqual(p.map(v => v.state), ['prompt', 'read', 'edit', 'fail', 'edit', 'test', 'commit', 'reply', 'prompt', 'read', 'reply']);
  assert.equal(p[1].n, 2);
  assert.equal(p[7].evidence, 'INFERRED');
  const l = loopStats(p);
  assert.deepEqual(l, { cycles: 1, fixed: 1, fails: 1, turns: 2, maxFailStreak: 1 });
  const pb = workPath(b, events);
  assert.deepEqual(pb.map(v => v.state), ['prompt', 'edit', 'reply']);
  assert.equal(pb[2].evidence, 'OBSERVED');
  // running session: no reply appended
  assert.deepEqual(workPath(c, events).map(v => v.state), ['edit']);
});

test('machine aggregates edges, counts and medians', () => {
  const m = machine([workPath(a, events), workPath(b, events)]);
  const pe = m.edges.find(e => e.from === 'prompt' && e.to === 'read')!;
  assert.equal(pe.count, 2);
  assert.equal(pe.medianMs, M);
  const ed = m.edges.find(e => e.from === 'edit' && e.to === 'reply')!;
  assert.equal(ed.count, 1);
  assert.deepEqual(ed.evidence, { OBSERVED: 1 });
  assert.equal(m.nodes.get('edit')!.visits, 3);
  assert.equal(m.nodes.get('edit')!.sessions, 2);
  assert.equal(m.transitions, 10 + 2);
  assert.equal(dwell(42_000), '42s');
  assert.equal(dwell(7 * M), '7m');
  assert.equal(dwell(185 * M), '3h05');
});

test('screen renders both machines, lists sessions, escapes', () => {
  const d: WsData = { sessions: [a, b, c], providers: [], events: [], now: NOW, ternAvailable: false, timeline: () => events };
  const h = renderLifecycle(d, { view: 'lifecycle', opts: { 'lifecycle.period': 'all' } });
  assert.ok(h.includes('Session status machine') && h.includes('Work loop machine'));
  assert.ok((h.match(/<svg/g) ?? []).length === 2);
  assert.ok(h.includes('marker-end="url(#lcs-ar)"') && h.includes('marker-end="url(#lcw-ar)"'));
  assert.ok(h.includes('OBSERVED') && h.includes('INFERRED') && h.includes('DERIVED'));
  assert.ok(!h.includes('<b>bug</b>'));
  assert.ok(h.includes('lc-k-inferred'), 'inferred edges styled apart');
  assert.ok(h.includes('INFERRED (dashed, lighter)'), 'edge legend');
  assert.equal(edgeKind({ OBSERVED: 3, INFERRED: 1 }), 'INFERRED');
  assert.equal(edgeKind({ OBSERVED: 3, UNKNOWN: 1 }), 'UNKNOWN');
  assert.equal(edgeKind({ DERIVED: 2 }), 'DERIVED');
  const l = renderLifecycle(d, { view: 'lifecycle', opts: { 'lifecycle.period': 'all', 'lifecycle.state': 'NEEDS_INPUT' } });
  assert.ok(l.includes(`data-select="${B}"`));
  assert.ok(!l.includes(`data-select="${A}"`));
  const w = renderLifecycle(d, { view: 'lifecycle', opts: { 'lifecycle.period': 'all', 'lifecycle.work': 'edit' } });
  assert.ok(w.includes(`data-select="${C}"`));
  const one = renderLifecycle(d, { view: 'lifecycle', opts: { 'lifecycle.period': 'all', 'lifecycle.mode': 'one', 'lifecycle.sess': sessTok(a) } });
  assert.ok(one.includes('lc-story') && one.includes('Longest fail run'));
  assert.ok(/^[a-z0-9._:-]{1,40}$/.test(sessTok(a)));
  const ws = renderLifecycle(d, { view: 'lifecycle', opts: { 'lifecycle.machine': 'work', 'lifecycle.period': 'all' } });
  assert.ok(!ws.includes('Session status machine'));
  assert.ok(renderLifecycle({ ...d, sessions: [] }, { view: 'lifecycle' }).includes('No session'));
  // no timeline: falls back to d.events without throwing
  assert.ok(renderLifecycle({ ...d, timeline: undefined }, { view: 'lifecycle', opts: { 'lifecycle.period': 'all' } }).includes('no event history'));
  assert.equal(lifecycleView.group, 'Time');
  assert.ok(renderWorkspace(d, { view: 'lifecycle' }).includes('Work loop machine'));
});
