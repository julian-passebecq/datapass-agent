import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { AgentSessionSnapshot } from '../src/model';
import { EXTRA_NAV, page, validateMessage } from '../src/render/html';
import { card, commitCount, COMMIT_CAVEAT, endTime, inspectorJumps, resultCard, statusStrip, WsData } from '../src/render/workspace';
import { extraViews } from '../src/render/extra';
import { REGISTRY_GONE } from '../src/sessions/classify';
import { ClaudeAdapter } from '../src/providers/claude/claude';
import { CodexAdapter } from '../src/providers/codex/codex';
import { SessionStore } from '../src/sessions/store';
import { clearGitCache } from '../src/git/git';
import { makeRepo, tmpDir } from './helpers';

const NOW = Date.parse('2026-10-04T12:00:00Z');
const T = Date.parse('2026-10-04T11:00:00Z');

function snap(p: Partial<AgentSessionSnapshot>): AgentSessionSnapshot {
  return { key: 'claude:a', provider: 'claude', sessionId: 'a', status: 'ENDED', statusReason: 'r', commits: [], changedFiles: [], tests: [], isWorker: false, counts: { tools: 0, commands: 0, fileEdits: 0, turns: 0 }, evidence: [], artifactPath: 'x', diagnostics: [], startedAt: T - 600_000, lastActivityAt: T, ...p };
}

function data(sessions: AgentSessionSnapshot[], extra: Partial<WsData> = {}): WsData {
  return { sessions, providers: [], events: [], now: NOW, ternAvailable: false, ...extra };
}

test('inferred end: card and result card never show the last record as an observed end', () => {
  const inferred = snap({ statusReason: REGISTRY_GONE });
  const recorded = snap({ statusReason: 'provider marked the session ended', endedAt: T });
  assert.match(endTime(inferred), /^inactive /);
  assert.doesNotMatch(endTime(recorded), /inactive/);
  const c = card(inferred, data([inferred]));
  assert.match(c, /inactive \d\d:\d\d/);
  assert.match(c, /INFERRED: no end recorded/);
  assert.doesNotMatch(card(recorded, data([recorded])), /INFERRED: no end recorded/);
  assert.match(resultCard(inferred, NOW), /Duration \(to last record\)/);
  assert.doesNotMatch(resultCard(recorded, NOW), /to last record/);
});

test('commit counts carry the window caveat unless the session ran git commit itself', () => {
  const c = (attribution: 'during-session' | 'session-ran-git-commit', sha: string) => ({ sha, subject: 's', at: T, attribution });
  assert.equal(commitCount(snap({})), '0');
  const window = commitCount(snap({ commits: [c('during-session', 'a1'), c('session-ran-git-commit', 'b2')] }));
  assert.ok(window.includes('not proof') && window.includes('1 ran by session') && window.includes('<sup>*</sup>'));
  const own = commitCount(snap({ commits: [c('session-ran-git-commit', 'b2')] }));
  assert.ok(!own.includes('not proof') && !own.includes('<sup>'));
  assert.ok(resultCard(snap({ commits: [c('during-session', 'a1')] }), NOW).includes('in window, not proof'));
  assert.ok(COMMIT_CAVEAT.includes('Not proof'));
});

test('status strip shows git n/N only while a git pass runs', () => {
  const run = statusStrip(data([], { git: { enabled: true, progress: { done: 3, total: 12 } } }));
  assert.match(run, />git 3\/12</);
  assert.doesNotMatch(statusStrip(data([], { git: { enabled: true, progress: { done: 12, total: 12 } } })), /git \d+\/\d+/);
  assert.doesNotMatch(statusStrip(data([], { git: { enabled: true, progress: { done: 0, total: 0 } } })), /git \d+\/\d+/);
  assert.doesNotMatch(statusStrip(data([])), /git \d+\/\d+/);
});

test('inspector jump bar: Replay and HUD navigate to registered screens', () => {
  for (const v of extraViews()) EXTRA_NAV.add(v.id);
  const h = inspectorJumps('claude:a"><x');
  assert.ok(h.includes('data-nav="replay"') && h.includes('data-nav="hud"'));
  assert.ok(!h.includes('"><x'), 'key escaped');
  for (const view of ['replay', 'hud']) assert.deepEqual(validateMessage({ type: 'nav', view, key: '' }, () => true), { type: 'nav', view, key: '' });
});

test('Esc posts a validated clear-selection message', () => {
  assert.deepEqual(validateMessage({ type: 'clear', key: '' }, () => false), { type: 'clear', key: '' });
  assert.equal(validateMessage({ type: 'clear', key: 'claude:a' }, () => true), undefined, 'clear carries no key');
  const script = page('x', '', { filter: true });
  assert.ok(/Escape[\s\S]*type: 'clear'/.test(script), 'Escape handler posts clear');
});

function line(sid: string, at: number, cwd: string, i: number): string {
  return JSON.stringify({ type: 'assistant', uuid: `${sid}-${i}`, timestamp: new Date(at).toISOString(), sessionId: sid, version: '2.1.289', cwd, message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: `t${sid}${i}`, name: 'Bash', input: { command: `echo ${i}` } }] } });
}

test('store: git correlation of ENDED sessions pauses with gitEnded=false and resumes after', async () => {
  clearGitCache();
  const { repo } = makeRepo();
  const home = tmpDir('wiring');
  const proj = path.join(home, 'claude', 'projects', 'p');
  fs.mkdirSync(proj, { recursive: true });
  const sid = '00000000-0000-4000-8000-000000000001';
  const at = Date.now() - 30 * 60_000; // no registry entry and older than the grace: ENDED (inferred)
  fs.writeFileSync(path.join(proj, `${sid}.jsonl`), [line(sid, at - 60_000, repo, 0), line(sid, at, repo, 1)].join('\n') + '\n');
  const opts = { historyDays: 2, maxSessions: 50, idleMinutes: 10, git: true, gitEnded: false };
  const store = new SessionStore([new ClaudeAdapter(path.join(home, 'claude')), new CodexAdapter(path.join(home, 'codex'))], opts);
  const paused = await store.refresh();
  assert.equal(store.all()[0].status, 'ENDED');
  assert.equal(paused.gitCorrelated, 0, 'no git while no view is visible');
  assert.equal(store.all()[0].repository, undefined);
  store.opts.gitEnded = true;
  assert.equal((await store.refresh()).gitCorrelated, 1, 'resumed');
  assert.ok(store.all()[0].repository, 'correlated');
  store.opts.gitEnded = false;
  await store.refresh();
  assert.ok(store.all()[0].repository, 'paused again: the correlated result is kept');
});
