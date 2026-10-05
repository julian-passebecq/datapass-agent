// Launcher logic: builds the command line that starts or resumes a Claude Code / Codex session in a
// terminal Agent owns. Pure functions (no vscode, no process), so every rule is unit-tested.
// Safety: only documented CLI flags; permission modes limited to default / plan / acceptEdits (never
// bypassPermissions, never danger-full-access or approval "never"); every token is validated against a
// strict character class, so the command needs no shell quoting and is the same in PowerShell, cmd and sh.
import type { AgentSessionSnapshot, Provider } from '../model';
import { isPlausibleLocalPath, normalizeCase } from '../util/paths';

export type LaunchProvider = 'claude' | 'codex';
export type LaunchMode = 'default' | 'plan' | 'acceptEdits';

export const MODES: LaunchMode[] = ['default', 'plan', 'acceptEdits'];
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const CODEX_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
/** Aliases documented by each CLI; "default" = no flag (the CLI's own setting wins). */
export const DEFAULT_MODELS: Record<LaunchProvider, string[]> = {
  claude: ['opus', 'sonnet', 'haiku'],
  codex: ['gpt-5-codex', 'gpt-5'],
};

/** Session ids we accept for resume. */
export const ID_RE = /^[A-Za-z0-9-]{8,64}$/;
/** Model / profile names: lowercase so they fit the webview option channel. */
export const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
/** Any token placed on the command line. No spaces, quotes, $, `, ;, &, |, <, >, (, ), %, !, ^. */
const TOKEN_RE = /^[A-Za-z0-9._:=/-]{1,80}$/;

export interface LaunchSpec {
  provider: LaunchProvider;
  cwd: string;
  /** Allowed name or undefined for the CLI default. */
  model?: string;
  effort?: string;
  /** Codex profile from ~/.codex/config.toml. */
  profile?: string;
  mode: LaunchMode;
}

export interface Allow {
  models: Record<LaunchProvider, string[]>;
  profiles: string[];
  folders: Folder[];
}

export interface Folder {
  key: string;
  path: string;
  /** Where we saw it. */
  from: 'sessions' | 'workspace' | 'both';
  sessions: number;
}

export type Built = { ok: true; argv: string[]; command: string; cwd: string } | { ok: false; error: string };

/** Joins validated tokens; throws on anything that would need quoting. */
export function joinTokens(argv: string[]): string {
  for (const t of argv) if (!TOKEN_RE.test(t)) throw new Error(`unsafe token: ${JSON.stringify(t.slice(0, 40))}`);
  return argv.join(' ');
}

/** Stable short key of a folder path (FNV-1a, case and slash insensitive). Fits the opt value channel. */
export function folderKey(p: string): string {
  const s = normalizeCase(p.replace(/[\\/]+$/, '')).replace(/\\/g, '/');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return 'f' + h.toString(16).padStart(8, '0');
}

/** A folder we would hand to the terminal as cwd. */
export function isSafeFolder(p: string | undefined): p is string {
  return !!p && p.length <= 400 && isPlausibleLocalPath(p) && !/[\u0000-\u001f\u007f]/.test(p);
}

/** Folders agents used (repository, else cwd; most recent first) plus open workspace folders. */
export function folderChoices(sessions: AgentSessionSnapshot[], workspace: string[], cap = 24): Folder[] {
  const by = new Map<string, Folder & { t: number }>();
  for (const s of sessions) {
    const p = s.repository ?? s.cwd;
    if (!isSafeFolder(p)) continue;
    const k = folderKey(p);
    const f = by.get(k);
    if (f) {
      f.sessions++;
      f.t = Math.max(f.t, s.lastActivityAt ?? 0);
    } else by.set(k, { key: k, path: p, from: 'sessions', sessions: 1, t: s.lastActivityAt ?? 0 });
  }
  for (const p of workspace) {
    if (!isSafeFolder(p)) continue;
    const k = folderKey(p);
    const f = by.get(k);
    if (f) f.from = 'both';
    else by.set(k, { key: k, path: p, from: 'workspace', sessions: 0, t: Number.MAX_SAFE_INTEGER });
  }
  return [...by.values()]
    .sort((a, b) => b.t - a.t || a.path.localeCompare(b.path))
    .slice(0, cap)
    .map(({ t: _t, ...f }) => f);
}

const providerOf = (p: Provider): LaunchProvider => (p === 'codex' ? 'codex' : 'claude');

/** Strips Claude's dated / context suffixes that the CLI would not take as a model name. */
function cleanModel(m: string): string | undefined {
  const v = m.trim().toLowerCase();
  if (!NAME_RE.test(v) || v.startsWith('<') || v === 'synthetic') return undefined;
  return v;
}

/** Allow-list per provider: defaults plus models seen in sessions (most used first), capped. */
export function modelChoices(sessions: AgentSessionSnapshot[], cap = 10): Record<LaunchProvider, string[]> {
  const seen: Record<LaunchProvider, Map<string, number>> = { claude: new Map(), codex: new Map() };
  for (const s of sessions) {
    const m = seen[providerOf(s.provider)];
    const names = new Set<string>([s.model ?? '', ...Object.keys(s.facts?.modelTokens ?? {})]);
    for (const n of names) {
      const c = n && cleanModel(n);
      if (c) m.set(c, (m.get(c) ?? 0) + 1);
    }
  }
  const out = {} as Record<LaunchProvider, string[]>;
  for (const p of ['claude', 'codex'] as LaunchProvider[]) {
    const list = [...DEFAULT_MODELS[p]];
    for (const [n] of [...seen[p].entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) if (!list.includes(n)) list.push(n);
    out[p] = list.slice(0, cap + DEFAULT_MODELS[p].length);
  }
  return out;
}

/** Codex profiles usable as a flag value (names outside NAME_RE are skipped, not rewritten). */
export function profileChoices(names: string[]): string[] {
  return [...new Set(names.filter(n => NAME_RE.test(n)))].slice(0, 30);
}

/** Builds the start command. Every value must come from the allow-lists. */
export function buildStart(spec: LaunchSpec, allow: Allow): Built {
  const folder = allow.folders.find(f => normalizeCase(f.path) === normalizeCase(spec.cwd));
  if (!folder || !isSafeFolder(spec.cwd)) return { ok: false, error: 'Pick a folder from the list.' };
  if (!MODES.includes(spec.mode)) return { ok: false, error: 'Permission mode must be default, plan or acceptEdits.' };
  if (spec.model !== undefined && !allow.models[spec.provider].includes(spec.model)) return { ok: false, error: `Model "${spec.model}" is not in the allow-list.` };
  const argv: string[] = [spec.provider];
  if (spec.provider === 'claude') {
    if (spec.profile !== undefined) return { ok: false, error: 'Profiles are a Codex option.' };
    if (spec.effort !== undefined && !(CLAUDE_EFFORTS as readonly string[]).includes(spec.effort)) return { ok: false, error: `Effort "${spec.effort}" is not a Claude Code level.` };
    if (spec.model) argv.push('--model', spec.model);
    if (spec.effort) argv.push('--effort', spec.effort);
    if (spec.mode !== 'default') argv.push('--permission-mode', spec.mode);
  } else {
    if (spec.effort !== undefined && !(CODEX_EFFORTS as readonly string[]).includes(spec.effort)) return { ok: false, error: `Effort "${spec.effort}" is not a Codex reasoning level.` };
    if (spec.profile !== undefined && !allow.profiles.includes(spec.profile)) return { ok: false, error: `Profile "${spec.profile}" is not in ~/.codex/config.toml.` };
    if (spec.profile) argv.push('--profile', spec.profile);
    if (spec.model) argv.push('--model', spec.model);
    if (spec.effort) argv.push('-c', `model_reasoning_effort=${spec.effort}`);
    // Codex has no plan / acceptEdits mode: map to its sandbox, always with approval on request.
    if (spec.mode === 'plan') argv.push('--sandbox', 'read-only', '--ask-for-approval', 'on-request');
    if (spec.mode === 'acceptEdits') argv.push('--sandbox', 'workspace-write', '--ask-for-approval', 'on-request');
  }
  try {
    return { ok: true, argv, command: joinTokens(argv), cwd: folder.path };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** `claude --resume <id>` / `codex resume <id>` in the session's own folder. */
export function buildResume(s: Pick<AgentSessionSnapshot, 'provider' | 'sessionId' | 'cwd' | 'repository'> | undefined): Built {
  if (!s) return { ok: false, error: 'Select a session first.' };
  if (!ID_RE.test(s.sessionId)) return { ok: false, error: 'This session id cannot be resumed from the CLI.' };
  const cwd = s.cwd ?? s.repository;
  if (!isSafeFolder(cwd)) return { ok: false, error: 'The session has no usable folder.' };
  const argv = providerOf(s.provider) === 'codex' ? ['codex', 'resume', s.sessionId] : ['claude', '--resume', s.sessionId];
  try {
    return { ok: true, argv, command: joinTokens(argv), cwd };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ---------- selection encoding (webview arg ↔ spec) ----------

export interface LaunchPick {
  provider: LaunchProvider;
  folder: string;
  model: string;
  effort: string;
  profile: string;
  mode: string;
}

/** Arg for the Start button: "provider|folderKey|model|effort|profile|mode" (each part re-validated on use). */
export function encodePick(p: LaunchPick): string {
  return [p.provider, p.folder, p.model, p.effort, p.profile, p.mode].join('|');
}

export function decodePick(arg: string): LaunchPick | undefined {
  if (typeof arg !== 'string' || arg.length > 300) return undefined;
  const parts = arg.split('|');
  if (parts.length !== 6) return undefined;
  const [provider, folder, model, effort, profile, mode] = parts;
  if (provider !== 'claude' && provider !== 'codex') return undefined;
  return { provider, folder, model, effort, profile, mode };
}

/** Option values are lowercase; "acceptedits" maps back to the CLI's acceptEdits. */
export function modeOf(v: string): LaunchMode | undefined {
  return v === 'default' ? 'default' : v === 'plan' ? 'plan' : v === 'acceptedits' ? 'acceptEdits' : undefined;
}

/** LaunchPick → spec ("default" / "" mean no flag). Undefined when the folder key is unknown. */
export function specOf(p: LaunchPick, allow: Allow): LaunchSpec | { error: string } {
  const folder = allow.folders.find(f => f.key === p.folder);
  if (!folder) return { error: 'Pick a folder from the list.' };
  const mode = modeOf(p.mode);
  if (!mode) return { error: 'Permission mode must be default, plan or acceptEdits.' };
  const v = (x: string) => (x === '' || x === 'default' || x === 'none' ? undefined : x);
  return { provider: p.provider, cwd: folder.path, model: v(p.model), effort: v(p.effort), profile: p.provider === 'codex' ? v(p.profile) : undefined, mode };
}

// ---------- terminals Agent started (this window only) ----------

export interface OwnedTerminal {
  id: string;
  name: string;
  cwd: string;
  command: string;
  provider: LaunchProvider;
  at: number;
}

const owned: OwnedTerminal[] = [];

export function addOwned(t: OwnedTerminal): void {
  owned.unshift(t);
  if (owned.length > 30) owned.length = 30;
}

/** Removes and returns the entry; undefined for ids Agent did not start. */
export function takeOwned(id: string): OwnedTerminal | undefined {
  const i = owned.findIndex(t => t.id === id);
  return i < 0 ? undefined : owned.splice(i, 1)[0];
}

export function listOwned(): readonly OwnedTerminal[] {
  return owned;
}

export function clearOwned(): void {
  owned.length = 0;
}

/** Terminal tab title: "Agent · Claude · repo" (bounded, no control chars). */
export function terminalName(provider: LaunchProvider, cwd: string, resume = false): string {
  const base = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  return `Agent · ${provider === 'codex' ? 'Codex' : 'Claude'}${resume ? ' resume' : ''} · ${base}`.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 60);
}
