import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { AgentSessionSnapshot } from '../src/model';
// Load the workspace before the screen module (the screen imports workspace helpers; workspace imports the registry).
import { renderWorkspace, WsData } from '../src/render/workspace';
import {
  BenchRow, BenchSnapshot, BenchSource, inferVendor, localRows, logFrac, logTicks, mergeSnapshot, pareto, parseAiderPolyglot, parseYamlList, PARSERS,
  trend, usd, usedLocally, validateSnapshot,
} from '../src/activity/benchmarks';
import { buildDispatches } from '../src/activity/dispatch';
import { BENCH_FEED, benchDir, defaultBenchDir, readBenchDb, readManual, writeWeek } from '../src/feeds/benchmarks';
import { benchmarksView, renderBenchmarks } from '../src/render/extra/benchmarks';
import { extraViews } from '../src/render/extra/index';
import { clearFeeds, setFeedValue } from '../src/render/extra/feeds';
import { T, tmpDir } from './helpers';

const NOW = T('2026-10-05T12:00:00Z');
const H = 3600_000;

// Obviously fake leaderboard: fake models and values, same shape as polyglot_leaderboard.yml.
const FAKE_YAML = `# fake fixture, not real results
- dirname: 2099-01-01--fake-a
  test_cases: 100
  model: fake-model-alpha
  edit_format: diff
  pass_rate_1: 10.0
  pass_rate_2: 42.5
  prompt_tokens: 100000
  completion_tokens: 50000
  command: aider --model fake/alpha --opt "x: y"
  date: 2099-01-01
  total_cost: 12.5000

- dirname: 2099-01-02--fake-b
  test_cases: 100
  model: "fake-model-beta (high)"
  reasoning_effort: high
  pass_rate_2: 61.0
  total_cost: 0.0000

- dirname: broken entry without score
  model: fake-model-gamma
  total_cost: 3
`;

test('benchmarks: minimal YAML list parser keeps scalars, strips quotes and comments', () => {
  const l = parseYamlList(FAKE_YAML);
  assert.equal(l.length, 3);
  assert.equal(l[0].test_cases, 100);
  assert.equal(l[0].command, 'aider --model fake/alpha --opt "x: y"');
  assert.equal(l[1].model, 'fake-model-beta (high)');
  assert.equal(l[1].total_cost, 0);
});

test('benchmarks: Aider polyglot parser maps fields, derives cost per task, leaves out total_cost 0', () => {
  const rows = parseAiderPolyglot(FAKE_YAML);
  assert.equal(rows.length, 2, 'entry without pass_rate_2 is skipped');
  const [a, b] = rows;
  assert.equal(a.model, 'fake-model-alpha');
  assert.equal(a.score, 42.5);
  assert.equal(a.costPerTask, 0.125);
  assert.equal(a.tokensPerTask, 1500);
  assert.equal(a.n, 100);
  assert.match(a.notes ?? '', /edit format diff/);
  assert.equal(b.effort, 'high');
  assert.equal(b.costPerTask, undefined);
  assert.match(b.notes ?? '', /total_cost 0/);
  assert.ok(PARSERS['aider-polyglot'].url.startsWith('https://raw.githubusercontent.com/Aider-AI/aider/'));
  assert.ok(PARSERS['aider-polyglot'].license);
});

test('benchmarks: vendor inference is keyword based', () => {
  assert.equal(inferVendor('claude-opus-5-5'), 'Anthropic');
  assert.equal(inferVendor('gpt-6'), 'OpenAI');
  assert.equal(inferVendor('o3 (high)'), 'OpenAI');
  assert.equal(inferVendor('gemini-x'), 'Google');
  assert.equal(inferVendor('fake-model-alpha'), 'Other');
});

test('benchmarks: Pareto frontier keeps the cheapest model for each score level', () => {
  const pts = [
    { cost: 1, value: 50 }, // frontier
    { cost: 2, value: 40 }, // dominated by 0
    { cost: 4, value: 70 }, // frontier
    { cost: 4, value: 60 }, // dominated (same cost, lower)
    { cost: 10, value: 70 }, // dominated (same score, dearer)
    { cost: 20, value: 90 }, // frontier
    { cost: 0, value: 99 }, // no cost: not on a log axis
  ];
  assert.deepEqual(pareto(pts), [0, 2, 5]);
  // Lower is better (tokens per task): only the cheapest-and-leanest chain.
  assert.deepEqual(pareto([{ cost: 1, value: 500 }, { cost: 2, value: 100 }, { cost: 3, value: 300 }], false), [0, 1]);
});

test('benchmarks: log ticks come from the data range and frame it', () => {
  const ax = logTicks(0.003, 0.8);
  assert.ok(ax.min <= 0.003 && ax.max >= 0.8);
  assert.deepEqual(ax.ticks, [0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1]);
  const wide = logTicks(0.001, 500);
  assert.ok(wide.ticks.every(t => Math.abs(Math.log10(t) - Math.round(Math.log10(t))) < 1e-9), 'wide ranges use powers of ten only');
  assert.equal(logFrac(ax.min, ax), 0);
  assert.equal(logFrac(ax.max, ax), 1);
  const one = logTicks(5, 5);
  assert.ok(one.max > one.min);
  assert.equal(usd(0.125), '$0.13');
  assert.equal(usd(0.002), '$0.002');
  assert.equal(usd(1.5), '$1.5');
  assert.equal(usd(1200), '$1,200');
});

test('benchmarks: local model matching is loose but not empty', () => {
  assert.ok(usedLocally('claude-opus-5-5', ['claude-opus-5-5-20261001']));
  assert.ok(usedLocally('Claude Opus 5.5', ['claude-opus-5-5']));
  assert.ok(!usedLocally('fake-model-alpha', ['claude-opus-5-5']));
  assert.ok(!usedLocally('x', ['x']));
});

const SRC_A: BenchSource = { id: 'fake-a', name: 'Fake A', kind: 'public', url: 'https://example.invalid/a.yml', license: 'fake', fetchedAt: NOW, metric: 'fake', costBasis: 'fake' };
const SRC_M: BenchSource = { id: 'manual:x', name: 'Manual X', kind: 'manual', fetchedAt: NOW, metric: 'm', costBasis: 'm' };
const row = (model: string, score: number, cost?: number, extra: Partial<BenchRow> = {}): BenchRow => ({ source: 'fake-a', model, vendor: inferVendor(model), score, scoreUnit: '%', costUnit: 'USD', ...(cost !== undefined ? { costPerTask: cost } : {}), ...extra });

test('benchmarks: merge replaces refreshed sources, keeps the others, drops vanished manual files', () => {
  const s1 = mergeSnapshot(undefined, '2026-W41', [{ source: SRC_A, rows: [row('fake-1', 10, 1)] }, { source: SRC_M, rows: [row('fake-m', 5, 2)] }], NOW);
  assert.equal(s1.rows.length, 2);
  const s2 = mergeSnapshot(s1, '2026-W41', [{ source: SRC_A, rows: [row('fake-1', 11, 1), row('fake-2', 20, 3)] }], NOW + 1);
  assert.deepEqual(s2.rows.map(r => `${r.source}:${r.model}:${r.score}`), ['fake-a:fake-1:11', 'fake-a:fake-2:20', 'manual:x:fake-m:5']);
  assert.equal(s2.capturedAt, NOW);
  assert.equal(s2.updatedAt, NOW + 1);
  const s3 = mergeSnapshot(s2, '2026-W41', [], NOW + 2, ['manual']);
  assert.deepEqual(s3.sources.map(s => s.id), ['fake-a']);
});

test('benchmarks: weekly snapshot write is atomic, idempotent and never touches other weeks', () => {
  const dir = tmpDir('bench');
  const older = path.join(dir, '2026-W40.json');
  fs.writeFileSync(older, JSON.stringify({ week: '2026-W40', capturedAt: 1, sources: [SRC_A], rows: [row('fake-old', 1, 1)] }));
  const before = fs.readFileSync(older, 'utf8');
  const up = [{ source: SRC_A, rows: [row('fake-1', 10, 1), row('fake-2', 20, 2)] }];
  const a = writeWeek(dir, '2026-W41', up, NOW);
  const b = writeWeek(dir, '2026-W41', up, NOW + 1000);
  assert.deepEqual(b.snapshot.rows, a.snapshot.rows, 'same inputs, same rows');
  assert.equal(b.snapshot.capturedAt, NOW);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['2026-W40.json', '2026-W41.json'], 'no temp file left behind');
  assert.equal(fs.readFileSync(older, 'utf8'), before);
  const db = readBenchDb(dir, 104, NOW);
  assert.deepEqual(db.weeks.map(w => w.week), ['2026-W40', '2026-W41']);
  assert.equal(db.weeks[1].rows.length, 2);
  // Dry run writes nothing.
  writeWeek(dir, '2026-W42', up, NOW, [], true);
  assert.ok(!fs.existsSync(path.join(dir, '2026-W42.json')));
  // A corrupt current week is reported, not overwritten.
  fs.writeFileSync(path.join(dir, '2026-W43.json'), '{not json');
  assert.throws(() => writeWeek(dir, '2026-W43', up, NOW), /not a valid snapshot/);
  assert.equal(fs.readFileSync(path.join(dir, '2026-W43.json'), 'utf8'), '{not json');
  assert.equal(readBenchDb(dir, 104, NOW).errors.length, 1);
});

test('benchmarks: snapshot validation drops bad rows and rows of unknown sources', () => {
  const v = validateSnapshot({ week: '2026-W41', capturedAt: 1, sources: [SRC_A, { id: 'x' }], rows: [row('ok', 1), { source: 'fake-a', model: 'no score' }, { ...row('orphan', 1), source: 'nope' }, { ...row('u', 1), url: 'javascript:x' }] });
  assert.ok(v);
  assert.deepEqual(v!.rows.map(r => r.model), ['ok', 'u']);
  assert.equal(validateSnapshot({ week: 'nope', sources: [], rows: [] }), undefined);
  assert.equal(validateSnapshot({ ...SRC_A, week: '2026-W41', sources: [{ ...SRC_A, url: 'http://x' }], rows: [] })!.sources[0].url, undefined, 'only https URLs are kept');
});

test('benchmarks: manual files (array or {source, rows}) become one source each', () => {
  const dir = tmpDir('bench-manual');
  fs.mkdirSync(path.join(dir, 'manual'));
  fs.writeFileSync(path.join(dir, 'manual', 'Fake Board.json'), JSON.stringify({ source: { name: 'Fake board', url: 'https://example.invalid/board' }, rows: [{ model: 'fake-model-x', score: 50, costPerTask: 0.5 }, { model: 'no score' }] }));
  fs.writeFileSync(path.join(dir, 'manual', 'plain.json'), JSON.stringify([{ model: 'fake-model-y', vendor: 'FakeCo', score: 3 }]));
  fs.writeFileSync(path.join(dir, 'manual', 'bad.json'), '{');
  const m = readManual(dir);
  assert.deepEqual(m.updates.map(u => u.source.id), ['manual:fake-board', 'manual:plain']);
  assert.equal(m.updates[0].source.kind, 'manual');
  assert.equal(m.updates[0].source.url, 'https://example.invalid/board');
  assert.equal(m.updates[0].rows.length, 1);
  assert.equal(m.updates[1].rows[0].vendor, 'FakeCo');
  assert.equal(m.updates[1].rows[0].vendorInferred, undefined);
  assert.equal(m.errors.length, 2);
  assert.equal(readManual(tmpDir('bench-none')).updates.length, 0);
});

test('benchmarks: folder setting falls back to ~/.agent/benchmarks', () => {
  assert.equal(benchDir(''), defaultBenchDir());
  assert.equal(benchDir('relative/dir'), defaultBenchDir());
  assert.match(defaultBenchDir(), /\.agent[\\/]benchmarks$/);
});

function mk(p: Partial<AgentSessionSnapshot> & { key: string }): AgentSessionSnapshot {
  const [provider, sessionId] = p.key.split(':') as ['claude' | 'codex', string];
  return { provider, sessionId, status: 'ENDED', statusReason: 'test', commits: [], changedFiles: [], tests: [], isWorker: false, counts: { tools: 0, commands: 0, fileEdits: 0, turns: 0 }, evidence: [], artifactPath: '', diagnostics: [], startedAt: NOW - 3 * H, lastActivityAt: NOW - H, ...p };
}

test('benchmarks: local workload rows are DERIVED from dispatch analytics, cost only with a user price', () => {
  const lead = mk({ key: 'claude:lead' });
  const w = (k: string, model: string, effort: string | undefined, ok: boolean, tokens: number) => mk({
    key: `claude:${k}`, parentSessionId: 'claude:lead', isWorker: true, workerLabel: 'coder', model, effort, usage: { totalTokens: tokens, outputTokens: 10, cachedInputTokens: 0 },
    ...(ok ? { commits: [{ sha: k, at: NOW - 2 * H, subject: 's', attribution: 'during-session' as const }] } : { tests: [{ command: 'npm test', at: NOW - 2 * H, outcome: 'FAIL' as const, source: 'provider-exit-code' as const, exitCode: 1 }] }),
  });
  const ds = buildDispatches([lead, w('a', 'fake-opus', 'high', true, 1000), w('b', 'fake-opus', 'high', false, 3000), w('c', 'fake-sonnet', undefined, true, 500)], undefined, NOW);
  const rows = localRows(ds);
  assert.equal(rows.length, 2);
  const opus = rows.find(r => r.model === 'fake-opus')!;
  assert.equal(opus.effort, 'high');
  assert.equal(opus.score, 50);
  assert.equal(opus.n, 2);
  assert.equal(opus.tokensPerTask, 2000);
  assert.equal(opus.costPerTask, undefined, 'no price set: no cost');
  const priced = localRows(ds, { 'fake-opus': 10 });
  assert.ok(Math.abs(priced.find(r => r.model === 'fake-opus')!.costPerTask! - 0.02) < 1e-12);
});

// ---- screen ------------------------------------------------------------------------------------------------

function db(weeks: BenchSnapshot[]) {
  return { dir: '/fake/bench', exists: true, weeks, files: weeks.length, manualFiles: 0, errors: [], at: NOW };
}
const W40: BenchSnapshot = { week: '2026-W40', capturedAt: NOW - 7 * 86400_000, sources: [SRC_A], rows: [row('fake-1', 30, 0.1), row('fake-2', 50, 1)] };
const W41: BenchSnapshot = {
  week: '2026-W41', capturedAt: NOW, sources: [SRC_A, SRC_M],
  rows: [row('fake-1', 35, 0.1, { tokensPerTask: 900 }), row('fake-2', 55, 1, { effort: 'high' }), row('fake-3', 40, 5), row('<img src=x onerror=alert(1)>', 60, 20), row('fake-nocost', 70), { ...row('fake-m', 10, 0.05), source: 'manual:x' }],
};
const data = (sessions: AgentSessionSnapshot[] = []): WsData => ({ sessions, providers: [], events: [], now: NOW, ternAvailable: false });

test('benchmarks screen: empty state explains how to fill the database', () => {
  const h = renderBenchmarks(data(), {} as never, undefined);
  assert.match(h, /npm run benchmarks/);
  assert.match(h, /--fetch/);
  assert.match(h, /manual/);
  const h2 = renderBenchmarks(data(), {} as never, { ...db([]), errors: [{ file: '<b>.json', error: 'bad' }] });
  assert.match(h2, /&lt;b&gt;\.json/);
});

test('benchmarks screen: scatter with log cost axis, frontier, labels, escaped tooltips, selectable rows', () => {
  const h = renderBenchmarks(data(), {} as never, db([W40, W41]));
  assert.ok(!h.includes('<img src=x'), 'model names are escaped');
  assert.match(h, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(h, /class="bm-svg"/);
  assert.match(h, /class="bm-front"/);
  assert.match(h, /class="bm-lbl"[^>]*>fake-1</, 'frontier points are labelled');
  assert.match(h, />\$0\.1</, 'dollar ticks');
  assert.match(h, /<title>fake-2 · high/);
  assert.match(h, /data-select="bench:2026-W41:0"/);
  assert.match(h, /1 row\(s\) not plotted/);
  assert.match(h, /2026-w41/);
  // Week picker: older snapshot.
  const old = renderBenchmarks(data(), { opts: { 'benchmarks.week': '2026-w40' } } as never, db([W40, W41]));
  assert.ok(!old.includes('fake-3'));
  // Orientation and metric variants render.
  const y = renderBenchmarks(data(), { opts: { 'benchmarks.orient': 'y' } } as never, db([W40, W41]));
  assert.match(y, /cheaper at the top/);
  const tok = renderBenchmarks(data(), { opts: { 'benchmarks.metric': 'tokens' } } as never, db([W40, W41]));
  assert.match(tok, /Tokens per task \(log\)/);
  // Source filter: one source only.
  const man = renderBenchmarks(data(), { opts: { 'benchmarks.source': 'manual:x' } } as never, db([W40, W41]));
  assert.ok(man.includes('fake-m') && !man.includes('fake-3'));
  // Only models I use.
  const mine = renderBenchmarks(data([mk({ key: 'claude:s', model: 'fake-3' })]), { opts: { 'benchmarks.mine': 'mine' } } as never, db([W40, W41]));
  assert.ok(mine.includes('fake-3') && !mine.includes('>fake-2<'));
});

test('benchmarks screen: trend tab draws weekly lines', () => {
  const h = renderBenchmarks(data(), { opts: { 'benchmarks.tab': 'trend' } } as never, db([W40, W41]));
  assert.match(h, /Score per week/);
  assert.match(h, /class="bm-tl"/);
  assert.match(h, /2 snapshots/);
  const tr = trend([W40, W41]);
  assert.deepEqual(tr.get('fake-1 [fake-a]')?.map(p => p.score), [30, 35]);
});

test('benchmarks screen: registered in the Usage group and rendered through the workspace', () => {
  clearFeeds();
  const v = extraViews().find(x => x.id === 'benchmarks');
  assert.ok(v);
  assert.equal(v, benchmarksView);
  assert.equal(v!.group, 'Usage');
  assert.equal(v!.label, 'Model benchmarks');
  setFeedValue(BENCH_FEED, db([W41]));
  const h = renderWorkspace(data(), { view: 'benchmarks' } as never);
  assert.match(h, /data-nav="benchmarks"/);
  assert.match(h, /fake-3/);
  clearFeeds();
});
