// Provider facts on screens (audit A4 follow-up): approval policy / collaboration mode / permission mode with evidence
// chips on HUD, Live, Transcript and Settings; compactions, cache writes and reasoning tokens on Context cost and Health;
// HUD feed loading / error states through kit.loading() / kit.loadError().
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import { AgentSessionSnapshot } from '../src/model';
// Load the workspace first: it owns the screen registry (extra/index imports every screen).
import '../src/render/workspace';
import type { WsData } from '../src/render/workspace';
import { clearFeeds, Feed, pump, setFeedValue } from '../src/render/extra/feeds';
import { liveView, modeFacts, modeHtml } from '../src/render/extra/live';
import { hudView } from '../src/render/extra/hud';
import { transcriptView } from '../src/render/extra/transcript';
import { ctxcostView, tokenFacts } from '../src/render/extra/ctxcost';
import { healthView } from '../src/render/extra/health';
import { clearTranscriptCache } from '../src/providers/transcript';
import { FIXTURES, T } from './helpers';

const NOW = T('2026-10-05T12:00:00Z');
const M = 60_000;

function mk(p: Partial<AgentSessionSnapshot> & { key: string }): AgentSessionSnapshot {
  const [provider, sessionId] = p.key.split(':') as ['claude' | 'codex', string];
  return { provider, sessionId, status: 'RUNNING', statusReason: 'test', commits: [], changedFiles: [], tests: [], isWorker: false, counts: { tools: 0, commands: 0, fileEdits: 0, turns: 0 }, evidence: [], artifactPath: '', diagnostics: [], startedAt: NOW - 60 * M, lastActivityAt: NOW - M, ...p };
}

const data = (sessions: AgentSessionSnapshot[], config: Record<string, unknown> = {}): WsData => ({
  sessions, providers: [], events: [], now: NOW, ternAvailable: false,
  config: <T>(k: string, f: T) => (k in config ? (config[k] as T) : f),
});

const CODEX = mk({
  key: 'codex:cx-1', title: 'codex <b>', repository: 'D:\\r\\cx',
  facts: { approvalPolicy: 'never', permissionMode: 'never', collaborationMode: 'plan', sandbox: 'workspace-write' },
  evidence: [
    { field: 'facts.approvalPolicy', kind: 'OBSERVED', source: 'turn_context.approval_policy (approval policy, not a permission mode)' },
    { field: 'facts.collaborationMode', kind: 'OBSERVED', source: 'turn_context.collaboration_mode.mode (plan = Codex plan mode)' },
  ],
});
const LEGACY = mk({ key: 'codex:cx-old', title: 'old codex', facts: { permissionMode: 'on-request' } });
const CLAUDE = mk({ key: 'claude:cl-1', title: 'claude one', repository: 'D:\\r\\cl', facts: { permissionMode: 'acceptEdits' } });
const BARE = mk({ key: 'claude:cl-bare', title: 'bare' });

test('modeFacts: Codex approval policy + collaboration mode, legacy alias, Claude permission mode', () => {
  assert.deepEqual(modeFacts(CODEX).map(f => [f.field, f.value, f.kind]), [['approvalPolicy', 'never', 'OBSERVED'], ['collaborationMode', 'plan', 'OBSERVED'], ['sandbox', 'workspace-write', 'OBSERVED']]);
  assert.match(modeFacts(CODEX)[0].basis, /approval policy, not a permission mode/, 'basis from the session evidence');
  assert.deepEqual(modeFacts(LEGACY).map(f => [f.label, f.value]), [['approval', 'on-request']], 'legacy permissionMode alias reads as approval');
  assert.deepEqual(modeFacts(CLAUDE).map(f => [f.label, f.value]), [['permission', 'acceptEdits']]);
  assert.deepEqual(modeFacts(BARE), []);
  const inf = mk({ key: 'claude:x', facts: { permissionMode: 'plan' }, evidence: [{ field: 'facts.permissionMode', kind: 'INFERRED', source: 'guess' }] });
  assert.ok(modeHtml(inf).includes('chip ev INFERRED'), 'weakest evidence kind on the chip');
  assert.equal(modeHtml(BARE), '');
});

test('live: mode column shows approval / collaboration / permission with an evidence chip', () => {
  const h = liveView.render(data([CODEX, CLAUDE]), { view: 'live' });
  assert.ok(h.includes('approval never · collaboration plan · sandbox workspace-write'), 'codex facts');
  assert.ok(h.includes('permission acceptEdits'), 'claude permission mode');
  assert.ok(h.includes('chip ev OBSERVED'));
  const cards = liveView.render(data([CODEX]), { view: 'live', opts: { 'live.layout': 'cards' } });
  assert.ok(cards.includes('collaboration plan') && cards.includes('chip ev OBSERVED'), 'cards layout too');
});

test('hud: Codex approval + collaboration (plan ON) and Claude permission mode with evidence', () => {
  clearFeeds();
  const h = hudView.render(data([CODEX, CLAUDE, LEGACY]), { view: 'hud' });
  assert.ok(h.includes('approval never'));
  assert.ok(h.includes('collaboration plan'));
  assert.ok(h.includes('plan [ON]'), 'Codex plan mode from the collaboration mode');
  assert.ok(h.includes('hud-ev-observed'));
  assert.ok(h.includes('acceptEdits'));
  assert.ok(!h.includes('codex <b>'), 'escaped');
});

test('hud: lessons and CI feeds use kit.loading() then kit.loadError()', async () => {
  clearFeeds();
  const d = data([CLAUDE], { 'agent.pipelines.enabled': true });
  const h = hudView.render(d, { view: 'hud' });
  assert.ok(h.includes(`data-loading="hud.lessons.${CLAUDE.key}"`), 'lessons loading marker');
  assert.ok(h.includes(`data-loading="hud.ci.${CLAUDE.key}"`), 'CI loading marker');
  assert.ok(h.includes('data-act="refresh"'), 'retry calls the screen refresh action');
  assert.equal(typeof hudView.actions?.refresh, 'function');
  const fail = (id: string): Feed => ({ id, intervalMs: 0, load: async () => { throw new Error('boom <x>'); } });
  await new Promise<void>(res => {
    let n = 0;
    pump([fail('hud.lessons'), fail('pipelines')], { sessions: [], trusted: true, config: <T>(_k: string, f: T) => f, now: Date.now() }, () => { if (++n === 2) res(); });
  });
  const e = hudView.render(d, { view: 'hud' });
  assert.ok(e.includes('ld-err'), 'error state');
  assert.ok(e.includes('lessons not read: boom &lt;x&gt;'), 'escaped error');
  setFeedValue('hud.lessons', { [CLAUDE.repository!]: { file: 'handoff/MEMORY.md', rules: 3 } });
  assert.ok(!hudView.render(d, { view: 'hud' }).includes('data-loading="hud.lessons.'), 'loaded value replaces the marker');
  clearFeeds();
});

test('transcript header: provider mode facts with an evidence chip', () => {
  clearTranscriptCache();
  const file = path.join(FIXTURES, 'facts', 'claude', 'projects', 'D--facts-repo', '55555555-5555-4555-8555-555555555555.jsonl');
  const s = mk({ key: 'claude:55555555-5555-4555-8555-555555555555', artifactPath: file, title: 'tx', facts: { permissionMode: 'plan' } });
  const h = transcriptView.render(data([s]), { view: 'transcript', selected: s.key });
  assert.ok(h.includes('tx-mode'));
  assert.ok(h.includes('permission plan'));
  assert.ok(h.includes('chip ev OBSERVED'));
});

test('tokenFacts: compactions, cache read / write, reasoning with evidence kinds; UNKNOWN when not recorded', () => {
  const a = mk({
    key: 'codex:t-a', usage: { totalTokens: 10_000, outputTokens: 2000, cachedInputTokens: 4000, cacheCreationInputTokens: 1500, reasoningOutputTokens: 700 },
    evidence: [{ field: 'usage', kind: 'OBSERVED', source: 'event_msg token_count (cumulative)' }],
    facts: { compactions: 2, compacts: [{ at: NOW - 30 * M, window: 1 }, { at: NOW - 10 * M, window: 2 }] },
  });
  const b = mk({ key: 'claude:t-b', usage: { totalTokens: 5000, outputTokens: 100, cachedInputTokens: 3000 }, facts: { compacts: [{ at: NOW - 5 * M, trigger: 'auto', preTokens: 180_000, postTokens: 20_000 }] } });
  const f = tokenFacts([a, b]);
  assert.equal(f.compacts.value, 3);
  assert.equal(f.lastCompact?.trigger, 'auto');
  assert.equal(f.lastCompactKind, 'OBSERVED');
  assert.deepEqual([f.cacheRead.value, f.cacheRead.kind], [7000, 'DERIVED'], 'claude session without usage.fields evidence → DERIVED');
  assert.deepEqual([f.cacheWrite.value, f.cacheWrite.sessions, f.cacheWrite.kind], [1500, 1, 'OBSERVED']);
  assert.deepEqual([f.reasoning.value, f.reasoning.kind], [700, 'OBSERVED']);
  assert.equal(tokenFacts([a]).cacheRead.kind, 'OBSERVED');
  const none = tokenFacts([BARE]);
  assert.deepEqual([none.cacheWrite.value, none.cacheWrite.kind, none.reasoning.kind, none.compacts.kind, none.lastCompactKind], [undefined, 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN']);
});

test('ctxcost and health: provider token facts strip with evidence chips', () => {
  clearFeeds();
  const s = mk({
    key: 'codex:h-1', title: 'h', usage: { totalTokens: 10_000, outputTokens: 2000, cachedInputTokens: 4000, cacheCreationInputTokens: 1500, reasoningOutputTokens: 700, contextTokens: 9000 },
    evidence: [{ field: 'usage', kind: 'OBSERVED', source: 'x' }],
    facts: { compactions: 1, compacts: [{ at: NOW - 10 * M, trigger: 'manual', preTokens: 150_000, postTokens: 12_000 }] },
  });
  for (const [name, h] of [['ctxcost', ctxcostView.render(data([s, BARE]), { view: 'ctxcost' })], ['health', healthView.render(data([s, BARE]), { view: 'health' })]] as const) {
    assert.ok(h.includes('data-facts="tokens"'), name);
    assert.ok(h.includes('Cache write') && h.includes('1.5k'), `${name}: cache write`);
    assert.ok(h.includes('Reasoning out') && h.includes('700'), `${name}: reasoning`);
    assert.ok(h.includes('Last compact') && h.includes('10 min ago') && h.includes('manual'), `${name}: last compact time`);
    assert.ok(h.includes('chip ev OBSERVED'), `${name}: evidence`);
    assert.ok(h.includes('(1/2 sessions)'), `${name}: partial coverage shown`);
  }
  const empty = ctxcostView.render(data([BARE]), { view: 'ctxcost' });
  assert.ok(empty.includes('chip ev UNKNOWN'), 'unrecorded fields stay UNKNOWN');
});
