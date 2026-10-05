// Provider adapter audit fixes (A4): fake transcripts / rollouts built inline, no real data.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { ClaudeAdapter } from '../src/providers/claude/claude';
import { CodexAdapter } from '../src/providers/codex/codex';
import { SessionAccumulator } from '../src/sessions/accumulator';
import { tmpDir } from './helpers';

const SID = 'aaaaaaaa-1111-4111-8111-111111111111';
const iso = (m: number) => new Date(Date.UTC(2026, 9, 5, 10, m)).toISOString();
const jl = (recs: object[]) => recs.map(r => JSON.stringify(r)).join('\n') + '\n';

function ingest(a: ClaudeAdapter | CodexAdapter, p: string): SessionAccumulator {
  const st = fs.statSync(p);
  const acc = a.ingest({ path: p, mtimeMs: st.mtimeMs, size: st.size });
  assert.ok(acc);
  return acc!;
}

function claudeHome() {
  const root = tmpDir('claude-adapt');
  const dir = path.join(root, 'projects', 'D--fake');
  fs.mkdirSync(path.join(dir, SID, 'subagents'), { recursive: true });
  return { root, main: path.join(dir, `${SID}.jsonl`), sub: (id: string) => path.join(dir, SID, 'subagents', `agent-${id}.jsonl`) };
}

let u = 0;
const user = (m: number, content: unknown, extra: object = {}) => ({ type: 'user', uuid: `u-${++u}`, timestamp: iso(m), sessionId: SID, message: { role: 'user', content }, ...extra });
const asst = (m: number, id: string, content: unknown[], extra: object = {}) => ({ type: 'assistant', uuid: `u-${++u}`, timestamp: iso(m), sessionId: SID, message: { id, role: 'assistant', model: 'claude-fake', content, ...extra } });
const agentUse = (m: number, tu: string) => asst(m, `msg-${tu}`, [{ type: 'tool_use', id: tu, name: 'Agent', input: { subagent_type: 'debug', description: 'fake task' } }]);
const agentResult = (m: number, tu: string, r: object) => user(m, [{ type: 'tool_result', tool_use_id: tu, content: 'ok' }], { toolUseResult: r });
const notification = (tu: string, status: string) => `<task-notification>\n<task-id>x1</task-id>\n<tool-use-id>${tu}</tool-use-id>\n<status>${status}</status>\n<summary>fake</summary>\n</task-notification>`;

test('claude: async_launched Agent result does not end the worker; task-notification does', () => {
  const h = claudeHome();
  fs.writeFileSync(h.main, jl([user(0, 'go'), agentUse(1, 'tu-bg'), agentResult(2, 'tu-bg', { status: 'async_launched', agentId: 'bg1', isAsync: true })]));
  fs.writeFileSync(h.sub('bg1'), jl([user(1, 'fake task'), asst(3, 'm-sub1', [{ type: 'tool_use', id: 'tu-x', name: 'Read', input: { file_path: 'D:\\fake\\a.ts' } }], { stop_reason: 'tool_use' })]));
  const a = new ClaudeAdapter(h.root);
  const parent = ingest(a, h.main);
  const worker = ingest(a, h.sub('bg1'));
  a.refreshLive([parent, worker], Date.parse(iso(4)));
  assert.equal(worker.live.explicitEnded, false, 'background worker still running after async_launched');
  assert.equal(worker.live.openTurn, true);
  assert.ok(!parent.timeline().some(e => e.type === 'WORKER_ENDED'), 'no WORKER_ENDED at launch');
  assert.ok(parent.timeline().some(e => e.type === 'SESSION_ACTIVITY' && /running in background/.test(e.label)));

  // The completion notification arrives as a user record (string content).
  fs.appendFileSync(h.main, jl([user(9, notification('tu-bg', 'completed'), { isMeta: true })]));
  ingest(a, h.main);
  a.refreshLive([parent, worker], Date.parse(iso(10)));
  assert.equal(worker.live.explicitEnded, true, 'task-notification ends the worker');
  const ends = parent.timeline().filter(e => e.type === 'WORKER_ENDED');
  assert.equal(ends.length, 1);
  assert.match(ends[0].label, /completed$/);
  assert.equal(worker.toSnapshot().evidence.find(e => e.field === 'status')?.kind, 'OBSERVED');
  assert.equal(parent.toSnapshot().facts?.prompts, 1, 'a notification is not a human prompt');
});

test('claude: queued task-notification ends a background worker once; sync results still end at once', () => {
  const h = claudeHome();
  fs.writeFileSync(h.main, jl([
    user(0, 'go'),
    agentUse(1, 'tu-a'), agentResult(2, 'tu-a', { status: 'async_launched', agentId: 'a1' }),
    agentUse(3, 'tu-s'), agentResult(4, 'tu-s', { status: 'completed', agentId: 's1' }),
    { type: 'queue-operation', operation: 'enqueue', timestamp: iso(5), sessionId: SID, content: notification('tu-a', 'killed') },
    user(6, notification('tu-a', 'killed')),
    { type: 'queue-operation', operation: 'dequeue', timestamp: iso(6), sessionId: SID },
  ]));
  fs.writeFileSync(h.sub('a1'), jl([user(1, 'x')]));
  fs.writeFileSync(h.sub('s1'), jl([user(3, 'y')]));
  const a = new ClaudeAdapter(h.root);
  const parent = ingest(a, h.main);
  const wa = ingest(a, h.sub('a1')), ws = ingest(a, h.sub('s1'));
  a.refreshLive([parent, wa, ws], Date.parse(iso(7)));
  assert.equal(wa.live.explicitEnded, true);
  assert.equal(ws.live.explicitEnded, true);
  const ends = parent.timeline().filter(e => e.type === 'WORKER_ENDED').map(e => e.label);
  assert.deepEqual(ends, ['debug · fake task — completed', 'debug · fake task — killed'], 'one end per worker');
  assert.deepEqual(parent.toSnapshot().facts?.queueOps, { enqueue: 1, dequeue: 1 });
});

test('claude: a worker whose own transcript ends on a final reply is no longer an open turn (INFERRED, not ENDED)', () => {
  const h = claudeHome();
  fs.writeFileSync(h.main, jl([user(0, 'go')]));
  fs.writeFileSync(h.sub('f1'), jl([user(1, 'x'), asst(2, 'm-f1', [{ type: 'text', text: 'done' }], { stop_reason: 'end_turn' })]));
  const a = new ClaudeAdapter(h.root);
  const w = ingest(a, h.sub('f1'));
  a.refreshLive([w], Date.parse(iso(3)));
  assert.equal(w.live.explicitEnded, false);
  assert.equal(w.live.openTurn, false);
  assert.equal(w.toSnapshot().evidence.find(e => e.field === 'status')?.kind, 'INFERRED');
  // Resumed (e.g. a message sent to it): open again, the INFERRED basis is dropped.
  fs.appendFileSync(h.sub('f1'), jl([user(4, 'more')]));
  ingest(a, h.sub('f1'));
  a.refreshLive([w], Date.parse(iso(5)));
  assert.equal(w.live.openTurn, true);
  assert.equal(w.toSnapshot().evidence.find(e => e.field === 'status'), undefined);
});

test('claude: usage totals are DERIVED; cache creation (5m / 1h) and new input are kept apart; repeated id counted once', () => {
  const h = claudeHome();
  const usage = (i: number, cr: number, cc: number, o: number, split?: object) => ({ input_tokens: i, cache_read_input_tokens: cr, cache_creation_input_tokens: cc, output_tokens: o, ...(split ? { cache_creation: split } : {}) });
  fs.writeFileSync(h.main, jl([
    user(0, 'go'),
    asst(1, 'm1', [{ type: 'text', text: 'a' }], { usage: usage(10, 100, 50, 5, { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 30 }) }),
    asst(1, 'm1', [{ type: 'text', text: 'a' }], { usage: usage(10, 100, 50, 7, { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 30 }) }),
    asst(2, 'm2', [{ type: 'text', text: 'b' }], { usage: usage(3, 160, 0, 4) }),
  ]));
  const a = new ClaudeAdapter(h.root);
  const s = ingest(a, h.main).toSnapshot();
  assert.deepEqual(s.usage, { totalTokens: 10 + 100 + 50 + 7 + 3 + 160 + 4, outputTokens: 11, cachedInputTokens: 260, inputTokens: 13, cacheCreationInputTokens: 50, cacheCreation5mTokens: 20, cacheCreation1hTokens: 30, contextTokens: 163 });
  assert.equal(s.evidence.find(e => e.field === 'usage')?.kind, 'DERIVED');
  assert.equal(s.evidence.find(e => e.field === 'usage.fields')?.kind, 'OBSERVED');
});

test('claude: test runs are INFERRED (command regex), outcome from is_error; interrupted / backgrounded → UNKNOWN', () => {
  const h = claudeHome();
  const bash = (m: number, id: string) => asst(m, `m-${id}`, [{ type: 'tool_use', id, name: 'Bash', input: { command: 'npm test' } }]);
  const res = (m: number, id: string, isError: boolean, r: object) => user(m, [{ type: 'tool_result', tool_use_id: id, content: 'out', is_error: isError }], { toolUseResult: { stdout: '', stderr: '', isImage: false, noOutputExpected: false, interrupted: false, ...r } });
  fs.writeFileSync(h.main, jl([
    user(0, 'go'),
    bash(1, 't1'), res(2, 't1', false, {}),
    bash(3, 't2'), res(4, 't2', true, {}),
    bash(5, 't3'), res(6, 't3', true, { interrupted: true }),
    bash(7, 't4'), res(8, 't4', false, { backgroundTaskId: 'bgx' }),
  ]));
  const a = new ClaudeAdapter(h.root);
  const acc = ingest(a, h.main);
  const s = acc.toSnapshot();
  assert.deepEqual(s.tests.map(t => t.outcome), ['PASS', 'FAIL', 'UNKNOWN', 'UNKNOWN']);
  assert.ok(s.tests.every(t => t.source === 'provider-tool-error-flag' && t.exitCode === undefined));
  const ev = acc.timeline().filter(e => e.type === 'TEST');
  assert.equal(ev.length, 4);
  assert.ok(ev.every(e => e.kind === 'INFERRED'), 'TEST events are INFERRED without a recorded exit code');
  assert.equal(s.evidence.find(e => e.field === 'tests')?.kind, 'INFERRED');
});

test('claude: permission mode changes, mode records, pr-link and compact_boundary are kept as bounded OBSERVED facts', () => {
  const h = claudeHome();
  const prs = Array.from({ length: 25 }, (_, i) => ({ type: 'pr-link', sessionId: SID, timestamp: iso(20 + i), prNumber: i + 1, prUrl: `https://example.invalid/r/pull/${i + 1}`, prRepository: 'fake/r' }));
  fs.writeFileSync(h.main, jl([
    user(0, 'go', { permissionMode: 'default' }),
    user(1, 'plan it', { permissionMode: 'plan' }),
    { type: 'mode', mode: 'normal', sessionId: SID },
    user(2, 'do it', { permissionMode: 'plan' }),
    { type: 'pr-link', sessionId: SID, timestamp: iso(3), prNumber: 7, prUrl: 'https://example.invalid/r/pull/7', prRepository: 'fake/r' },
    { type: 'pr-link', sessionId: SID, timestamp: iso(4), prNumber: 7, prUrl: 'https://example.invalid/r/pull/7', prRepository: 'fake/r' },
    { type: 'pr-link', sessionId: SID, timestamp: iso(4), prNumber: 8, prUrl: 'javascript:alert(1)' },
    { type: 'system', subtype: 'compact_boundary', uuid: 'c1', timestamp: iso(5), compactMetadata: { trigger: 'auto', preTokens: 390000, postTokens: 48000, durationMs: 9000, preservedSegment: { headUuid: 'h' } } },
    ...prs,
  ]));
  const a = new ClaudeAdapter(h.root);
  const acc = ingest(a, h.main);
  const f = acc.toSnapshot().facts!;
  assert.equal(f.permissionMode, 'plan');
  assert.deepEqual(f.modeChanges?.map(m => [m.field, m.value]), [['permissionMode', 'default'], ['permissionMode', 'plan'], ['sessionMode', 'normal']]);
  assert.equal(f.modeChanges?.[2].at, Date.parse(iso(1)), 'untimed mode record dated by the previous record');
  assert.equal(f.sessionMode, 'normal');
  assert.ok(acc.timeline().some(e => e.label === 'permission mode → plan' && e.kind === 'OBSERVED'));
  assert.equal(f.prLinks?.length, 20, 'bounded');
  assert.deepEqual(f.prLinks?.[f.prLinks.length - 1], { at: Date.parse(iso(44)), url: 'https://example.invalid/r/pull/25', number: 25, repository: 'fake/r' });
  assert.ok(!f.prLinks?.some(p => p.url.startsWith('javascript')), 'non-http url rejected');
  assert.equal(f.compactions, 1);
  assert.deepEqual(f.compacts, [{ at: Date.parse(iso(5)), trigger: 'auto', preTokens: 390000, postTokens: 48000, durationMs: 9000 }]);
  assert.ok(acc.timeline().some(e => e.label === 'context compacted (390000 → 48000 tokens)'));
});

// ---------------- Codex ----------------

const CID = 'bbbbbbbb-2222-7222-8222-222222222222';
function codexRollout(recs: object[]) {
  const root = tmpDir('codex-adapt');
  const dir = path.join(root, 'sessions', '2026', '10', '05');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `rollout-2026-10-05T10-00-00-${CID}.jsonl`);
  fs.writeFileSync(p, jl([{ timestamp: iso(0), type: 'session_meta', payload: { id: CID, cwd: 'D:\\fake', cli_version: '0.9.0' } }, ...recs]));
  const a = new CodexAdapter(root);
  return { a, acc: ingest(a, p) };
}
const ev = (m: number, payload: object) => ({ timestamp: iso(m), type: 'event_msg', payload });
const item = (m: number, it: object) => ev(m, { type: 'item_completed', item: it });

test('codex: cache writes and reasoning tokens kept; call rhythm INFERRED', () => {
  const tot = (n: number) => ({ input_tokens: 100 * n, cached_input_tokens: 60 * n, cache_write_input_tokens: 10 * n, output_tokens: 20 * n, reasoning_output_tokens: 5 * n, total_tokens: 120 * n });
  const { acc } = codexRollout([
    ev(1, { type: 'token_count', info: { total_token_usage: tot(1), last_token_usage: tot(1), model_context_window: 1000 } }),
    ev(2, { type: 'token_count', info: { total_token_usage: tot(2), last_token_usage: tot(1), model_context_window: 1000 } }),
  ]);
  const s = acc.toSnapshot();
  assert.deepEqual(s.usage, { totalTokens: 240, outputTokens: 40, cachedInputTokens: 120, cacheCreationInputTokens: 20, reasoningOutputTokens: 10, contextTokens: 100, contextWindow: 1000 });
  assert.equal(s.evidence.find(e => e.field === 'usage')?.kind, 'OBSERVED');
  assert.equal(s.evidence.find(e => e.field === 'facts.calls')?.kind, 'INFERRED');
});

test('codex: approval policy, permission profile and collaboration (plan) mode are distinct facts', () => {
  const { acc } = codexRollout([
    { timestamp: iso(1), type: 'turn_context', payload: { model: 'gpt-fake', approval_policy: 'on-request', sandbox_policy: { type: 'workspace-write' }, active_permission_profile: { id: 'workspace' }, collaboration_mode: { mode: 'default', settings: {} } } },
    ev(2, { type: 'task_started', turn_id: 't2', collaboration_mode_kind: 'plan' }),
    ev(3, { type: 'task_complete', turn_id: 't2' }),
  ]);
  const f = acc.toSnapshot().facts!;
  assert.equal(f.approvalPolicy, 'on-request');
  assert.equal(f.permissionMode, 'on-request', 'legacy alias kept for existing screens');
  assert.equal(f.sandbox, 'workspace-write');
  assert.equal(f.permissionProfile, 'workspace');
  assert.equal(f.collaborationMode, 'plan');
  assert.deepEqual(f.modeChanges?.filter(m => m.field === 'collaborationMode').map(m => m.value), ['default', 'plan']);
  assert.equal(acc.toSnapshot().evidence.find(e => e.field === 'facts.approvalPolicy')?.kind, 'OBSERVED');
});

test('codex: one subagent spawn recorded by three record kinds gives one WORKER_STARTED and one spawn', () => {
  const T1 = '01a01494-0000-7000-8000-000000000001', T2 = '01a01494-0000-7000-8000-000000000002';
  const { acc } = codexRollout([
    { timestamp: iso(1), type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', call_id: 'call_A', arguments: JSON.stringify({ task_name: '/root/fake', message: 'x' }) } },
    item(1, { type: 'SubAgentActivity', id: 'call_A', kind: 'started', agent_thread_id: T1, agent_path: '/root/fake' }),
    item(1, { type: 'CollabAgentToolCall', id: 'collab-1', tool: 'spawn_agent', status: 'completed', sender_thread_id: CID, receiver_thread_ids: [T1] }),
    { timestamp: iso(1), type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_A', output: '{"task_name":"/root/fake"}' } },
    // A spawn seen only through SubAgentActivity still counts once.
    item(2, { type: 'SubAgentActivity', id: 'call_B', kind: 'started', agent_thread_id: T2, agent_path: '/root/other' }),
    item(4, { type: 'SubAgentActivity', id: 'e1', kind: 'completed', agent_thread_id: T1 }),
    item(5, { type: 'SubAgentActivity', id: 'e2', kind: 'completed', agent_thread_id: T1 }),
  ]);
  const tl = acc.timeline();
  assert.equal(tl.filter(e => e.type === 'WORKER_STARTED').length, 2);
  assert.equal(tl.filter(e => e.type === 'WORKER_ENDED').length, 1, 'repeated completion of one thread counted once');
  assert.deepEqual(acc.toSnapshot().facts?.spawns?.map(s => s.description), ['/root/fake', '/root/other']);
});

test('codex: test events are OBSERVED only with a recorded exit code; compacted window kept', () => {
  const { acc } = codexRollout([
    item(1, { type: 'CommandExecution', id: 'c1', command: 'npm test', exit_code: 1, status: 'completed' }),
    item(2, { type: 'CommandExecution', id: 'c2', command: 'npm test', status: 'failed' }),
    item(3, { type: 'CommandExecution', id: 'c3', command: 'npm test', status: 'completed' }),
    { timestamp: iso(4), type: 'compacted', payload: { window_number: 3, previous_window_id: 'w2' } },
    item(4, { type: 'ContextCompaction', id: 'cc1' }),
  ]);
  const s = acc.toSnapshot();
  assert.deepEqual(s.tests.map(t => [t.outcome, t.source]), [['FAIL', 'provider-exit-code'], ['FAIL', 'provider-tool-error-flag'], ['UNKNOWN', 'provider-tool-error-flag']]);
  assert.deepEqual(acc.timeline().filter(e => e.type === 'TEST').map(e => e.kind), ['OBSERVED', 'INFERRED', 'INFERRED']);
  assert.equal(s.facts?.compactions, 1, 'two records of one compaction count once');
  assert.deepEqual(s.facts?.compacts, [{ at: Date.parse(iso(4)), window: 3 }]);
  assert.equal(s.evidence.find(e => e.field === 'facts.compactions')?.kind, 'DERIVED');
});
