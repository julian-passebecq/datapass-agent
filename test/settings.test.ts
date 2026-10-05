import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import { FIXTURES } from './helpers';
import { collectSettings, effective, frontMatter, isForbidden, layersFor, mergedRules, parseToml, rootsOf } from '../src/feeds/settings';
// workspace first: it loads the screen registry (screens import helpers from workspace).
import '../src/render/workspace';
import { setFeedValue, clearFeeds } from '../src/render/extra/feeds';
import { settingsView } from '../src/render/extra/settings';
import type { WsData } from '../src/render/workspace';

const BASE = path.join(FIXTURES, 'settings');
const HOME = path.join(BASE, 'home');
const REPO = path.join(BASE, 'repo');

function report() {
  return collectSettings({ claudeHome: path.join(HOME, '.claude'), codexHome: path.join(HOME, '.codex'), roots: [REPO, HOME, REPO, 'relative/path', path.join(BASE, 'missing')], managedFile: path.join(BASE, 'no-managed.json'), now: 1 });
}

test('settings: layers, precedence and merged rules', () => {
  const r = report();
  assert.equal(r.roots.length, 1, 'home folder, duplicates, relative and missing roots are skipped');
  const user = r.layers.find(l => l.kind === 'user')!;
  assert.equal(user.exists, true);
  assert.equal(user.error, undefined, 'comments and trailing commas are tolerated');
  assert.equal(user.model, 'claude-opus-4-1');
  assert.equal(user.defaultMode, 'acceptEdits');
  assert.deepEqual(user.envNames, ['CLAUDE_CODE_AUTO_COMPACT_WINDOW']);
  assert.equal(user.envHidden, 1);
  assert.equal(user.apiKeyHelper, true);
  assert.deepEqual(user.otherKeys, ['theme']);
  assert.equal(r.layers.find(l => l.kind === 'managed')!.exists, false);

  const L = layersFor(r, REPO);
  assert.deepEqual(L.map(l => l.kind), ['local', 'project', 'user']);
  const m = effective(L, 'model');
  assert.equal(m.value, 'claude-sonnet-4-5');
  assert.equal(m.layer, 'project');
  assert.deepEqual(m.shadowed, [{ layer: 'user', value: 'claude-opus-4-1' }]);
  assert.equal(effective(L, 'defaultMode').value, 'plan');
  assert.equal(effective(L, 'defaultMode').layer, 'local');
  assert.equal(effective(layersFor(r), 'defaultMode').value, 'acceptEdits');
  assert.equal(effective(L, 'outputStyle').value, undefined);
  assert.deepEqual(mergedRules(L), { allow: 3, deny: 1, ask: 1, hooks: 1 });
});

test('settings: hooks are redacted and secrets never leave the collector', () => {
  const r = report();
  const hook = r.layers.find(l => l.kind === 'user')!.hooks[0];
  assert.equal(hook.event, 'PreToolUse');
  assert.equal(hook.matcher, 'Bash');
  assert.equal(hook.timeout, 5);
  assert.ok(!hook.command.includes('fakefakefakefake123'), hook.command);
  const all = JSON.stringify(r);
  for (const secret of ['fake-value-should-not-leak', 'fake-helper-output', 'fake-mcp-env-value', 'fake-shell-secret', 'fakefakefakefake123', 'must never be read']) assert.ok(!all.includes(secret), secret);
  assert.ok(!r.files.some(f => /auth\.json|\.credentials\.json/.test(f)));
  assert.ok(isForbidden('C:\\Users\\x\\.claude\\.credentials.json'));
  assert.ok(isForbidden('/home/x/.codex/auth.json'));
  assert.ok(!isForbidden('/home/x/.codex/config.toml'));
});

test('settings: subagents, skills, commands and memory files', () => {
  const r = report();
  const agent = r.items.find(i => i.kind === 'agent')!;
  assert.deepEqual([agent.name, agent.model, agent.effort, agent.tools, agent.scope], ['coder', 'claude-opus-5-5', 'medium', 'Read, Edit, Bash', 'user']);
  const skill = r.items.find(i => i.kind === 'skill')!;
  assert.equal(skill.name, 'handoff');
  assert.equal(skill.description, 'Write a one-page hand-off for the next session.');
  assert.equal(r.items.find(i => i.kind === 'command')!.name, 'ns:go');
  assert.deepEqual(r.memory.map(m => `${m.provider}:${m.scope}:${path.basename(m.file)}`).sort(), ['claude:project:CLAUDE.md', 'claude:user:CLAUDE.md']);
  assert.ok(r.files.includes(path.join(REPO, '.claude', 'settings.local.json')));
});

test('settings: Codex config.toml subset parser', () => {
  const r = report();
  const c = r.codex[0];
  assert.equal(c.exists, true);
  assert.equal(c.model, 'gpt-5.5-codex');
  assert.equal(c.effort, 'high');
  assert.equal(c.approval, 'on-request');
  assert.equal(c.sandbox, 'workspace-write');
  assert.equal(c.notify, true);
  assert.equal(c.profile, 'fast');
  assert.deepEqual(c.profiles.map(p => [p.name, p.model ?? '', p.approval ?? '', p.sandbox ?? '']), [['fast', 'gpt-5.5-mini', '', ''], ['yolo', '', 'never', 'danger-full-access']]);
  assert.deepEqual(c.mcpServers, ['linear', 'node_repl']);
  assert.deepEqual(c.features, [{ name: 'multi_agent', on: true }, { name: 'js_repl', on: false }]);
  assert.equal(c.trustedProjects, 1);
  assert.deepEqual(c.plugins, [{ name: 'browser@openai-bundled', on: true }, { name: 'pdf@x', on: false }]);
  assert.deepEqual(c.otherKeys, ['shell_environment_policy']);
  assert.equal(r.codex[1].scope, 'project');
  assert.equal(r.codex[1].model, 'o4-mini');
  const t = parseToml('a = { b = 1, c = "x" }\n[[arr]]\nk = 2\n');
  assert.deepEqual(t.a, { b: 1, c: 'x' });
});

test('settings: front matter and roots', () => {
  assert.deepEqual(frontMatter('---\nname: a\ntools:\n  - Read\n  - Edit\n---\n'), { name: 'a', tools: 'Read, Edit' });
  assert.deepEqual(frontMatter('no front matter'), {});
  assert.deepEqual(rootsOf([{ cwd: REPO, lastActivityAt: 1 }, { repository: REPO, lastActivityAt: 5 }, { cwd: 'x' }]), [REPO]);
});

test('settings screen renders every tab escaped', () => {
  clearFeeds();
  const d = { sessions: [], providers: [], events: [], now: Date.now(), ternAvailable: false } as unknown as WsData;
  assert.ok(settingsView.render(d, { view: 'settings' }).includes('Reading configuration'));
  setFeedValue('settings.config', report());
  for (const tab of ['effective', 'layers', 'hooks', 'catalog', 'codex', 'memory']) {
    for (const layout of ['matrix', 'cards', 'table']) {
      const html = settingsView.render(d, { view: 'settings', opts: { 'settings.tab': tab, 'settings.layout': layout, 'settings.layout2': layout, 'settings.repos': 'all', 'settings.kind': 'all', 'settings.hookby': 'layer' } });
      assert.ok(html.length > 500, tab);
      assert.ok(!/<script/i.test(html));
      assert.ok(!html.includes('fakefakefakefake123'));
    }
  }
  const eff = settingsView.render(d, { view: 'settings', opts: { 'settings.repos': 'all' } });
  assert.ok(eff.includes('repo') && eff.includes('cfg-local'), 'repo row with local-layer winner');
  clearFeeds();
});

test('settings actions only open files the feed listed', async () => {
  const r = report();
  setFeedValue('settings.config', r);
  const opened: string[] = [];
  const ctx = { openFile: async (p: string) => void opened.push(p) } as never;
  await settingsView.actions!.open(r.files[0], ctx);
  assert.deepEqual(opened, [r.files[0]]);
  await assert.rejects(async () => settingsView.actions!.open(path.join(HOME, '.codex', 'auth.json'), ctx));
  await assert.rejects(async () => settingsView.actions!.open('C:\\Windows\\win.ini', ctx));
  clearFeeds();
});
