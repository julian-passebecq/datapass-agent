import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { tmpDir } from './helpers';
import { DbCopies, loadCodexState, threadActivity, originRepo, selectSql, FORBIDDEN_COLUMNS } from '../src/providers/codex/state';
// workspace first: it loads the screen registry (screens import helpers from workspace).
import '../src/render/workspace';
import { setFeedValue, clearFeeds } from '../src/render/extra/feeds';
import { codexView } from '../src/render/extra/codex';
import type { WsData } from '../src/render/workspace';
import type { AgentSessionSnapshot } from '../src/model';

type Ctor = new (f: string, o?: { readOnly?: boolean }) => { exec(sql: string): void; close(): void };
let Sqlite: Ctor | undefined;
let why = '';
try {
  Sqlite = (require('node:sqlite') as { DatabaseSync: Ctor }).DatabaseSync;
} catch (e) {
  why = `node:sqlite unavailable in Node ${process.versions.node}`;
}

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const T3 = '33333333-3333-4333-8333-333333333333';

function db(file: string, sql: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const d = new Sqlite!(file);
  d.exec(sql);
  d.close();
}

function fixture(): string {
  const root = tmpDir('codex-state');
  db(
    path.join(root, 'state_5.sqlite'),
    `CREATE TABLE threads (id TEXT, title TEXT, name TEXT, first_user_message TEXT, preview TEXT, model TEXT, reasoning_effort TEXT, tokens_used INTEGER, git_branch TEXT, git_origin_url TEXT, cwd TEXT, project_id TEXT, is_pinned INTEGER, archived INTEGER, created_at INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER, agent_nickname TEXT, agent_role TEXT);
     INSERT INTO threads VALUES ('${T1}', 'SECRET-PROMPT-1', NULL, 'SECRET-PROMPT-1', 'SECRET-PREVIEW', 'gpt-6', 'high', 12000, 'main', 'https://user:ghp_abcdefghijklmnopqrstuvwxyz@github.com/acme/widget.git', 'D:\\x\\widget', 'p1', 1, 0, 1700000000, NULL, 1700000500000, NULL, NULL);
     INSERT INTO threads VALUES ('${T2}', 'Fix the parser', NULL, 'SECRET-PROMPT-2', NULL, 'gpt-6', 'medium', 3000, 'feat', 'git@gitlab.com:team/tool.git', 'D:\\x\\tool', 'p1', 0, 0, NULL, 1700000100000, 1700000200000, 'worker', 'explorer');
     INSERT INTO threads VALUES ('${T3}', 'SECRET-PROMPT-3', 'Named by user', 'SECRET-PROMPT-3', NULL, 'gpt-6-mini', NULL, 10, NULL, NULL, NULL, NULL, 0, 1, NULL, 1600000000000, 1600000000000, NULL, NULL);
     CREATE TABLE projects (id TEXT, name TEXT, metadata TEXT, position INTEGER);
     INSERT INTO projects VALUES ('p1', 'Widgets', 'SECRET-META', 0);
     CREATE TABLE project_roots (project_id TEXT, position INTEGER, path TEXT);
     INSERT INTO project_roots VALUES ('p1', 0, 'D:\\x\\widget');
     CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT, status TEXT);
     INSERT INTO thread_spawn_edges VALUES ('${T1}', '${T2}', 'completed');`,
  );
  db(
    path.join(root, 'sqlite', 'codex-dev.db'),
    `CREATE TABLE automations (id TEXT, name TEXT, prompt TEXT, status TEXT, next_run_at INTEGER, last_run_at INTEGER, rrule TEXT, model TEXT, reasoning_effort TEXT, kind TEXT);
     INSERT INTO automations VALUES ('a1', 'Nightly audit', 'SECRET-AUTO', 'ACTIVE', 1700100000000, 1700000000000, 'FREQ=DAILY;BYHOUR=2', 'gpt-6', 'low', 'cron');
     CREATE TABLE automation_runs (thread_id TEXT, automation_id TEXT, status TEXT, thread_title TEXT, inbox_summary TEXT);
     INSERT INTO automation_runs VALUES ('${T1}', 'a1', 'done', 'SECRET-RUN', 'SECRET-SUM');
     INSERT INTO automation_runs VALUES ('${T2}', 'a1', 'done', 'SECRET-RUN', 'SECRET-SUM');`,
  );
  db(
    path.join(root, 'goals_1.sqlite'),
    `CREATE TABLE thread_goals (thread_id TEXT, goal_id TEXT, objective TEXT, status TEXT, token_budget INTEGER, tokens_used INTEGER, time_used_seconds INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER);
     INSERT INTO thread_goals VALUES ('${T1}', 'g1', 'SECRET-GOAL', 'active', 100000, 25000, 600, 1, 1700000000000);`,
  );
  db(
    path.join(root, 'queue_1.sqlite'),
    `CREATE TABLE queued_items (id TEXT, thread_id TEXT, payload_json TEXT, queue_order INTEGER);
     INSERT INTO queued_items VALUES ('q1', '${T1}', '{"text":"SECRET-Q"}', 0);
     INSERT INTO queued_items VALUES ('q2', '${T1}', '{"text":"SECRET-Q"}', 1);
     CREATE TABLE queued_thread_revisions (revision INTEGER, thread_id TEXT);
     INSERT INTO queued_thread_revisions VALUES (1, '${T1}');`,
  );
  db(
    path.join(root, 'thread_history_1.sqlite'),
    `CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, status TEXT, error_json TEXT, started_at INTEGER, completed_at INTEGER, duration_ms INTEGER);
     INSERT INTO thread_turns VALUES ('${T1}', 'u1', 'completed', NULL, 1700000000000, 1700000005000, 5000);
     INSERT INTO thread_turns VALUES ('${T1}', 'u2', 'completed', '{"message":"SECRET-ERR"}', 1700000010000, NULL, 45000);
     INSERT INTO thread_turns VALUES ('${T2}', 'u3', 'failed', NULL, 1700000020000, 1700000140000, NULL);`,
  );
  const locks = path.join(root, 'thread-writer-locks');
  fs.mkdirSync(locks);
  fs.writeFileSync(path.join(locks, `${T1}.lock`), '');
  fs.writeFileSync(path.join(locks, '.coordination.lock'), '');
  fs.writeFileSync(path.join(root, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'gpt-6', display_name: 'GPT-6', context_window: 272000, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }], default_reasoning_level: 'medium' }] }));
  fs.writeFileSync(path.join(root, 'auth.json'), '{"token":"SECRET-AUTH"}');
  return root;
}

test('codexState: whitelisted columns only, locks, models', { skip: Sqlite ? false : why }, async () => {
  const root = fixture();
  const copies = new DbCopies(path.join(tmpDir('codex-copies'), 'c'));
  try {
    const st = await loadCodexState({ root, now: 1700000600000, copies });
    assert.equal(st.sqlite, true);
    assert.doesNotMatch(JSON.stringify(st), /SECRET|ghp_|user:/, 'no prompt, objective, payload, error text, credential');
    const t1 = st.threads.find(t => t.id === T1)!;
    assert.equal(t1.title, undefined, 'title equal to the first prompt is dropped');
    assert.equal(t1.repo, 'github.com/acme/widget');
    assert.equal(t1.createdAt, 1700000000000, 'seconds normalised to ms');
    assert.equal(t1.pinned, true);
    assert.equal(st.threads.find(t => t.id === T2)!.title, 'Fix the parser');
    assert.equal(st.threads.find(t => t.id === T2)!.repo, 'gitlab.com/team/tool');
    assert.equal(st.threads.find(t => t.id === T3)!.title, 'Named by user');
    assert.equal(st.threads.find(t => t.id === T3)!.archived, true);
    assert.deepEqual(st.projects, [{ id: 'p1', name: 'Widgets', position: 0, roots: ['D:\\x\\widget'] }]);
    assert.deepEqual(st.edges, [{ parent: T1, child: T2, status: 'completed' }]);
    assert.equal(st.automations[0].name, 'Nightly audit');
    assert.equal(st.automations[0].rrule, 'FREQ=DAILY;BYHOUR=2');
    assert.deepEqual(st.automations[0].runs, { done: 2 });
    assert.equal(st.goals[0].tokensUsed, 25000);
    assert.deepEqual(st.queue, { [T1]: 2 });
    assert.equal(st.queueRevisions, 1);
    assert.equal(st.turns.length, 3);
    assert.equal(st.turns.filter(t => t.failed).length, 2, 'error_json set or failed status');
    assert.equal(st.turns.find(t => t.thread === T2)!.durationMs, 120000, 'duration derived from start / end');
    assert.deepEqual(st.locks.map(l => l.id), [T1], 'only <uuid>.lock files');
    assert.equal(threadActivity(st, 1700000600000).get(T1), 'running', 'lock + update < 5 min');
    assert.equal(threadActivity(st, 1800000000000).get(T1), 'open', 'lock only, stale');
    assert.equal(threadActivity(st, 1700000600000).has(T2), false, 'no lock');
    assert.equal(st.models[0].context, 272000);
    assert.deepEqual(st.models[0].efforts, ['low', 'high']);
    assert.ok(st.sources.every(s => s.status === 'ready'), JSON.stringify(st.sources));

    // Copies: reused when unchanged, deleted on dispose.
    const copy = path.join(copies.dir, 'state_5.sqlite');
    const m0 = fs.statSync(copy).mtimeMs;
    await loadCodexState({ root, now: 1700000700000, copies });
    assert.equal(fs.statSync(copy).mtimeMs, m0);

    // Render: threads link to loaded sessions, nothing secret, every tab renders.
    clearFeeds();
    setFeedValue('codex.state', st);
    const s = { key: `codex:${T2}`, provider: 'codex', sessionId: T2, title: 'x' } as unknown as AgentSessionSnapshot;
    const d = { sessions: [s], providers: [], events: [], now: 1700000600000, ternAvailable: false } as WsData;
    for (const tab of ['threads', 'projects', 'agents', 'automations', 'goals', 'timing']) {
      const html = codexView.render(d, { view: 'codex', opts: { 'codex.tab': tab, 'codex.show': 'all' } } as never);
      assert.doesNotMatch(html, /SECRET/);
      assert.ok(html.length > 200, tab);
      if (tab === 'threads') {
        assert.match(html, new RegExp(`data-select="codex:${T2}"`));
        assert.match(html, /Codex app state \(undocumented, may change\)/);
      }
    }
    clearFeeds();
  } finally {
    copies.dispose();
  }
  assert.equal(fs.existsSync(copies.dir), false, 'temp copies deleted on dispose');
});

test('codexState: without node:sqlite every db source is missing, no throw', async () => {
  const root = tmpDir('codex-nosql');
  const st = await loadCodexState({ root, noSqlite: true });
  assert.equal(st.sqlite, false);
  assert.ok(st.sources.filter(s => s.id !== 'codex.locks' && s.id !== 'codex.models').every(s => s.status === 'missing'));
  assert.equal(st.threads.length, 0);
});

test('codexState: select never includes forbidden columns; origin URL keeps host/owner/repo', () => {
  const have = new Set(['id', 'first_user_message', 'preview', 'objective', 'payload_json', 'model']);
  assert.equal(selectSql(have, 't', ['id', 'first_user_message', 'preview', 'objective', 'payload_json', 'model', 'absent']), 'SELECT id, model FROM t');
  assert.ok(FORBIDDEN_COLUMNS.has('item_json'));
  assert.equal(originRepo('https://x:tok@github.com/a/b.git?x=1'), 'github.com/a/b');
  assert.equal(originRepo('ssh://git@host.example:22/g/sub/r.git'), 'host.example/sub/r');
  assert.equal(originRepo('nonsense'), undefined);
});
