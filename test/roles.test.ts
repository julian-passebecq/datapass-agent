import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AgentSessionSnapshot } from '../src/model';
// Load the workspace before the screen module (the screen imports workspace helpers; workspace imports the registry).
import { renderWorkspace, WsData } from '../src/render/workspace';
import { buildUnits, compileRules, DEFAULT_RULES, fileOverlap, groupOf, handoffEdges, inPeriod, layers, median, roleSlug, roleStats } from '../src/activity/roles';
import { renderRoles, rolesView } from '../src/render/extra/roles';
import type { WorkflowsSnapshot } from '../src/providers/claude/workflows';
import { T } from './helpers';

const NOW = T('2026-10-05T12:00:00Z');
const H = 3600_000;

function mk(p: Partial<AgentSessionSnapshot> & { key: string }): AgentSessionSnapshot {
  const [provider, sessionId] = p.key.split(':') as ['claude' | 'codex', string];
  return { provider, sessionId, status: 'ENDED', statusReason: 'test', commits: [], changedFiles: [], tests: [], isWorker: false, counts: { tools: 0, commands: 0, fileEdits: 0, turns: 0 }, evidence: [], artifactPath: '', diagnostics: [], startedAt: NOW - 3 * H, lastActivityAt: NOW - H, ...p };
}

const pm = mk({ key: 'claude:pm', title: 'PM DataPass 31', status: 'RUNNING', usage: { totalTokens: 1000, outputTokens: 100, cachedInputTokens: 0, costUSD: 2 } });
const coord = mk({ key: 'claude:co', title: 'Coordinator wave 2 <script>x</script>', usage: { totalTokens: 500, outputTokens: 50, cachedInputTokens: 0 }, commits: [{ sha: 'a', at: NOW - 2 * H, subject: 's', attribution: 'during-session' }], tests: [{ command: 'npm test', at: NOW - 2 * H, outcome: 'PASS', source: 'provider-tool-error-flag' }, { command: 'npm test', at: NOW - 2 * H, outcome: 'FAIL', source: 'provider-tool-error-flag' }] });
const plain = mk({ key: 'codex:x', title: 'fix the bug' });
const w1 = mk({ key: 'claude:w1', parentSessionId: 'claude:pm', isWorker: true, workerLabel: 'coder · build', startedAt: NOW - 2.5 * H, lastActivityAt: NOW - 1.5 * H, facts: { files: [{ path: 'src/a.ts', edits: 3, lastAt: NOW - 2 * H }] }, counts: { tools: 1, commands: 0, fileEdits: 3, turns: 1 } });
const w2 = mk({ key: 'claude:w2', parentSessionId: 'claude:pm', isWorker: true, workerLabel: 'coder', startedAt: NOW - 2 * H, lastActivityAt: NOW - 1.2 * H, facts: { files: [{ path: 'src\\a.ts', edits: 1, lastAt: NOW - 1.3 * H }, { path: 'src/b.ts', edits: 1, lastAt: NOW - 1.3 * H }] } });
const w3 = mk({ key: 'claude:w3', parentSessionId: 'claude:pm', isWorker: true, workerLabel: 'debug', startedAt: NOW - 0.9 * H, lastActivityAt: NOW - 0.5 * H, changedFiles: ['src/b.ts'] });
const cx = mk({ key: 'codex:k', parentSessionId: 'codex:x', isWorker: true, workerLabel: 'Ada', startedAt: NOW - 2 * H });
const cxParent = { ...plain, facts: { spawns: [{ at: NOW - 2 * H - 5000, type: 'explorer', description: 'look' }] } };
const old = mk({ key: 'claude:old', title: 'architect review', startedAt: NOW - 40 * 86400_000, lastActivityAt: NOW - 39 * 86400_000 });
const sessions = [pm, coord, cxParent, w1, w2, w3, cx, old];

const snap: WorkflowsSnapshot = {
  scannedAt: NOW,
  scanMs: 1,
  diagnostics: [],
  background: [],
  runs: [{
    runId: 'run1', sessionId: 'pm', parentKey: 'claude:pm', projectSlug: 'p', name: 'wave', phases: [], status: 'running', startedAt: NOW - H,
    agents: [
      { agentId: 'a1', label: 'pkg roles', agentType: 'tester', sessionKey: 'claude:wfa1', tokens: 900, outputTokens: 90, calls: 1, tools: 1, toolErrors: 0, status: 'running', statusBasis: '', firstAt: NOW - 0.5 * H },
      { agentId: 'a2', label: 'architect check', sessionKey: 'claude:wfa2', tokens: 10, outputTokens: 1, calls: 1, tools: 0, toolErrors: 0, status: 'done', statusBasis: '', firstAt: NOW - H, lastAt: NOW - 0.8 * H },
      { agentId: 'a3', label: 'is w3', agentType: 'debugger', sessionKey: 'claude:w3', tokens: 1, outputTokens: 1, calls: 1, tools: 0, toolErrors: 0, status: 'done', statusBasis: '', firstAt: NOW - H },
    ],
  }],
};

const rules = compileRules(DEFAULT_RULES);

test('roles: rules compile, invalid entries are skipped', () => {
  assert.equal(rules.length, 4);
  assert.equal(compileRules([{ match: '(', role: 'x' }, { match: 'ok', role: '' }, 3, { match: 'a', role: 'A' }]).length, 1);
  assert.equal(compileRules('nope').length, 4, 'non-array falls back to defaults');
  assert.equal(roleSlug('General Purpose'), 'general-purpose');
});

test('roles: recorded type beats title pattern; fallback lead / worker', () => {
  const u = new Map(buildUnits(sessions, snap, { rules, now: NOW }).map(x => [x.key, x]));
  assert.equal(u.get('claude:pm')!.role, 'PM');
  assert.equal(u.get('claude:pm')!.basis, 'INFERRED');
  assert.equal(u.get('claude:co')!.role, 'coordinator');
  assert.equal(u.get('codex:x')!.role, 'lead');
  assert.equal(u.get('claude:w1')!.role, 'coder');
  assert.equal(u.get('claude:w1')!.basis, 'OBSERVED');
  assert.equal(u.get('claude:w3')!.role, 'debugger', 'workflow agent type wins over subagent label');
  assert.equal(u.get('claude:w3')!.runId, 'run1');
  assert.equal(u.get('codex:k')!.role, 'explorer', 'codex worker typed by the parent spawn call');
  assert.equal(u.get('claude:old')!.role, 'architect', 'first matching pattern wins');
  assert.equal(u.get('claude:wfa1')!.role, 'tester');
  assert.equal(u.get('claude:wfa1')!.live, true);
  assert.equal(u.get('claude:wfa2')!.role, 'architect');
  assert.equal(u.get('claude:wfa2')!.basis, 'INFERRED');
  assert.equal(u.size, 10);
});

test('roles: stats, period, median, outcome mix', () => {
  const all = buildUnits(sessions, snap, { rules, now: NOW });
  const units = inPeriod(all, '7d', NOW);
  assert.ok(!units.some(x => x.key === 'claude:old'));
  const st = new Map(roleStats(units).map(r => [r.role, r]));
  const coder = st.get('coder')!;
  assert.equal(coder.units, 2);
  assert.equal(coder.edits, 3);
  assert.equal(coder.mix.changed, 2);
  assert.equal(coder.medianMs, (H + 0.8 * H) / 2);
  const co = st.get('coordinator')!;
  assert.deepEqual([co.pass, co.fail, co.commits, co.mix.committed], [1, 1, 1, 1]);
  assert.equal(st.get('PM')!.costUnits, 1);
  assert.equal(st.get('tester')!.mix.live, 1);
  assert.equal(st.get('architect')!.mix.unknown, 1);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([]), undefined);
});

test('roles: hand-off edges, layers, file overlap, groups', () => {
  const units = buildUnits(sessions, snap, { rules, now: NOW });
  const e = handoffEdges(units);
  const pmCoder = e.find(x => x.from === 'PM' && x.to === 'coder');
  assert.equal(pmCoder?.count, 2);
  assert.ok(e.some(x => x.from === 'lead' && x.to === 'explorer'));
  const lay = layers(['PM', 'coder', 'tester'], [{ from: 'PM', to: 'coder', count: 2 }, { from: 'coder', to: 'tester', count: 1 }, { from: 'coder', to: 'coder', count: 1 }]);
  assert.deepEqual([lay.get('PM'), lay.get('coder'), lay.get('tester')], [0, 1, 2]);
  const ov = fileOverlap(units, () => 'repo');
  const a = ov.find(f => f.path === 'repo/src/a.ts')!;
  assert.equal(a.edits.size, 2, 'backslash paths merge');
  assert.equal(a.concurrentPairs.length, 1, 'w1 and w2 windows overlap');
  const b = ov.find(f => f.path === 'repo/src/b.ts')!;
  assert.equal(b.concurrentPairs.length, 0, 'w2 ended before w3 started');
  const byKey = new Map(units.map(x => [x.key, x]));
  assert.equal(groupOf(byKey.get('claude:w1')!, byKey).id, 'lead:claude:pm');
  assert.equal(groupOf(byKey.get('claude:wfa1')!, byKey).id, 'run:run1');
});

test('roles: screen renders every tab, escapes, carries data-select', () => {
  const d: WsData = { sessions, providers: [], events: [], now: NOW, ternAvailable: false };
  for (const tab of ['table', 'score', 'graph', 'files', 'gantt']) {
    const h = renderRoles(d, { view: 'roles', opts: { 'roles.tab': tab, 'roles.period': 'all' } }, snap);
    assert.ok(!h.includes('<script>'), `${tab}: title escaped`);
    assert.ok(h.length > 200, tab);
  }
  const t = renderRoles(d, { view: 'roles', opts: { 'roles.focus': 'coder' } }, snap);
  assert.ok(t.includes('data-select="claude:w1"') && t.includes('data-select="claude:w2"'));
  assert.ok(renderRoles(d, { view: 'roles', opts: { 'roles.tab': 'graph', 'roles.dir': 'tb' } }, snap).includes('<svg'));
  const f = renderRoles(d, { view: 'roles', opts: { 'roles.tab': 'files' } }, snap);
  assert.ok(f.includes('concurrent edits'));
  assert.ok(renderRoles(d, { view: 'roles', opts: { 'roles.tab': 'gantt' } }, undefined).includes('data-select="claude:w1"'));
  assert.equal(rolesView.ready, true);
  assert.ok(renderWorkspace(d, { view: 'roles' }).includes('Role table'));
});
