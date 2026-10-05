import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import { AgentSessionSnapshot, TimelineEvent } from '../src/model';
import { canonicalJson, CONFIG_SNAPSHOT_SCHEMA, OBSERVATION_SCHEMA, pathRef, validateGalaxyDoc } from '../src/galaxy/index';
import { toObservation, toObservations } from '../src/galaxy/observation';
import { toConfigSnapshot } from '../src/galaxy/configSnapshot';
import { collectSettings } from '../src/feeds/settings';
import type { CatalogReport } from '../src/feeds/catalog';
import { ClaudeAdapter } from '../src/providers/claude/claude';
import { CodexAdapter } from '../src/providers/codex/codex';
import { SessionStore } from '../src/sessions/store';
import { clearGitCache } from '../src/git/git';
import { FIXTURES, jpath, makeRepo, materialize, T, tmpDir } from './helpers';

const NOW = Date.parse('2026-10-05T12:00:00Z');
const SECRET = 'PROMPT-TEXT-SHOULD-NOT-LEAK';

function snap(p: Partial<AgentSessionSnapshot>): AgentSessionSnapshot {
  return { key: 'claude:a', provider: 'claude', sessionId: 'a', status: 'ENDED', statusReason: 'no live registry entry', commits: [], changedFiles: [], tests: [], isWorker: false, counts: { tools: 0, commands: 0, fileEdits: 0, turns: 0 }, evidence: [], artifactPath: 'C:\\Users\\x\\.claude\\projects\\p\\a.jsonl', diagnostics: [], ...p };
}

const rich = snap({
  title: `${SECRET} title`,
  cwd: 'C:\\Users\\julia\\repo\\wt',
  repository: 'C:\\Users\\julia\\repo',
  worktree: 'C:\\Users\\julia\\repo\\wt',
  isLinkedWorktree: true,
  branch: 'feat/x',
  model: 'claude-opus-5-5',
  startedAt: NOW - 3_600_000,
  lastActivityAt: NOW - 60_000,
  endedAt: NOW - 60_000,
  commits: [{ sha: 'abc1234', at: NOW - 120_000, subject: `${SECRET} commit subject`, attribution: 'during-session' }],
  changedFiles: ['src/secret-name.ts', 'README.md'],
  tests: [{ command: `npm test -- ${SECRET}`, at: NOW - 200_000, outcome: 'PASS', exitCode: 0, source: 'provider-exit-code' }],
  usage: { totalTokens: 1000, outputTokens: 100, cachedInputTokens: 800, contextTokens: 5000 },
  lastAction: `Bash ${SECRET}`,
  facts: { prompts: 3, replies: 4, toolCounts: { Bash: 2 }, permissionMode: 'plan', currentTool: { name: 'Bash', detail: SECRET, startedAt: NOW }, todos: { at: NOW, source: 'TodoWrite', items: [{ text: SECRET, status: 'pending' }] }, spawns: [{ at: NOW, type: 'coder', description: SECRET }], activeMs: 1000 },
  evidence: [{ field: 'model', kind: 'OBSERVED', source: 'assistant message .model' }, { field: 'endedAt', kind: 'DERIVED', source: 'last recorded activity of an ended session' }, { field: 'status', kind: 'DERIVED', source: 'no live registry entry for this session' }],
});
const events: TimelineEvent[] = [
  { at: NOW - 3_000_000, type: 'TOOL_ACTIVITY', label: `Bash ${SECRET}`, provider: 'claude', sessionKey: 'claude:a', kind: 'OBSERVED' },
  { at: NOW - 3_500_000, type: 'SESSION_STARTED', label: SECRET, provider: 'claude', sessionKey: 'claude:a', kind: 'OBSERVED' },
  { at: NOW - 3_400_000, type: 'COMMIT', label: 'other session', provider: 'claude', sessionKey: 'claude:b', kind: 'DERIVED' },
];

test('observation: schema, ISO times, events of this session only, oldest first, without labels', () => {
  const o = toObservation(rich, events, { capturedAt: NOW });
  assert.equal(o.schema, OBSERVATION_SCHEMA);
  assert.equal(o.observationId, 'claude:a');
  assert.equal(o.capturedAt, '2026-10-05T12:00:00.000Z');
  assert.equal(o.freshness, 'live');
  assert.deepEqual(o.events.map(e => e.type), ['SESSION_STARTED', 'TOOL_ACTIVITY']);
  assert.ok(!('label' in o.events[0]));
  assert.equal(o.changedFiles, 2);
  assert.deepEqual(o.commits, [{ sha: 'abc1234', at: new Date(NOW - 120_000).toISOString(), attribution: 'during-session' }]);
  assert.deepEqual(o.tests[0], { at: new Date(NOW - 200_000).toISOString(), outcome: 'PASS', source: 'provider-exit-code', exitCode: 0 });
  assert.equal(o.facts?.spawns, 1);
  assert.deepEqual(validateGalaxyDoc(o), []);
});

test('observation: no prompt, title, command, commit subject, todo, file name or absolute path is exported', () => {
  const json = JSON.stringify(toObservation(rich, events, { capturedAt: NOW }));
  assert.ok(!json.includes(SECRET), 'free text leaked');
  assert.ok(!json.includes('secret-name'), 'file name leaked');
  assert.ok(!/julia|\\\\|C:/.test(json), 'absolute path leaked');
  const o = toObservation(rich, [], { capturedAt: NOW });
  assert.deepEqual(o.repo, pathRef('C:\\Users\\julia\\repo'));
  assert.equal(o.repo?.name, 'repo');
  assert.equal(o.worktree?.linked, true);
  assert.equal(pathRef('C:\\Users\\Julia\\Repo\\')?.hash, pathRef('c:/users/julia/repo')?.hash, 'hash ignores case and separators');
});

test('observation: absent values are UNKNOWN, never OBSERVED; recorded evidence wins; live status is INFERRED', () => {
  const bare = toObservation(snap({ status: 'RUNNING' }), [], { capturedAt: NOW });
  for (const f of ['model', 'effort', 'repo', 'branch', 'headBefore', 'commits', 'tests', 'changedFiles', 'usage.totalTokens', 'usage.costUSD', 'facts', 'parentKey']) assert.equal(bare.kinds[f], 'UNKNOWN', f);
  assert.equal(bare.kinds.status, 'INFERRED');
  assert.ok(!('model' in bare) && !('usage' in bare) && !('facts' in bare), 'absent fields are left out, not null');
  assert.equal(toObservation(snap({ status: 'UNKNOWN' }), [], { capturedAt: NOW }).kinds.status, 'UNKNOWN');
  const o = toObservation(rich, [], { capturedAt: NOW, freshness: 'archived' });
  assert.equal(o.kinds.model, 'OBSERVED');
  assert.equal(o.kinds.endedAt, 'DERIVED');
  assert.equal(o.kinds.status, 'DERIVED');
  assert.equal(o.kinds['usage.totalTokens'], 'DERIVED', 'Claude totals are a sum over messages');
  assert.equal(o.kinds['usage.contextTokens'], 'OBSERVED');
  assert.equal(o.freshness, 'archived');
  assert.equal(toObservation(snap({ provider: 'codex', key: 'codex:a', usage: { totalTokens: 1, outputTokens: 1, cachedInputTokens: 0 } }), [], { capturedAt: NOW }).kinds['usage.totalTokens'], 'OBSERVED');
});

test('observation: maxEvents keeps the newest events', () => {
  const many: TimelineEvent[] = Array.from({ length: 20 }, (_, i) => ({ at: NOW - i * 1000, type: 'TOOL_ACTIVITY', label: 'x', provider: 'claude', sessionKey: 'claude:a', kind: 'OBSERVED' }));
  const o = toObservation(rich, many, { capturedAt: NOW, maxEvents: 5 });
  assert.equal(o.events.length, 5);
  assert.equal(o.events[4].at, new Date(NOW).toISOString());
});

test('observation: real fixture sessions project to valid, path-free documents', async () => {
  clearGitCache();
  const { repo, shas } = makeRepo();
  const home = tmpDir('galaxy');
  const vars = { __CWD__: jpath(repo), __HEAD__: shas[1], __MISSING__: jpath(path.join(home, 'deleted-worktree')) };
  materialize(path.join(FIXTURES, 'claude'), path.join(home, 'claude'), vars);
  materialize(path.join(FIXTURES, 'codex'), path.join(home, 'codex'), vars);
  const store = new SessionStore([new ClaudeAdapter(path.join(home, 'claude')), new CodexAdapter(path.join(home, 'codex'))], { historyDays: 30, maxSessions: 100, idleMinutes: 10, git: true }, () => T('2026-10-04T12:00:00Z'));
  await store.refresh();
  const sessions = store.all();
  assert.ok(sessions.length > 0);
  const docs = toObservations(sessions, store.timeline(undefined, 5000), { capturedAt: NOW });
  assert.equal(docs.length, sessions.length);
  for (const d of docs) {
    assert.deepEqual(validateGalaxyDoc(d), [], d.observationId);
    for (const s of sessions.filter(x => x.key === d.observationId && x.title)) assert.ok(!JSON.stringify(d).includes(s.title!), 'title not exported');
  }
});

const SETTINGS = path.join(FIXTURES, 'settings');
function settingsReport(now = 1) {
  return collectSettings({ claudeHome: path.join(SETTINGS, 'home', '.claude'), codexHome: path.join(SETTINGS, 'home', '.codex'), roots: [path.join(SETTINGS, 'repo')], managedFile: path.join(SETTINGS, 'no-managed.json'), now });
}

const catalog: CatalogReport = {
  at: 1, claudeHome: 'C:\\h\\.claude', codexHome: 'C:\\h\\.codex', roots: [],
  items: [{ provider: 'claude', kind: 'skill', source: 'user', active: true, file: 'C:\\h\\.claude\\skills\\handoff\\SKILL.md', name: 'handoff', description: SECRET }],
  plugins: [{ provider: 'claude', id: 'p@m', name: 'p', installed: true, enabled: true, dir: 'C:\\h\\p', skills: 1, agents: 0, commands: 0, hooks: 0, mcp: 0, projects: [] }],
  hooks: [{ event: 'PreToolUse', matcher: 'Bash', type: 'command', program: 'python hook.py', source: 'user', file: 'C:\\h\\.claude\\settings.json' }],
  mcp: [{ provider: 'claude', name: 'files', transport: 'stdio', program: 'node', source: 'user', file: 'C:\\h\\.claude.json' }],
  settings: [{ key: 'model', value: 'claude-opus-4-1', layer: 'user', file: 'x' }, { key: 'model', value: 'y', layer: 'project', file: 'x' }],
  instructions: [{ provider: 'claude', source: 'user', file: 'C:\\h\\.claude\\CLAUDE.md', bytes: 10, lines: 1, headings: [SECRET] }],
  memory: [], codexRules: [], files: [], errors: [],
};

test('config snapshot: layers, effective values, names and counts only; no env, hook command, values or paths', () => {
  const c = toConfigSnapshot({ settings: settingsReport(), catalog, cli: [{ tool: 'claude', status: 'ok', version: '2.1.289', exe: 'C:\\x\\claude.exe', flags: [], commands: [], at: 1 }], capturedAt: NOW });
  assert.equal(c.schema, CONFIG_SNAPSHOT_SCHEMA);
  assert.deepEqual(validateGalaxyDoc(c), []);
  assert.equal(c.claude?.effective.model !== undefined, true);
  const user = c.claude!.layers.find(l => l.kind === 'user')!;
  assert.equal(user.model, 'claude-opus-4-1');
  assert.deepEqual(user.hookEvents, ['PreToolUse']);
  assert.equal(user.allow, 2);
  assert.equal(user.deny, 1);
  assert.ok(user.env >= 2);
  assert.deepEqual(c.catalog?.settingsKeys, ['model']);
  assert.deepEqual(c.cli, [{ tool: 'claude', status: 'ok', version: '2.1.289' }]);
  const json = JSON.stringify(c);
  for (const bad of ['fake-value-should-not-leak', 'fakefakefake', 'fake-helper-output', 'MY_API_KEY', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'Bash(git status', 'rm -rf', SECRET, 'claude.exe', 'SKILL.md']) assert.ok(!json.includes(bad), bad);
  assert.ok(!/[A-Za-z]:\\\\/.test(json), 'no absolute path');
});

test('config snapshot: content hash ignores capturedAt and key order, changes with content; missing feed is UNKNOWN', () => {
  const a = toConfigSnapshot({ settings: settingsReport(1), catalog, capturedAt: NOW });
  const b = toConfigSnapshot({ settings: settingsReport(2), catalog: { ...catalog, settings: [...catalog.settings].reverse(), at: 99 }, capturedAt: NOW + 60_000 });
  assert.match(a.contentHash, /^[0-9a-f]{64}$/);
  assert.equal(a.contentHash, b.contentHash);
  const c = toConfigSnapshot({ settings: settingsReport(1), catalog: { ...catalog, mcp: [] }, capturedAt: NOW });
  assert.notEqual(a.contentHash, c.contentHash);
  const none = toConfigSnapshot({ capturedAt: NOW });
  assert.equal(none.kinds.claude, 'UNKNOWN');
  assert.equal(none.kinds.catalog, 'UNKNOWN');
  assert.ok(!('claude' in none) && !('catalog' in none) && !('codex' in none));
  assert.equal(canonicalJson({ b: 1, a: [2, { d: undefined, c: 3 }] }), '{"a":[2,{"c":3}],"b":1}');
});
