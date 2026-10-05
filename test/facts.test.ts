import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { ClaudeAdapter } from '../src/providers/claude/claude';
import { CodexAdapter } from '../src/providers/codex/codex';
import { SessionAccumulator } from '../src/sessions/accumulator';
import { ProviderAdapter } from '../src/providers/types';
import { FIXTURES, jpath, materialize, T, tmpDir } from './helpers';

function load(provider: 'claude' | 'codex') {
  const home = tmpDir(`facts-${provider}`);
  const cwd = path.join(home, 'repo');
  fs.mkdirSync(cwd, { recursive: true });
  materialize(path.join(FIXTURES, 'facts', provider), path.join(home, provider), { __CWD__: jpath(cwd) });
  const a: ProviderAdapter = provider === 'claude' ? new ClaudeAdapter(path.join(home, provider)) : new CodexAdapter(path.join(home, provider));
  const accs: SessionAccumulator[] = [];
  for (const ref of a.listArtifacts(0, 50)) {
    const acc = a.ingest(ref);
    if (acc) accs.push(acc);
  }
  assert.equal(accs.length, 1);
  return { acc: accs[0], cwd, adapter: a, home };
}

const MIN = 60_000;

test('facts: claude tools, current tool, prompts, files, per-model tokens, spawns, modes, waits', () => {
  const { acc } = load('claude');
  const s = acc.toSnapshot();
  const f = s.facts!;
  assert.ok(f, 'facts present');
  assert.deepEqual(f.toolCounts, { Bash: 2, Edit: 2, Agent: 1, mcp__github__search_code: 1, WebFetch: 1 });
  assert.equal(f.toolErrors, 1, 'tool_result is_error');
  assert.equal(f.currentTool?.name, 'Bash', 'last tool_use without result');
  assert.ok(f.currentTool?.detail.includes('npm run build'));
  assert.equal(f.currentTool?.startedAt, T('2026-10-05T10:20:30Z'));
  assert.equal(f.prompts, 2, 'meta and <command> records are not prompts; tool results are not prompts');
  assert.equal(f.replies, 2, 'one per assistant message id with text');
  assert.deepEqual(f.files?.map(x => [x.path, x.edits]), [['src/a.ts', 2]]);
  assert.deepEqual(f.modelTokens, { 'claude-opus-5-5': 1050 + 2010, 'claude-sonnet-5-5': 15 }, 'repeated message id replaces its earlier usage');
  assert.deepEqual(f.calls, [[T('2026-10-05T10:00:10Z'), 1000, 50], [T('2026-10-05T10:01:00Z'), 10, 5], [T('2026-10-05T10:20:30Z'), 2000, 10]]);
  assert.deepEqual(f.spawns, [{ at: T('2026-10-05T10:03:00Z'), type: 'Explore', description: 'Scan repo' }]);
  assert.equal(f.web, 1);
  assert.deepEqual(f.mcp, { github: 1 });
  assert.equal(f.compactions, 1);
  assert.equal(f.permissionMode, 'plan', 'latest recorded mode');
  assert.equal(f.entrypoint, 'claude-vscode');
  assert.equal(f.recordedBranch, 'feat/facts');
  assert.equal(f.waitMaxMs, 15 * MIN, 'agent done 10:05 → next prompt 10:20');
  assert.equal(f.waitTotalMs, 15 * MIN);
  assert.equal(f.activeMs, 6 * MIN + 30_000, 'gaps ≥ 5 min are not active');
  assert.equal(s.providerVersion, '2.1.290');
  assert.equal(s.evidence.find(e => e.field === 'facts.activeMs')?.kind, 'DERIVED');
  assert.ok(!JSON.stringify(s).includes('abc123secretvalue'), 'command secrets redacted');
  assert.strictEqual(acc.toSnapshot().facts, f, 'facts object cached while nothing changes');
});

test('facts: codex calls, current tool, modes, token deltas, spawns, web / mcp / compaction dedupe, waits', () => {
  const { acc } = load('codex');
  const s = acc.toSnapshot();
  const f = s.facts!;
  assert.deepEqual(f.toolCounts, { exec_command: 2, apply_patch: 1, spawn_agent: 1, web_search: 1 });
  assert.equal(f.toolErrors, 1, 'failed command execution');
  assert.equal(f.currentTool?.name, 'exec_command');
  assert.ok(f.currentTool?.detail.includes('cargo build'));
  assert.equal(f.prompts, 2, 'injected <environment_context> is not a prompt');
  assert.equal(f.replies, 1);
  assert.deepEqual(f.calls, [[T('2026-10-05T10:00:21Z'), 900, 100], [T('2026-10-05T10:00:40Z'), 550, 50]], 'repeated token_count adds no call');
  assert.deepEqual(f.modelTokens, { 'gpt-6.1-sol': 1600 });
  assert.equal(s.usage?.totalTokens, 1600);
  assert.deepEqual(f.spawns, [{ at: T('2026-10-05T10:01:00Z'), type: 'explorer', description: 'audit' }]);
  assert.equal(f.web, 1, 'web_search_call and WebSearch item describe one search');
  assert.equal(f.compactions, 1, 'compacted record and ContextCompaction item describe one compaction');
  assert.deepEqual(f.mcp, { node_repl: 1 });
  assert.equal(f.permissionMode, 'on-request');
  assert.equal(f.sandbox, 'workspace-write');
  assert.equal(f.entrypoint, 'codex_cli_rs');
  assert.equal(f.recordedBranch, 'feat/cx');
  assert.deepEqual(f.files?.map(x => [x.path, x.edits]), [['src/b.ts', 1]]);
  assert.equal(f.waitMaxMs, 7 * MIN, 'task_complete 10:05 → task_started 10:12');
  assert.equal(f.activeMs, 5 * MIN + 10_000);
});

test('facts: turn completion clears the current tool; incremental append updates facts', () => {
  const { acc, adapter, home } = load('codex');
  const file = fs.readdirSync(path.join(home, 'codex', 'sessions', '2026', '10', '05'))[0];
  const p = path.join(home, 'codex', 'sessions', '2026', '10', '05', file);
  fs.appendFileSync(p, JSON.stringify({ timestamp: '2026-10-05T10:13:00.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 't2' } }) + '\n');
  const st = fs.statSync(p);
  adapter.ingest({ path: p, mtimeMs: st.mtimeMs, size: st.size });
  const f = acc.toSnapshot().facts!;
  assert.equal(f.currentTool, undefined);
  assert.equal(f.toolCounts?.exec_command, 2, 'no double count on re-read');
});

test('facts: sessions without tool data keep facts small and never invent values', () => {
  const acc = new SessionAccumulator('claude', 'x', '/nowhere.jsonl');
  assert.equal(acc.toSnapshot().facts, undefined, 'no records → no facts');
  acc.touch(T('2026-10-05T10:00:00Z'));
  const f = acc.toSnapshot().facts!;
  assert.deepEqual(Object.keys(f), ['activeMs']);
  assert.equal(f.activeMs, 0);
});

test('facts: bounded call history and file list', () => {
  const acc = new SessionAccumulator('codex', 'y', '/nowhere.jsonl');
  for (let i = 0; i < 3000; i++) acc.modelCall(undefined, i * 1000, 10, 1, 'm');
  for (let i = 0; i < 400; i++) acc.editedFile(`/r/f${i}.ts`, i);
  const f = acc.toSnapshot().facts!;
  assert.equal(f.calls!.length, 2000);
  assert.equal(f.calls![1999][0], 2999 * 1000, 'newest calls kept');
  assert.equal(f.files!.length, 300);
  assert.equal(f.modelTokens!.m, 3000 * 11);
});
