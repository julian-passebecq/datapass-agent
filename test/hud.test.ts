import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { AgentSessionSnapshot, TimelineEvent } from '../src/model';
// Load the workspace before the screen module (the screen imports workspace helpers; workspace imports the registry).
import { renderWorkspace, WsData } from '../src/render/workspace';
import { ciFor, countLessons, hudSessions, logTail, testSummary, todoProgress, workersOf } from '../src/activity/hud';
import { loadLessons, readLessons } from '../src/feeds/lessons';
import { hudView, lessonRoots, renderHud } from '../src/render/extra/hud';
import { sessTok } from '../src/render/extra/lifecycle';
import { extraViews } from '../src/render/extra/index';
import { clearFeeds, setFeedValue } from '../src/render/extra/feeds';
import { ClaudeAdapter } from '../src/providers/claude/claude';
import { CodexAdapter, objectArg } from '../src/providers/codex/codex';
import { ProviderAdapter } from '../src/providers/types';
import { SessionAccumulator } from '../src/sessions/accumulator';
import type { CiReport } from '../src/feeds/pipelines';
import { FIXTURES, jpath, materialize, T, tmpDir } from './helpers';

const NOW = T('2026-10-05T12:00:00Z');
const M = 60_000;

function mk(p: Partial<AgentSessionSnapshot> & { key: string }): AgentSessionSnapshot {
  const [provider, sessionId] = p.key.split(':') as ['claude' | 'codex', string];
  return { provider, sessionId, status: 'ENDED', statusReason: 'test', commits: [], changedFiles: [], tests: [], isWorker: false, counts: { tools: 0, commands: 0, fileEdits: 0, turns: 0 }, evidence: [], artifactPath: '', diagnostics: [], startedAt: NOW - 120 * M, lastActivityAt: NOW - 60 * M, ...p };
}

function load(provider: 'claude' | 'codex'): SessionAccumulator[] {
  const home = tmpDir(`todos-${provider}`);
  const cwd = path.join(home, 'repo');
  fs.mkdirSync(cwd, { recursive: true });
  materialize(path.join(FIXTURES, 'todos', provider), path.join(home, provider), { __CWD__: jpath(cwd) });
  const a: ProviderAdapter = provider === 'claude' ? new ClaudeAdapter(path.join(home, provider)) : new CodexAdapter(path.join(home, provider));
  const accs: SessionAccumulator[] = [];
  for (const ref of a.listArtifacts(0, 50)) {
    const acc = a.ingest(ref);
    if (acc) accs.push(acc);
  }
  return accs.sort((x, y) => x.sessionId.localeCompare(y.sessionId));
}

test('todos: claude TodoWrite keeps the latest list, capped at 30 × 120 chars, redacted', () => {
  const [a] = load('claude');
  const t = a.toSnapshot().facts?.todos;
  assert.ok(t);
  assert.equal(t.source, 'TodoWrite');
  assert.equal(t.at, T('2026-10-05T10:01:00Z'));
  assert.equal(t.items.length, 30);
  assert.equal(t.dropped, 12);
  assert.equal(t.items[0].status, 'completed');
  assert.ok(!t.items[0].text.includes('abc123secretvalue'), 'redacted');
  assert.equal(t.items[1].status, 'in_progress');
  assert.ok(t.items[1].text.length <= 120);
  assert.ok(!t.items.some(i => i.text === 'old item'), 'replaced by the newer list');
  assert.equal(a.toSnapshot().evidence.find(e => e.field === 'facts.todos')?.kind, 'OBSERVED');
});

test('todos: claude TaskCreate / TaskUpdate build a list by creation order, duplicates ignored, deleted removed', () => {
  const [, b] = load('claude');
  const t = b.toSnapshot().facts?.todos;
  assert.ok(t);
  assert.deepEqual(t.items, [{ text: 'Write parser', status: 'completed' }, { text: 'Add tests', status: 'in_progress' }]);
  assert.equal(t.source, 'TaskUpdate');
});

test('todos: codex update_plan from function_call and from exec scripts', () => {
  const [c] = load('codex');
  const t = c.toSnapshot().facts?.todos;
  assert.ok(t);
  assert.equal(t.source, 'update_plan');
  assert.deepEqual(t.items, [{ text: 'Read code', status: 'completed' }, { text: 'Patch {x}', status: 'in_progress' }, { text: 'Test', status: 'pending' }]);
  assert.equal(t.at, T('2026-10-05T10:05:00Z'));
  assert.deepEqual(objectArg('tools.update_plan({plan: []})', 0), undefined, 'non-JSON literal is skipped');
  assert.deepEqual(objectArg('x({"a":"}{"})', 0), { a: '}{' });
});

test('hud: lessons count bullets, CLAUDE.md only in a Lessons section, code fences skipped', () => {
  assert.equal(countLessons('# Memory\n- one\n* two\n  - nested\n1. num\ntext\n```\n- code\n```\n', 'all'), 4);
  const claude = '# Rules\n- not a lesson\n## Lessons\n- l1\n- l2\n### Detail\n- l3\n## Other\n- no\n';
  assert.equal(countLessons(claude, 'section'), 3);
  assert.equal(countLessons('# Rules\n- a\n', 'section'), 0);
});

test('hud: lessons feed reads the first candidate file, async, capped', async () => {
  const root = tmpDir('hud-lessons');
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# X\n## Lessons\n- a\n');
  let l = await readLessons(root);
  assert.equal(l.file, 'CLAUDE.md');
  assert.equal(l.rules, 1);
  fs.mkdirSync(path.join(root, 'handoff'));
  fs.writeFileSync(path.join(root, 'handoff', 'MEMORY.md'), '- a\n- b\n'.repeat(50));
  l = await readLessons(root, 16);
  assert.equal(l.file, 'handoff/MEMORY.md');
  assert.equal(l.truncated, true);
  assert.ok(l.rules <= 4);
  const none = tmpDir('hud-none');
  const all = await loadLessons([root, root.toUpperCase(), none]);
  assert.equal(Object.keys(all).length, 2);
  assert.equal(all[none].file, undefined);
});

const LEAD = mk({ key: 'claude:lead-1', title: 'lead <script>', status: 'RUNNING', repository: 'D:\\r\\app', branch: 'feat/x', lastActivityAt: NOW - M, facts: { permissionMode: 'plan', todos: { at: NOW - 2 * M, source: 'TodoWrite', items: [{ text: 'done <b>', status: 'completed' }, { text: 'doing', status: 'in_progress' }, { text: 'next', status: 'pending' }] } }, usage: { totalTokens: 1, outputTokens: 1, cachedInputTokens: 0, contextTokens: 38_080 }, tests: [{ command: 'npm test', at: NOW - 9 * M, outcome: 'FAIL', source: 'provider-exit-code' }, { command: 'npm test', at: NOW - 5 * M, outcome: 'PASS', source: 'provider-exit-code' }, { command: 'npm run build', at: NOW - 4 * M, outcome: 'FAIL', source: 'provider-exit-code' }] });
const W1 = mk({ key: 'claude:w-1', isWorker: true, parentSessionId: LEAD.key, status: 'RUNNING', workerLabel: 'Explore', lastActivityAt: NOW - M });
const W2 = mk({ key: 'claude:w-2', isWorker: true, parentSessionId: LEAD.key, status: 'ENDED', workerLabel: 'Plan' });
const OLD = mk({ key: 'codex:old-1', title: 'old one', status: 'ENDED', facts: { permissionMode: 'on-request', sandbox: 'workspace-write' } });

test('hud: workers, todo progress, tests, sessions, log tail', () => {
  assert.deepEqual(workersOf(LEAD, [LEAD, W1, W2, OLD]).map(w => [w.s.key, w.state]), [[W1.key, 'run'], [W2.key, 'ended']]);
  const tp = todoProgress(LEAD)!;
  assert.equal(tp.done, 1);
  assert.equal(tp.total, 3);
  assert.equal(tp.active, 'doing');
  const t = testSummary(LEAD)!;
  assert.deepEqual([t.passed, t.failed, t.total, t.runs], [1, 1, 2, 3], 'latest outcome per command');
  assert.deepEqual(hudSessions([LEAD, W1, W2, OLD], undefined).map(s => s.key), [LEAD.key], 'worker folds into its lead');
  assert.deepEqual(hudSessions([LEAD, W1, OLD], OLD).map(s => s.key), [OLD.key, LEAD.key], 'pinned first');
  const evs: TimelineEvent[] = Array.from({ length: 12 }, (_, i) => ({ at: NOW - (12 - i) * M, type: 'TOOL_ACTIVITY', label: `t${i}`, provider: 'claude', sessionKey: LEAD.key, kind: 'OBSERVED' }));
  assert.deepEqual(logTail(LEAD.key, evs, 8).map(l => l.label), ['t4', 't5', 't6', 't7', 't8', 't9', 't10', 't11']);
  assert.deepEqual(lessonRoots([OLD, LEAD]), ['D:\\r\\app']);
});

test('hud: CI from the pipelines report, branch first, else newest of the repo', () => {
  const run = (id: string, ref: string, status: 'success' | 'failed', at: number) => ({ key: `github:h/o#${id}`, id, provider: 'github' as const, host: 'h', slug: 'o/r', root: 'd:/r/app', repo: 'app', title: `run ${id}`, ref, status, raw: status, createdAt: at });
  const rep: CiReport = { state: 'ok', at: NOW, calls: 1, noRemote: 0, repos: [{ root: 'D:/r/app/', name: 'app', remotes: [], errors: [], ms: 1, runs: [run('1', 'feat/x', 'failed', NOW - 9 * M), run('2', 'main', 'success', NOW - M)] }] };
  const c = ciFor(LEAD, rep);
  assert.ok(typeof c === 'object' && c.status === 'failed' && c.basis === 'branch');
  const c2 = ciFor({ ...LEAD, branch: 'other', facts: {} }, rep);
  assert.ok(typeof c2 === 'object' && c2.status === 'success' && c2.basis === 'repo');
  assert.equal(ciFor(LEAD, { ...rep, state: 'off' }), 'off');
  assert.equal(ciFor(OLD, rep), 'none');
});

test('hud: screen renders cards with evidence, escapes text, pins a session', () => {
  clearFeeds();
  const d: WsData = { sessions: [LEAD, W1, W2, OLD], providers: [], events: [], now: NOW, ternAvailable: false, timeline: (k, n) => [<TimelineEvent>{ at: NOW - M, type: 'TEST', label: 'FAIL <npm> test', provider: 'claude', sessionKey: k ?? '', kind: 'OBSERVED' }].slice(-(n ?? 8)), config: <T>(_k: string, f: T) => f };
  let h = renderHud(d, { view: 'hud' });
  assert.ok(extraViews().some(v => v.id === 'hud'));
  assert.ok(h.includes('lead &lt;script&gt;') && !h.includes('<script>'), 'escaped title');
  assert.ok(h.includes('[ON]'), 'plan mode');
  assert.ok(h.includes('<b>1</b>/2 running'), 'subagents');
  assert.ok(h.includes('<b>1/3</b>'), 'todo progress');
  assert.ok(!h.includes('done &lt;b&gt;'), 'completed items hidden by default');
  assert.ok(h.includes('<b>1/2</b> passed'), 'tests');
  assert.ok(h.includes('not enabled'), 'CI off by default');
  assert.ok(h.includes('<b>14 %</b>'), 'context vs 272k reference');
  assert.ok(h.includes('FAIL &lt;npm&gt; test'), 'log tail escaped');
  assert.ok(h.includes('data-select="claude:w-1"'), 'worker rows selectable');
  assert.ok(!h.includes('old one</b>'), 'ended session not shown unless pinned');
  setFeedValue('hud.lessons', { 'D:\\r\\app': { root: 'D:\\r\\app', file: 'handoff/MEMORY.md', rules: 7, bytes: 10, truncated: false } });
  h = renderHud(d, { view: 'hud', opts: { 'hud.pin': sessTok(OLD), 'hud.todo': 'all' } });
  assert.ok(h.includes('old one</b>'), 'pinned card');
  assert.ok(h.includes('approval on-request'), 'codex mode');
  assert.ok(h.includes('done &lt;b&gt;'), 'all items');
  assert.ok(h.includes('<b>7</b> rules'), 'lessons from feed');
  const ws = renderWorkspace(d, { view: 'hud' });
  assert.ok(ws.includes('Session HUD'));
  assert.equal(hudView.badge?.(d), '1');
  clearFeeds();
});
