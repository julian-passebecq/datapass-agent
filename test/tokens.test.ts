import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AgentSessionSnapshot } from '../src/model';
// workspace first: it loads the screen registry (the screen file imports helpers from workspace).
import { renderWorkspace, WsData } from '../src/render/workspace';
import { contextLines, cumulative, rhythm, rhythmCsv, tBucketStart, tokenPieces } from '../src/activity/tokens';
import { tokensView } from '../src/render/extra/tokens';
import { T } from './helpers';

const NOW = T('2026-10-04T12:00:00Z');
const M = 60_000;
const H = 60 * M;

function mk(p: Partial<AgentSessionSnapshot> & { key: string }): AgentSessionSnapshot {
  const [provider, sessionId] = p.key.split(':') as ['claude' | 'codex', string];
  return { provider, sessionId, status: 'ENDED', statusReason: 'test', commits: [], changedFiles: [], tests: [], isWorker: false, counts: { tools: 0, commands: 0, fileEdits: 0, turns: 0 }, evidence: [], artifactPath: '', diagnostics: [], startedAt: NOW - 3 * H, lastActivityAt: NOW - H, ...p };
}

// A: three calls, totals exceed the calls by 230 tokens (untimed: 200 prompt + 30 output)
const A = mk({ key: 'claude:a', repository: 'D:/x/alpha', model: 'claude-opus-5-5', usage: { totalTokens: 1000, outputTokens: 100, cachedInputTokens: 0, contextWindow: 1000 }, facts: { calls: [[NOW - 2 * H, 300, 30], [NOW - 2 * H + 30_000, 400, 40], [NOW - 2 * M, 10, 0]] } });
const B = mk({ key: 'codex:b', repository: 'D:/x/beta', model: 'gpt-6', status: 'RUNNING', lastActivityAt: NOW - M, usage: { totalTokens: 600, outputTokens: 60, cachedInputTokens: 0 }, facts: { calls: [[NOW - 10 * M, 500, 50], [NOW - 3 * M, 40, 10]] } });
const W = mk({ key: 'claude:w', repository: 'D:/x/alpha', isWorker: true, workerLabel: 'Explore · find', parentSessionId: 'claude:a', usage: { totalTokens: 200, outputTokens: 20, cachedInputTokens: 0 } });
const ALL = [A, B, W];

test('tokens: pieces split calls and the untimed remainder, totals preserved', () => {
  const p = tokenPieces(A);
  assert.equal(p.filter(x => x.timed).length, 3);
  const u = p.find(x => !x.timed)!;
  assert.deepEqual([u.prompt, u.output, u.at], [190, 30, NOW - H]);
  assert.equal(p.reduce((a, x) => a + x.prompt + x.output, 0), 1000);
  assert.deepEqual(tokenPieces(W).map(x => [x.timed, x.prompt, x.output]), [[false, 180, 20]]);
});

test('tokens: rhythm per minute stacks by provider, rates and untimed apart', () => {
  const r = rhythm(ALL, { period: '1h', now: NOW, gran: 'minute', by: 'provider', metric: 'total' });
  assert.equal(r.x.length, 61);
  assert.equal(r.total, 10 + 550 + 50);
  assert.deepEqual(r.stacks.map(s => [s.key, s.total]), [['Codex', 600], ['Claude Code', 10]]);
  assert.equal(r.ratePerMin5, (10 + 50) / 5);
  assert.equal(r.ratePerMin60, 610 / 60);
  assert.equal(r.calls, 3);
  // A's and W's remainders sit at NOW - H (inside the 1 h period): counted apart, not on the axis
  assert.equal(r.untimed.value, 220 + 200);
  assert.equal(r.untimed.sessions, 2);
  assert.equal(r.peaks[0].value, 550);
  assert.equal(r.peaks[0].top, 'Codex');
  const placed = rhythm(ALL, { period: '1h', now: NOW, gran: 'minute', by: 'provider', metric: 'total', untimed: true });
  assert.equal(placed.total, 610 + 420);
});

test('tokens: 24 h by hour, kind split, leads only, session rows and peaks', () => {
  const r = rhythm(ALL, { period: '24h', now: NOW, gran: 'hour', by: 'kind', metric: 'total' });
  assert.deepEqual(r.stacks.map(s => s.key), ['prompt', 'output']);
  assert.equal(r.stacks[0].total, 300 + 400 + 10 + 500 + 40);
  assert.equal(r.stacks[1].total, 30 + 40 + 50 + 10);
  const out = rhythm(ALL, { period: '24h', now: NOW, gran: 'hour', by: 'kind', metric: 'output' });
  assert.deepEqual(out.stacks.map(s => s.key), ['output']);
  const leads = rhythm(ALL, { period: '24h', now: NOW, gran: 'hour', by: 'session', metric: 'total', leadsOnly: true, untimed: true });
  assert.ok(!leads.rows.some(x => x.key === 'claude:w'));
  const rows = rhythm(ALL, { period: '24h', now: NOW, gran: 'hour', by: 'session', metric: 'total' }).rows;
  const a = rows.find(x => x.key === 'claude:a')!;
  assert.equal(a.calls, 3);
  assert.equal(a.peakMin, 770, 'two calls in the same minute');
  assert.equal(a.untimed, 220);
  assert.ok(rows.some(x => x.key === 'claude:w' && x.untimed === 200 && x.calls === 0));
});

test('tokens: buckets are capped to the latest ones, folding stacks into other', () => {
  const r = rhythm(ALL, { period: '30d', now: NOW, gran: 'minute', by: 'session', metric: 'total', maxBuckets: 100, maxStacks: 1 });
  assert.equal(r.x.length, 100);
  assert.ok(r.clipped > 40_000);
  assert.equal(r.x[r.x.length - 1], tBucketStart(NOW, 'minute'));
  assert.deepEqual(r.stacks.map(s => s.key), ['codex:b', 'other']);
  assert.equal(r.stacks[1].label, 'other (1)');
  const days = rhythm(ALL, { period: 'all', now: NOW, gran: 'day', by: 'repo', metric: 'total' });
  assert.equal(days.total, 780 + 600);
  assert.deepEqual(cumulative([1, 2, 3]), [1, 3, 6]);
});

test('tokens: context lines mark drops and keep the recorded window', () => {
  const S = mk({ key: 'claude:c', usage: { totalTokens: 1, outputTokens: 0, cachedInputTokens: 0, contextWindow: 272_000 }, facts: { calls: [[NOW - 30 * M, 100_000, 1], [NOW - 20 * M, 150_000, 1], [NOW - 10 * M, 20_000, 1], [NOW - 5 * M, 30_000, 1]] } });
  const [l] = contextLines([S], { period: '24h', now: NOW });
  assert.deepEqual(l.points.map(p => p.drop), [false, false, true, false]);
  assert.equal(l.max, 150_000);
  assert.equal(l.last, 30_000);
  assert.equal(l.window, 272_000);
});

test('tokens: CSV uses keys and numbers only', () => {
  const r = rhythm([A], { period: '24h', now: NOW, gran: 'hour', by: 'session', metric: 'total' });
  const csv = rhythmCsv(r, 'total');
  assert.ok(csv.startsWith('bucket_start,group,total_tokens\n'));
  assert.ok(csv.includes(',claude:a,770\n'));
});

test('tokens: every chart renders escaped, rows selectable', () => {
  assert.equal(tokensView.ready, true);
  const evil = mk({ key: 'claude:z', repository: 'D:/x/<img src=x onerror=alert(1)>', title: '<script>x</script>', usage: { totalTokens: 50, outputTokens: 5, cachedInputTokens: 0 }, facts: { calls: [[NOW - 4 * M, 40, 5]] } });
  const d: WsData = { sessions: [...ALL, evil], providers: [], events: [], now: NOW, ternAvailable: false };
  for (const chart of ['columns', 'area', 'lines', 'heatmap', 'table'])
    for (const by of ['provider', 'model', 'repo', 'session', 'kind'])
      for (const extra of <Record<string, string>[]>[{}, { 'tokens.orient': 'horizontal', 'tokens.mode': 'permin' }, { 'tokens.mode': 'cumulative', 'tokens.period': 'all', 'tokens.gran': 'minute' }]) {
        const html = renderWorkspace(d, { view: 'tokens', selected: 'claude:a', opts: { 'tokens.chart': chart, 'tokens.by': by, ...extra } });
        assert.ok(!html.includes('<img src=x') && !html.includes('<script>'), `${chart}/${by} escapes`);
        assert.ok(html.includes('class="tk"'), `${chart} renders`);
        assert.ok(!/NaN|Infinity/.test(html.replace(/<style[\s\S]*?<\/style>/g, '')), `${chart}/${by} no NaN`);
      }
  const html = renderWorkspace(d, { view: 'tokens', opts: { 'tokens.ctx': 'live' } });
  assert.ok(html.includes('data-select="codex:b"'));
  const empty = renderWorkspace({ ...d, sessions: [] }, { view: 'tokens' });
  assert.ok(empty.includes('No timed model call'));
  assert.equal(tokensView.badge!({ ...d, now: NOW }), '21/m');
});

test('tokens: CSV action validates its argument', async () => {
  const saved: string[] = [];
  const infos: string[] = [];
  const ctx = { sessions: () => ALL, saveText: async (n: string, c: string) => (saved.push(n + '\n' + c), 'x.csv'), info: (m: string) => infos.push(m) } as any;
  await tokensView.actions!.csv('all|day|provider|total|all|apart', ctx);
  assert.equal(saved.length, 1);
  assert.ok(saved[0].startsWith('agent-tokens-all-day-provider-total.csv\nbucket_start,group,total_tokens\n'));
  await tokensView.actions!.csv('all|day|../x|total|all|apart', ctx);
  await tokensView.actions!.csv('all|day|provider|total|all', ctx);
  assert.equal(saved.length, 1);
  assert.equal(infos.filter(m => m.includes('invalid')).length, 2);
});
