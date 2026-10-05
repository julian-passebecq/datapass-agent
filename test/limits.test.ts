import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { AgentSessionSnapshot } from '../src/model';
// workspace first: it loads the screen registry (the screen file imports helpers from workspace).
import { renderWorkspace, WsData } from '../src/render/workspace';
import { blocks, Call, claudeLimits, codexLimits, codexPeak, parseRateLimits, percentile, thresholds, windowKind } from '../src/activity/limits';
import { limitsView } from '../src/render/extra/limits';
import { CodexAdapter } from '../src/providers/codex/codex';
import { FIXTURES, jpath, materialize, T, tmpDir } from './helpers';

const M = 60_000;
const H = 60 * M;
const NOW = T('2026-10-05T12:30:00Z');

function mk(p: Partial<AgentSessionSnapshot> & { key: string }): AgentSessionSnapshot {
  const [provider, sessionId] = p.key.split(':') as ['claude' | 'codex', string];
  return { provider, sessionId, status: 'ENDED', statusReason: 'test', commits: [], changedFiles: [], tests: [], isWorker: false, counts: { tools: 0, commands: 0, fileEdits: 0, turns: 0 }, evidence: [], artifactPath: '', diagnostics: [], ...p };
}

const c = (at: number, tokens: number, output = 0): Call => ({ at, tokens, output });

test('limits: blocks floor to the hour, split at 5 h from start and at gaps ≥ 5 h', () => {
  const b0 = T('2026-10-04T08:20:00Z');
  const calls = [
    c(b0, 100, 10), c(b0 + H, 200, 20), // block 08:00–13:00
    c(T('2026-10-04T13:05:00Z'), 50, 5), // past 13:00 → new block 13:00–18:00
    c(T('2026-10-04T13:30:00Z'), 50, 5),
    // gap 18:30 → 23:59 (≥ 5 h) → new block 23:00
    c(T('2026-10-04T23:59:00Z'), 10, 1),
  ];
  const bl = blocks(calls, NOW);
  assert.deepEqual(bl.map(b => [new Date(b.start).toISOString().slice(11, 16), b.tokens, b.output, b.calls]), [['08:00', 300, 30, 2], ['13:00', 100, 10, 2], ['23:00', 10, 1, 1]]);
  assert.equal(bl[0].end, T('2026-10-04T13:00:00Z'));
  assert.ok(bl.every(b => !b.active));
  // a gap ≥ 5 h inside what would still be the same 5 h block is impossible; but a gap ≥ 5 h after the end is a new block
  const g = blocks([c(T('2026-10-05T01:00:00Z'), 1), c(T('2026-10-05T06:00:00Z'), 1)], NOW);
  assert.equal(g.length, 2);
  assert.equal(g[1].start, T('2026-10-05T06:00:00Z'));
});

test('limits: current block burn (last 15 min), projection, past p90 / max', () => {
  const past = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000].map((n, i) => [T('2026-10-01T00:10:00Z') + i * 6 * H, n, 0] as [number, number, number]);
  const cur: [number, number, number][] = [[NOW - 2 * H, 3000, 300], [NOW - 10 * M, 600, 60], [NOW - 5 * M, 900, 90]];
  const s = [mk({ key: 'claude:a', facts: { calls: past } }), mk({ key: 'claude:w', isWorker: true, facts: { calls: cur } }), mk({ key: 'codex:x', facts: { calls: [[NOW - M, 99999, 0]] } })];
  const cl = claudeLimits(s, NOW);
  assert.equal(cl.past.n, 10);
  assert.equal(cl.past.max, 10000);
  assert.equal(cl.past.p90, 9000);
  assert.equal(percentile([5], 90), 5);
  const now = cl.current!;
  assert.ok(now, 'active block');
  assert.equal(now.block.start, T('2026-10-05T10:00:00Z'));
  assert.equal(now.block.tokens, 4950, 'prompt + output; codex calls never enter Claude blocks');
  assert.equal(now.burnPerMin, 1650 / 15);
  assert.equal(now.msLeft, T('2026-10-05T15:00:00Z') - NOW);
  // Projection uses the 60-min average (1650 tokens / 60 min), not the 15-min burst.
  assert.equal(now.projected, Math.round(4950 + (1650 / 60) * 150));
  assert.equal(now.projectedOutput, Math.round(450 + (150 / 60) * 150));
  assert.equal(now.settled, true, 'first call 2 h ago');
  assert.equal(now.block.output, 450);
});

test('limits: codex rate_limits parsing (resets_at seconds, resets_in_seconds, window kinds)', () => {
  const at = T('2026-10-05T10:00:00Z');
  const a = parseRateLimits({ primary: { used_percent: 30, window_minutes: 10080, resets_at: 1791581063 }, secondary: null, plan_type: 'pro' }, at)!;
  assert.deepEqual(a, { at, primary: { usedPercent: 30, windowMinutes: 10080, resetsAt: 1791581063000 }, planType: 'pro' });
  assert.equal(windowKind(a.primary!, 'primary'), 'weekly');
  const b = parseRateLimits({ primary: { used_percent: 5, window_minutes: 300, resets_in_seconds: 60 } }, at)!;
  assert.equal(b.primary!.resetsAt, at + 60_000);
  assert.equal(windowKind(b.primary!, 'primary'), '5h');
  assert.equal(parseRateLimits(null, at), undefined);
  assert.equal(parseRateLimits({ primary: { used_percent: 'x' } }, at), undefined);
  const t = thresholds((k, d) => (k === 'agent.limits.warnPercent' ? (95 as never) : k === 'agent.limits.alertPercent' ? (80 as never) : d));
  assert.deepEqual(t, { warn: 95, alert: 95 }, 'alert never below warn');
});

test('limits: codex rollout fixture → facts.rateLimits, gauges, trend, badge', () => {
  const home = tmpDir('limits');
  const cwd = path.join(home, 'repo');
  fs.mkdirSync(cwd, { recursive: true });
  materialize(path.join(FIXTURES, 'limits', 'codex'), path.join(home, 'codex'), { __CWD__: jpath(cwd) });
  const a = new CodexAdapter(path.join(home, 'codex'));
  const accs = a.listArtifacts(0, 10).map(r => a.ingest(r)!).filter(Boolean);
  assert.equal(accs.length, 1);
  const s = accs[0].toSnapshot();
  const rl = s.facts!.rateLimits!;
  assert.equal(rl.at, T('2026-10-05T10:05:00Z'));
  assert.deepEqual(rl.primary, { usedPercent: 75, windowMinutes: 10080, resetsAt: 1791800000 * 1000 });
  assert.equal(rl.planType, 'pro');
  // first sample (info null) still recorded; the repeat at 10:00:20 is not a change
  assert.deepEqual(rl.history, [[T('2026-10-05T10:00:05Z'), 12.5, 40], [T('2026-10-05T10:05:00Z'), null, 75]]);
  assert.equal(s.usage?.totalTokens, 2000, 'token accounting unchanged');

  const now = T('2026-10-05T10:30:00Z');
  const cx = codexLimits([s], now);
  assert.equal(cx.gauges.weekly!.usedPercent, 75);
  assert.equal(cx.gauges['5h'], undefined, 'the latest sample of this rollout records the weekly window only');
  assert.deepEqual(cx.trend.weekly, [[T('2026-10-05T10:00:05Z'), 40], [T('2026-10-05T10:05:00Z'), 75]]);
  assert.deepEqual(cx.trend['5h'], [[T('2026-10-05T10:00:05Z'), 12.5]]);
  // another session with an older 5-hour sample: latest sample per window kind across sessions
  const old = mk({ key: 'codex:old', facts: { rateLimits: { at: T('2026-10-05T10:01:00Z'), primary: { usedPercent: 20, windowMinutes: 300, resetsAt: T('2026-10-05T11:00:00Z') } } } });
  const both = codexLimits([s, old], now);
  assert.equal(both.gauges['5h']!.usedPercent, 20);
  assert.equal(both.gauges['5h']!.stale, false);
  assert.equal(both.gauges.weekly!.sessionKey, s.key);
  assert.equal(codexLimits([s, old], T('2026-10-05T11:30:00Z')).gauges['5h']!.stale, true, '5 h window reset passed');
  assert.equal(codexPeak([s], now), 75);

  const d: WsData = { sessions: [s], providers: [], events: [], now, ternAvailable: false, config: <T>(_k: string, f: T) => f };
  assert.equal(limitsView.badge!(d), '75%');
  assert.equal(limitsView.badge!({ ...d, config: <T>(k: string, f: T) => (k === 'agent.limits.warnPercent' ? (80 as T) : f) }), '');
  const html = limitsView.render(d, { opts: {} } as never);
  assert.ok(html.includes('Weekly window') && html.includes('75'));
  assert.ok(html.includes('Warning'), 'warn alert at 75 % ≥ 70 %');
  assert.ok(!html.includes('<script'));
  void renderWorkspace;
});
