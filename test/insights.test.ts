import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { AgentSessionSnapshot, TimelineEvent } from '../src/model';
import { attention, flow, hourly, identityColor, outcome, PALETTE, stages, usageSince } from '../src/activity/insights';
import { ClaudeAdapter } from '../src/providers/claude/claude';
import { CodexAdapter } from '../src/providers/codex/codex';
import { SessionStore } from '../src/sessions/store';
import { validateMessage } from '../src/render/html';
import { renderWorkspace, teamRoot, WS_VIEWS, WsData } from '../src/render/workspace';
import { T, tmpDir } from './helpers';

const NOW = T('2026-10-04T12:00:00Z');

function mk(p: Partial<AgentSessionSnapshot> & { key: string }): AgentSessionSnapshot {
  const [provider, sessionId] = p.key.split(':') as ['claude' | 'codex', string];
  return { provider, sessionId, status: 'ENDED', statusReason: 'test', commits: [], changedFiles: [], tests: [], isWorker: false, counts: { tools: 0, commands: 0, fileEdits: 0, turns: 0 }, evidence: [], artifactPath: '', diagnostics: [], startedAt: NOW - 3600_000, lastActivityAt: NOW - 600_000, ...p };
}

test('usage: Claude counts each message id once (latest record wins) and keeps the recorded cost', async () => {
  const home = tmpDir('usage');
  const dir = path.join(home, 'projects', 'D--u');
  fs.mkdirSync(dir, { recursive: true });
  const sid = '66666666-6666-4666-8666-666666666666';
  const rec = (uuid: string, id: string, out: number, at: string) => JSON.stringify({ type: 'assistant', uuid, timestamp: at, sessionId: sid, message: { id, model: 'claude-opus-5-5', role: 'assistant', content: [], usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 90, output_tokens: out } } });
  const lines = [
    rec('a', 'msg_1', 5, '2026-10-04T11:00:00Z'),
    rec('b', 'msg_1', 40, '2026-10-04T11:00:01Z'), // same message, second content block: replaces, not adds
    rec('c', 'msg_2', 60, '2026-10-04T11:05:00Z'),
    JSON.stringify({ type: 'cost-state', sessionId: sid, totalCostUSD: 0.4321, totalLinesAdded: 3, totalLinesRemoved: 1 }),
  ];
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), lines.join('\n') + '\n');
  const store = new SessionStore([new ClaudeAdapter(home)], { historyDays: 30, maxSessions: 50, idleMinutes: 10, git: false }, () => NOW);
  await store.refresh();
  const u = store.get(`claude:${sid}`)!.usage!;
  assert.equal(u.totalTokens, 1100 + 40 + 1100 + 60);
  assert.equal(u.outputTokens, 100);
  assert.equal(u.cachedInputTokens, 2000);
  assert.equal(u.contextTokens, 1100, 'latest call prompt size');
  assert.equal(u.contextWindow, undefined, 'Claude does not record the window');
  assert.equal(u.costUSD, 0.4321);
  assert.equal(store.get(`claude:${sid}`)!.evidence.find(e => e.field === 'costUSD')?.kind, 'OBSERVED');
});

test('usage: Codex token_count is cumulative and exposes the context window', async () => {
  const home = tmpDir('cxusage');
  const dir = path.join(home, 'sessions', '2026', '10', '04');
  fs.mkdirSync(dir, { recursive: true });
  const id = '77777777-7777-7777-8777-777777777777';
  const tc = (at: string, total: number, last: number) => JSON.stringify({ timestamp: at, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: total - 10, cached_input_tokens: 5, output_tokens: 10, total_tokens: total }, last_token_usage: { input_tokens: last, output_tokens: 3 }, model_context_window: 200000 } } });
  const lines = [
    JSON.stringify({ timestamp: '2026-10-04T11:00:00Z', type: 'session_meta', payload: { id, cwd: 'C:\\nowhere', cli_version: '0.160.0' } }),
    tc('2026-10-04T11:01:00Z', 5000, 4000),
    tc('2026-10-04T11:02:00Z', 170000, 165000),
  ];
  fs.writeFileSync(path.join(dir, `rollout-2026-10-04T11-00-00-${id}.jsonl`), lines.join('\n') + '\n');
  const store = new SessionStore([new CodexAdapter(home)], { historyDays: 30, maxSessions: 50, idleMinutes: 10, git: false }, () => NOW);
  await store.refresh();
  const s = store.get(`codex:${id}`)!;
  assert.deepEqual(s.usage, { totalTokens: 170000, outputTokens: 10, cachedInputTokens: 5, contextTokens: 165000, contextWindow: 200000 });
  assert.equal(store.get(`codex:${id}`)!.usage?.costUSD, undefined, 'Codex records no cost; Agent never prices tokens');
});

test('attention: input, failing test, full context, stale turn, long idle, ended-with-edits; never for clean ends', () => {
  const sessions = [
    mk({ key: 'claude:need', status: 'NEEDS_INPUT', statusReason: 'registry: waiting' }),
    mk({ key: 'codex:fail', status: 'RUNNING', tests: [{ command: 'npm test', at: NOW - 60_000, outcome: 'FAIL', exitCode: 1, source: 'provider-exit-code' }] }),
    mk({ key: 'codex:ctx', status: 'RUNNING', usage: { totalTokens: 1, outputTokens: 0, cachedInputTokens: 0, contextTokens: 180_000, contextWindow: 200_000 } }),
    mk({ key: 'codex:stale', status: 'UNKNOWN' }),
    mk({ key: 'claude:idle', status: 'IDLE', lastActivityAt: NOW - 45 * 60_000 }),
    mk({ key: 'claude:edits', status: 'ENDED', changedFiles: ['a.ts'] }),
    mk({ key: 'claude:clean', status: 'ENDED', changedFiles: ['a.ts'], commits: [{ sha: 'abc', at: NOW - 1000, subject: 's', attribution: 'during-session' }] }),
    mk({ key: 'claude:nothing', status: 'ENDED' }),
  ];
  const items = attention(sessions, NOW);
  const keys = items.map(i => i.key);
  assert.deepEqual(items.slice(0, 2).map(i => i.severity), ['high', 'high']);
  for (const k of ['claude:need', 'codex:fail', 'codex:ctx', 'codex:stale', 'claude:idle', 'claude:edits']) assert.ok(keys.includes(k), k);
  assert.ok(!keys.includes('claude:clean') && !keys.includes('claude:nothing'));
  assert.ok(items.every(i => i.basis.length > 0), 'every item states its basis');
  assert.ok(!items.some(i => /fail/i.test(i.reason) && i.key === 'claude:edits'), 'no commit is not a failure');
  assert.equal(attention(sessions, NOW, { idleAlertMinutes: 60 }).some(i => i.key === 'claude:idle'), false);
});

test('stages, outcome and flow are factual', () => {
  const s = mk({ key: 'claude:s', changedFiles: ['x'], tests: [{ command: 'npm test', at: NOW, outcome: 'FAIL', source: 'provider-tool-error-flag' }] });
  assert.deepEqual(stages(s).map(g => g.state), ['done', 'done', 'fail', 'none', 'done']);
  assert.equal(outcome(s), 'changed');
  assert.equal(outcome(mk({ key: 'claude:l', status: 'RUNNING' })), 'live');
  const f = flow([s, mk({ key: 'codex:a', cwd: 'D:\\r\\alpha', commits: [{ sha: '1', at: NOW, subject: '', attribution: 'during-session' }] }), mk({ key: 'codex:w', isWorker: true })]);
  assert.deepEqual(f.providers, ['claude', 'codex']);
  const total = (stage: number) => f.links.filter(l => l.stage === stage).reduce((a, l) => a + l.value, 0);
  assert.equal(total(0), 2, 'workers excluded');
  assert.equal(total(1), 2);
});

test('hourly heatmap ignores turn/tool chatter; identity colors are stable', () => {
  const ev = (at: number, type: TimelineEvent['type']): TimelineEvent => ({ at, type, label: '', provider: 'claude', sessionKey: 'k', kind: 'OBSERVED' });
  const rows = hourly([ev(NOW - 1000, 'TEST'), ev(NOW - 1000, 'TOOL_ACTIVITY'), ev(NOW - 1000, 'SESSION_ACTIVITY'), ev(NOW - 30 * 86400_000, 'TEST')], NOW);
  assert.equal(rows.length, 7);
  assert.equal(rows.flatMap(r => r.counts).reduce((a, b) => a + b, 0), 1);
  assert.equal(identityColor('tern-vscode'), identityColor('tern-vscode'));
  assert.ok(PALETTE.includes(identityColor('x')));
  assert.equal(new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(identityColor)).size > 3, true);
  assert.equal(usageSince([mk({ key: 'claude:u', usage: { totalTokens: 10, outputTokens: 1, cachedInputTokens: 0, costUSD: 1.5 } }), mk({ key: 'codex:u', usage: { totalTokens: 5, outputTokens: 1, cachedInputTokens: 0 } })], NOW - 86400_000).costSessions, 1);
});

test('workspace: every view renders, escapes provider text, team root follows workers', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const lead = mk({ key: 'claude:lead', status: 'RUNNING', title: evil, branch: evil, cwd: 'D:\\r\\alpha' });
  const w1 = mk({ key: 'claude:lead/w1', isWorker: true, parentSessionId: 'claude:lead', workerLabel: 'coder · build it', status: 'RUNNING' });
  const w2 = mk({ key: 'claude:lead/w2', isWorker: true, parentSessionId: 'claude:lead', workerLabel: 'tester · run', tests: [{ command: evil, at: NOW, outcome: 'PASS', source: 'provider-tool-error-flag' }] });
  const d: WsData = { sessions: [lead, w1, w2, mk({ key: 'codex:x', status: 'NEEDS_INPUT' })], providers: [{ provider: 'claude', detected: true, version: '2.1.289', note: '', artifactsScanned: 3, diagnostics: [] }], events: [], now: NOW, ternAvailable: false };
  for (const view of WS_VIEWS) {
    const h = renderWorkspace(d, { view, selected: 'claude:lead/w1' });
    assert.ok(!h.includes('<img'), `${view}: escaped`);
    assert.ok(!/<script/i.test(h), `${view}: no script`);
    assert.ok(h.includes(`data-nav="${view}"`));
  }
  assert.equal(teamRoot(d, 'claude:lead/w1')?.key, 'claude:lead', 'worker selection resolves to its lead');
  const team = renderWorkspace(d, { view: 'team' });
  assert.ok(team.includes('coder') && team.includes('tester'), 'lanes from recorded worker roles');
});

test('sources view: collectors, storage and git off state', () => {
  const d: WsData = {
    sessions: [mk({ key: 'claude:big', artifactBytes: 5 * 1024 ** 2 }), mk({ key: 'codex:small', artifactBytes: 2048 })],
    providers: [{ provider: 'codex', detected: true, note: '', artifactsScanned: 1, diagnostics: [], sources: [{ id: 'codex.live', label: 'Codex live status', status: 'partial', detail: 'INFERRED', at: NOW }, { id: 'codex.archive', label: 'Codex archive', status: 'missing', detail: 'no archived_sessions/', at: NOW }] }],
    events: [], now: NOW, ternAvailable: false, git: { enabled: false },
  };
  const h = renderWorkspace(d, { view: 'providers' });
  for (const t of ['st-partial', 'st-missing', 'st-off', 'off in untrusted workspaces', '5.0 MB', '2 KB', 'never copies, compacts or deletes']) assert.ok(h.includes(t), t);
  assert.ok(h.includes('1 partial') && h.includes('1 missing'), 'rail collector summary');
});

test('messages: nav and select are validated against allow-lists', () => {
  const known = (k: string) => k === 'claude:a';
  assert.deepEqual(validateMessage({ type: 'nav', view: 'team', key: '' }, known), { type: 'nav', view: 'team', key: '' });
  assert.equal(validateMessage({ type: 'nav', view: 'evil', key: '' }, known), undefined);
  assert.deepEqual(validateMessage({ type: 'select', key: 'claude:a' }, known), { type: 'select', key: 'claude:a' });
  assert.equal(validateMessage({ type: 'select', key: 'claude:zzz' }, known), undefined);
  assert.deepEqual(validateMessage({ type: 'cmd', cmd: 'openWorkspace', key: '' }, known), { type: 'cmd', cmd: 'openWorkspace', key: '' });
});
