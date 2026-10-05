import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AgentSessionSnapshot } from '../src/model';
// Load the workspace before the screen module (the screen imports workspace helpers; workspace imports the registry).
import { WsData } from '../src/render/workspace';
import type { WfAgent, WfRun } from '../src/providers/claude/workflows';
import { agentChain, buildForecast, estimate, History, labelPrefix, quartiles } from '../src/activity/forecast';
import { capItems, forecastView, renderForecast } from '../src/render/extra/forecast';
import { T } from './helpers';

const NOW = T('2026-10-05T22:00:00Z');
const MIN = 60_000;

function agent(p: Partial<WfAgent> & { agentId: string }): WfAgent {
  return { label: 'coder: x', tokens: 0, outputTokens: 0, calls: 0, tools: 0, toolErrors: 0, status: 'done', statusBasis: 'test', sessionKey: `claude:agent-${p.agentId}`, agentType: 'general-purpose', ...p };
}

function run(p: Partial<WfRun> & { runId: string; agents: WfAgent[] }): WfRun {
  const starts = p.agents.map(a => a.firstAt ?? Infinity);
  return { sessionId: 's', parentKey: 'claude:parent', projectSlug: 'D--PROJ-repo', phases: [], status: 'done', startedAt: Math.min(...starts), lastAt: Math.max(...p.agents.map(a => a.lastAt ?? 0)), ...p };
}

function mk(p: Partial<AgentSessionSnapshot> & { key: string }): AgentSessionSnapshot {
  const [provider, sessionId] = p.key.split(':') as ['claude' | 'codex', string];
  return { provider, sessionId, status: 'ENDED', statusReason: 'test', commits: [], changedFiles: [], tests: [], isWorker: false, counts: { tools: 0, commands: 0, fileEdits: 0, turns: 0 }, evidence: [], artifactPath: '', diagnostics: [], cwd: 'D:\\PROJ\\repo', ...p };
}

test('forecast: quartiles and label prefix', () => {
  const q = quartiles([10, 20, 30, 40, 50])!;
  assert.deepEqual([q.n, q.p25, q.p50, q.p75, q.min, q.max], [5, 20, 30, 40, 10, 50]);
  assert.equal(quartiles([]), undefined);
  assert.equal(labelPrefix('coder: forecast'), 'coder');
  assert.equal(labelPrefix('review-3'), 'review');
  assert.equal(labelPrefix(''), '(none)');
});

test('forecast: estimate walks the key chain, conditions on elapsed time and flags overrun', () => {
  const h = new History();
  const chain = [{ key: 'a', label: 'specific' }, { key: 'b', label: 'wide' }];
  h.add([chain[0]], { id: 'x', dur: 5 * MIN, end: 1 });
  for (const [i, m] of [4, 8, 10, 12, 20].entries()) h.add([chain[1]], { id: `w${i}`, dur: m * MIN, end: 1 });
  const fresh = estimate(h, chain, 0, 0, { minSamples: 3, noun: 'agents' })!;
  assert.equal(fresh.step, 1, 'specific key has 1 sample < 3 → wide key');
  assert.equal(fresh.q!.p50, 10 * MIN);
  assert.equal(fresh.conditioned, false);
  assert.match(fresh.basis, /median of 5 similar agents \(wide\)/);
  const mid = estimate(h, chain, 0, 9 * MIN, { minSamples: 3, noun: 'agents' })!;
  assert.equal(mid.conditioned, true);
  assert.equal(mid.n, 3);
  assert.equal(mid.q!.p50, 12 * MIN, 'only the 3 samples longer than 9 min');
  assert.equal(mid.etaAt, 12 * MIN);
  const late = estimate(h, chain, 0, 15 * MIN, { minSamples: 3, noun: 'agents' })!;
  assert.equal(late.overrun, true);
  assert.equal(late.etaAt, undefined);
  assert.match(late.basis, /longer than 4 of 5/);
  assert.equal(estimate(h, chain, 0, 0, { minSamples: 6, noun: 'agents' }), undefined);
  assert.equal(estimate(h, chain, 0, 0, { minSamples: 3, noun: 'agents', before: 0 }), undefined, 'before filters samples');
});

// Three finished runs of "night" (plan 10 min, code 20 min), and a running one in phase "code".
function history(): WfRun[] {
  const out: WfRun[] = [];
  for (let i = 0; i < 3; i++) {
    const t = NOW - (5 - i) * 3600_000;
    out.push(run({
      runId: `wf_${i}`, name: 'night', phases: [{ title: 'plan' }, { title: 'code' }, { title: 'verify' }],
      agents: [
        agent({ agentId: `p${i}`, label: 'planner', phase: 'plan', firstAt: t, lastAt: t + 10 * MIN, tokens: 1000 }),
        agent({ agentId: `c${i}`, label: 'coder: a', phase: 'code', firstAt: t + 10 * MIN, lastAt: t + (28 + i * 2) * MIN, tokens: 5000 }),
        agent({ agentId: `v${i}`, label: 'verify', phase: 'verify', firstAt: t + 30 * MIN, lastAt: t + 35 * MIN, tokens: 300 }),
      ],
    }));
  }
  return out;
}

test('forecast: running agent, phase composition and pending phase projection', () => {
  const live = run({
    runId: 'wf_live', name: 'night', status: 'running', phases: [{ title: 'plan' }, { title: 'code' }, { title: 'verify' }],
    agents: [
      agent({ agentId: 'pl', label: 'planner', phase: 'plan', firstAt: NOW - 15 * MIN, lastAt: NOW - 5 * MIN }),
      agent({ agentId: 'cl', label: 'coder: b', phase: 'code', firstAt: NOW - 5 * MIN, lastAt: NOW - MIN, status: 'running', tokens: 2500 }),
    ],
  });
  const f = buildForecast([], [...history(), live], { now: NOW });
  const a = f.items.find(i => i.id === 'a:wf_live:cl')!;
  assert.equal(a.state, 'running');
  assert.equal(a.est!.step, 0, 'type + label prefix + phase key has 3 samples');
  assert.equal(a.est!.q!.p50, 20 * MIN, 'median of 18 / 20 / 22 min');
  assert.equal(a.est!.etaAt, NOW + 15 * MIN);
  assert.ok(a.est!.projectedTokens! > 2500, 'tokens projected at current rate');
  const code = f.items.find(i => i.id === 'p:wf_live:1')!;
  assert.equal(code.est!.source, 'composition');
  assert.equal(code.est!.etaAt, NOW + 15 * MIN);
  const verify = f.items.find(i => i.id === 'p:wf_live:2')!;
  assert.equal(verify.state, 'pending');
  assert.equal(verify.start, NOW + 15 * MIN);
  assert.equal(verify.est!.etaAt, NOW + 20 * MIN);
  const r = f.items.find(i => i.id === 'r:wf_live')!;
  assert.equal(r.est!.source, 'composition');
  assert.equal(r.est!.etaAt, NOW + 20 * MIN);
  assert.deepEqual([r.progress!.done, r.progress!.total, r.progress!.phaseIdx, r.progress!.phases], [1, 2, 2, 3]);
  assert.equal(f.items.filter(i => i.parentId === 'r:wf_live').length, 3, 'three phases under the run');
});

test('forecast: sessions tree, worker keys, workflow transcripts not double-counted', () => {
  const ended = [1, 2, 3].map(i => mk({ key: `claude:old${i}`, startedAt: NOW - (10 + i) * 3600_000, endedAt: NOW - (10 + i) * 3600_000 + (30 + i * 10) * MIN }));
  const lead = mk({ key: 'claude:lead', status: 'RUNNING', startedAt: NOW - 20 * MIN, lastActivityAt: NOW, usage: { totalTokens: 9000, outputTokens: 100, cachedInputTokens: 0 }, facts: { calls: [[NOW - 2 * MIN, 4000, 100], [NOW - 30 * MIN, 1, 1]] } });
  const worker = mk({ key: 'claude:w', status: 'RUNNING', isWorker: true, parentSessionId: 'claude:lead', workerLabel: 'Explore', startedAt: NOW - 3 * MIN });
  const wfSession = mk({ key: 'claude:agent-c0', startedAt: NOW - 5 * 3600_000, endedAt: NOW - 4 * 3600_000 });
  const f = buildForecast([...ended, lead, worker, wfSession], history(), { now: NOW });
  const l = f.items.find(i => i.id === 's:claude:lead')!;
  assert.equal(l.est!.q!.p50, 50 * MIN, 'median of 40 / 50 / 60 min (all longer than 20 min)');
  assert.equal(l.ratePerMin, 410, '4100 tokens in the last 10 min');
  const w = f.items.find(i => i.id === 's:claude:w')!;
  assert.equal(w.parentId, 's:claude:lead');
  assert.equal(w.depth, 1);
  assert.equal(w.est, undefined, 'no finished Explore worker in history');
  assert.ok(!f.items.some(i => i.id === 's:claude:agent-c0'), 'workflow agent transcript is shown under its run only');
});

test('forecast: accuracy back-test only uses items finished before the 50 % point', () => {
  const f = buildForecast([], history(), { now: NOW, minSamples: 2 });
  const rows = f.accuracy.rows;
  // Only the third run's agents have 2 earlier finished similar agents.
  assert.ok(rows.length >= 1);
  const c2 = rows.find(r => r.id === 'a:wf_2:c2')!;
  assert.equal(c2.actual, 22 * MIN);
  assert.equal(c2.predicted, 19 * MIN, 'median of 18 and 20 min');
  assert.ok(Math.abs(c2.err! - (19 - 22) / 22) < 1e-9);
  assert.equal(rows.find(r => r.id === 'a:wf_0:c0'), undefined, 'first run has no earlier history');
  assert.equal(f.accuracy.scored, rows.filter(r => r.err !== undefined).length);
});

test('forecast: screen renders escaped Gantt, table, accuracy and vertical views', () => {
  const live = run({
    runId: 'wf_live', name: 'night <b>', status: 'running', phases: [{ title: 'code' }],
    agents: [agent({ agentId: 'cl', label: 'coder: <script>', phase: 'code', firstAt: NOW - 5 * MIN, lastAt: NOW - MIN, status: 'running', sessionKey: 'claude:agent-cl' })],
  });
  const s = mk({ key: 'claude:agent-cl', status: 'RUNNING', startedAt: NOW - 5 * MIN });
  const lead = mk({ key: 'codex:lead', status: 'RUNNING', title: 'Lead "x"', startedAt: NOW - 10 * MIN });
  const d: WsData = { sessions: [s, lead], providers: [], events: [], now: NOW, ternAvailable: false };
  const snap = { runs: [...history(), live], background: [], scannedAt: NOW, scanMs: 3, diagnostics: [] };
  const views = ['gantt', 'eta', 'accuracy'].map(v => renderForecast(d, { view: 'forecast', opts: { 'forecast.view': v } }, snap));
  views.push(renderForecast(d, { view: 'forecast', opts: { 'forecast.orient': 'vertical', 'forecast.zoom': '6h' } }, snap));
  for (const html of views) {
    assert.ok(!html.includes("<script>"), "escaped");
    assert.ok(!html.includes('night <b>'), 'escaped');
  }
  assert.match(views[0], /class="fc-proj"/);
  assert.match(views[0], /data-select="claude:agent-cl"/);
  assert.match(views[0], /class="fc-now"/);
  assert.match(views[1], /median of 3 similar agents/);
  assert.match(views[2], /back-tested/);
  assert.match(views[3], /fc-vcols/);
  const empty = renderForecast({ ...d, sessions: [] }, { view: 'forecast' }, undefined);
  assert.match(empty, /Scanning/);
  assert.equal(forecastView.ready, true);
  assert.ok(forecastView.css!.split('\n').filter(l => l.trim().startsWith('.')).every(l => l.trim().startsWith('.fc')), 'scoped CSS');
});

test('forecast: capItems keeps running items with their parents first', () => {
  const it = (id: string, state: 'running' | 'done', parentId?: string) => ({ id, parentId, depth: parentId ? 1 : 0, kind: 'agent' as const, label: id, detail: '', start: 0, end: 1, state, ident: 'x' });
  const items = [it('r1', 'done'), it('a1', 'done', 'r1'), it('r2', 'running'), it('a2', 'running', 'r2'), it('s1', 'done'), it('s2', 'done')];
  assert.deepEqual(capItems(items, 3).map(i => i.id), ['r2', 'a2', 's2']);
  assert.equal(capItems(items, 10).length, 6);
});
