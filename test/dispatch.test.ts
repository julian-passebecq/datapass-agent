import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AgentSessionSnapshot } from '../src/model';
// Load the workspace before the screen module (the screen imports workspace helpers; workspace imports the registry).
import { renderWorkspace, WsData } from '../src/render/workspace';
import { buildDispatches, costOf, groupStats, inPeriod, last24h, niceTicks, priceFor, slug } from '../src/activity/dispatch';
import { dispatchView, renderDispatch } from '../src/render/extra/dispatch';
import type { WorkflowsSnapshot } from '../src/providers/claude/workflows';
import { T } from './helpers';

const NOW = T('2026-10-05T12:00:00Z');
const H = 3600_000;

function mk(p: Partial<AgentSessionSnapshot> & { key: string }): AgentSessionSnapshot {
  const [provider, sessionId] = p.key.split(':') as ['claude' | 'codex', string];
  return { provider, sessionId, status: 'ENDED', statusReason: 'test', commits: [], changedFiles: [], tests: [], isWorker: false, counts: { tools: 0, commands: 0, fileEdits: 0, turns: 0 }, evidence: [], artifactPath: '', diagnostics: [], startedAt: NOW - 3 * H, lastActivityAt: NOW - H, ...p };
}

const pm = mk({
  key: 'claude:pm', title: 'PM <b>x</b>', status: 'RUNNING', repository: 'D:/PROJ/agent-vscode',
  facts: { spawns: [
    { at: NOW - 2.5 * H - 2000, type: 'coder', description: 'package A' },
    { at: NOW - 2.5 * H - 1000, type: 'debug', description: 'run tests' },
    { at: NOW - 2 * H - 1000, type: 'coder', description: 'package B' },
  ] },
});
const w1 = mk({ key: 'claude:w1', parentSessionId: 'claude:pm', isWorker: true, workerLabel: 'coder', model: 'claude-opus-5-5', effort: 'medium', startedAt: NOW - 2.5 * H, lastActivityAt: NOW - 2 * H, usage: { totalTokens: 1_000_000, outputTokens: 10_000, cachedInputTokens: 0 }, commits: [{ sha: 'a', at: NOW - 2.1 * H, subject: 's', attribution: 'during-session' }], counts: { tools: 12, commands: 3, fileEdits: 4, turns: 1 } });
const w2 = mk({ key: 'claude:w2', parentSessionId: 'claude:pm', isWorker: true, workerLabel: 'debug', model: 'claude-sonnet-5-5', startedAt: NOW - 2.5 * H + 500, lastActivityAt: NOW - 2.2 * H, usage: { totalTokens: 200_000, outputTokens: 2000, cachedInputTokens: 0 }, tests: [{ command: 'npm test', at: NOW - 2.3 * H, outcome: 'FAIL', source: 'provider-exit-code', exitCode: 1 }] });
const w3 = mk({ key: 'claude:w3', parentSessionId: 'claude:pm', isWorker: true, workerLabel: 'coder', model: 'claude-opus-5-5', status: 'RUNNING', startedAt: NOW - 2 * H, lastActivityAt: NOW - 60_000 });
const cxLead = mk({ key: 'codex:lead', title: 'codex lead' });
const cx = mk({ key: 'codex:k', parentSessionId: 'codex:lead', isWorker: true, workerLabel: 'Ada', model: 'gpt-6', effort: 'high', startedAt: NOW - 40 * 86400_000, lastActivityAt: NOW - 39 * 86400_000 });
const lead = mk({ key: 'claude:solo', title: 'top level' });

const snap: WorkflowsSnapshot = {
  scannedAt: NOW, scanMs: 1, diagnostics: [], background: [],
  runs: [{
    runId: 'r1', sessionId: 'pm', parentKey: 'claude:pm', projectSlug: 'p', name: 'wave', phases: [], status: 'done', startedAt: NOW - H,
    agents: [
      { agentId: 'a1', label: 'pkg dispatch', agentType: 'coder', model: 'claude-opus-5-5', sessionKey: 'claude:wfa1', tokens: 500_000, outputTokens: 5000, calls: 3, tools: 4, toolErrors: 1, status: 'done', statusBasis: 'journal', firstAt: NOW - H, lastAt: NOW - 0.5 * H },
      { agentId: 'a2', label: 'pkg broken', sessionKey: 'claude:wfa2', tokens: 10, outputTokens: 1, calls: 1, tools: 0, toolErrors: 0, status: 'failed', statusBasis: 'journal error', firstAt: NOW - H, lastAt: NOW - 0.9 * H },
    ],
  }],
};

const sessions = [pm, w1, w2, w3, cxLead, cx, lead];

test('dispatch: one row per worker plus workflow agents not loaded, newest first', () => {
  const ds = buildDispatches(sessions, snap, NOW);
  assert.deepEqual(ds.map(d => d.key).sort(), ['claude:w1', 'claude:w2', 'claude:w3', 'claude:wfa1', 'claude:wfa2', 'codex:k'].sort());
  assert.ok(!ds.some(d => d.key === 'claude:pm' || d.key === 'claude:solo'), 'leads are not dispatches');
  for (let i = 1; i < ds.length; i++) assert.ok((ds[i - 1].dispatchedAt ?? 0) >= (ds[i].dispatchedAt ?? 0));
});

test('dispatch: spawn join prefers same type, each spawn used once', () => {
  const m = new Map(buildDispatches(sessions, snap, NOW).map(d => [d.key, d]));
  assert.equal(m.get('claude:w1')!.description, 'package A');
  assert.equal(m.get('claude:w1')!.dispatchedAt, NOW - 2.5 * H - 2000);
  assert.equal(m.get('claude:w2')!.description, 'run tests');
  assert.equal(m.get('claude:w3')!.description, 'package B');
  assert.equal(m.get('codex:k')!.spawnMatched, false);
  assert.equal(m.get('codex:k')!.dispatchedAt, cx.startedAt);
  assert.equal(m.get('claude:w1')!.parentTitle, 'PM <b>x</b>');
  assert.equal(m.get('claude:w1')!.repo, 'agent-vscode', 'repo falls back to the parent');
});

test('dispatch: outcome, success and verified', () => {
  const m = new Map(buildDispatches(sessions, snap, NOW).map(d => [d.key, d]));
  assert.equal(m.get('claude:w1')!.state, 'ok');
  assert.equal(m.get('claude:w1')!.verified, true, 'commit observed');
  assert.equal(m.get('claude:w2')!.state, 'failed');
  assert.match(m.get('claude:w2')!.reasons[0], /last test failed/);
  assert.equal(m.get('claude:w3')!.state, 'live');
  assert.equal(m.get('claude:w3')!.success, undefined);
  assert.equal(m.get('claude:wfa1')!.success, true);
  assert.equal(m.get('claude:wfa1')!.verified, false);
  assert.equal(m.get('claude:wfa1')!.kind, 'workflow');
  assert.equal(m.get('claude:wfa2')!.state, 'failed');
  assert.equal(m.get('claude:wfa2')!.typeKind, 'UNKNOWN');
  assert.equal(m.get('codex:k')!.type, 'Ada');
  assert.equal(m.get('codex:k')!.kind, 'codex');
});

test('dispatch: period filter keeps live ones', () => {
  const ds = buildDispatches(sessions, snap, NOW);
  assert.ok(!inPeriod(ds, '7d', NOW).some(d => d.key === 'codex:k'));
  assert.ok(inPeriod(ds, 'all', NOW).some(d => d.key === 'codex:k'));
  assert.equal(last24h(ds, NOW), 5);
});

test('dispatch: prices only from the user setting', () => {
  assert.equal(priceFor('claude-opus-5-5', {}), undefined);
  assert.equal(priceFor('claude-opus-5-5', { 'claude-opus-5-5': 2 }), 2);
  assert.equal(priceFor('claude-opus-5-5', { opus: 3, 'opus-5-5': 4 }), 4, 'longest containing key wins');
  assert.equal(priceFor('claude-opus-5-5', { opus: 'x' }), undefined, 'non-numbers ignored');
  const w = buildDispatches(sessions, snap, NOW).find(d => d.key === 'claude:w1')!;
  assert.equal(costOf(w, { opus: 1.5 }), 1.5);
  assert.equal(costOf(w, {}), undefined);
});

test('dispatch: group stats by model, model+effort, type', () => {
  const ds = buildDispatches(sessions, snap, NOW);
  const g = new Map(groupStats(ds, 'model').map(x => [x.key, x]));
  const opus = g.get('claude-opus-5-5')!;
  assert.equal(opus.n, 3);
  assert.equal(opus.live, 1);
  assert.equal(opus.finished, 2);
  assert.equal(opus.successRate, 1);
  assert.equal(opus.verifiedRate, 0.5);
  assert.equal(opus.medTokens, 750_000);
  assert.equal(opus.medCost, undefined);
  assert.equal(g.get('claude-sonnet-5-5')!.successRate, 0);
  const me = groupStats(ds, 'model-effort').map(x => x.key);
  assert.ok(me.includes('claude-opus-5-5 · medium'));
  assert.ok(me.includes('claude-opus-5-5'));
  const ty = new Map(groupStats(ds, 'type', { opus: 1 }).map(x => [x.key, x]));
  assert.equal(ty.get('coder')!.n, 3);
  assert.equal(ty.get('coder')!.medCost, 0.75);
});

test('dispatch: helpers', () => {
  assert.equal(slug('D:/PROJ My Repo'), 'd:-proj-my-repo');
  assert.deepEqual(niceTicks(950), [0, 200, 400, 600, 800, 1000]);
  assert.deepEqual(niceTicks(0), [0]);
});

test('dispatch: screen renders both tabs, escapes, honest n < 5, no $ without setting', () => {
  const d: WsData = { sessions, providers: [], events: [], now: NOW, ternAvailable: false };
  const log = renderDispatch(d, { view: 'dispatch' } as never, snap);
  assert.match(log, /package A/);
  assert.ok(!log.includes('<b>x</b>'), 'parent title escaped');
  assert.ok(!log.includes('$ (your price)'));
  const cost = renderDispatch(d, { view: 'dispatch', opts: { 'dispatch.tab': 'cost' } } as never, snap);
  assert.match(cost, /<svg class="dp-c"/);
  assert.match(cost, /n &lt; 5/);
  assert.match(cost, /never prices tokens/);
  const priced = renderDispatch({ ...d, config: <V>(k: string, f: V) => (k.endsWith('pricePerMTok') ? ({ opus: 1 } as unknown as V) : f) }, { view: 'dispatch', opts: { 'dispatch.tab': 'cost', 'dispatch.x': 'cost', 'dispatch.by': 'model-effort', 'dispatch.xscale': 'log' } } as never, snap);
  assert.match(priced, /\$ \(your price\)/);
  const filtered = renderDispatch(d, { view: 'dispatch', opts: { 'dispatch.outcome': 'failed' } } as never, snap);
  assert.ok(!filtered.includes('package A'));
  assert.match(filtered, /pkg broken/);
  const empty = renderDispatch({ ...d, sessions: [lead] }, { view: 'dispatch' } as never, undefined);
  assert.match(empty, /No dispatch in this period/);
  assert.equal(dispatchView.id, 'dispatch');
  const ws = renderWorkspace(d, { view: 'dispatch' } as never);
  assert.match(ws, /data-nav="dispatch"/);
});
