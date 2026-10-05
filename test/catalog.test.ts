import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { tmpDir } from './helpers';
import { clearCliCache, collectCatalog, headingsOf, loadCli, parseHelp, programOf } from '../src/feeds/catalog';
// workspace first: it loads the screen registry (screens import helpers from workspace).
import '../src/render/workspace';
import { clearFeeds, setFeedValue } from '../src/render/extra/feeds';
import { catalogView } from '../src/render/extra/catalog';
import { extraViews } from '../src/render/extra/index';
import type { WsData } from '../src/render/workspace';

function w(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const SECRETS = ['fake-env-secret-value', 'fake-mcp-arg-secret', 'fake-header-secret', 'fake-auth-json-secret', 'fake-hook-arg-secret', 'fake-codex-secret'];

async function fixture() {
  const base = tmpDir('catalog');
  const home = path.join(base, 'home');
  const ch = path.join(home, '.claude');
  const cx = path.join(home, '.codex');
  const repo = path.join(base, 'repo');
  w(path.join(ch, 'settings.json'), JSON.stringify({ model: 'opus', effortLevel: 'medium', cleanupPeriodDays: 30, permissions: { defaultMode: 'acceptEdits', allow: ['Bash(git *)', 'Read'] }, env: { MY_TOKEN: 'fake-env-secret-value' }, apiKeyHelper: 'echo fake', enabledPlugins: { 'demo@mkt': true }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'python "C:/x/guard.py" --token fake-hook-arg-secret', timeout: 5 }] }] } }));
  w(path.join(ch, '.credentials.json'), '{"x":"fake-auth-json-secret"}');
  w(path.join(ch, 'CLAUDE.md'), '# Rules\n\n## One\n```\n# not a heading\n```\n### Two\n');
  w(path.join(ch, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: Does alpha things\n---\nbody');
  w(path.join(ch, 'skills', 'alpha', 'ref.md'), 'x');
  w(path.join(ch, 'agents', 'rev.md'), '---\nname: reviewer\ndescription: Reviews\nmodel: sonnet\ntools: Read, Grep\neffort: low\n---\n');
  w(path.join(ch, 'commands', 'ship.md'), '---\ndescription: Ship it\nargument-hint: <branch>\n---\n');
  w(path.join(ch, 'commands', 'ns', 'go.md'), '---\ndescription: Namespaced\n---\n');
  w(path.join(ch, 'projects', 'D--x', 'memory', 'MEMORY.md'), 'secret memory text');
  w(path.join(ch, 'projects', 'D--x', 'memory', 'user_prefs.md'), 'x');
  // plugin marketplace with one enabled plugin and one available
  const mk = path.join(ch, 'plugins', 'marketplaces', 'mkt');
  w(path.join(ch, 'plugins', 'known_marketplaces.json'), JSON.stringify({ mkt: { installLocation: mk } }));
  w(path.join(mk, '.claude-plugin', 'marketplace.json'), JSON.stringify({ plugins: [{ name: 'demo', source: './plugins/demo' }, { name: 'other', source: './plugins/other' }] }));
  const pd = path.join(mk, 'plugins', 'demo');
  w(path.join(pd, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'demo', version: '1.2.3', description: 'Demo plugin' }));
  w(path.join(pd, 'skills', 'ds', 'SKILL.md'), '---\nname: demo-skill\ndescription: from plugin\n---\n');
  w(path.join(pd, 'commands', 'dc.md'), '---\ndescription: plugin cmd\n---\n');
  w(path.join(pd, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node ${CLAUDE_PLUGIN_ROOT}/stop.js' }] }] } }));
  w(path.join(pd, '.mcp.json'), JSON.stringify({ mcpServers: { pmcp: { command: 'npx', args: ['fake-mcp-arg-secret'] } } }));
  w(path.join(mk, 'plugins', 'other', 'skills', 'os', 'SKILL.md'), '---\nname: other-skill\n---\n');
  w(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'fake@example.invalid' }, mcpServers: { usermcp: { type: 'http', url: 'https://x.invalid/?k=fake-header-secret', headers: { Authorization: 'fake-header-secret' } } }, projects: { [repo]: { mcpServers: { localmcp: { command: 'C:/tools/server.exe', env: { K: 'fake-mcp-arg-secret' } } } } } }));
  // project
  w(path.join(repo, '.claude', 'settings.json'), JSON.stringify({ model: 'sonnet', enabledPlugins: { 'demo@mkt': false } }));
  w(path.join(repo, '.claude', 'agents', 'pa.md'), '---\nname: project-agent\n---\n');
  w(path.join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { projmcp: { command: 'uvx', args: ['fake-mcp-arg-secret'] } } }));
  w(path.join(repo, 'CLAUDE.md'), '# Repo\n');
  // codex
  w(path.join(cx, 'config.toml'), 'model = "gpt-5"\nmodel_reasoning_effort = "high"\napproval_policy = "on-request"\nsandbox_mode = "workspace-write"\n[mcp_servers.cmcp]\ncommand = "node"\nargs = ["fake-codex-secret"]\n[features]\nweb = true\n');
  w(path.join(cx, 'auth.json'), '{"t":"fake-auth-json-secret"}');
  w(path.join(cx, 'secrets', 'x.json'), '{"t":"fake-codex-secret"}');
  w(path.join(cx, 'AGENTS.md'), '# Codex rules\n');
  w(path.join(cx, 'skills', 'cs', 'SKILL.md'), '---\nname: codex-skill\ndescription: c\n---\n');
  w(path.join(cx, 'skills', '.system', 'sys', 'SKILL.md'), '---\nname: sys-skill\n---\n');
  w(path.join(cx, 'rules', 'default.rules'), 'prefix_rule(pattern=["git"])\nprefix_rule(pattern=["ls"])\n');
  w(path.join(cx, 'plugins', 'cache', 'bundled', 'browser', '1.0.0', '.codex-plugin', 'plugin.json'), JSON.stringify({ version: '1.0.0', description: 'Browser' }));
  w(path.join(cx, 'plugins', 'cache', 'bundled', 'browser', '1.0.0', 'skills', 'b', 'SKILL.md'), '---\nname: browse\n---\n');
  const r = await collectCatalog({ claudeHome: ch, codexHome: cx, claudeJson: path.join(home, '.claude.json'), roots: [repo, home, repo, 'rel/x'], now: 1 });
  return { r, ch, cx, repo, home };
}

test('catalog: skills, agents, commands with sources', async () => {
  const { r, repo } = await fixture();
  assert.deepEqual(r.roots, [repo]);
  const skill = r.items.find(i => i.name === 'alpha')!;
  assert.equal(skill.source, 'user');
  assert.equal(skill.files, 2);
  assert.equal(skill.description, 'Does alpha things');
  const ag = r.items.find(i => i.name === 'reviewer')!;
  assert.deepEqual([ag.kind, ag.model, ag.tools, ag.effort], ['agent', 'sonnet', 'Read, Grep', 'low']);
  const cmd = r.items.find(i => i.name === 'ship')!;
  assert.equal(cmd.argumentHint, '<branch>');
  assert.ok(r.items.some(i => i.name === 'ns:go' && i.kind === 'command'));
  assert.equal(r.items.find(i => i.name === 'project-agent')!.source, 'project');
  const ps = r.items.find(i => i.name === 'demo-skill')!;
  assert.deepEqual([ps.source, ps.plugin, ps.active], ['plugin', 'demo@mkt', true]);
  assert.equal(r.items.find(i => i.name === 'other-skill'), undefined, 'available-only plugins are counted, not read');
  assert.equal(r.plugins.find(p => p.id === 'other@mkt')!.skills, 1);
});

test('catalog: plugins, hooks, MCP and settings are redacted', async () => {
  const { r, ch } = await fixture();
  const demo = r.plugins.find(p => p.id === 'demo@mkt')!;
  assert.deepEqual([demo.enabled, demo.version, demo.skills, demo.commands, demo.hooks, demo.mcp], [true, '1.2.3', 1, 1, 1, 1]);
  assert.deepEqual(demo.projects, ['repo (off)']);
  assert.equal(r.plugins.find(p => p.id === 'other@mkt')!.enabled, undefined);
  const hook = r.hooks.find(h => h.event === 'PreToolUse')!;
  assert.equal(hook.program, 'python guard.py');
  assert.equal(r.hooks.find(h => h.event === 'Stop')!.program, 'node stop.js');
  const names = r.mcp.map(m => `${m.provider}:${m.name}:${m.source}:${m.transport}:${m.program ?? ''}`).sort();
  assert.deepEqual(names, ['claude:localmcp:local:stdio:server.exe', 'claude:pmcp:plugin:stdio:npx', 'claude:projmcp:project:stdio:uvx', 'claude:usermcp:user:http:', 'codex:cmcp:user:stdio:node']);
  const val = (k: string, root?: string) => r.settings.find(s => s.key === k && s.root === root)?.value;
  assert.equal(val('model'), 'opus');
  assert.equal(val('cleanupPeriodDays'), '30');
  assert.equal(val('permissions.defaultMode'), 'acceptEdits');
  assert.equal(val('permissions.allow'), '2 items');
  assert.equal(val('apiKeyHelper'), 'set');
  assert.match(val('env')!, /^1 variable name/);
  assert.equal(val('model', r.roots[0]), 'sonnet');
  const all = JSON.stringify(r);
  for (const sx of SECRETS) assert.ok(!all.includes(sx), sx);
  assert.ok(!all.includes('MY_TOKEN'), 'env names are not listed');
  assert.ok(!all.includes('fake@example.invalid'));
  assert.ok(!r.files.some(f => /\.claude\.json$|auth\.json|credentials|secrets/.test(f)), 'never offered for opening');
  assert.ok(r.files.includes(path.join(ch, 'settings.json')));
});

test('catalog: instructions, memory names and Codex inventory', async () => {
  const { r } = await fixture();
  const u = r.instructions.find(i => i.provider === 'claude' && i.source === 'user')!;
  assert.deepEqual(u.headings, ['Rules', '  One', '    Two']);
  assert.ok(r.instructions.some(i => i.provider === 'codex' && i.headings[0] === 'Codex rules'));
  assert.equal(r.memory.length, 1);
  assert.deepEqual(r.memory[0].names, ['MEMORY.md', 'user_prefs.md']);
  assert.ok(!JSON.stringify(r).includes('secret memory text'));
  assert.equal(r.codexConfig?.model, 'gpt-5');
  assert.equal(r.codexConfig?.approval, 'on-request');
  const cs = r.items.filter(i => i.provider === 'codex' && i.kind === 'skill').map(i => `${i.name}:${i.source}`).sort();
  assert.deepEqual(cs, ['browse:plugin', 'codex-skill:user', 'sys-skill:system']);
  assert.deepEqual(r.codexRules.map(x => x.rules), [2]);
  assert.equal(r.plugins.find(p => p.provider === 'codex')!.version, '1.0.0');
});

test('catalog: helpers', () => {
  assert.equal(programOf('"C:\\Program Files\\x\\tool.exe" --flag secret'), 'tool.exe');
  assert.equal(programOf('bash ./hooks/check.sh arg'), 'bash check.sh');
  assert.equal(programOf(''), '');
  assert.deepEqual(headingsOf('text\n#nope\n# Yes #\n'), ['Yes']);
});

/** Longest gap between two event-loop turns while `fn` runs (a setImmediate chain keeps ticking). */
async function longestBlock(fn: () => Promise<unknown>): Promise<{ max: number; total: number }> {
  let last = performance.now();
  let max = 0;
  let on = true;
  const tick = () => {
    const t = performance.now();
    max = Math.max(max, t - last);
    last = t;
    if (on) setImmediate(tick);
  };
  setImmediate(tick);
  const t0 = performance.now();
  await fn();
  const total = performance.now() - t0;
  on = false;
  max = Math.max(max, performance.now() - last);
  return { max, total };
}

test('catalog: a large tree never blocks the event loop for long', async () => {
  const base = tmpDir('catalog-big');
  const ch = path.join(base, 'home', '.claude');
  const cx = path.join(base, 'home', '.codex');
  const fm = (n: string) => `---\nname: ${n}\ndescription: ${'d'.repeat(120)}\n---\n${'body\n'.repeat(200)}`;
  for (let i = 0; i < 120; i++) {
    w(path.join(ch, 'skills', `s${i}`, 'SKILL.md'), fm(`s${i}`));
    for (let j = 0; j < 6; j++) w(path.join(ch, 'skills', `s${i}`, 'ref', `r${j}.md`), 'x');
  }
  for (let i = 0; i < 80; i++) w(path.join(ch, 'agents', `a${i}.md`), fm(`a${i}`));
  for (let i = 0; i < 80; i++) w(path.join(ch, 'commands', `ns${i % 8}`, `c${i}.md`), fm(`c${i}`));
  const installed: Record<string, unknown> = {};
  for (let p = 0; p < 30; p++) {
    const dir = path.join(ch, 'plugins', 'cache', 'mkt', `p${p}`, '1.0.0');
    installed[`p${p}@mkt`] = [{ installPath: dir, version: '1.0.0' }];
    w(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: `p${p}`, version: '1.0.0' }));
    for (let i = 0; i < 6; i++) w(path.join(dir, 'skills', `k${i}`, 'SKILL.md'), fm(`p${p}-k${i}`));
    w(path.join(dir, 'commands', 'go.md'), fm(`p${p}-go`));
  }
  w(path.join(ch, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: installed }));
  for (let i = 0; i < 40; i++) w(path.join(ch, 'projects', `D--p${i}`, 'memory', 'MEMORY.md'), 'x');
  for (let i = 0; i < 40; i++) w(path.join(cx, 'skills', `c${i}`, 'SKILL.md'), fm(`c${i}`));
  const roots: string[] = [];
  for (let i = 0; i < 20; i++) {
    const r = path.join(base, `repo${i}`);
    roots.push(r);
    w(path.join(r, 'CLAUDE.md'), '# Repo\n## Part\n'.repeat(50));
    w(path.join(r, '.claude', 'settings.json'), JSON.stringify({ model: 'sonnet', permissions: { allow: ['Read'] } }));
    for (let j = 0; j < 4; j++) w(path.join(r, '.claude', 'agents', `x${j}.md`), fm(`r${i}x${j}`));
  }
  let r: Awaited<ReturnType<typeof collectCatalog>> | undefined;
  const { max, total } = await longestBlock(async () => {
    r = await collectCatalog({ claudeHome: ch, codexHome: cx, roots, now: 1 });
  });
  assert.equal(r!.items.filter(i => i.provider === 'claude' && i.kind === 'skill' && i.source === 'user').length, 120);
  assert.equal(r!.items.find(i => i.name === 's0')!.files, 7);
  assert.equal(r!.plugins.length, 30);
  assert.equal(r!.items.filter(i => i.source === 'plugin').length, 30 * 7);
  assert.equal(r!.memory.length, 40);
  assert.equal(r!.instructions.length, 20);
  // eslint-disable-next-line no-console
  if (process.env.CATALOG_BLOCK_LOG) console.log(`catalog scan: total ${total.toFixed(0)} ms, longest block ${max.toFixed(1)} ms`);
  assert.ok(max < 50, `longest synchronous block ${max.toFixed(1)} ms (total ${total.toFixed(0)} ms)`);
});

const CLAUDE_HELP = `Usage: claude [options] [command] [prompt]

Claude Code - starts an interactive session

Arguments:
  prompt                                Your prompt

Options:
  --add-dir <directories...>            Additional directories to allow tool
                                        access to
  --allowedTools, --allowed-tools <tools...>
      Comma or space-separated list of tool names
  -c, --continue                        Continue the most recent conversation
  -h, --help                            Display help for command

Commands:
  agents [options]                      Manage background agents
  plugin|plugins                        Manage Claude Code plugins
`;

const CODEX_HELP = `Codex CLI

Usage: codex [OPTIONS] [PROMPT]

Commands:
  exec              Run Codex non-interactively [aliases: e]
  apply             Apply the latest diff
                    to your working tree [aliases: a]

Options:
  -c, --config <key=value>
          Override a configuration value.
          Use a dotted path.

          Examples: - \`-c model="o3"\`

      --enable <FEATURE>
          Enable a feature (repeatable)

  -V, --version
          Print version
`;

test('catalog: --help parsing (commander and clap)', () => {
  const a = parseHelp(CLAUDE_HELP);
  assert.deepEqual(a.flags.map(f => [f.flag, f.short ?? '', f.arg ?? '']), [
    ['--add-dir', '', '<directories...>'],
    ['--allowedTools, --allowed-tools', '', '<tools...>'],
    ['--continue', '-c', ''],
    ['--help', '-h', ''],
  ]);
  assert.equal(a.flags[0].description, 'Additional directories to allow tool access to');
  assert.equal(a.flags[1].description, 'Comma or space-separated list of tool names');
  assert.deepEqual(a.commands.map(c => c.name), ['agents', 'plugin|plugins']);
  const b = parseHelp(CODEX_HELP);
  assert.deepEqual(b.flags.map(f => f.flag), ['--config', '--enable', '--version']);
  assert.equal(b.flags[0].description, 'Override a configuration value. Use a dotted path.');
  assert.equal(b.flags[0].arg, '<key=value>');
  assert.deepEqual(b.commands.map(c => c.name), ['exec', 'apply']);
  assert.equal(b.commands[1].description, 'Apply the latest diff to your working tree [aliases: a]');
});

test('catalog: CLI runner respects trust, cache and missing exe', async () => {
  clearCliCache();
  let calls = 0;
  const run = async (_e: string, args: string[]) => {
    calls++;
    return { ok: true, out: args[0] === '--version' ? '9.9.9 (Claude Code)\n' : CLAUDE_HELP, err: '' };
  };
  const resolve = () => '/bin/claude';
  assert.equal((await loadCli('claude', { trusted: false, enabled: true, now: 1, run, resolve })).status, 'untrusted');
  assert.equal((await loadCli('claude', { trusted: true, enabled: false, now: 1, run, resolve })).status, 'off');
  assert.equal((await loadCli('codex', { trusted: true, enabled: true, now: 1, run, resolve: () => undefined })).status, 'missing');
  assert.equal(calls, 0);
  const c = await loadCli('claude', { trusted: true, enabled: true, now: 1, run, resolve });
  assert.equal(c.version, '9.9.9 (Claude Code)');
  assert.equal(c.flags.length, 4);
  await loadCli('claude', { trusted: true, enabled: true, now: 1000, run, resolve });
  assert.equal(calls, 2, 'cached for a day');
});

function data(): WsData {
  return { sessions: [], providers: [], events: [], now: 10_000, ternAvailable: false };
}

test('catalog: screen renders every tab, escaped, and validates actions', async () => {
  clearFeeds();
  const { r } = await fixture();
  r.items.push({ provider: 'claude', kind: 'skill', source: 'user', active: true, file: '/x/<b>.md', name: '<script>x</script>' });
  setFeedValue('catalog.scan', r);
  setFeedValue('catalog.cli', [{ tool: 'claude', status: 'ok', version: '9.9.9', flags: parseHelp(CLAUDE_HELP).flags, commands: [], at: 1 }, { tool: 'codex', status: 'missing', flags: [], commands: [], at: 1, error: 'codex not found' }]);
  assert.ok(extraViews().some(v => v.id === 'catalog'));
  for (const tab of ['skills', 'agents', 'commands', 'plugins', 'hooks', 'mcp', 'settings', 'instructions', 'cli', 'codex']) {
    for (const group of ['source', 'flat']) {
      const html = catalogView.render(data(), { view: 'catalog' as never, opts: { 'catalog.tab': tab, 'catalog.group': group, 'catalog.avail': 'all' } });
      assert.ok(html.length > 200, tab);
      assert.ok(!html.includes('<script>'), tab);
      assert.ok(!html.includes('data-select'), 'plain rows only');
      for (const sx of SECRETS) assert.ok(!html.includes(sx), `${tab} ${sx}`);
    }
  }
  const skills = catalogView.render(data(), { view: 'catalog' as never, opts: {} });
  assert.match(skills, /alpha/);
  assert.match(skills, /demo-skill/);
  assert.ok(!skills.includes('other-skill'), 'available-only plugin items hidden by default');
  const settings = catalogView.render(data(), { view: 'catalog' as never, opts: { 'catalog.tab': 'settings' } });
  assert.match(settings, /project-level overrides/);
  const cli = catalogView.render(data(), { view: 'catalog' as never, opts: { 'catalog.tab': 'cli' } });
  assert.match(cli, /--allowedTools/);
  const opened: string[] = [];
  const ctx = { openFile: async (f: string) => void opened.push(f) } as never;
  await catalogView.actions!.open(r.files[0], ctx);
  assert.deepEqual(opened, [r.files[0]]);
  assert.throws(() => catalogView.actions!.open(path.join(path.dirname(r.claudeHome), '.claude.json'), ctx));
  assert.throws(() => catalogView.actions!.open('/etc/passwd', ctx));
  clearFeeds();
});
