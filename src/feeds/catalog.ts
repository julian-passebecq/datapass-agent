// Read-only inventory of what Claude Code and Codex have installed and configured: skills, subagents, slash
// commands, output styles, plugins (and what they bring), hooks, MCP servers, settings keys, instruction files,
// memory file names, Codex skills / plugins / rules / prompts / config, and the CLI options parsed from --help.
// Pure fs reads with size caps (plus `<cli> --help` / `--version` when trusted). Never returns env values, args,
// headers, URLs, auth files or anything key / token-like: values pass an allow-list, then redact().
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { bounded } from '../util/redact';
import { isPlausibleLocalPath, normalizeCase } from '../util/paths';
import { resolveExe } from '../git/git';
import { CodexConfig, frontMatter, isForbidden, LayerKind, parseToml, readCodexConfig, TomlValue } from './settings';

export type Provider = 'claude' | 'codex';
/** Where an item comes from. `system` = shipped with the CLI (Codex .system skills). */
export type Source = 'user' | 'project' | 'local' | 'plugin' | 'system' | 'managed';
export type ItemKind = 'skill' | 'agent' | 'command' | 'output-style' | 'prompt';

export interface CatItem {
  provider: Provider;
  kind: ItemKind;
  source: Source;
  /** Plugin id (name@marketplace or name) when source = plugin. */
  plugin?: string;
  /** False for an item of a plugin that is available in a marketplace but neither installed nor enabled. */
  active: boolean;
  root?: string;
  file: string;
  name: string;
  description?: string;
  model?: string;
  effort?: string;
  tools?: string;
  argumentHint?: string;
  /** Skills: files in the skill folder (DERIVED, capped). */
  files?: number;
}

export interface PluginInfo {
  provider: Provider;
  id: string;
  name: string;
  marketplace?: string;
  version?: string;
  description?: string;
  /** undefined = not mentioned in any enabledPlugins / config. */
  enabled?: boolean;
  installed: boolean;
  dir: string;
  manifest?: string;
  skills: number;
  agents: number;
  commands: number;
  hooks: number;
  mcp: number;
  /** Repos whose project settings enable / disable it. */
  projects: string[];
}

export interface HookRow {
  event: string;
  matcher: string;
  type: string;
  /** Program name only (basename of the first word), plus a script basename when the second word is a script. */
  program: string;
  source: Source;
  plugin?: string;
  root?: string;
  file: string;
  timeout?: number;
}

export interface McpRow {
  provider: Provider;
  name: string;
  transport: string;
  /** Basename of the command, never its args, env, headers or URL. */
  program?: string;
  source: Source;
  plugin?: string;
  root?: string;
  /** Where it is declared. ~/.claude.json is listed but never offered for opening. */
  file: string;
}

export interface SettingRow {
  key: string;
  /** Scalar value when it is safe to show, else a shape ("set", "3 items"). */
  value: string;
  layer: LayerKind;
  root?: string;
  file: string;
}

export interface InstrFile {
  provider: Provider;
  source: Source;
  root?: string;
  file: string;
  bytes: number;
  lines: number;
  headings: string[];
}

export interface MemoryDir {
  /** Encoded project folder name under ~/.claude/projects. */
  project: string;
  dir: string;
  count: number;
  names: string[];
}

export interface CodexRules {
  file: string;
  rules: number;
}

export interface CliFlag {
  flag: string;
  short?: string;
  arg?: string;
  description: string;
}

export interface CliCommand {
  name: string;
  args?: string;
  description: string;
}

export interface CliInfo {
  tool: Provider;
  status: 'ok' | 'untrusted' | 'missing' | 'error' | 'off';
  exe?: string;
  version?: string;
  error?: string;
  flags: CliFlag[];
  commands: CliCommand[];
  at: number;
}

export interface CatalogReport {
  at: number;
  claudeHome: string;
  codexHome: string;
  roots: string[];
  items: CatItem[];
  plugins: PluginInfo[];
  hooks: HookRow[];
  mcp: McpRow[];
  settings: SettingRow[];
  instructions: InstrFile[];
  memory: MemoryDir[];
  codexConfig?: CodexConfig;
  codexRules: CodexRules[];
  /** Every path the screen may open (validated against it in actions). */
  files: string[];
  errors: string[];
}

export interface CatalogInput {
  claudeHome: string;
  codexHome: string;
  /** ~/.claude.json (MCP server names only are read from it). */
  claudeJson?: string;
  managedFile?: string;
  roots: string[];
  now?: number;
}

const MAX_BYTES = 1_000_000;
const MAX_JSON_BYTES = 8_000_000;
const MAX_ITEMS = 4000;
const MAX_PLUGINS = 300;
const SECRET_NAME = /(token|secret|passw|api_?key|apikey|access_?key|private|credential|auth|bearer|cookie|session_?id|helper)/i;
/** Never descended into: secrets, credentials, dependency trees. */
const SKIP_DIR = /^(secrets?|node_modules|\.git|credentials?)$/i;

function stat(file: string): fs.Stats | undefined {
  try {
    return fs.statSync(file);
  } catch {
    return undefined;
  }
}

function dirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(e => (e.isDirectory() || e.isSymbolicLink()) && !SKIP_DIR.test(e.name))
      .map(e => e.name)
      .sort();
  } catch {
    return [];
  }
}

function filesIn(dir: string, re: RegExp): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && re.test(e.name))
      .map(e => e.name)
      .sort();
  } catch {
    return [];
  }
}

function readText(file: string, max = MAX_BYTES): string | undefined {
  if (isForbidden(file)) return undefined;
  const st = stat(file);
  if (!st || !st.isFile() || st.size > max) return undefined;
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** First 16 KB of a file (enough for YAML front matter) without reading large skill bodies. */
function readHead(file: string, max = 16_384): string | undefined {
  if (isForbidden(file)) return undefined;
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(max);
    const n = fs.readSync(fd, buf, 0, max, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function readJson(file: string, max = MAX_BYTES): Record<string, unknown> | undefined {
  const t = readText(file, max);
  if (t === undefined) return undefined;
  try {
    const j = JSON.parse(t.replace(/^\uFEFF/, ''));
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : undefined;
  } catch {
    try {
      const noComments = t.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, s) => s ?? '').replace(/,(\s*[}\]])/g, '$1');
      const j = JSON.parse(noComments);
      return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const s = (v: unknown, max = 80): string | undefined => (typeof v === 'string' && v.trim() ? bounded(v, max) : undefined);

/** Counts files under a folder (depth ≤ 4, cap 500). DERIVED. */
export function countFiles(dir: string, depth = 4, cap = 500): number {
  let n = 0;
  const walk = (d: string, left: number) => {
    let es: fs.Dirent[];
    try {
      es = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of es) {
      if (n >= cap) return;
      if (e.isFile()) n++;
      else if (e.isDirectory() && left > 0 && !SKIP_DIR.test(e.name)) walk(path.join(d, e.name), left - 1);
    }
  };
  walk(dir, depth);
  return n;
}

// ---------------------------------------------------------------- redaction helpers

/** Program name of a command line: basename of the first word, plus the basename of a script second word. */
export function programOf(command: unknown): string {
  if (typeof command !== 'string' || !command.trim()) return '';
  const words: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command.trim())) && words.length < 2) words.push(m[1] ?? m[2] ?? m[3]);
  const base = (w: string) => w.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? w;
  const prog = base(words[0] ?? '');
  const second = words[1] && /\.(py|js|mjs|cjs|ts|ps1|sh|bash|cmd|bat|rb|pl)$/i.test(words[1]) && !/^-/.test(words[1]) ? base(words[1]) : '';
  return bounded([prog, second].filter(Boolean).join(' '), 60);
}

/** Heading lines (#, ##, ###) outside code fences. */
export function headingsOf(text: string, max = 40): string[] {
  const out: string[] = [];
  let fence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    const m = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) out.push(`${'  '.repeat(m[1].length - 1)}${bounded(m[2], 90)}`);
    if (out.length >= max) break;
  }
  return out;
}

// ---------------------------------------------------------------- markdown items

interface ItemCtx {
  provider: Provider;
  source: Source;
  root?: string;
  plugin?: string;
  active: boolean;
}

function pushItem(out: CatItem[], file: string, kind: ItemKind, c: ItemCtx, fallback: string, files?: number): void {
  if (out.length >= MAX_ITEMS) return;
  const text = readHead(file);
  const fm = text ? frontMatter(text) : {};
  out.push({
    provider: c.provider,
    kind,
    source: c.source,
    plugin: c.plugin,
    active: c.active,
    root: c.root,
    file,
    name: bounded(fm.name || fallback, 70),
    description: fm.description ? bounded(fm.description, 220) : undefined,
    model: fm.model ? bounded(fm.model, 40) : undefined,
    effort: fm.effort ? bounded(fm.effort, 20) : undefined,
    tools: fm.tools || fm['allowed-tools'] ? bounded(fm.tools || fm['allowed-tools'], 160) : undefined,
    argumentHint: fm['argument-hint'] ? bounded(fm['argument-hint'], 80) : undefined,
    files,
  });
}

/** skills/<name>/SKILL.md (and one nested level for grouped skills). */
export function scanSkills(dir: string, c: ItemCtx, out: CatItem[]): number {
  let n = 0;
  for (const d of dirs(dir)) {
    if (d.startsWith('.')) continue;
    const f = path.join(dir, d, 'SKILL.md');
    if (stat(f)?.isFile()) {
      pushItem(out, f, 'skill', c, d, c.active ? countFiles(path.join(dir, d)) : undefined);
      n++;
      continue;
    }
    for (const sub of dirs(path.join(dir, d)).slice(0, 60)) {
      const g = path.join(dir, d, sub, 'SKILL.md');
      if (stat(g)?.isFile()) {
        pushItem(out, g, 'skill', c, `${d}/${sub}`, c.active ? countFiles(path.join(dir, d, sub)) : undefined);
        n++;
      }
    }
  }
  return n;
}

/** <dir>/*.md, with sub-folders as namespaces (commands/ns/x.md → ns:x), depth ≤ 3. */
export function scanMd(dir: string, kind: ItemKind, c: ItemCtx, out: CatItem[], ns = '', depth = 3): number {
  let n = 0;
  for (const f of filesIn(dir, /\.md$/i)) {
    if (/^readme\.md$/i.test(f)) continue;
    const base = f.replace(/\.md$/i, '');
    pushItem(out, path.join(dir, f), kind, c, ns ? `${ns}:${base}` : base);
    n++;
  }
  if (depth > 0) for (const d of dirs(dir).slice(0, 80)) n += scanMd(path.join(dir, d), kind, c, out, ns ? `${ns}:${d}` : d, depth - 1);
  return n;
}

function scanClaudeDir(base: string, c: ItemCtx, out: CatItem[]): { skills: number; agents: number; commands: number; styles: number } {
  return {
    skills: scanSkills(path.join(base, 'skills'), c, out),
    agents: scanMd(path.join(base, 'agents'), 'agent', c, out, '', 1),
    commands: scanMd(path.join(base, 'commands'), 'command', c, out),
    styles: scanMd(path.join(base, 'output-styles'), 'output-style', c, out, '', 0),
  };
}

// ---------------------------------------------------------------- hooks and MCP

export function hooksFrom(v: unknown, base: Omit<HookRow, 'event' | 'matcher' | 'type' | 'program' | 'timeout'>, out: HookRow[]): number {
  let n = 0;
  for (const [event, groups] of Object.entries(obj(v))) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      const go = obj(g);
      const matcher = s(go.matcher, 60) ?? '';
      for (const h of Array.isArray(go.hooks) ? go.hooks : []) {
        const r = obj(h);
        const type = s(r.type, 20) ?? 'command';
        const program = typeof r.command === 'string' ? programOf(r.command) : type === 'http' || r.url ? 'http' : typeof r.prompt === 'string' ? 'prompt' : '';
        out.push({ ...base, event: bounded(event, 40), matcher, type, program, timeout: typeof r.timeout === 'number' ? r.timeout : undefined });
        n++;
        if (out.length >= MAX_ITEMS) return n;
      }
    }
  }
  return n;
}

export function mcpFrom(v: unknown, base: Omit<McpRow, 'name' | 'transport' | 'program'>, out: McpRow[]): number {
  let n = 0;
  for (const [name, cfg] of Object.entries(obj(v)).slice(0, 200)) {
    const c = obj(cfg);
    const transport = s(c.type, 20) ?? s(c.transport, 20) ?? (typeof c.command === 'string' ? 'stdio' : typeof c.url === 'string' ? 'http' : '?');
    out.push({ ...base, name: SECRET_NAME.test(name) && name.length > 40 ? '(hidden name)' : bounded(name, 60), transport, program: typeof c.command === 'string' ? programOf(c.command).split(' ')[0] : undefined });
    n++;
  }
  return n;
}

// ---------------------------------------------------------------- settings keys

/** String settings whose value is shown (everything else shows as "set"). */
const SHOW_STRING = new Set(['model', 'effortLevel', 'outputStyle', 'theme', 'language', 'defaultMode', 'preferredNotifChannel', 'forceLoginMethod', 'defaultShell', 'agent', 'autoUpdatesChannel', 'subagentModel', 'spinnerTipsEnabled', 'editorMode', 'viewMode']);
const HIDE_KEYS = new Set(['env', 'apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper']);

function shape(v: unknown): string {
  if (Array.isArray(v)) return `${v.length} item${v.length === 1 ? '' : 's'}`;
  if (v && typeof v === 'object') {
    const n = Object.keys(v).length;
    return `${n} key${n === 1 ? '' : 's'}`;
  }
  return 'set';
}

/** Flattens a settings file to depth 2 with safe values only. */
export function settingRows(j: Record<string, unknown>, layer: LayerKind, file: string, root: string | undefined, out: SettingRow[]): void {
  const push = (key: string, value: string) => out.length < MAX_ITEMS && out.push({ key, value, layer, root, file });
  const val = (name: string, v: unknown): string =>
    typeof v === 'boolean' || typeof v === 'number' ? String(v) : typeof v === 'string' ? (SHOW_STRING.has(name) && !SECRET_NAME.test(name) ? bounded(v, 60) : 'set') : shape(v);
  for (const [k, v] of Object.entries(j)) {
    if (SECRET_NAME.test(k) && !HIDE_KEYS.has(k)) {
      push('(hidden key)', 'set');
      continue;
    }
    if (k === 'env') {
      push('env', `${Object.keys(obj(v)).length} variable name(s), values never read`);
      continue;
    }
    if (HIDE_KEYS.has(k)) {
      push(k, 'set');
      continue;
    }
    if (k === 'hooks' || k === 'enabledPlugins' || k === 'mcpServers') {
      push(k, shape(v));
      continue;
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sub = Object.entries(v as Record<string, unknown>);
      if (!sub.length) push(k, '0 keys');
      for (const [k2, v2] of sub.slice(0, 40)) push(`${k}.${SECRET_NAME.test(k2) ? '(hidden key)' : bounded(k2, 40)}`, SECRET_NAME.test(k2) ? 'set' : val(k2, v2));
    } else push(bounded(k, 50), val(k, v));
  }
}

// ---------------------------------------------------------------- plugins

interface PluginRef {
  name: string;
  marketplace?: string;
  dir: string;
  installed: boolean;
  version?: string;
}

/** Plugins known to Claude Code: installed_plugins.json, marketplace catalogs, enabledPlugins of every layer. */
function claudePluginRefs(home: string, enabledIds: Set<string>, errors: string[]): PluginRef[] {
  const refs = new Map<string, PluginRef>();
  const pdir = path.join(home, 'plugins');
  const inst = readJson(path.join(pdir, 'installed_plugins.json'));
  const ip = obj(inst?.plugins);
  for (const [id, raw] of Object.entries(ip).slice(0, MAX_PLUGINS)) {
    const e = obj(Array.isArray(raw) ? raw[0] : raw);
    const [name, marketplace] = id.split('@');
    const dir = typeof e.installPath === 'string' ? e.installPath : '';
    if (dir) refs.set(id, { name, marketplace, dir, installed: true, version: s(e.version, 30) });
  }
  const known = readJson(path.join(pdir, 'known_marketplaces.json'));
  const mks = new Map<string, string>();
  for (const [m, e] of Object.entries(obj(known))) if (typeof obj(e).installLocation === 'string') mks.set(m, obj(e).installLocation as string);
  for (const m of dirs(path.join(pdir, 'marketplaces'))) if (!mks.has(m)) mks.set(m, path.join(pdir, 'marketplaces', m));
  for (const [m, loc] of mks) {
    if (!isPlausibleLocalPath(loc)) continue;
    const cat = readJson(path.join(loc, '.claude-plugin', 'marketplace.json'), 4_000_000);
    const list = Array.isArray(cat?.plugins) ? (cat!.plugins as unknown[]) : [];
    if (!cat && stat(loc)) errors.push(`marketplace ${bounded(m, 40)}: no readable .claude-plugin/marketplace.json`);
    for (const p of list.slice(0, MAX_PLUGINS)) {
      const o = obj(p);
      const name = s(o.name, 60);
      if (!name) continue;
      const id = `${name}@${m}`;
      if (refs.has(id)) continue;
      const src = typeof o.source === 'string' ? o.source : undefined;
      const dir = src && !/^[a-z]+:/i.test(src) ? path.resolve(loc, src) : path.join(loc, 'plugins', name);
      refs.set(id, { name, marketplace: m, dir, installed: false, version: s(o.version, 30) });
    }
  }
  // install cache: plugins/cache/<marketplace>/<plugin>/<version>
  for (const m of dirs(path.join(pdir, 'cache'))) {
    for (const p of dirs(path.join(pdir, 'cache', m))) {
      const id = `${p}@${m}`;
      const vs = dirs(path.join(pdir, 'cache', m, p));
      const v = vs.includes('latest') ? 'latest' : vs[vs.length - 1];
      const dir = v ? path.join(pdir, 'cache', m, p, v) : path.join(pdir, 'cache', m, p);
      const prev = refs.get(id);
      if (!prev || !prev.installed) refs.set(id, { name: p, marketplace: m, dir, installed: true, version: prev?.version ?? (v && v !== 'latest' ? bounded(v, 30) : undefined) });
    }
  }
  for (const id of enabledIds) if (!refs.has(id)) {
    const [name, marketplace] = id.split('@');
    refs.set(id, { name, marketplace, dir: '', installed: false });
  }
  return [...refs.values()].slice(0, MAX_PLUGINS);
}

function scanPlugin(ref: PluginRef, provider: Provider, enabled: boolean | undefined, items: CatItem[], hooks: HookRow[], mcp: McpRow[], files: string[]): PluginInfo {
  const id = ref.marketplace ? `${ref.name}@${ref.marketplace}` : ref.name;
  const active = ref.installed || enabled === true;
  const info: PluginInfo = { provider, id, name: ref.name, marketplace: ref.marketplace, version: ref.version, enabled, installed: ref.installed, dir: ref.dir, skills: 0, agents: 0, commands: 0, hooks: 0, mcp: 0, projects: [] };
  if (!ref.dir || !stat(ref.dir)?.isDirectory()) return info;
  const manifest = [path.join(ref.dir, provider === 'codex' ? '.codex-plugin' : '.claude-plugin', 'plugin.json'), path.join(ref.dir, 'plugin.json')].find(f => stat(f)?.isFile());
  if (manifest) {
    const m = readJson(manifest);
    info.manifest = manifest;
    files.push(manifest);
    info.version = s(m?.version, 30) ?? info.version;
    info.description = s(m?.description, 220);
  }
  if (!active) {
    // available only: count from directory listings, read nothing else (marketplaces list hundreds)
    info.skills = dirs(path.join(ref.dir, 'skills')).filter(d => !d.startsWith('.')).length;
    info.agents = filesIn(path.join(ref.dir, 'agents'), /\.md$/i).length;
    info.commands = filesIn(path.join(ref.dir, provider === 'claude' ? 'commands' : 'prompts'), /\.md$/i).length;
    info.hooks = stat(path.join(ref.dir, 'hooks', 'hooks.json')) ? 1 : 0;
    info.mcp = stat(path.join(ref.dir, '.mcp.json')) ? 1 : 0;
    return info;
  }
  const c: ItemCtx = { provider, source: 'plugin', plugin: id, active };
  const before = items.length;
  info.skills = scanSkills(path.join(ref.dir, 'skills'), c, items);
  if (provider === 'claude') {
    info.agents = scanMd(path.join(ref.dir, 'agents'), 'agent', c, items, '', 1);
    info.commands = scanMd(path.join(ref.dir, 'commands'), 'command', c, items);
    scanMd(path.join(ref.dir, 'output-styles'), 'output-style', c, items, '', 0);
  } else info.commands = scanMd(path.join(ref.dir, 'prompts'), 'prompt', c, items, '', 0);
  for (const it of items.slice(before)) files.push(it.file);
  const hf = path.join(ref.dir, 'hooks', 'hooks.json');
  const hj = readJson(hf);
  if (hj) {
    info.hooks = hooksFrom(hj.hooks ?? hj, { source: 'plugin', plugin: id, file: hf }, hooks);
    files.push(hf);
  }
  const mf = path.join(ref.dir, '.mcp.json');
  const mj = readJson(mf);
  if (mj) {
    info.mcp = mcpFrom(mj.mcpServers ?? mj, { provider, source: 'plugin', plugin: id, file: mf }, mcp);
    files.push(mf);
  }
  return info;
}

// ---------------------------------------------------------------- instructions and memory

function instr(file: string, provider: Provider, source: Source, root: string | undefined, out: InstrFile[]): void {
  const st = stat(file);
  if (!st || !st.isFile()) return;
  const text = readText(file) ?? '';
  out.push({ provider, source, root, file, bytes: st.size, lines: text ? text.split('\n').length : 0, headings: headingsOf(text) });
}

function memoryDirs(home: string): MemoryDir[] {
  const out: MemoryDir[] = [];
  const base = path.join(home, 'projects');
  for (const p of dirs(base)) {
    const dir = path.join(base, p, 'memory');
    const names = filesIn(dir, /\.md$/i);
    if (!names.length) continue;
    out.push({ project: bounded(p, 120), dir, count: names.length, names: names.slice(0, 100).map(n => bounded(n, 80)) });
    if (out.length >= 500) break;
  }
  return out;
}

// ---------------------------------------------------------------- collection

export function collectCatalog(input: CatalogInput): CatalogReport {
  const errors: string[] = [];
  const homeParent = normalizeCase(path.dirname(input.claudeHome));
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const r of input.roots) {
    if (!isPlausibleLocalPath(r)) continue;
    const k = normalizeCase(path.resolve(r));
    if (seen.has(k) || k === homeParent) continue;
    seen.add(k);
    if (stat(r)?.isDirectory()) roots.push(r);
    if (roots.length >= 80) break;
  }
  const items: CatItem[] = [];
  const hooks: HookRow[] = [];
  const mcp: McpRow[] = [];
  const settings: SettingRow[] = [];
  const instructions: InstrFile[] = [];
  const files: string[] = [];

  // settings layers: keys, hooks, enabledPlugins
  const layers: { kind: LayerKind; file: string; root?: string }[] = [];
  if (input.managedFile) layers.push({ kind: 'managed', file: input.managedFile });
  layers.push({ kind: 'user', file: path.join(input.claudeHome, 'settings.json') });
  for (const r of roots) {
    layers.push({ kind: 'project', file: path.join(r, '.claude', 'settings.json'), root: r });
    layers.push({ kind: 'local', file: path.join(r, '.claude', 'settings.local.json'), root: r });
  }
  const enabled = new Map<string, boolean>();
  const enabledBy = new Map<string, Set<string>>();
  for (const l of layers) {
    const j = readJson(l.file);
    if (!j) {
      if (stat(l.file)?.isFile()) errors.push(`${bounded(l.file, 120)}: unreadable or too large`);
      continue;
    }
    files.push(l.file);
    settingRows(j, l.kind, l.file, l.root, settings);
    hooksFrom(j.hooks, { source: l.kind === 'project' ? 'project' : l.kind, root: l.root, file: l.file }, hooks);
    for (const [id, on] of Object.entries(obj(j.enabledPlugins))) {
      const v = on !== false;
      // managed comes first, so it wins over user; repos are listed as overrides
      if (!l.root) {
        if (!enabled.has(id)) enabled.set(id, v);
      } else enabledBy.set(id, (enabledBy.get(id) ?? new Set()).add(`${path.basename(l.root) || l.root}${v ? '' : ' (off)'}`));
    }
  }
  // user / project markdown items
  const mark = items.length;
  scanClaudeDir(input.claudeHome, { provider: 'claude', source: 'user', active: true }, items);
  for (const r of roots) scanClaudeDir(path.join(r, '.claude'), { provider: 'claude', source: 'project', root: r, active: true }, items);
  for (const it of items.slice(mark)) files.push(it.file);

  // plugins
  const plugins: PluginInfo[] = [];
  const enabledIds = new Set([...enabled.keys(), ...enabledBy.keys()]);
  for (const ref of claudePluginRefs(input.claudeHome, enabledIds, errors)) {
    const id = ref.marketplace ? `${ref.name}@${ref.marketplace}` : ref.name;
    const userOn = enabled.has(id) ? enabled.get(id) : undefined;
    const p = scanPlugin(ref, 'claude', userOn, items, hooks, mcp, files);
    p.projects = [...(enabledBy.get(id) ?? [])].sort();
    plugins.push(p);
  }

  // MCP: ~/.claude.json (user + per-project local), project .mcp.json
  if (input.claudeJson) {
    const cj = readJson(input.claudeJson, MAX_JSON_BYTES);
    if (cj) {
      mcpFrom(cj.mcpServers, { provider: 'claude', source: 'user', file: input.claudeJson }, mcp);
      for (const [p, e] of Object.entries(obj(cj.projects)).slice(0, 2000)) {
        if (!isPlausibleLocalPath(p)) continue;
        mcpFrom(obj(e).mcpServers, { provider: 'claude', source: 'local', root: p, file: input.claudeJson }, mcp);
      }
    }
  }
  for (const r of roots) {
    const f = path.join(r, '.mcp.json');
    const j = readJson(f);
    if (!j) continue;
    files.push(f);
    mcpFrom(j.mcpServers ?? j, { provider: 'claude', source: 'project', root: r, file: f }, mcp);
  }

  // instruction files
  instr(path.join(input.claudeHome, 'CLAUDE.md'), 'claude', 'user', undefined, instructions);
  instr(path.join(input.codexHome, 'AGENTS.md'), 'codex', 'user', undefined, instructions);
  for (const r of roots) {
    instr(path.join(r, 'CLAUDE.md'), 'claude', 'project', r, instructions);
    instr(path.join(r, '.claude', 'CLAUDE.md'), 'claude', 'project', r, instructions);
    instr(path.join(r, 'CLAUDE.local.md'), 'claude', 'local', r, instructions);
    instr(path.join(r, 'AGENTS.md'), 'codex', 'project', r, instructions);
  }
  for (const i of instructions) files.push(i.file);

  // Codex
  const cx = input.codexHome;
  let codexConfig: CodexConfig | undefined;
  const cfgFile = path.join(cx, 'config.toml');
  if (stat(cfgFile)?.isFile()) {
    codexConfig = readCodexConfig(cfgFile, 'user');
    files.push(cfgFile);
    const t = readText(cfgFile);
    if (t) {
      let toml: { [k: string]: TomlValue } = {};
      try {
        toml = parseToml(t);
      } catch {
        /* readCodexConfig already reported it */
      }
      mcpFrom(toml.mcp_servers, { provider: 'codex', source: 'user', file: cfgFile }, mcp);
    }
  }
  const cmark = items.length;
  const userSkills = path.join(cx, 'skills');
  scanSkills(userSkills, { provider: 'codex', source: 'user', active: true }, items);
  // .system skills ship with Codex
  scanSkills(path.join(userSkills, '.system'), { provider: 'codex', source: 'system', active: true }, items);
  scanMd(path.join(cx, 'prompts'), 'prompt', { provider: 'codex', source: 'user', active: true }, items, '', 0);
  for (const r of roots) scanSkills(path.join(r, '.codex', 'skills'), { provider: 'codex', source: 'project', root: r, active: true }, items);
  for (const it of items.slice(cmark)) files.push(it.file);
  const codexOn = new Map((codexConfig?.plugins ?? []).map(p => [p.name, p.on] as const));
  for (const m of dirs(path.join(cx, 'plugins', 'cache'))) {
    for (const p of dirs(path.join(cx, 'plugins', 'cache', m))) {
      if (plugins.length >= MAX_PLUGINS * 2) break;
      const vs = dirs(path.join(cx, 'plugins', 'cache', m, p));
      const v = vs.includes('latest') ? 'latest' : vs[vs.length - 1];
      const dir = v ? path.join(cx, 'plugins', 'cache', m, p, v) : path.join(cx, 'plugins', 'cache', m, p);
      const id = `${p}@${m}`;
      const on = codexOn.has(id) ? codexOn.get(id) : codexOn.has(p) ? codexOn.get(p) : undefined;
      plugins.push(scanPlugin({ name: p, marketplace: m, dir, installed: true, version: v && v !== 'latest' ? bounded(v, 30) : vs.filter(x => x !== 'latest').pop() }, 'codex', on, items, hooks, mcp, files));
    }
  }
  const codexRules: CodexRules[] = [];
  for (const f of filesIn(path.join(cx, 'rules'), /\.rules$/i).slice(0, 50)) {
    const file = path.join(cx, 'rules', f);
    const t = readText(file) ?? '';
    codexRules.push({ file, rules: (t.match(/^\s*prefix_rule\s*\(/gm) ?? []).length });
    files.push(file);
  }

  return {
    at: input.now ?? Date.now(),
    claudeHome: input.claudeHome,
    codexHome: input.codexHome,
    roots,
    items,
    plugins,
    hooks,
    mcp,
    settings,
    instructions,
    memory: memoryDirs(input.claudeHome),
    codexConfig,
    codexRules,
    files: [...new Set(files)].filter(f => !isForbidden(f) && (!input.claudeJson || normalizeCase(f) !== normalizeCase(input.claudeJson))),
    errors: errors.slice(0, 20),
  };
}

// ---------------------------------------------------------------- CLI --help

const FLAG_HEAD = /^(\s{1,8})(-{1,2}[A-Za-z0-9?][^\s,]*(?:,\s*-{1,2}[A-Za-z0-9][^\s,]*)*(?:[ =][<[].*?)?)(?:\s{2,}(.*))?$/;

/** Parses commander (claude) and clap (codex) style --help output into flags and sub-commands. */
export function parseHelp(text: string): { flags: CliFlag[]; commands: CliCommand[] } {
  const flags: CliFlag[] = [];
  const commands: CliCommand[] = [];
  const lines = text.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/);
  let section = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const sec = /^([A-Z][A-Za-z ]*):\s*$/.exec(line);
    if (sec) {
      section = sec[1].toLowerCase();
      continue;
    }
    if (!line.trim()) continue;
    const indent = /^\s*/.exec(line)![0].length;
    // description: rest of the head line, then deeper-indented lines up to a blank line
    const desc = (first: string | undefined): string => {
      const parts = first ? [first.trim()] : [];
      while (i + 1 < lines.length) {
        const nx = lines[i + 1];
        const ni = /^\s*/.exec(nx)![0].length;
        if (!nx.trim()) {
          if (parts.length) break;
          i++;
          continue;
        }
        if (ni <= indent) break;
        parts.push(nx.trim());
        i++;
      }
      return bounded(parts.join(' '), 400);
    };
    if (section.includes('option') || (section === '' && /^\s+-/.test(line))) {
      const m = FLAG_HEAD.exec(line);
      if (!m || indent > 8) continue;
      const head = m[2].trim();
      const names = head.split(/[ =](?=[<[])/)[0].split(/,\s*/);
      const arg = /[ =]([<[].*)$/.exec(head)?.[1];
      const short = names.find(n => /^-[^-]/.test(n));
      const long = names.filter(n => n.startsWith('--'));
      flags.push({ flag: bounded(long.join(', ') || short || head, 80), short: long.length && short ? short : undefined, arg: arg ? bounded(arg, 60) : undefined, description: desc(m[3]) });
    } else if (section.includes('command')) {
      const m = /^(\s{1,6})(\S+)((?:\s\S+)*?)(?:\s{2,}(.*))?$/.exec(line);
      if (!m || indent > 6) continue;
      const name = m[2].split('|')[0];
      if (!/^[a-z][\w:-]*$/i.test(name)) continue;
      commands.push({ name: bounded(m[2], 40), args: m[3]?.trim() ? bounded(m[3].trim(), 60) : undefined, description: desc(m[4]) });
    }
  }
  return { flags, commands };
}

export type HelpRunner = (exe: string, args: string[]) => Promise<{ ok: boolean; out: string; err: string }>;

function childEnv(): NodeJS.ProcessEnv {
  // Locations only; no token, key or proxy variable is forwarded.
  const e: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'Path', 'SystemRoot', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']) if (process.env[k]) e[k] = process.env[k];
  return Object.assign(e, { NO_COLOR: '1', CI: '1', COLUMNS: '200' });
}

export const execHelp: HelpRunner = (exe, args) =>
  new Promise(resolve => {
    execFile(exe, args, { timeout: 5_000, windowsHide: true, maxBuffer: 4 << 20, env: childEnv() }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout ?? ''), err: err ? bounded(String(stderr || (err as Error).message || err), 160) : '' });
    });
  });

const cliCache = new Map<string, CliInfo>();
const DAY = 86400_000;

/** `<tool> --version` and `<tool> --help`, cached a day per executable. Untrusted: nothing runs. */
export async function loadCli(tool: Provider, opts: { trusted: boolean; enabled: boolean; now: number; run?: HelpRunner; resolve?: (n: string) => string | undefined }): Promise<CliInfo> {
  const base: CliInfo = { tool, status: 'ok', flags: [], commands: [], at: opts.now };
  if (!opts.enabled) return { ...base, status: 'off' };
  if (!opts.trusted) return { ...base, status: 'untrusted' };
  const exe = (opts.resolve ?? resolveExe)(tool);
  if (!exe) return { ...base, status: 'missing', error: `${tool} not found as an executable on PATH (.cmd / .ps1 shims are not run)` };
  const hit = cliCache.get(exe);
  if (hit && opts.now - hit.at < DAY) return hit;
  const run = opts.run ?? execHelp;
  const v = await run(exe, ['--version']);
  const h = await run(exe, ['--help']);
  const info: CliInfo = { ...base, exe, version: v.ok ? bounded(v.out.trim().split(/\r?\n/)[0], 60) : undefined };
  if (!h.ok && !h.out) return { ...info, status: 'error', error: h.err || 'no output' };
  Object.assign(info, parseHelp(h.out));
  cliCache.set(exe, info);
  return info;
}

export function clearCliCache(): void {
  cliCache.clear();
}
