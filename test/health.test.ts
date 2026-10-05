import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AgentSessionSnapshot } from '../src/model';
// workspace first: it loads the screen registry (the screen file imports helpers from workspace).
import { renderWorkspace, WsData } from '../src/render/workspace';
import { ctxInfo, ctxLabel, ctxSeries, healthRows, tok, healthTotal, healthTrend } from '../src/activity/health';
import { healthView, parseConfig, spark } from '../src/render/extra/health';
import { clearFeeds, setFeedValue } from '../src/render/extra/feeds';
import { T } from './helpers';

const NOW = T('2026-10-04T12:00:00Z');
const H = 3600_000;

function mk(p: Partial<AgentSessionSnapshot> & { key: string }): AgentSessionSnapshot {
  const [provider, sessionId] = p.key.split(':') as ['claude' | 'codex', string];
  return { provider, sessionId, status: 'ENDED', statusReason: 'test', commits: [], changedFiles: [], tests: [], isWorker: false, counts: { tools: 0, commands: 0, fileEdits: 0, turns: 0 }, evidence: [], artifactPath: '', diagnostics: [], startedAt: NOW - 3 * H, lastActivityAt: NOW - H, ...p };
}

const pass = (at: number) => ({ command: 'npm test', at, outcome: 'PASS' as const, source: 'provider-exit-code' as const });
const fail = (at: number) => ({ command: 'npm test', at, outcome: 'FAIL' as const, source: 'provider-exit-code' as const });

const A = mk({
  key: 'claude:a', title: 'Alpha <b>work</b>', repository: 'D:/x/alpha', model: 'claude-opus-5-5', status: 'RUNNING',
  usage: { totalTokens: 1e6, outputTokens: 1e4, cachedInputTokens: 0, contextTokens: 17_500 },
  facts: { calls: [[NOW - 2 * H, 10_000, 100], [NOW - 2 * H + 60_000, 290_000, 100], [NOW - 90 * 60_000, 17_500, 50]], compactions: 1, toolCounts: { Bash: 8, Edit: 2 }, toolErrors: 1 },
  tests: [pass(NOW - 2 * H), fail(NOW - 100 * 60_000), pass(NOW - 95 * 60_000)],
  commits: [{ sha: 'a1', at: NOW - 80 * 60_000, subject: 's', attribution: 'during-session' }, { sha: 'a2', at: NOW - 70 * 60_000, subject: 's', attribution: 'during-session' }],
});
const B = mk({ key: 'codex:b', repository: 'D:/x/beta', model: 'gpt-6', usage: { totalTokens: 5000, outputTokens: 50, cachedInputTokens: 0, contextTokens: 50_000, contextWindow: 200_000 }, tests: [fail(NOW - 2 * H)] });
const W = mk({ key: 'claude:w', repository: 'D:/x/alpha', isWorker: true, parentSessionId: 'claude:a', commits: [{ sha: 'w1', at: NOW - 75 * 60_000, subject: 's', attribution: 'during-session' }] });
const OLD = mk({ key: 'codex:old', repository: 'D:/x/beta', startedAt: NOW - 10 * 24 * H, lastActivityAt: NOW - 9 * 24 * H, tests: [pass(NOW - 9 * 24 * H)] });
const ALL = [A, B, W, OLD];

test('health: context uses the recorded window when present, else the reference marker', () => {
  const a = ctxInfo(A, 272_000);
  assert.equal(a.windowSource, 'setting');
  assert.equal(a.window, 272_000);
  assert.equal(a.now, 17_500);
  assert.equal(a.peak, 290_000);
  assert.equal(a.overMarker, true);
  assert.equal(ctxLabel(a), '17.5k / 272k · 6 %');
  const b = ctxInfo(B, 272_000);
  assert.equal(b.windowSource, 'OBSERVED');
  assert.equal(ctxLabel(b), '50k / 200k · 25 %');
  assert.equal(b.overMarker, false);
  assert.equal(ctxLabel(ctxInfo(W)), '—');
  assert.equal(tok(1_234_567), '1.2M');
  assert.equal(tok(100_000), '100k');
});

test('health: series downsamples by max and keeps the peak', () => {
  const many = mk({ key: 'claude:m', facts: { calls: Array.from({ length: 400 }, (_, i) => [NOW - (400 - i) * 1000, i === 123 ? 999_999 : i, 1] as [number, number, number]) } });
  const s = ctxSeries(many, 40);
  assert.equal(s.length, 40);
  assert.equal(Math.max(...s), 999_999);
  assert.deepEqual(ctxSeries(A), [10_000, 290_000, 17_500]);
});

test('health: rows by repo and session, period clipping, leads-only commits per session', () => {
  const o = { period: '7d' as const, now: NOW };
  const repo = healthRows(ALL, 'repo', o);
  const alpha = repo.find(r => r.key === 'alpha')!;
  assert.equal(alpha.pass, 2);
  assert.equal(alpha.fail, 1);
  assert.equal(alpha.passRate, 2 / 3);
  assert.equal(alpha.commits, 3); // lead 2 + worker 1
  assert.equal(alpha.leads, 1);
  assert.equal(alpha.commitsPerSession, 3);
  assert.equal(alpha.compactions, 1);
  assert.equal(alpha.toolErrorRate, 0.1);
  const beta = repo.find(r => r.key === 'beta')!;
  assert.equal(beta.sessions.length, 1, 'old session is outside 7 d');
  assert.equal(beta.passRate, 0);
  const all = healthRows(ALL, 'repo', { period: 'all', now: NOW }).find(r => r.key === 'beta')!;
  assert.equal(all.pass, 1);
  const sess = healthRows(ALL, 'session', o).find(r => r.key === 'claude:a')!;
  assert.equal(sess.label, 'Alpha <b>work</b>');
  assert.equal(sess.ctx?.now, 17_500);
  const leads = healthRows(ALL, 'repo', { ...o, leadsOnly: true }).find(r => r.key === 'alpha')!;
  assert.equal(leads.commits, 2);
});

test('health: total aggregates once over the period', () => {
  const t = healthTotal(ALL, { period: '7d', now: NOW });
  assert.equal(t.pass, 2);
  assert.equal(t.fail, 2);
  assert.equal(t.passRate, 0.5);
  assert.equal(t.tested, 2);
  assert.equal(t.sessions.length, 3);
  assert.equal(t.commits, 3);
  assert.equal(t.commitsPerSession, 1.5);
  assert.equal(t.overMarker, 1);
  const empty = healthTotal([], { period: '24h', now: NOW });
  assert.equal(empty.passRate, undefined);
});

test('health: trend buckets per hour', () => {
  const tr = healthTrend(ALL, { period: '24h', now: NOW, gran: 'hour' });
  assert.ok(tr.x.length >= 24 && tr.x.length <= 26);
  const i = tr.x.findIndex(x => x <= NOW - 2 * H && x + H > NOW - 2 * H);
  assert.equal(tr.values.pass[i], 2 / 4); // A pass, fail, pass + B fail, all in the 10:00 hour
  assert.equal(tr.values.tests[i], 4);
  assert.ok((tr.values.context[i] ?? 0) > 0);
  assert.equal(tr.values.pass[tr.x.length - 1], undefined);
  const j = tr.x.findIndex(x => x <= NOW - 80 * 60_000 && x + H > NOW - 80 * 60_000);
  assert.ok((tr.values.commits[j] ?? 0) > 0);
});

test('health: settings parse with safe defaults', () => {
  assert.deepEqual(parseConfig(undefined, undefined), { window: 272_000, warn: 80 });
  assert.deepEqual(parseConfig(200_000, 90), { window: 200_000, warn: 90 });
  assert.deepEqual(parseConfig('x', 500), { window: 272_000, warn: 80 });
});

test('health: sparkline handles gaps and empty input', () => {
  assert.match(spark([]), /—/);
  const s = spark([1, undefined, 3, 4], { marker: 2 });
  assert.equal((s.match(/<polyline/g) ?? []).length, 1);
  assert.match(s, /hl-mk/);
  assert.match(spark([1, 2], { bars: true }), /<rect/);
});

test('health: screen renders escaped, with every toggle combination', () => {
  clearFeeds();
  setFeedValue('health.config', { window: 272_000, warn: 80 });
  const d: WsData = { sessions: ALL, providers: [], events: [], now: NOW, ternAvailable: false };
  assert.equal(healthView.ready, true);
  for (const group of ['session', 'repo', 'provider', 'model'])
    for (const trend of ['spark', 'bars', 'table'])
      for (const orient of ['h', 'v']) {
        const html = renderWorkspace(d, { view: 'health', opts: { 'health.group': group, 'health.trend': trend, 'health.orient': orient, 'health.period': '24h' } });
        assert.ok(!html.includes('<b>work</b>'), 'title escaped');
        assert.match(html, /272k/);
      }
  const html = healthView.render(d, { view: 'health' });
  assert.match(html, /17\.5k \/ 272k · 6 %/);
  assert.match(html, /data-select="claude:a"/);
  assert.match(html, /50k \/ 200k · 25 %/);
  const empty = healthView.render({ ...d, sessions: [] }, { view: 'health' });
  assert.match(empty, /No session active/);
  assert.equal(healthView.badge?.(d), '');
  clearFeeds();
});
