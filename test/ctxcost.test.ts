import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { AgentSessionSnapshot, ToolResultSize } from '../src/model';
// workspace first: it loads the screen registry (the screen file imports helpers from workspace).
import { renderWorkspace, WsData } from '../src/render/workspace';
import { ctxCost, fmt, logAxis, logPos, percentile, sortRows, timesSmallest, tip, toolLabel } from '../src/activity/ctxcost';
import { ctxcostView, renderCtxCost } from '../src/render/extra/ctxcost';
import { ClaudeAdapter, resultChars } from '../src/providers/claude/claude';
import { CodexAdapter, outputChars } from '../src/providers/codex/codex';
import { SessionAccumulator } from '../src/sessions/accumulator';
import { ProviderAdapter } from '../src/providers/types';
import { FIXTURES, jpath, materialize, T, tmpDir } from './helpers';

function load(provider: 'claude' | 'codex') {
  const home = tmpDir(`ctxcost-${provider}`);
  const cwd = path.join(home, 'repo');
  fs.mkdirSync(cwd, { recursive: true });
  materialize(path.join(FIXTURES, 'facts', provider), path.join(home, provider), { __CWD__: jpath(cwd) });
  const a: ProviderAdapter = provider === 'claude' ? new ClaudeAdapter(path.join(home, provider)) : new CodexAdapter(path.join(home, provider));
  const refs = a.listArtifacts(0, 50);
  assert.equal(refs.length, 1);
  const acc = a.ingest(refs[0])!;
  return { acc, adapter: a, file: refs[0].path };
}

function reingest(adapter: ProviderAdapter, file: string): void {
  const st = fs.statSync(file);
  adapter.ingest({ path: file, mtimeMs: st.mtimeMs, size: st.size });
}

const stat = (calls: number, chars: number, max: number, samples: [number, number][]): ToolResultSize => ({ calls, chars, max, samples });

test('ctxcost parser: claude tool_result sizes per tool, never the content', () => {
  const { acc, adapter, file } = load('claude');
  const f = acc.toSnapshot().facts!;
  assert.deepEqual(f.toolResultChars, {
    Bash: stat(1, 9, 9, [[T('2026-10-05T10:00:40Z'), 9]]),
    Edit: stat(2, 4, 2, [[T('2026-10-05T10:01:05Z'), 2], [T('2026-10-05T10:02:05Z'), 2]]),
    Agent: stat(1, 5, 5, [[T('2026-10-05T10:03:05Z'), 5]]),
    mcp__github__search_code: stat(1, 1, 1, [[T('2026-10-05T10:04:05Z'), 1]]),
    WebFetch: stat(1, 1, 1, [[T('2026-10-05T10:04:05Z'), 1]]),
  });
  assert.ok(!JSON.stringify(f).includes('1 failing'), 'result text not kept');
  // A huge result line (> 512 KB, not parsed) still counts with its line length; an unknown id lands in "unknown".
  const big = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ tool_use_id: 't7', type: 'tool_result', content: 'x'.repeat(600_000) }] }, uuid: 'f-big', timestamp: '2026-10-05T10:21:00.000Z' });
  const orphan = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ tool_use_id: 'zz', type: 'tool_result', content: [{ type: 'text', text: 'abc' }, { type: 'image', source: { data: 'AAAA' } }] }] }, uuid: 'f-orphan', timestamp: '2026-10-05T10:22:00.000Z' });
  fs.appendFileSync(file, `${big}\n${orphan}\n`);
  reingest(adapter, file);
  reingest(adapter, file);
  const g = acc.toSnapshot().facts!.toolResultChars!;
  assert.equal(g.Bash.calls, 2);
  assert.equal(g.Bash.max, big.length, 'oversized line counted by its length (upper bound)');
  assert.deepEqual(g.unknown, stat(1, 3, 3, [[T('2026-10-05T10:22:00Z'), 3]]), 'image parts not counted');
});

test('ctxcost parser: codex function_call_output / custom_tool_call_output sizes per tool', () => {
  const { acc, adapter, file } = load('codex');
  const f = acc.toSnapshot().facts!;
  assert.deepEqual(f.toolResultChars, {
    exec_command: stat(1, 6, 6, [[T('2026-10-05T10:00:20Z'), 6]]),
    apply_patch: stat(1, 2, 2, [[T('2026-10-05T10:00:31Z'), 2]]),
    spawn_agent: stat(1, 7, 7, [[T('2026-10-05T10:01:01Z'), 7]]),
  });
  const big = JSON.stringify({ timestamp: '2026-10-05T10:12:30.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'c4', output: 'y'.repeat(600_000) } });
  const call = JSON.stringify({ timestamp: '2026-10-05T10:12:40.000Z', type: 'response_item', payload: { type: 'function_call', call_id: 'c5', name: 'view_image', arguments: '{}' } });
  const img = JSON.stringify({ timestamp: '2026-10-05T10:12:41.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'c5', output: [{ type: 'input_image', image_url: `data:image/png;base64,${'A'.repeat(600_000)}` }] } });
  fs.appendFileSync(file, `${big}\n${call}\n${img}\n`);
  reingest(adapter, file);
  const g = acc.toSnapshot().facts!.toolResultChars!;
  assert.equal(g.exec_command.calls, 2);
  assert.equal(g.exec_command.chars, 6 + big.length);
  assert.deepEqual(g.view_image, stat(1, 0, 0, [[T('2026-10-05T10:12:41Z'), 0]]), 'image output counts as a call with no size');
});

test('ctxcost parser: content size helpers and bounded samples', () => {
  assert.equal(resultChars('abcd'), 4);
  assert.equal(resultChars([{ type: 'text', text: 'ab' }, { type: 'image' }, 'c']), 3);
  assert.equal(resultChars(undefined), 0);
  assert.equal(outputChars('{"output":"x"}'), 14);
  assert.equal(outputChars([{ type: 'input_text', text: 'abc' }]), 3);
  assert.equal(outputChars({ content: 'hello' }), 5);
  assert.equal(outputChars(null), 0);
  const acc = new SessionAccumulator('codex', 'b', '/nowhere.jsonl');
  for (let i = 0; i < 500; i++) {
    acc.toolStart('exec_command', '', i, `c${i}`);
    acc.toolResult(`c${i}`, i, i);
  }
  acc.toolResult('c1', 999, 1);
  const r = acc.toSnapshot().facts!.toolResultChars!.exec_command;
  assert.equal(r.calls, 500, 'repeated result id counted once');
  assert.equal(r.samples.length, 200);
  assert.deepEqual(r.samples[199], [499, 499], 'newest samples kept');
  assert.equal(r.max, 499);
  for (let i = 500; i < 7000; i++) acc.toolResult(`c${i}`, 1, i);
  assert.ok(acc.seenIds.size <= 5000, 'result dedupe ids stay bounded');
});

// ---------------------------------------------------------------- aggregation + screen

const NOW = T('2026-10-05T12:00:00Z');
const H = 3600_000;
function mk(p: Partial<AgentSessionSnapshot> & { key: string }): AgentSessionSnapshot {
  const [provider, sessionId] = p.key.split(':') as ['claude' | 'codex', string];
  return { provider, sessionId, status: 'ENDED', statusReason: 'test', commits: [], changedFiles: [], tests: [], isWorker: false, counts: { tools: 0, commands: 0, fileEdits: 0, turns: 0 }, evidence: [], artifactPath: '', diagnostics: [], startedAt: NOW - 3 * H, lastActivityAt: NOW - H, ...p };
}

const a = mk({
  key: 'claude:a', repository: 'D:/PROJ/alpha',
  facts: { toolResultChars: {
    Read: stat(3, 12_000, 8000, [[NOW - 2 * H, 2000], [NOW - 2 * H, 2000], [NOW - 2 * H, 8000]]),
    Grep: stat(2, 400, 300, [[NOW - 2 * H, 100], [NOW - 2 * H, 300]]),
    Bash: stat(1, 400_000, 400_000, [[NOW - 2 * H, 400_000]]),
    'mcp__github__search_code': stat(1, 4000, 4000, [[NOW - 2 * H, 4000]]),
  } },
});
const b = mk({
  key: 'codex:b', repository: 'D:/PROJ/<beta>',
  facts: { toolResultChars: { exec_command: stat(2, 40_000, 36_000, [[NOW - 2 * H, 4000], [NOW - 2 * H, 36_000]]) } },
});
// Started before the 24 h period: only samples inside it count, and it had more results than samples → partial.
const old = mk({
  key: 'claude:old', startedAt: NOW - 3 * 24 * H, lastActivityAt: NOW - H,
  facts: { toolResultChars: { Read: stat(300, 1_000_000, 9000, [[NOW - 2 * 24 * H, 9000], [NOW - 5 * H, 400]]) } },
});
const none = mk({ key: 'claude:none' });
const sessions = [a, b, old, none];
const repo = (s: AgentSessionSnapshot) => (s.repository ?? '').split('/').pop() || '(no repo)';

test('ctxcost: aggregation per tool, percentiles, shares, period slicing, unknown sessions', () => {
  const r = ctxCost(sessions, { period: '24h', now: NOW, group: 'tool', repoOf: repo });
  assert.equal(r.sessions, 4);
  assert.equal(r.withoutData, 1);
  const read = r.rows.find(x => x.key === 'Read')!;
  assert.equal(read.calls, 4, '3 from a + 1 sample of old inside 24 h');
  assert.equal(read.chars, 12_400);
  assert.equal(read.p50Chars, 2000);
  assert.equal(read.maxChars, 8000);
  assert.equal(read.partial, true);
  assert.ok(r.rows.find(x => x.key === 'MCP github'), 'MCP tools grouped by server');
  const sum = r.rows.reduce((n, x) => n + x.share, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  const all = ctxCost(sessions, { period: 'all', now: NOW, group: 'tool', repoOf: repo });
  assert.equal(all.rows.find(x => x.key === 'Read')!.calls, 303, 'whole record when the period covers the session');
  const bp = ctxCost(sessions, { period: 'all', now: NOW, group: 'provider', repoOf: repo });
  assert.ok(bp.rows.some(x => x.label === 'Read · Claude'));
  const br = ctxCost(sessions, { period: 'all', now: NOW, group: 'repo', repoOf: repo });
  assert.deepEqual(br.rows.map(x => x.label).sort(), ['(no repo)', '<beta>', 'alpha']);
  assert.deepEqual(sortRows(r.rows, 'p50').map(x => x.key)[0], 'Bash');
});

test('ctxcost: helpers (labels, percentile, log axis, ratios, tips)', () => {
  assert.equal(toolLabel('mcp__srv__tool'), 'MCP srv');
  assert.equal(toolLabel('Task'), 'Task (subagent result)');
  assert.equal(percentile([5, 1, 3], 0.5), 3);
  assert.equal(percentile([], 0.5), undefined);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
  const ax = logAxis([25, 100_000], 272_000);
  assert.deepEqual(ax.ticks, [10, 100, 1000, 10_000, 100_000, 1_000_000]);
  assert.equal(logPos(10, ax), 0);
  assert.equal(logPos(1_000_000, ax), 100);
  assert.equal(timesSmallest(2450, 10), 245);
  assert.equal(timesSmallest(5, 0), undefined);
  assert.equal(fmt(272_000), '272k');
  const r = ctxCost(sessions, { period: 'all', now: NOW, group: 'tool', repoOf: repo });
  assert.match(tip(r.rows.find(x => x.key === 'Bash')!, 272_000), /1 result ≥ 20k tokens \(≈\) · largest ≈ 100k/);
  assert.match(tip(r.rows.find(x => x.key === 'Bash')!, 50_000), /bigger than the context window/);
});

test('ctxcost: screen renders bars, window line, table, tips; escaped; registered', () => {
  const d: WsData = { sessions, providers: [], events: [], now: NOW, ternAvailable: false };
  const h = renderCtxCost(d, { view: 'ctxcost' } as never);
  assert.match(h, /272k-token context window/);
  assert.match(h, /× the smallest/);
  assert.match(h, /class="cc-tb"/);
  assert.match(h, /Tips/);
  assert.match(h, /inferred/);
  assert.match(h, /1 of 4 sessions in the period carry no tool-result size/);
  const repoView = renderCtxCost(d, { view: 'ctxcost', opts: { 'ctxcost.group': 'repo', 'ctxcost.metric': 'total', 'ctxcost.window': '1m', 'ctxcost.period': 'all' } } as never);
  assert.ok(repoView.includes('&lt;beta&gt;') && !repoView.includes('<beta>'), 'repo names escaped');
  assert.match(repoView, /1M-token context window/);
  const custom = renderCtxCost({ ...d, config: <V>(k: string, f: V) => (k === 'agent.health.contextWindow' ? (200_000 as unknown as V) : f) }, { view: 'ctxcost' } as never);
  assert.match(custom, /200k-token context window/);
  const empty = renderCtxCost({ ...d, sessions: [none] }, { view: 'ctxcost' } as never);
  assert.match(empty, /No tool result with a recorded size/);
  assert.equal(ctxcostView.id, 'ctxcost');
  assert.equal(ctxcostView.group, 'Usage');
  assert.match(renderWorkspace(d, { view: 'ctxcost' } as never), /data-nav="ctxcost"/);
});
