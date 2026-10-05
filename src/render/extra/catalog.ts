// Add-on screen "Catalog": everything Claude Code and Codex have installed or configured on this machine
// (skills, subagents, commands, plugins, hooks, MCP servers, settings keys, instruction files, CLI options).
// Data: src/feeds/catalog.ts (fs reads; `--help` / `--version` only when trusted). Read-only; open / copy actions only.
import type { ExtraView, ActCtx } from './kit';
import { actBtn, loadError, loading, seg, toolbar, opt } from './kit';
import { Feed, FeedCtx, feedValue } from './feeds';
import { esc } from '../html';
import { ago, bytes, kpi, prettyModel, WsData, WsState } from '../workspace';
import { normalizeCase } from '../../util/paths';
import { bounded } from '../../util/redact';
import { CatalogReport, CatItem, CliInfo, collectCatalog, loadCli, Source } from '../../feeds/catalog';
import { defaultHomes, isForbidden, rootsOf } from '../../feeds/settings';
import * as path from 'path';

const FEED = 'catalog.scan';
const CLI_FEED = 'catalog.cli';

function cfg<T>(ctx: FeedCtx, name: string, fallback: T): T {
  const full = ctx.config<T | undefined>(`agent.catalog.${name}`, undefined);
  return full !== undefined ? full : ctx.config<T>(`catalog.${name}`, fallback);
}

const scanFeed: Feed<CatalogReport> = {
  id: FEED,
  intervalMs: 5 * 60_000,
  async load(ctx) {
    const h = defaultHomes();
    const extra = cfg<unknown>(ctx, 'extraRoots', []);
    const max = Math.max(1, Math.min(200, Number(cfg<number>(ctx, 'maxRepos', 40)) || 40));
    const roots = [...rootsOf(ctx.sessions).slice(0, max), ...(Array.isArray(extra) ? extra.filter((x): x is string => typeof x === 'string').slice(0, 50) : [])];
    return collectCatalog({ claudeHome: h.claudeHome, codexHome: h.codexHome, claudeJson: path.join(path.dirname(h.claudeHome), '.claude.json'), managedFile: h.managedFile, roots, now: ctx.now });
  },
};

const cliFeed: Feed<CliInfo[]> = {
  id: CLI_FEED,
  intervalMs: 86400_000,
  async load(ctx) {
    const enabled = cfg<boolean>(ctx, 'runCli', true) !== false;
    return Promise.all((['claude', 'codex'] as const).map(t => loadCli(t, { trusted: ctx.trusted, enabled, now: ctx.now })));
  },
};

// ---------------------------------------------------------------- helpers

type Tab = 'skills' | 'agents' | 'commands' | 'plugins' | 'hooks' | 'mcp' | 'settings' | 'instructions' | 'cli' | 'codex';
const OBS = 'OBSERVED: parsed from the file on disk';
const DER = 'DERIVED: counted from the scanned files';

function home(r: CatalogReport): string {
  return path.dirname(r.claudeHome);
}

function short(r: CatalogReport, file: string): string {
  const h = home(r);
  return h && normalizeCase(file).startsWith(normalizeCase(h)) ? '~' + file.slice(h.length).replace(/\\/g, '/') : file.replace(/\\/g, '/');
}

function repoName(root?: string): string {
  return root ? path.basename(root) || root : '';
}

function canOpen(r: CatalogReport, file: string): boolean {
  return r.files.includes(file) && !isForbidden(file);
}

function acts(r: CatalogReport, file: string | undefined, name?: string): string {
  return `<span class="cat-acts">${file && canOpen(r, file) ? actBtn('open', file, 'Open', `Open ${short(r, file)}`) : ''}${name ? actBtn('copy', name, 'Copy name') : ''}</span>`;
}

function src(source: Source, root?: string, plugin?: string): string {
  const label = source === 'plugin' ? plugin ?? 'plugin' : source === 'project' || source === 'local' ? `${repoName(root)}${source === 'local' ? ' (local)' : ''}` : source;
  return `<span class="cat-src cat-${source}" title="${esc(`${source}${root ? ' · ' + root : ''}`)}">${esc(label)}</span>`;
}

function where(r: CatalogReport, file: string): string {
  return `<td class="cat-path" title="${esc(file)}">${esc(short(r, file))}</td>`;
}

/** Groups rows by source when the toggle is on, with a count per group. */
function grouped<T>(st: WsState, rows: T[], key: (x: T) => string, cols: number, row: (x: T) => string): string {
  if (opt(st, 'catalog.group', 'source') !== 'source') return rows.map(row).join('');
  const g = new Map<string, T[]>();
  for (const x of rows) g.set(key(x), [...(g.get(key(x)) ?? []), x]);
  const order = (k: string) => (k.startsWith('user') ? 0 : k.startsWith('project') || k.startsWith('local') ? 1 : k.startsWith('system') ? 3 : 2);
  return [...g]
    .sort((a, b) => order(a[0]) - order(b[0]) || a[0].localeCompare(b[0]))
    .map(([k, xs]) => `<tr class="cat-grp"><td colspan="${cols}">${esc(k)} <span class="muted" title="${DER}">· ${xs.length}</span></td></tr>${xs.map(row).join('')}`)
    .join('');
}

const groupKey = (x: { source: Source; root?: string; plugin?: string }) => (x.source === 'plugin' ? `plugin · ${x.plugin ?? ''}` : x.root ? `${x.source} · ${repoName(x.root)}` : x.source);

function srcFilter<T extends { source: Source }>(st: WsState, xs: T[]): T[] {
  const f = opt(st, 'catalog.src', 'all');
  return f === 'all' ? xs : xs.filter(x => (f === 'project' ? x.source === 'project' || x.source === 'local' : x.source === f));
}

const empty = (msg: string) => `<div class="empty">${esc(msg)}</div>`;

// ---------------------------------------------------------------- tabs

function itemsOf(r: CatalogReport, st: WsState, kind: CatItem['kind'] | CatItem['kind'][], provider: 'claude' | 'codex' = 'claude'): CatItem[] {
  const ks = Array.isArray(kind) ? kind : [kind];
  return srcFilter(
    st,
    r.items.filter(i => i.provider === provider && ks.includes(i.kind)),
  ).sort((a, b) => a.name.localeCompare(b.name));
}

function itemTable(r: CatalogReport, st: WsState, xs: CatItem[], kind: 'skill' | 'agent' | 'command' | 'output-style' | 'prompt'): string {
  if (!xs.length) return empty('Nothing found for this filter.');
  const head =
    kind === 'agent'
      ? '<th>Name</th><th>Model</th><th>Effort</th><th>Tools</th><th>Description</th>'
      : kind === 'command' || kind === 'prompt'
        ? '<th>Command</th><th>Arguments</th><th>Description</th>'
        : kind === 'skill'
          ? '<th>Name</th><th title="' + DER + '">Files</th><th>Description</th>'
          : '<th>Name</th><th>Description</th>';
  const cols = (kind === 'agent' ? 5 : kind === 'skill' || kind === 'command' || kind === 'prompt' ? 3 : 2) + 3;
  const row = (i: CatItem) => {
    const name = kind === 'command' ? '/' + i.name : i.name;
    const desc = `<td class="cat-desc" title="${esc(i.description ?? '')}">${esc(i.description ?? '')}</td>`;
    const cells =
      kind === 'agent'
        ? `<td><b>${esc(name)}</b></td><td>${esc(i.model ? prettyModel(i.model) : 'inherit')}</td><td>${esc(i.effort ?? '')}</td><td class="cat-tools" title="${esc(i.tools ?? 'all tools (inherited)')}">${esc(i.tools ?? 'all')}</td>${desc}`
        : kind === 'command' || kind === 'prompt'
          ? `<td><b>${esc(name)}</b></td><td><code>${esc(i.argumentHint ?? '')}</code></td>${desc}`
          : kind === 'skill'
            ? `<td><b>${esc(name)}</b></td><td class="num">${i.files ?? ''}</td>${desc}`
            : `<td><b>${esc(name)}</b></td>${desc}`;
    return `<tr class="${i.active ? '' : 'cat-off'}" title="${esc(OBS + (i.active ? '' : ' · plugin not installed or enabled'))}">${cells}<td>${src(i.source, i.root, i.plugin)}</td>${where(r, i.file)}<td>${acts(r, i.file, name)}</td></tr>`;
  };
  return `<table class="cat-t"><tr>${head}<th>Source</th><th>Path</th><th></th></tr>${grouped(st, xs, groupKey, cols, row)}</table>`;
}

function pluginsTab(r: CatalogReport, st: WsState): string {
  const avail = opt(st, 'catalog.avail', 'active') === 'all';
  const xs = r.plugins.filter(p => p.provider === 'claude' && (avail || p.installed || p.enabled !== undefined || p.projects.length)).sort((a, b) => Number(b.enabled === true) - Number(a.enabled === true) || Number(b.installed) - Number(a.installed) || a.id.localeCompare(b.id));
  const hidden = r.plugins.filter(p => p.provider === 'claude').length - xs.length;
  if (!xs.length) return empty(`No Claude Code plugin installed or enabled.${hidden ? ` ${hidden} plugin(s) available in marketplaces: switch to "Include available".` : ''}`);
  const note = 'Skills, agents and commands of installed / enabled plugins appear in their tabs; available plugins are only counted.';
  const state = (p: (typeof xs)[number]) => (p.enabled === true ? '<span class="cat-ok">enabled</span>' : p.enabled === false ? '<span class="cat-bad">disabled</span>' : p.installed ? '<span class="cat-warn" title="installed, not listed in enabledPlugins">installed</span>' : '<span class="muted">available</span>');
  const n = (v: number) => `<td class="num" title="${DER}">${v || ''}</td>`;
  return `<table class="cat-t"><tr><th>Plugin</th><th>Marketplace</th><th>Version</th><th>State</th><th>Skills</th><th>Agents</th><th>Commands</th><th>Hooks</th><th>MCP</th><th>Repos (project settings)</th><th>Description</th><th></th></tr>${xs
    .map(
      p => `<tr title="${OBS}"><td><b>${esc(p.name)}</b></td><td>${esc(p.marketplace ?? '')}</td><td>${esc(p.version ?? '')}</td><td>${state(p)}</td>${n(p.skills)}${n(p.agents)}${n(p.commands)}${n(p.hooks)}${n(p.mcp)}<td class="cat-tools">${esc(p.projects.join(', '))}</td><td class="cat-desc" title="${esc(p.description ?? '')}">${esc(p.description ?? '')}</td><td>${acts(r, p.manifest, p.id)}</td></tr>`,
    )
    .join('')}</table>${hidden ? `<div class="foot">${hidden} more plugin(s) available in marketplaces but not installed (toggle "Include available").</div>` : ''}<div class="foot">${esc(note)}</div>`;
}

function hooksTab(r: CatalogReport, st: WsState): string {
  const xs = srcFilter(st, r.hooks).sort((a, b) => a.event.localeCompare(b.event) || a.matcher.localeCompare(b.matcher));
  if (!xs.length) return empty('No hook configured in any settings file or active plugin.');
  return `<table class="cat-t"><tr><th>Event</th><th>Matcher</th><th>Type</th><th title="program name only; arguments are never shown">Program</th><th>Timeout</th><th>Source</th><th>Path</th><th></th></tr>${grouped(
    st,
    xs,
    groupKey,
    8,
    h => `<tr title="${OBS}"><td><b>${esc(h.event)}</b></td><td><code>${esc(h.matcher || '*')}</code></td><td>${esc(h.type)}</td><td><code>${esc(h.program || '—')}</code></td><td class="num">${h.timeout !== undefined ? esc(h.timeout + ' s') : ''}</td><td>${src(h.source, h.root, h.plugin)}</td>${where(r, h.file)}<td>${acts(r, h.file)}</td></tr>`,
  )}</table><div class="foot">Commands are reduced to the program name (and a script file name); arguments, env and URLs are never read into Agent.</div>`;
}

function mcpTab(r: CatalogReport, st: WsState): string {
  const xs = srcFilter(st, r.mcp.filter(m => m.provider === 'claude')).sort((a, b) => a.name.localeCompare(b.name));
  if (!xs.length) return empty('No MCP server declared in ~/.claude.json, project .mcp.json files or active plugins.');
  return `<table class="cat-t"><tr><th>Server</th><th>Transport</th><th>Program</th><th>Source</th><th>Declared in</th><th></th></tr>${grouped(
    st,
    xs,
    groupKey,
    6,
    m => `<tr title="${OBS}"><td><b>${esc(m.name)}</b></td><td>${esc(m.transport)}</td><td><code>${esc(m.program ?? '')}</code></td><td>${src(m.source, m.root, m.plugin)}</td>${where(r, m.file)}<td>${acts(r, m.file, m.name)}</td></tr>`,
  )}</table><div class="foot">Names, transport and program only. Args, env, headers and URLs are never shown. ~/.claude.json is read for server names only and is not offered for opening (it holds account data).</div>`;
}

function settingsTab(r: CatalogReport, st: WsState): string {
  const xs = srcFilter(st, r.settings.map(s => ({ ...s, source: (s.layer === 'project' ? 'project' : s.layer) as Source })));
  if (!xs.length) return empty('No Claude Code settings file found.');
  const repoKeys = new Map<string, Set<string>>();
  for (const s of r.settings) if (s.root) repoKeys.set(s.key, (repoKeys.get(s.key) ?? new Set()).add(repoName(s.root)));
  const rows = grouped(
    st,
    xs.sort((a, b) => a.key.localeCompare(b.key)),
    x => (x.root ? `${x.layer} · ${repoName(x.root)}` : x.layer),
    5,
    s => {
      const ov = !s.root ? [...(repoKeys.get(s.key) ?? [])] : [];
      return `<tr title="${OBS}"><td><b>${esc(s.key)}</b></td><td><code>${esc(s.value)}</code></td><td>${src(s.source, s.root)}</td><td class="cat-tools" title="${esc(ov.length ? 'DERIVED: repos whose project settings also set this key' : '')}">${esc(ov.join(', '))}</td><td>${acts(r, s.file)}</td></tr>`;
    },
  );
  return `<table class="cat-t"><tr><th>Key</th><th>Value</th><th>Layer</th><th>Overridden in repos</th><th></th></tr>${rows}</table>${overrides(r)}<div class="foot">Scalars (booleans, numbers, model / effort / mode / style names) are shown; other strings show as "set"; lists and objects as counts. Env values and secret-like keys are never shown.</div>`;
}

/** Repos with project-level config of any kind. */
function overrides(r: CatalogReport): string {
  const by = new Map<string, Record<string, number>>();
  const add = (root: string | undefined, k: string) => {
    if (!root) return;
    const m = by.get(root) ?? {};
    m[k] = (m[k] ?? 0) + 1;
    by.set(root, m);
  };
  for (const s of r.settings) add(s.root, 'settings');
  for (const i of r.items) if (i.source === 'project' || i.source === 'local') add(i.root, i.kind);
  for (const m of r.mcp) if (m.source === 'project') add(m.root, 'mcp');
  for (const h of r.hooks) if (h.root) add(h.root, 'hooks');
  for (const i of r.instructions) if (i.root) add(i.root, i.provider === 'claude' ? 'claude.md' : 'agents.md');
  if (!by.size) return '';
  const cols = ['settings', 'hooks', 'skill', 'agent', 'command', 'mcp', 'claude.md', 'agents.md'];
  return `<h3 class="cat-h3">Repos with project-level overrides · ${by.size} <span class="muted">of ${r.roots.length} repo(s) agents used</span></h3><table class="cat-t"><tr><th>Repo</th>${cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr>${[...by]
    .sort((a, b) => repoName(a[0]).localeCompare(repoName(b[0])))
    .map(([root, m]) => `<tr><td title="${esc(root)}"><b>${esc(repoName(root))}</b></td>${cols.map(c => `<td class="num" title="${DER}">${m[c] ?? ''}</td>`).join('')}</tr>`)
    .join('')}</table>`;
}

function instructionsTab(r: CatalogReport, st: WsState): string {
  const xs = srcFilter(st, r.instructions);
  let h = xs.length
    ? `<table class="cat-t"><tr><th>File</th><th>Provider</th><th>Source</th><th>Lines</th><th>Size</th><th>Headings</th><th></th></tr>${xs
        .map(
          i => `<tr title="${OBS}"><td class="cat-path" title="${esc(i.file)}">${esc(short(r, i.file))}</td><td>${esc(i.provider)}</td><td>${src(i.source, i.root)}</td><td class="num">${i.lines}</td><td class="num">${bytes(i.bytes)}</td><td><details class="cat-det"><summary>${i.headings.length} heading(s)</summary><pre>${esc(i.headings.join('\n'))}</pre></details></td><td>${acts(r, i.file)}</td></tr>`,
        )
        .join('')}</table>`
    : empty('No CLAUDE.md or AGENTS.md found.');
  const mem = r.memory;
  const total = mem.reduce((n, m) => n + m.count, 0);
  h += `<h3 class="cat-h3">Memory files <span class="muted" title="${DER}">· ${total} file(s) in ${mem.length} project folder(s) under ~/.claude/projects/*/memory (names only, contents not read)</span></h3>`;
  if (mem.length)
    h += `<table class="cat-t"><tr><th>Project folder</th><th>Files</th><th>Names</th></tr>${mem
      .sort((a, b) => b.count - a.count)
      .map(m => `<tr><td class="cat-path" title="${esc(m.dir)}">${esc(m.project)}</td><td class="num">${m.count}</td><td class="cat-desc" title="${esc(m.names.join(', '))}">${esc(m.names.join(', '))}</td></tr>`)
      .join('')}</table>`;
  return h;
}

function cliTab(st: WsState): string {
  const fs = feedValue<CliInfo[]>(CLI_FEED);
  if (!fs.value) return fs.error ? loadError(`CLI help unavailable: ${fs.error}`, 'refresh') : loading('catalog.cli', 'Reading CLI help…', { retry: 'refresh' });
  const tool = opt(st, 'catalog.cli', 'claude');
  const c = fs.value.find(x => x.tool === tool);
  const tb = toolbar(seg(st, 'catalog.cli', fs.value.map(x => [x.tool, `${x.tool === 'claude' ? 'Claude Code' : 'Codex'} ${x.flags.length || ''}`] as [string, string]), 'claude', 'Which CLI'));
  if (!c) return tb;
  const status: Record<CliInfo['status'], string> = { ok: '', off: 'Off: setting agent.catalog.runCli is false.', untrusted: 'Workspace not trusted: Agent runs no process here.', missing: c.error ?? 'Not found.', error: `Error: ${c.error ?? ''}` };
  if (c.status !== 'ok') return tb + empty(status[c.status]);
  let h = tb + `<div class="cat-ver" title="OBSERVED: ${esc(c.tool)} --version / --help, cached one day">${esc(c.version ?? c.tool)} · <span class="muted">${esc(c.exe ?? '')}</span></div>`;
  h += `<table class="cat-t"><tr><th>Flag</th><th>Short</th><th>Argument</th><th>Description</th><th></th></tr>${c.flags.map(f => `<tr><td><code>${esc(f.flag)}</code></td><td><code>${esc(f.short ?? '')}</code></td><td><code>${esc(f.arg ?? '')}</code></td><td class="cat-long">${esc(f.description)}</td><td>${actBtn('copy', f.flag.split(',')[0], 'Copy')}</td></tr>`).join('')}</table>`;
  if (c.commands.length) h += `<h3 class="cat-h3">Commands · ${c.commands.length}</h3><table class="cat-t"><tr><th>Command</th><th>Arguments</th><th>Description</th></tr>${c.commands.map(x => `<tr><td><b>${esc(x.name)}</b></td><td><code>${esc(x.args ?? '')}</code></td><td class="cat-long">${esc(x.description)}</td></tr>`).join('')}</table>`;
  return h;
}

function codexTab(r: CatalogReport, st: WsState): string {
  const c = r.codexConfig;
  let h = '';
  if (c) {
    const kv = (k: string, v?: string) => `<div class="cat-kv"><span>${esc(k)}</span><b>${esc(v ?? '—')}</b></div>`;
    h += `<div class="cat-card" title="${OBS}"><div class="cat-ch"><b>config.toml</b> <span class="muted cat-path">${esc(short(r, c.file))}</span>${acts(r, c.file)}</div>${c.error ? `<div class="cat-bad">${esc(c.error)}</div>` : ''}<div class="cat-grid">${kv('Model', c.model && prettyModel(c.model))}${kv('Reasoning effort', c.effort)}${kv('Approval policy', c.approval)}${kv('Sandbox mode', c.sandbox)}${kv('Default profile', c.profile)}${kv('Profiles', c.profiles.map(p => p.name).join(', ') || undefined)}${kv('MCP servers', c.mcpServers.join(', ') || undefined)}${kv('Notify', c.notify ? 'set' : 'not set')}</div>${c.features.length ? `<div class="cat-chips">${c.features.map(f => `<span class="cat-chip ${f.on ? 'on' : 'off'}">${esc(f.name)}</span>`).join('')}</div>` : ''}</div>`;
  } else h += empty('No ~/.codex/config.toml.');
  const skills = itemsOf(r, st, 'skill', 'codex');
  h += `<h3 class="cat-h3">Skills · ${skills.length}</h3>${itemTable(r, st, skills, 'skill')}`;
  const prompts = itemsOf(r, st, 'prompt', 'codex');
  if (prompts.length) h += `<h3 class="cat-h3">Prompts · ${prompts.length}</h3>${itemTable(r, st, prompts, 'prompt')}`;
  const plugins = r.plugins.filter(p => p.provider === 'codex');
  if (plugins.length)
    h += `<h3 class="cat-h3">Plugins · ${plugins.length}</h3><table class="cat-t"><tr><th>Plugin</th><th>Marketplace</th><th>Version</th><th>Enabled</th><th>Skills</th><th>MCP</th><th>Description</th><th></th></tr>${plugins
      .map(p => `<tr title="${OBS}"><td><b>${esc(p.name)}</b></td><td>${esc(p.marketplace ?? '')}</td><td>${esc(p.version ?? '')}</td><td>${p.enabled === true ? '<span class="cat-ok">yes</span>' : p.enabled === false ? '<span class="cat-bad">no</span>' : '<span class="muted">—</span>'}</td><td class="num">${p.skills || ''}</td><td class="num">${p.mcp || ''}</td><td class="cat-desc" title="${esc(p.description ?? '')}">${esc(p.description ?? '')}</td><td>${acts(r, p.manifest, p.id)}</td></tr>`)
      .join('')}</table>`;
  if (r.codexRules.length) h += `<h3 class="cat-h3">Rules</h3><table class="cat-t"><tr><th>File</th><th title="${DER}">prefix_rule entries</th><th></th></tr>${r.codexRules.map(x => `<tr>${where(r, x.file)}<td class="num">${x.rules}</td><td>${acts(r, x.file)}</td></tr>`).join('')}</table>`;
  const agents = r.instructions.filter(i => i.provider === 'codex');
  if (agents.length) h += `<h3 class="cat-h3">AGENTS.md · ${agents.length}</h3><div class="foot">See Instructions for headings.</div>`;
  return h + '<div class="foot">auth.json, secrets/ and session databases are never read.</div>';
}

// ---------------------------------------------------------------- view

function render(d: WsData, st: WsState): string {
  const fs = feedValue<CatalogReport>(FEED);
  const r = fs.value;
  if (!r) return fs.error ? loadError(`Could not read the catalog: ${fs.error}`, 'refresh') : loading('catalog', 'Scanning Claude Code and Codex folders…', { retry: 'refresh' });
  const tab = opt(st, 'catalog.tab', 'skills') as Tab;
  const active = r.items.filter(i => i.active);
  const n = (k: CatItem['kind'], p: 'claude' | 'codex' = 'claude') => active.filter(i => i.kind === k && i.provider === p).length;
  const cli = feedValue<CliInfo[]>(CLI_FEED).value ?? [];
  const cp = r.plugins.filter(p => p.provider === 'claude');
  const tabs: [Tab, string][] = [
    ['skills', `Skills ${n('skill')}`],
    ['agents', `Agents ${n('agent')}`],
    ['commands', `Commands ${n('command')}`],
    ['plugins', `Plugins ${cp.filter(p => p.installed || p.enabled !== undefined).length}`],
    ['hooks', `Hooks ${r.hooks.length}`],
    ['mcp', `MCP ${r.mcp.filter(m => m.provider === 'claude').length}`],
    ['settings', `Settings ${r.settings.length}`],
    ['instructions', `Instructions ${r.instructions.length}`],
    ['cli', `CLI options ${cli.reduce((s, c) => s + c.flags.length, 0) || ''}`.trim()],
    ['codex', `Codex ${n('skill', 'codex') + r.plugins.filter(p => p.provider === 'codex').length}`],
  ];
  let h = `<div class="cat">`;
  const claudeVer = cli.find(c => c.tool === 'claude')?.version;
  h += `<div class="kpis" title="${DER}">${kpi(n('skill'), 'Skills')}${kpi(n('agent'), 'Subagents')}${kpi(n('command'), 'Commands')}${kpi(cp.filter(p => p.enabled === true).length, 'Plugins enabled', '', `${cp.filter(p => p.installed).length} installed · ${cp.length} known in marketplaces`)}${kpi(r.hooks.length, 'Hooks')}${kpi(r.mcp.length, 'MCP servers')}${kpi(r.instructions.length, 'Instruction files')}${kpi(r.memory.reduce((s, m) => s + m.count, 0), 'Memory files')}${claudeVer ? kpi(claudeVer.replace(/\s*\(.*\)$/, ''), 'Claude Code') : ''}</div>`;
  h += toolbar(
    seg(st, 'catalog.tab', tabs, 'skills', 'Section'),
  );
  h += toolbar(
    seg(st, 'catalog.src', [['all', 'All sources'], ['user', 'User'], ['project', 'Project'], ['plugin', 'Plugin']], 'all', 'Filter by where the item comes from'),
    seg(st, 'catalog.group', [['source', 'Group by source'], ['flat', 'Flat']], 'source'),
    tab === 'plugins' ? seg(st, 'catalog.avail', [['active', 'Installed / enabled'], ['all', 'Include available']], 'active', 'Only installed or enabled plugins, or everything the marketplaces list') : '',
    `<span class="muted" title="${esc(new Date(r.at).toLocaleString())}">scanned ${esc(ago(d.now, r.at))}${fs.ms !== undefined ? ` in ${fs.ms} ms` : ''} · ${r.roots.length} repo(s)</span>`,
    actBtn('refresh', '', 'Re-scan', 'Scan the folders again'),
  );
  h +=
    tab === 'agents'
      ? itemTable(r, st, itemsOf(r, st, 'agent'), 'agent')
      : tab === 'commands'
        ? itemTable(r, st, itemsOf(r, st, 'command'), 'command') + (itemsOf(r, st, 'output-style').length ? `<h3 class="cat-h3">Output styles</h3>${itemTable(r, st, itemsOf(r, st, 'output-style'), 'output-style')}` : '')
        : tab === 'plugins'
          ? pluginsTab(r, st)
          : tab === 'hooks'
            ? hooksTab(r, st)
            : tab === 'mcp'
              ? mcpTab(r, st)
              : tab === 'settings'
                ? settingsTab(r, st)
                : tab === 'instructions'
                  ? instructionsTab(r, st)
                  : tab === 'cli'
                    ? cliTab(st)
                    : tab === 'codex'
                      ? codexTab(r, st)
                      : itemTable(r, st, itemsOf(r, st, 'skill'), 'skill');
  if (r.errors.length) h += `<div class="foot cat-warn">${r.errors.map(e => esc(e)).join('<br>')}</div>`;
  h += `<div class="foot">Rows OBSERVED from files on disk (front matter, JSON, TOML); counts DERIVED. Read-only: Agent never writes these files. Credential files (.credentials.json, auth.json, secrets/) are never read.</div>`;
  return h + '</div>';
}

function checkPath(arg: string): string {
  const files = feedValue<CatalogReport>(FEED).value?.files ?? [];
  const f = files.find(x => x === arg);
  if (!f || isForbidden(f)) throw new Error('Unknown catalog file.');
  return f;
}

export const catalogView: ExtraView = {
  id: 'catalog',
  label: 'Catalog',
  group: 'System',
  hint: 'Everything Claude Code and Codex have installed: skills, agents, commands, plugins, hooks, MCP, settings, CLI options (read-only).',
  ready: true,
  feeds: [scanFeed as Feed, cliFeed as Feed],
  render,
  actions: {
    open: (arg: string, ctx: ActCtx) => ctx.openFile(checkPath(arg)),
    copy: (arg: string, ctx: ActCtx) => ctx.copy(bounded(arg, 200)),
    refresh: (_arg: string, ctx: ActCtx) => ctx.refreshFeeds(),
  },
  css: `
.cat .cat-t { font-size: 12px; margin-bottom: 6px; }
.cat .cat-t th { white-space: nowrap; text-align: left; }
.cat .cat-t tr:hover td { background: var(--vscode-list-hoverBackground); }
.cat .cat-t td.num { text-align: right; white-space: nowrap; }
.cat .cat-grp td { font-weight: 600; font-size: 11px; background: var(--raise); border-top: 1px solid var(--line); padding-top: 4px; }
.cat .cat-off { opacity: .55; }
.cat .cat-path { font-family: var(--vscode-editor-font-family); font-size: 11px; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); }
.cat .cat-desc { max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); }
.cat .cat-long { max-width: 640px; color: var(--vscode-descriptionForeground); }
.cat .cat-tools { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
.cat .cat-acts { white-space: nowrap; } .cat .cat-acts .link { margin-right: 6px; }
.cat .cat-src { font-size: 10px; padding: 0 5px; border-radius: 8px; border: 1px solid var(--line); white-space: nowrap; }
.cat .cat-project, .cat .cat-local { border-color: var(--accent); } .cat .cat-plugin { border-color: var(--claude); } .cat .cat-system { border-color: var(--codex); } .cat .cat-managed { border-color: var(--bad); }
.cat .cat-ok { color: var(--ok); } .cat .cat-bad { color: var(--bad); } .cat .cat-warn { color: var(--warn); }
.cat .cat-h3 { font-size: 12px; margin: 10px 0 3px; font-weight: 600; }
.cat .cat-det summary { cursor: pointer; font-size: 11px; color: var(--vscode-descriptionForeground); } .cat .cat-det pre { margin: 2px 0; font-size: 11px; white-space: pre-wrap; }
.cat .cat-card { border: 1px solid var(--line); border-left: 3px solid var(--codex); border-radius: 6px; background: var(--raise); padding: 7px 9px; margin-bottom: 8px; font-size: 12px; }
.cat .cat-ch { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; margin-bottom: 3px; }
.cat .cat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); column-gap: 18px; }
.cat .cat-kv { display: flex; justify-content: space-between; gap: 8px; border-bottom: 1px dashed var(--line); padding: 1px 0; }
.cat .cat-kv span { color: var(--vscode-descriptionForeground); font-size: 11px; } .cat .cat-kv b { font-weight: 600; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cat .cat-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.cat .cat-chip { font-size: 10px; padding: 1px 6px; border-radius: 9px; border: 1px solid var(--line); } .cat .cat-chip.on { border-color: var(--ok); } .cat .cat-chip.off { color: var(--quiet); text-decoration: line-through; }
.cat .cat-ver { font-size: 12px; margin: 2px 0 6px; }
`,
};
