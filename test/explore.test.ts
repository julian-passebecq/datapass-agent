import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AgentSessionSnapshot } from '../src/model';
// workspace first: it loads the screen registry (the screen file imports helpers from workspace).
import { renderWorkspace, WsData } from '../src/render/workspace';
import { contributions, cross, pivot, pivotCsv, series, slug, topN } from '../src/activity/explore';
import { exploreView, squarify } from '../src/render/extra/explore';
import { T } from './helpers';

const NOW = T('2026-10-04T12:00:00Z');
const H = 3600_000;

function mk(p: Partial<AgentSessionSnapshot> & { key: string }): AgentSessionSnapshot {
  const [provider, sessionId] = p.key.split(':') as ['claude' | 'codex', string];
  return { provider, sessionId, status: 'ENDED', statusReason: 'test', commits: [], changedFiles: [], tests: [], isWorker: false, counts: { tools: 0, commands: 0, fileEdits: 0, turns: 0 }, evidence: [], artifactPath: '', diagnostics: [], startedAt: NOW - 3 * H, lastActivityAt: NOW - H, ...p };
}

const A = mk({ key: 'claude:a', repository: 'D:/x/alpha', model: 'claude-opus-5-5', effort: 'high', usage: { totalTokens: 1000, outputTokens: 100, cachedInputTokens: 0, costUSD: 1.5 }, facts: { calls: [[NOW - 2 * H, 300, 30], [NOW - 2 * H + 60_000, 400, 40]], toolCounts: { Bash: 3, Edit: 2 } }, counts: { tools: 5, commands: 3, fileEdits: 2, turns: 1 }, commits: [{ sha: 'abc', at: NOW - 90 * 60_000, subject: 's', attribution: 'during-session' }], tests: [{ command: 'npm test', at: NOW - 100 * 60_000, outcome: 'PASS', source: 'provider-exit-code' }] });
const B = mk({ key: 'codex:b', repository: 'D:/x/beta', model: 'gpt-6', usage: { totalTokens: 500, outputTokens: 50, cachedInputTokens: 0 }, tests: [{ command: 'npm test', at: NOW - 2 * H, outcome: 'FAIL', source: 'provider-exit-code' }] });
const W = mk({ key: 'claude:w', repository: 'D:/x/alpha', isWorker: true, workerLabel: 'Explore · find', parentSessionId: 'claude:a', usage: { totalTokens: 200, outputTokens: 20, cachedInputTokens: 0 } });
const OLD = mk({ key: 'codex:old', repository: 'D:/x/beta', startedAt: NOW - 10 * 24 * H, lastActivityAt: NOW - 9 * 24 * H, usage: { totalTokens: 9999, outputTokens: 9, cachedInputTokens: 0 } });
const ALL = [A, B, W, OLD];

test('explore: tokens split per recorded call, remainder at last activity; totals preserved', () => {
  const c = contributions(A, 'tokens');
  assert.deepEqual(c, [[NOW - 2 * H, 330], [NOW - 2 * H + 60_000, 440], [NOW - H, 230]]);
  assert.equal(c.reduce((a, [, v]) => a + v, 0), 1000);
});

test('explore: pivot by repo, period filter and leads-only', () => {
  const p = pivot(ALL, { dim: 'repo', metric: 'tokens', period: '7d', now: NOW });
  assert.deepEqual(p.groups.map(g => [g.key, g.value, g.sessions.length]), [['alpha', 1200, 2], ['beta', 500, 1]]);
  assert.equal(p.total, 1700);
  assert.equal(p.sessionCount, 3);
  const all = pivot(ALL, { dim: 'repo', metric: 'tokens', period: 'all', now: NOW });
  assert.equal(all.total, 1700 + 9999);
  const leads = pivot(ALL, { dim: 'repo', metric: 'sessions', period: '7d', now: NOW, leadsOnly: true });
  assert.deepEqual(leads.groups.map(g => [g.key, g.value]), [['alpha', 1], ['beta', 1]]);
});

test('explore: dimensions provider / worker / model / tool and cost only where recorded', () => {
  const prov = pivot(ALL, { dim: 'provider', metric: 'sessions', period: '7d', now: NOW });
  assert.deepEqual(prov.groups.map(g => [g.key, g.value]), [['Claude Code', 2], ['Codex', 1]]);
  const wk = pivot(ALL, { dim: 'worker', metric: 'sessions', period: '7d', now: NOW });
  assert.deepEqual(wk.groups.map(g => [g.key, g.value]), [['lead', 2], ['Explore', 1]]);
  const model = pivot(ALL, { dim: 'model', metric: 'sessions', period: '7d', now: NOW });
  assert.ok(model.groups.some(g => g.key === 'Opus 5.5') && model.groups.some(g => g.key === '(not recorded)'));
  const cost = pivot(ALL, { dim: 'provider', metric: 'cost', period: '7d', now: NOW });
  assert.deepEqual(cost.groups.map(g => [g.key, g.value]), [['Claude Code', 1.5]]);
  const tools = pivot(ALL, { dim: 'tool', metric: 'tools', period: '7d', now: NOW });
  assert.deepEqual(tools.groups.map(g => [g.key, g.value]), [['Bash', 3], ['Edit', 2]]);
  const toolSessions = pivot(ALL, { dim: 'tool', metric: 'sessions', period: '7d', now: NOW });
  assert.equal(toolSessions.overlap, true);
  assert.equal(toolSessions.total, 3, 'overlap total counts each session once');
});

test('explore: tests pass / fail and commits are timed; hour dimension uses piece time', () => {
  const pass = pivot(ALL, { dim: 'repo', metric: 'pass', period: '7d', now: NOW });
  const fail = pivot(ALL, { dim: 'repo', metric: 'fail', period: '7d', now: NOW });
  assert.deepEqual([pass.total, fail.total], [1, 1]);
  const hours = pivot([A], { dim: 'hour', metric: 'tokens', period: '7d', now: NOW });
  assert.equal(hours.groups.reduce((a, g) => a + g.value, 0), 1000);
  assert.deepEqual(hours.groups.map(g => g.key), [...hours.groups.map(g => g.key)].sort(), 'natural order');
});

test('explore: cross, series and topN', () => {
  const x = cross(ALL, { dim: 'repo', dim2: 'provider', metric: 'tokens', period: '7d', now: NOW });
  assert.deepEqual(x.rows, ['alpha', 'beta']);
  assert.equal(x.cells[x.rows.indexOf('alpha')][x.cols.indexOf('Claude Code')], 1200);
  assert.equal(x.max, 1200);
  const s = series(ALL, { dim: 'provider', metric: 'tokens', period: '24h', now: NOW, gran: 'hour' });
  assert.equal(s.lines.reduce((a, l) => a + l.total, 0), 1700);
  assert.ok(s.x.length >= 24 && s.x.length <= 26);
  const t = topN([{ key: 'a', value: 5, sessions: ['1'] }, { key: 'b', value: 3, sessions: ['2'] }, { key: 'c', value: 1, sessions: ['2', '3'] }], 1);
  assert.deepEqual(t.map(g => [g.key, g.value, g.sessions.length]), [['a', 5, 1], ['other (2)', 4, 2]]);
});

test('explore: CSV quotes labels and stays numbers-only', () => {
  const evil = mk({ key: 'claude:e', repository: 'D:/x/a,"b"', usage: { totalTokens: 7, outputTokens: 1, cachedInputTokens: 0 } });
  const csv = pivotCsv([evil], { dim: 'repo', metric: 'tokens', period: '7d', now: NOW });
  assert.equal(csv, 'repo,tokens,sessions\n"a,""b""",7,1\n');
  const cx = pivotCsv([A], { dim: 'repo', metric: 'active', period: '7d', now: NOW, dim2: 'provider' });
  assert.equal(cx, 'repo,provider,minutes\nalpha,Claude Code,120.0\n');
});

test('explore: squarify fills the box', () => {
  const r = squarify([{ key: 'a', value: 6, sessions: [] }, { key: 'b', value: 3, sessions: [] }, { key: 'c', value: 1, sessions: [] }], 100, 50);
  const area = r.reduce((a, x) => a + x.w * x.h, 0);
  assert.ok(Math.abs(area - 5000) < 1e-6);
  for (const x of r) assert.ok(x.x >= -1e-9 && x.y >= -1e-9 && x.x + x.w <= 100 + 1e-6 && x.y + x.h <= 50 + 1e-6);
});

test('explore: every chart renders escaped, with drill-down rows selectable', () => {
  assert.equal(exploreView.ready, true);
  const evil = mk({ key: 'claude:z', repository: 'D:/x/<img src=x onerror=alert(1)>', title: '<script>x</script>', usage: { totalTokens: 50, outputTokens: 5, cachedInputTokens: 0 } });
  const d: WsData = { sessions: [...ALL, evil], providers: [], events: [], now: NOW, ternAvailable: false };
  for (const chart of ['bars-h', 'bars-v', 'table', 'treemap', 'heatmap', 'line']) {
    for (const metric of ['sessions', 'tokens', 'active']) {
      const html = renderWorkspace(d, { view: 'explore', opts: { 'explore.chart': chart, 'explore.metric': metric, 'explore.period': '7d' } });
      assert.ok(!html.includes('<img src=x') && !html.includes('<script>'), `${chart}/${metric} escapes`);
      assert.ok(html.includes('class="ex"'), `${chart} renders`);
    }
  }
  const pick = slug('<img src=x onerror=alert(1)>');
  const html = renderWorkspace(d, { view: 'explore', opts: { 'explore.pick': pick } });
  assert.ok(html.includes('data-select="claude:z"'), 'drill-down lists the session');
  assert.ok(/^[a-z0-9._:-]{0,40}$/.test(pick));
});

test('explore: CSV action validates its argument', async () => {
  const saved: string[] = [];
  const infos: string[] = [];
  const ctx = { sessions: () => ALL, saveText: async (n: string, c: string) => (saved.push(n + '\n' + c), 'x.csv'), info: (m: string) => infos.push(m) } as any;
  await exploreView.actions!.csv('repo|tokens|all|all|', ctx);
  assert.equal(saved.length, 1);
  assert.ok(saved[0].startsWith('agent-explore-repo-tokens-all.csv\nrepo,tokens,sessions\n'));
  await exploreView.actions!.csv('repo|tokens|all|all|repo', ctx);
  await exploreView.actions!.csv('../x|tokens|all|all|', ctx);
  assert.equal(saved.length, 1);
  assert.equal(infos.filter(m => m.includes('invalid')).length, 2);
});
