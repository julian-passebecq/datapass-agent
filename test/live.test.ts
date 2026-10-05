import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AgentSessionSnapshot } from '../src/model';
// Load the workspace before the screen module (the screen imports workspace helpers; workspace imports the registry).
import { renderWorkspace, WsData } from '../src/render/workspace';
import { lanes, liveRows, liveTotals, rateOf, spark } from '../src/activity/live';
import { liveView } from '../src/render/extra/live';
import { T } from './helpers';

const NOW = T('2026-10-04T12:00:00Z');
const MIN = 60_000;

function mk(p: Partial<AgentSessionSnapshot> & { key: string }): AgentSessionSnapshot {
  const [provider, sessionId] = p.key.split(':') as ['claude' | 'codex', string];
  return { provider, sessionId, status: 'ENDED', statusReason: 'test', commits: [], changedFiles: [], tests: [], isWorker: false, counts: { tools: 0, commands: 0, fileEdits: 0, turns: 0 }, evidence: [], artifactPath: '', diagnostics: [], startedAt: NOW - 3600_000, lastActivityAt: NOW - 600_000, ...p };
}

const lead = mk({
  key: 'claude:lead', title: 'Lead <script>', status: 'RUNNING', cwd: 'D:/PROJ/alpha', model: 'claude-opus-5-5', effort: 'medium', lastActivityAt: NOW - 10_000,
  usage: { totalTokens: 90_000, outputTokens: 900, cachedInputTokens: 0, contextTokens: 40_000 },
  facts: {
    calls: [[NOW - 20 * MIN, 1000, 10], [NOW - 4 * MIN, 2000, 100], [NOW - 30_000, 3000, 200]],
    currentTool: { name: 'Bash', detail: 'npm test <x>', startedAt: NOW - 7 * MIN },
    prompts: 3, permissionMode: 'acceptEdits', files: [{ path: 'a.ts', edits: 2, lastAt: NOW }],
    spawns: [{ at: NOW - 30 * MIN, type: 'Explore', description: 'map the repo' }],
  },
});
const worker = mk({ key: 'claude:w1', parentSessionId: 'claude:lead', isWorker: true, workerLabel: 'Explore', status: 'RUNNING', startedAt: NOW - 29 * MIN, cwd: 'D:/PROJ/alpha', lastActivityAt: NOW - 5_000, lastAction: 'Read src/x.ts', lastActionAt: NOW - 5_000 });
const codex = mk({ key: 'codex:c1', status: 'NEEDS_INPUT', cwd: 'D:/PROJ/beta', usage: { totalTokens: 500, outputTokens: 50, cachedInputTokens: 0, contextTokens: 200_000, contextWindow: 250_000 }, lastActivityAt: NOW - 60_000, facts: { sandbox: 'workspace-write' } });
const ended = mk({ key: 'codex:old', status: 'ENDED', endedAt: NOW - 20 * MIN, lastActivityAt: NOW - 20 * MIN, cwd: 'D:/PROJ/beta' });
const ancient = mk({ key: 'codex:older', status: 'ENDED', endedAt: NOW - 5 * 3600_000, lastActivityAt: NOW - 5 * 3600_000 });
const all = [ended, worker, codex, lead, ancient];

test('live: rate over the window and per-minute spark from recorded calls', () => {
  const r = rateOf(lead, NOW, 5 * MIN);
  assert.equal(r.calls, 2);
  assert.equal(r.rate, (2100 + 3200) / 5);
  assert.equal(r.outRate, 300 / 5);
  assert.deepEqual(rateOf(codex, NOW, 5 * MIN), { calls: 0 }, 'no call record → rate unknown, not zero');
  const sp = spark(lead, NOW, 15);
  assert.equal(sp.length, 15);
  assert.equal(sp[14], 3200);
  assert.equal(sp[10] + sp[11], 2100);
  assert.equal(sp.reduce((a, b) => a + b, 0), 5300, 'the call 20 min ago is outside the spark');
});

test('live: rows nest workers under their lead, keep live only by default, add recent on request', () => {
  const rows = liveRows(all, { now: NOW });
  assert.deepEqual(rows.map(r => [r.s.key, r.depth]), [['claude:lead', 0], ['claude:w1', 1], ['codex:c1', 0]]);
  const l = rows[0];
  assert.equal(l.tool?.name, 'Bash');
  assert.equal(l.tool?.elapsedMs, 7 * MIN);
  assert.equal(l.workersLive, 1);
  assert.equal(l.workersTotal, 1);
  assert.equal(l.files, 1);
  assert.equal(l.ctxPct, undefined, 'Claude records no window → no %');
  assert.equal(rows[1].spawn, 'map the repo');
  assert.equal(rows[2].ctxPct, 80);
  const recent = liveRows(all, { now: NOW, recentMs: 30 * MIN });
  assert.ok(recent.some(r => r.s.key === 'codex:old' && !r.live));
  assert.ok(!recent.some(r => r.s.key === 'codex:older'));
  const flat = liveRows(all, { now: NOW, sort: 'status' }, false);
  assert.equal(flat[0].s.key, 'codex:c1', 'needs input sorts first');
  assert.ok(flat.every(r => r.depth === 0));
});

test('live: totals and lanes', () => {
  const rows = liveRows(all, { now: NOW, recentMs: 30 * MIN });
  const t = liveTotals(rows, s => s.cwd ?? '');
  assert.equal(t.agents, 3);
  assert.equal(t.conversations, 2);
  assert.equal(t.workers, 1);
  assert.equal(t.needsInput, 1);
  assert.equal(t.running, 2);
  assert.equal(t.toolsInFlight, 1);
  assert.equal(t.rateRows, 1);
  assert.equal(t.repos, 2);
  assert.deepEqual(t.byProvider, { claude: 2, codex: 1 });
  const ls = lanes(rows, r => r.s.cwd ?? '');
  assert.equal(ls[0][0], 'D:/PROJ/alpha');
  assert.equal(ls[0][1].length, 2);
});

test('live: screen renders every layout escaped, with selection hooks', () => {
  const d: WsData = { sessions: all, providers: [], events: [], now: NOW, ternAvailable: false };
  for (const layout of ['table', 'cards', 'lanes']) {
    for (const orient of ['horizontal', 'vertical']) {
      const h = liveView.render(d, { view: 'live', selected: 'claude:w1', opts: { 'live.layout': layout, 'live.orient': orient, 'live.show': '30m' } });
      assert.ok(!h.includes('<script>'), 'title escaped');
      assert.ok(h.includes('Lead &lt;script&gt;'));
      assert.ok(h.includes('npm test &lt;x&gt;'));
      assert.ok(h.includes('data-select="claude:w1"'));
      assert.ok(h.includes('data-select="codex:old"'));
      assert.ok(h.includes('lv-sel'));
    }
  }
  const hidden = liveView.render(d, { view: 'live', opts: { 'live.workers': 'hide' } });
  assert.ok(!hidden.includes('data-select="claude:w1"'));
  const out = liveView.render(d, { view: 'live', opts: { 'live.basis': 'output', 'live.win': '1' } });
  assert.ok(out.includes('tok/min · 1 min'));
  const empty = liveView.render({ ...d, sessions: [ancient] }, { view: 'live' });
  assert.ok(empty.includes('No live Claude Code or Codex session'));
  const ws = renderWorkspace(d, { view: 'live' });
  assert.ok(ws.includes('lv-tab'));
  assert.equal(liveView.ready, true);
});
