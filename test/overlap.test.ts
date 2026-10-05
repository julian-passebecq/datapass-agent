import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import { AgentSessionSnapshot } from '../src/model';
// workspace first: it loads the screen registry (screen files import helpers from workspace).
import '../src/render/workspace';
import type { WsData } from '../src/render/workspace';
import { sharedWindows } from '../src/git/changes';
import { changesView } from '../src/render/extra/changes';
import { reviewView } from '../src/render/extra/review';
import { clearFeeds } from '../src/render/extra/feeds';
import { T } from './helpers';

const NOW = T('2026-10-05T12:00:00Z');
const M = 60_000;
const WT = path.resolve('/work/agent-wt');

function mk(p: Partial<AgentSessionSnapshot> & { key: string }): AgentSessionSnapshot {
  const [provider, sessionId] = p.key.split(':') as ['claude' | 'codex', string];
  return { provider, sessionId, status: 'ENDED', statusReason: 'test', commits: [], changedFiles: [], tests: [], isWorker: false, counts: { tools: 0, commands: 0, fileEdits: 0, turns: 0 }, evidence: [], artifactPath: '', diagnostics: [], repository: WT, worktree: WT, cwd: WT, ...p };
}
const win = (sha: string, at: number) => ({ sha, at, subject: 'feat', attribution: 'during-session' as const });
const own = (sha: string, at: number) => ({ sha, at, subject: 'feat', attribution: 'session-ran-git-commit' as const });

/** A: 10:00-11:00, B: 10:30-11:30 in the same worktree. c1 at 10:15 (A only), c2 at 10:45 (both). */
function pair(bOwn = false) {
  const c1 = win('c1', NOW - 105 * M);
  const c2 = NOW - 75 * M;
  const a = mk({ key: 'claude:A', title: 'Session Alpha', startedAt: NOW - 120 * M, lastActivityAt: NOW - 60 * M, changedFiles: ['src/a.ts'], commits: [c1, win('c2', c2)] });
  const b = mk({ key: 'codex:B', title: 'Session <b>Beta</b>', startedAt: NOW - 90 * M, lastActivityAt: NOW - 30 * M, changedFiles: ['src/b.ts'], commits: [bOwn ? own('c2', c2) : win('c2', c2)] });
  return { a, b };
}

test('overlap: two overlapping sessions in one worktree share their window commits (INFERRED)', () => {
  const { a, b } = pair();
  const m = sharedWindows([a, b], NOW);
  const sa = m.get('claude:A')!;
  assert.deepEqual([...sa.shas.keys()], ['c2'], 'c1 is outside B window: not shared');
  assert.deepEqual(sa.others, ['codex:B']);
  assert.equal(sa.n, 2);
  assert.deepEqual([...m.get('codex:B')!.shas.keys()], ['c2']);
});

test('overlap: a session that ran git commit itself stays OBSERVED (not marked)', () => {
  const { a, b } = pair(true);
  const m = sharedWindows([a, b], NOW);
  assert.ok(!m.has('codex:B'), 'own commit not marked');
  assert.ok(m.has('claude:A'), 'the other session only had it by window');
});

test('overlap: different worktrees, disjoint windows and own workers are not shared; live runs until now', () => {
  const { a, b } = pair();
  assert.equal(sharedWindows([a, { ...b, worktree: path.resolve('/work/other') }], NOW).size, 0);
  assert.equal(sharedWindows([a, { ...b, startedAt: NOW - 20 * M, lastActivityAt: NOW - 10 * M, commits: [win('c3', NOW - 15 * M)] }], NOW).size, 0);
  assert.equal(sharedWindows([a, { ...b, isWorker: true, parentSessionId: 'claude:A' }], NOW).size, 0);
  const live = mk({ key: 'claude:L', status: 'RUNNING', startedAt: NOW - 80 * M, lastActivityAt: NOW - 79 * M });
  assert.deepEqual(sharedWindows([a, live], NOW).get('claude:A')?.others, ['claude:L']);
});

test('overlap: Changes and Review screens show the badge with the other sessions in the tooltip', () => {
  clearFeeds();
  const { a, b } = pair();
  const d: WsData = { sessions: [a, b], providers: [], events: [], now: NOW, ternAvailable: false };
  for (const layout of ['table', 'cards']) {
    const h = changesView.render(d, { view: 'changes', opts: { 'changes.tab': 'sessions', 'changes.period': 'all', 'changes.slayout': layout, 'changes.who': 'all' } });
    assert.match(h, /shared window \(2 sessions\)/, `changes ${layout}`);
    assert.match(h, /INFERRED: 1 of 2 window commit\(s\)[^"]*Session &lt;b&gt;Beta&lt;\/b&gt;/);
    assert.ok(!h.includes('<b>Beta</b>'), 'escaped');
  }
  for (const layout of ['board', 'table']) {
    const h = reviewView.render(d, { view: 'review', opts: { 'review.layout': layout, 'review.show': 'all', 'review.period': 'all' } });
    assert.match(h, /class="rv-shared" data-ev="INFERRED" title="INFERRED:[^"]*Session Alpha/, `review ${layout}`);
  }
  const solo = changesView.render({ ...d, sessions: [a] }, { view: 'changes', opts: { 'changes.tab': 'sessions', 'changes.period': 'all' } });
  assert.ok(!solo.includes('shared window'));
});
