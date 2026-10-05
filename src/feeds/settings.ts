// Read-only collector for Claude Code and Codex configuration (settings layers, hooks, subagents, skills,
// commands, memory files, Codex config.toml). Pure fs reads with size caps; no process, no network, no writes.
// Never returns env values, auth files or anything key / token-like: values pass an allow-list, then redact().
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { bounded, safeEnv } from '../util/redact';
import { isPlausibleLocalPath, normalizeCase } from '../util/paths';

export type LayerKind = 'managed' | 'local' | 'project' | 'user';
/** Claude Code precedence, highest first (CC /settings: managed > local project > shared project > user). */
export const LAYER_ORDER: LayerKind[] = ['managed', 'local', 'project', 'user'];

export interface HookEntry {
  event: string;
  matcher: string;
  type: string;
  /** Redacted, single line, bounded. */
  command: string;
  timeout?: number;
}

export interface ClaudeLayer {
  kind: LayerKind;
  /** Repo root for project / local layers. */
  root?: string;
  file: string;
  exists: boolean;
  bytes?: number;
  mtime?: number;
  error?: string;
  model?: string;
  effortLevel?: string;
  defaultMode?: string;
  outputStyle?: string;
  /** "command: …" (redacted) or "set". */
  statusLine?: string;
  allow: string[];
  deny: string[];
  ask: string[];
  additionalDirectories: number;
  hooks: HookEntry[];
  /** Env variable names only (secret-like names are counted, not listed). */
  envNames: string[];
  envHidden: number;
  enabledPlugins: string[];
  /** Other top-level key names (no values). */
  otherKeys: string[];
  apiKeyHelper: boolean;
}

export interface MdItem {
  kind: 'agent' | 'skill' | 'command' | 'output-style';
  scope: 'user' | 'project';
  root?: string;
  file: string;
  name: string;
  description?: string;
  model?: string;
  effort?: string;
  tools?: string;
  mtime?: number;
}

export interface MemoryFile {
  provider: 'claude' | 'codex';
  scope: 'user' | 'project';
  root?: string;
  file: string;
  bytes: number;
  mtime: number;
  lines: number;
}

export interface CodexProfile {
  name: string;
  model?: string;
  effort?: string;
  approval?: string;
  sandbox?: string;
}

export interface CodexConfig {
  scope: 'user' | 'project';
  root?: string;
  file: string;
  exists: boolean;
  bytes?: number;
  mtime?: number;
  error?: string;
  model?: string;
  effort?: string;
  approval?: string;
  sandbox?: string;
  serviceTier?: string;
  profile?: string;
  profiles: CodexProfile[];
  mcpServers: string[];
  notify: boolean;
  features: { name: string; on: boolean }[];
  trustedProjects: number;
  plugins: { name: string; on: boolean }[];
  /** Other table / key names (no values). */
  otherKeys: string[];
}

export interface RootInfo {
  path: string;
  name: string;
}

export interface SettingsReport {
  at: number;
  claudeHome: string;
  codexHome: string;
  roots: RootInfo[];
  layers: ClaudeLayer[];
  items: MdItem[];
  memory: MemoryFile[];
  codex: CodexConfig[];
  /** Every path the screen may open (validated against it in actions). */
  files: string[];
}

export interface SettingsInput {
  claudeHome: string;
  codexHome: string;
  roots: string[];
  managedFile?: string;
  now?: number;
}

const MAX_BYTES = 1_000_000;
const MAX_ROOTS = 60;
const MAX_LIST = 200;
/** Files Agent never opens, lists or reads. */
const FORBIDDEN = /(^|[\\/])(\.credentials\.json|auth\.json|\.env(\..*)?|.*\.pem|.*\.key)$/i;
const SECRET_NAME = /(token|secret|passw|api_?key|apikey|access_?key|private|credential|auth|bearer|cookie|session_?id)/i;

export function isForbidden(file: string): boolean {
  return FORBIDDEN.test(file);
}

export function defaultHomes(): { claudeHome: string; codexHome: string; managedFile: string } {
  const env = safeEnv();
  const home = env.USERPROFILE ?? env.HOME ?? os.homedir();
  return {
    claudeHome: env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude'),
    codexHome: env.CODEX_HOME ?? path.join(home, '.codex'),
    managedFile:
      process.platform === 'win32'
        ? 'C:\\Program Files\\ClaudeCode\\managed-settings.json'
        : process.platform === 'darwin'
          ? '/Library/Application Support/ClaudeCode/managed-settings.json'
          : '/etc/claude-code/managed-settings.json',
  };
}

function stat(file: string): fs.Stats | undefined {
  try {
    return fs.statSync(file);
  } catch {
    return undefined;
  }
}

function readSmall(file: string): { text?: string; st?: fs.Stats; error?: string } {
  if (isForbidden(file)) return { error: 'not read (credential file)' };
  const st = stat(file);
  if (!st || !st.isFile()) return {};
  if (st.size > MAX_BYTES) return { st, error: `too large (${st.size} bytes)` };
  try {
    return { text: fs.readFileSync(file, 'utf8'), st };
  } catch (e) {
    return { st, error: String((e as Error).message ?? e).slice(0, 120) };
  }
}

const str = (v: unknown, max = 80): string | undefined => (typeof v === 'string' && v.trim() ? bounded(v, max) : undefined);
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, MAX_LIST).map(x => bounded(x, 140)) : []);

/** Strips // and /* comments and trailing commas (settings files are JSON, but users sometimes add them). */
function parseJsonLoose(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const noComments = text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, s) => s ?? '');
    return JSON.parse(noComments.replace(/,(\s*[}\]])/g, '$1'));
  }
}

function hooksOf(v: unknown): HookEntry[] {
  const out: HookEntry[] = [];
  if (!v || typeof v !== 'object') return out;
  for (const [event, groups] of Object.entries(v as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!g || typeof g !== 'object') continue;
      const matcher = str((g as Record<string, unknown>).matcher, 60) ?? '';
      const hs = (g as Record<string, unknown>).hooks;
      for (const h of Array.isArray(hs) ? hs : []) {
        if (!h || typeof h !== 'object') continue;
        const r = h as Record<string, unknown>;
        const args = Array.isArray(r.args) ? r.args.filter((a): a is string => typeof a === 'string').map(a => (/\s/.test(a) ? `"${a}"` : a)) : [];
        const command = typeof r.command === 'string' ? str([r.command, ...args].join(' '), 160) : undefined;
        out.push({ event: bounded(event, 40), matcher, type: str(r.type, 20) ?? 'command', command: command ?? str(r.url, 160) ?? (typeof r.prompt === 'string' ? 'prompt' : ''), timeout: typeof r.timeout === 'number' ? r.timeout : undefined });
        if (out.length >= MAX_LIST) return out;
      }
    }
  }
  return out;
}

const KNOWN_CLAUDE = new Set(['model', 'effortLevel', 'permissions', 'hooks', 'outputStyle', 'statusLine', 'env', 'enabledPlugins', 'apiKeyHelper']);

export function readClaudeLayer(kind: LayerKind, file: string, root?: string): ClaudeLayer {
  const layer: ClaudeLayer = { kind, root, file, exists: false, allow: [], deny: [], ask: [], additionalDirectories: 0, hooks: [], envNames: [], envHidden: 0, enabledPlugins: [], otherKeys: [], apiKeyHelper: false };
  const { text, st, error } = readSmall(file);
  if (st) Object.assign(layer, { exists: true, bytes: st.size, mtime: st.mtimeMs });
  if (error) layer.error = error;
  if (text === undefined) return layer;
  let j: unknown;
  try {
    j = parseJsonLoose(text);
  } catch (e) {
    layer.error = `invalid JSON: ${bounded(String((e as Error).message ?? e), 80)}`;
    return layer;
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) {
    layer.error = 'not a JSON object';
    return layer;
  }
  const o = j as Record<string, unknown>;
  layer.model = str(o.model);
  layer.effortLevel = str(o.effortLevel, 20);
  layer.outputStyle = str(o.outputStyle, 40);
  const p = o.permissions && typeof o.permissions === 'object' ? (o.permissions as Record<string, unknown>) : {};
  layer.defaultMode = str(p.defaultMode, 30);
  layer.allow = strArr(p.allow);
  layer.deny = strArr(p.deny);
  layer.ask = strArr(p.ask);
  layer.additionalDirectories = Array.isArray(p.additionalDirectories) ? p.additionalDirectories.length : 0;
  layer.hooks = hooksOf(o.hooks);
  const sl = o.statusLine;
  if (sl && typeof sl === 'object') layer.statusLine = str((sl as Record<string, unknown>).command, 120) ? `command: ${str((sl as Record<string, unknown>).command, 120)}` : 'set';
  else if (typeof sl === 'string') layer.statusLine = bounded(sl, 120);
  if (o.env && typeof o.env === 'object') {
    for (const k of Object.keys(o.env as object)) {
      if (SECRET_NAME.test(k)) layer.envHidden++;
      else if (layer.envNames.length < 50) layer.envNames.push(bounded(k, 60));
    }
  }
  if (o.enabledPlugins && typeof o.enabledPlugins === 'object') {
    layer.enabledPlugins = Object.entries(o.enabledPlugins as Record<string, unknown>).filter(([, v]) => v !== false).map(([k]) => bounded(k, 80)).slice(0, MAX_LIST);
  }
  layer.apiKeyHelper = o.apiKeyHelper !== undefined;
  layer.otherKeys = Object.keys(o).filter(k => !KNOWN_CLAUDE.has(k)).map(k => (SECRET_NAME.test(k) ? '(hidden key)' : bounded(k, 50))).slice(0, 60);
  return layer;
}

/** Minimal YAML front-matter reader: top-level `key: value` pairs only. */
export function frontMatter(text: string): Record<string, string> {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out: Record<string, string> = {};
  if (!m) return out;
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v === '' || v === '|' || v === '>' || v === '|-' || v === '>-') {
      // list or block value: join the indented lines that follow
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim().replace(/^-\s*/, ''));
      v = parts.join(v.startsWith('|') || v.startsWith('>') ? ' ' : ', ');
    }
    out[kv[1]] = v.replace(/^["']|["']$/g, '');
  }
  return out;
}

function listMd(dir: string, kind: MdItem['kind'], scope: MdItem['scope'], root: string | undefined, out: MdItem[]): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names.sort()) {
    if (out.length >= 2000) return;
    let file = path.join(dir, n);
    const st = stat(file);
    if (!st) continue;
    if (kind === 'skill') {
      if (!st.isDirectory()) continue;
      file = path.join(file, 'SKILL.md');
      if (!stat(file)) {
        // plugin-style folders hold several skills one level down
        let sub: string[] = [];
        try {
          sub = fs.readdirSync(path.join(dir, n));
        } catch {
          /* ignore */
        }
        for (const s of sub.slice(0, 50)) {
          const f = path.join(dir, n, s, 'SKILL.md');
          if (stat(f)) pushMd(f, kind, scope, root, out, `${n}/${s}`);
        }
        continue;
      }
      pushMd(file, kind, scope, root, out, n);
    } else if (st.isFile() && n.toLowerCase().endsWith('.md')) pushMd(file, kind, scope, root, out, n.replace(/\.md$/i, ''));
    else if (kind === 'command' && st.isDirectory()) {
      // namespaced commands: commands/<ns>/<name>.md → /ns:name
      let sub: string[] = [];
      try {
        sub = fs.readdirSync(file);
      } catch {
        /* ignore */
      }
      for (const s of sub.filter(x => x.toLowerCase().endsWith('.md')).slice(0, 100)) pushMd(path.join(file, s), kind, scope, root, out, `${n}:${s.replace(/\.md$/i, '')}`);
    }
  }
}

function pushMd(file: string, kind: MdItem['kind'], scope: MdItem['scope'], root: string | undefined, out: MdItem[], fallback: string): void {
  const { text, st } = readSmall(file);
  const fm = text ? frontMatter(text) : {};
  out.push({
    kind,
    scope,
    root,
    file,
    name: bounded(fm.name || fallback, 60),
    description: fm.description ? bounded(fm.description, 180) : undefined,
    model: fm.model ? bounded(fm.model, 40) : undefined,
    effort: fm.effort ? bounded(fm.effort, 20) : undefined,
    tools: fm.tools || fm['allowed-tools'] ? bounded(fm.tools || fm['allowed-tools'], 140) : undefined,
    mtime: st?.mtimeMs,
  });
}

function memory(file: string, provider: MemoryFile['provider'], scope: MemoryFile['scope'], root: string | undefined, out: MemoryFile[]): void {
  const st = stat(file);
  if (!st || !st.isFile()) return;
  let lines = 0;
  if (st.size <= MAX_BYTES) {
    try {
      lines = fs.readFileSync(file, 'utf8').split('\n').length;
    } catch {
      /* ignore */
    }
  }
  out.push({ provider, scope, root, file, bytes: st.size, mtime: st.mtimeMs, lines });
}

// ---------- TOML (subset) ----------

export type TomlValue = string | number | boolean | TomlValue[] | { [k: string]: TomlValue };

function splitKey(s: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let q: string | undefined;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = undefined;
      else if (c === '\\' && q === '"' && i + 1 < s.length) cur += s[++i];
      else cur += c;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '.') {
      parts.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  parts.push(cur.trim());
  return parts.filter(p => p !== '');
}

/** Parses one TOML value starting at s[i]; returns [value, nextIndex]. Unknown forms return a raw string. */
function parseValue(s: string, i: number): [TomlValue, number] {
  while (s[i] === ' ' || s[i] === '\t') i++;
  const c = s[i];
  if (s.startsWith('"""', i) || s.startsWith("'''", i)) {
    const q = s.slice(i, i + 3);
    const end = s.indexOf(q, i + 3);
    const e = end < 0 ? s.length : end;
    return [s.slice(i + 3, e).replace(/^\r?\n/, ''), e + 3];
  }
  if (c === '"') {
    let out = '';
    let j = i + 1;
    for (; j < s.length && s[j] !== '"'; j++) {
      if (s[j] === '\\' && j + 1 < s.length) {
        const n = s[++j];
        out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
      } else out += s[j];
    }
    return [out, j + 1];
  }
  if (c === "'") {
    const e = s.indexOf("'", i + 1);
    return [s.slice(i + 1, e < 0 ? s.length : e), (e < 0 ? s.length : e) + 1];
  }
  if (c === '[') {
    const arr: TomlValue[] = [];
    let j = i + 1;
    for (;;) {
      while (j < s.length && /[\s,]/.test(s[j])) j++;
      if (s[j] === '#') {
        while (j < s.length && s[j] !== '\n') j++;
        continue;
      }
      if (j >= s.length || s[j] === ']') return [arr, j + 1];
      const [v, n] = parseValue(s, j);
      arr.push(v);
      j = n;
    }
  }
  if (c === '{') {
    const obj: { [k: string]: TomlValue } = {};
    let j = i + 1;
    for (;;) {
      while (j < s.length && /[\s,]/.test(s[j])) j++;
      if (j >= s.length || s[j] === '}') return [obj, j + 1];
      const eq = s.indexOf('=', j);
      if (eq < 0) return [obj, s.length];
      const key = splitKey(s.slice(j, eq));
      const [v, n] = parseValue(s, eq + 1);
      setPath(obj, key, v);
      j = n;
    }
  }
  const m = /^[^,\]}\r\n#]*/.exec(s.slice(i))![0];
  const raw = m.trim();
  const v: TomlValue = raw === 'true' ? true : raw === 'false' ? false : /^[+-]?\d[\d_]*(\.\d+)?$/.test(raw) ? Number(raw.replace(/_/g, '')) : raw;
  return [v, i + m.length];
}

function setPath(obj: { [k: string]: TomlValue }, keys: string[], v: TomlValue): void {
  let o = obj;
  for (const k of keys.slice(0, -1)) {
    const cur = o[k];
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) o[k] = {};
    o = o[k] as { [k: string]: TomlValue };
  }
  o[keys[keys.length - 1]] = v;
}

/** Small TOML reader good enough for Codex config.toml (tables, dotted / quoted keys, strings, arrays, inline tables). */
export function parseToml(text: string): { [k: string]: TomlValue } {
  const root: { [k: string]: TomlValue } = {};
  let table: string[] = [];
  let i = 0;
  const s = text.replace(/^\uFEFF/, '');
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    if (s[i] === '#') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (s[i] === '[') {
      const arrayTable = s[i + 1] === '[';
      const end = s.indexOf(arrayTable ? ']]' : ']', i);
      const header = s.slice(i + (arrayTable ? 2 : 1), end < 0 ? s.length : end);
      table = splitKey(header);
      if (arrayTable) table = [...table, String(Date.now() + i)];
      setPath(root, table, {});
      i = (end < 0 ? s.length : end) + (arrayTable ? 2 : 1);
      continue;
    }
    const eq = s.indexOf('=', i);
    const nl = s.indexOf('\n', i);
    if (eq < 0 || (nl >= 0 && nl < eq)) {
      i = nl < 0 ? s.length : nl + 1;
      continue;
    }
    const key = splitKey(s.slice(i, eq));
    const [v, n] = parseValue(s, eq + 1);
    if (key.length) setPath(root, [...table, ...key], v);
    i = n;
    // skip the rest of the line (trailing comment)
    while (i < s.length && s[i] !== '\n') i++;
  }
  return root;
}

const tstr = (v: TomlValue | undefined, max = 60) => (typeof v === 'string' && v ? bounded(v, max) : undefined);
const ttab = (v: TomlValue | undefined): { [k: string]: TomlValue } => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const KNOWN_CODEX = new Set(['model', 'model_reasoning_effort', 'approval_policy', 'sandbox_mode', 'sandbox', 'service_tier', 'profile', 'profiles', 'mcp_servers', 'notify', 'features', 'projects', 'plugins']);

export function readCodexConfig(file: string, scope: CodexConfig['scope'], root?: string): CodexConfig {
  const c: CodexConfig = { scope, root, file, exists: false, profiles: [], mcpServers: [], notify: false, features: [], trustedProjects: 0, plugins: [], otherKeys: [] };
  const { text, st, error } = readSmall(file);
  if (st) Object.assign(c, { exists: true, bytes: st.size, mtime: st.mtimeMs });
  if (error) c.error = error;
  if (text === undefined) return c;
  let t: { [k: string]: TomlValue };
  try {
    t = parseToml(text);
  } catch (e) {
    c.error = `unreadable TOML: ${bounded(String((e as Error).message ?? e), 80)}`;
    return c;
  }
  c.model = tstr(t.model);
  c.effort = tstr(t.model_reasoning_effort, 20);
  c.approval = tstr(t.approval_policy, 30);
  c.sandbox = tstr(t.sandbox_mode, 30) ?? tstr(t.sandbox, 30);
  c.serviceTier = tstr(t.service_tier, 20);
  c.profile = tstr(t.profile, 40);
  for (const [name, p] of Object.entries(ttab(t.profiles)).slice(0, 50)) {
    const q = ttab(p);
    c.profiles.push({ name: bounded(name, 40), model: tstr(q.model), effort: tstr(q.model_reasoning_effort, 20), approval: tstr(q.approval_policy, 30), sandbox: tstr(q.sandbox_mode, 30) ?? tstr(q.sandbox, 30) });
  }
  c.mcpServers = Object.keys(ttab(t.mcp_servers)).slice(0, MAX_LIST).map(k => bounded(k, 50));
  c.notify = Array.isArray(t.notify) ? t.notify.length > 0 : t.notify !== undefined && t.notify !== '' && t.notify !== false;
  c.features = Object.entries(ttab(t.features)).filter(([, v]) => typeof v === 'boolean').map(([k, v]) => ({ name: bounded(k, 40), on: v === true })).slice(0, 60);
  c.trustedProjects = Object.values(ttab(t.projects)).filter(p => ttab(p).trust_level === 'trusted').length;
  c.plugins = Object.entries(ttab(t.plugins)).map(([k, v]) => ({ name: bounded(k, 60), on: ttab(v).enabled !== false })).slice(0, 80);
  c.otherKeys = Object.keys(t).filter(k => !KNOWN_CODEX.has(k)).map(k => (SECRET_NAME.test(k) ? '(hidden key)' : bounded(k, 40))).slice(0, 40);
  return c;
}

// ---------- collection ----------

/** Distinct repo roots (repository, else cwd) of the given sessions, most recent first. */
export function rootsOf(sessions: { repository?: string; cwd?: string; lastActivityAt?: number }[]): string[] {
  const seen = new Map<string, { p: string; t: number }>();
  for (const s of sessions) {
    const p = s.repository ?? s.cwd;
    if (!isPlausibleLocalPath(p)) continue;
    const k = normalizeCase(p);
    const prev = seen.get(k);
    if (!prev || (s.lastActivityAt ?? 0) > prev.t) seen.set(k, { p, t: s.lastActivityAt ?? 0 });
  }
  return [...seen.values()].sort((a, b) => b.t - a.t).map(x => x.p);
}

export function collectSettings(input: SettingsInput): SettingsReport {
  const homeKey = normalizeCase(path.dirname(input.claudeHome));
  const roots: RootInfo[] = [];
  const seen = new Set<string>();
  for (const r of input.roots) {
    if (!isPlausibleLocalPath(r)) continue;
    const k = normalizeCase(path.resolve(r));
    // the home folder's .claude is the user layer, not a project
    if (seen.has(k) || k === homeKey) continue;
    seen.add(k);
    if (!stat(r)?.isDirectory()) continue;
    roots.push({ path: r, name: path.basename(r) || r });
    if (roots.length >= MAX_ROOTS) break;
  }
  const layers: ClaudeLayer[] = [];
  if (input.managedFile) layers.push(readClaudeLayer('managed', input.managedFile));
  layers.push(readClaudeLayer('user', path.join(input.claudeHome, 'settings.json')));
  for (const r of roots) {
    layers.push(readClaudeLayer('project', path.join(r.path, '.claude', 'settings.json'), r.path));
    layers.push(readClaudeLayer('local', path.join(r.path, '.claude', 'settings.local.json'), r.path));
  }

  const items: MdItem[] = [];
  const scan = (base: string, scope: MdItem['scope'], root?: string) => {
    listMd(path.join(base, 'agents'), 'agent', scope, root, items);
    listMd(path.join(base, 'skills'), 'skill', scope, root, items);
    listMd(path.join(base, 'commands'), 'command', scope, root, items);
    listMd(path.join(base, 'output-styles'), 'output-style', scope, root, items);
  };
  scan(input.claudeHome, 'user');
  for (const r of roots) scan(path.join(r.path, '.claude'), 'project', r.path);

  const mem: MemoryFile[] = [];
  memory(path.join(input.claudeHome, 'CLAUDE.md'), 'claude', 'user', undefined, mem);
  memory(path.join(input.codexHome, 'AGENTS.md'), 'codex', 'user', undefined, mem);
  for (const r of roots) {
    memory(path.join(r.path, 'CLAUDE.md'), 'claude', 'project', r.path, mem);
    memory(path.join(r.path, '.claude', 'CLAUDE.md'), 'claude', 'project', r.path, mem);
    memory(path.join(r.path, 'CLAUDE.local.md'), 'claude', 'project', r.path, mem);
    memory(path.join(r.path, 'AGENTS.md'), 'codex', 'project', r.path, mem);
  }

  const codex: CodexConfig[] = [readCodexConfig(path.join(input.codexHome, 'config.toml'), 'user')];
  for (const r of roots) {
    const f = path.join(r.path, '.codex', 'config.toml');
    if (stat(f)) codex.push(readCodexConfig(f, 'project', r.path));
  }

  const files = [...layers.filter(l => l.exists).map(l => l.file), ...items.map(i => i.file), ...mem.map(m => m.file), ...codex.filter(c => c.exists).map(c => c.file)].filter(f => !isForbidden(f));
  return { at: input.now ?? Date.now(), claudeHome: input.claudeHome, codexHome: input.codexHome, roots, layers, items, memory: mem, codex, files };
}

// ---------- effective values ----------

export interface Effective<T> {
  value?: T;
  layer?: LayerKind;
  file?: string;
  /** Lower layers that also set it (shadowed). */
  shadowed: { layer: LayerKind; value: T }[];
}

/** Layers that apply to one scope: managed + user, plus project / local of `root` (undefined = user scope only). */
export function layersFor(report: SettingsReport, root?: string): ClaudeLayer[] {
  const k = root ? normalizeCase(root) : undefined;
  return report.layers
    .filter(l => l.exists && !l.error && (l.kind === 'managed' || l.kind === 'user' || (k !== undefined && l.root !== undefined && normalizeCase(l.root) === k)))
    .sort((a, b) => LAYER_ORDER.indexOf(a.kind) - LAYER_ORDER.indexOf(b.kind));
}

export function effective<K extends 'model' | 'effortLevel' | 'defaultMode' | 'outputStyle' | 'statusLine'>(layers: ClaudeLayer[], key: K): Effective<string> {
  const set = layers.filter(l => l[key] !== undefined);
  const win = set[0];
  return { value: win?.[key], layer: win?.kind, file: win?.file, shadowed: set.slice(1).map(l => ({ layer: l.kind, value: l[key] as string })) };
}

/** Permission rules merge across layers (CC: deny wins over ask over allow). */
export function mergedRules(layers: ClaudeLayer[]): { allow: number; deny: number; ask: number; hooks: number } {
  const u = (f: (l: ClaudeLayer) => string[]) => new Set(layers.flatMap(f)).size;
  return { allow: u(l => l.allow), deny: u(l => l.deny), ask: u(l => l.ask), hooks: layers.reduce((n, l) => n + l.hooks.length, 0) };
}
