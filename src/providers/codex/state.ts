// Read-only reader for the Codex desktop app's own state (~/.codex sqlite files, writer locks, model cache).
// Undocumented format: every value is OBSERVED from the db, may change between Codex versions.
// Safety: each db (+ -wal / -shm) is COPIED to os.tmpdir()/agent-codex/<pid> and opened readOnly with node:sqlite;
// only whitelisted, non-text columns are selected (never first_user_message, preview, objective, prompt,
// payload_json, item_json, error_json, log bodies). auth.json and secrets/ are never opened.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SourceState, SourceStatus } from '../../model';
import { bounded } from '../../util/redact';

// ---------------------------------------------------------------- types

export interface CodexThread {
  id: string;
  /** User-set name or a title that differs from the first prompt; undefined otherwise. */
  title?: string;
  model?: string;
  effort?: string;
  tokens?: number;
  branch?: string;
  /** host/owner/repo of git_origin_url, nothing else. */
  repo?: string;
  cwd?: string;
  projectId?: string;
  pinned: boolean;
  archived: boolean;
  createdAt?: number;
  updatedAt?: number;
  source?: string;
  nickname?: string;
  role?: string;
}

export interface CodexProject {
  id: string;
  name?: string;
  position?: number;
  roots: string[];
}

export interface CodexEdge {
  parent: string;
  child: string;
  status?: string;
}

export interface CodexAutomation {
  id: string;
  name?: string;
  kind?: string;
  status?: string;
  rrule?: string;
  nextRunAt?: number;
  lastRunAt?: number;
  model?: string;
  effort?: string;
  /** automation_runs counts by status. */
  runs: Record<string, number>;
}

export interface CodexGoal {
  thread: string;
  status?: string;
  tokenBudget?: number;
  tokensUsed?: number;
  timeUsedSec?: number;
  updatedAt?: number;
}

export interface CodexTurn {
  thread: string;
  status?: string;
  startedAt?: number;
  durationMs?: number;
  /** error_json is not read; only whether it is set. */
  failed: boolean;
}

export interface CodexLock {
  id: string;
  mtime: number;
}

export interface CodexModel {
  slug: string;
  name?: string;
  context?: number;
  maxContext?: number;
  defaultEffort?: string;
  efforts: string[];
}

export interface CodexStateSource {
  id: string;
  label: string;
  /** Path relative to the Codex root. */
  file: string;
  status: SourceStatus;
  detail: string;
  count?: number;
}

export interface CodexState {
  root: string;
  at: number;
  /** False when node:sqlite cannot be loaded in this runtime. */
  sqlite: boolean;
  sqliteReason?: string;
  threads: CodexThread[];
  projects: CodexProject[];
  edges: CodexEdge[];
  automations: CodexAutomation[];
  goals: CodexGoal[];
  /** queued_items count per thread. */
  queue: Record<string, number>;
  queueRevisions: number;
  turns: CodexTurn[];
  locks: CodexLock[];
  models: CodexModel[];
  sources: CodexStateSource[];
}

// ---------------------------------------------------------------- node:sqlite (optional)

interface Stmt {
  all(...p: unknown[]): Record<string, unknown>[];
}
interface Db {
  prepare(sql: string): Stmt;
  close(): void;
}
type DbCtor = new (file: string, opts: { readOnly: boolean }) => Db;

let sqliteCache: { ctor?: DbCtor; reason?: string } | undefined;
/** Loads node:sqlite once. A missing module (older Node / Electron) is reported, never thrown. */
export function loadSqlite(): { ctor?: DbCtor; reason?: string } {
  if (sqliteCache) return sqliteCache;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('node:sqlite') as { DatabaseSync?: DbCtor };
    sqliteCache = mod?.DatabaseSync ? { ctor: mod.DatabaseSync } : { reason: 'node:sqlite has no DatabaseSync' };
  } catch (e) {
    sqliteCache = { reason: `node:sqlite unavailable in this runtime (Node ${process.versions.node}): ${bounded(String((e as Error)?.message ?? e), 120)}` };
  }
  return sqliteCache;
}

// ---------------------------------------------------------------- db copies

const BIG = 64 * 1024 * 1024;
const BIG_MIN_MS = 10 * 60_000;

/** Agent's own temp folder for sqlite copies: one sub-folder per extension host process. */
export function codexCopiesBase(): string {
  return path.join(os.tmpdir(), 'agent-codex');
}

const SWEEP_IDLE_MS = 60 * 60_000;

function newestMtime(dir: string): number {
  let t = 0;
  try {
    t = fs.statSync(dir).mtimeMs;
    for (const f of fs.readdirSync(dir)) {
      try {
        t = Math.max(t, fs.statSync(path.join(dir, f)).mtimeMs);
      } catch {
        /* vanished */
      }
    }
  } catch {
    /* gone */
  }
  return t;
}

/** Start-up cleanup of copies left by an earlier run that did not dispose (crash, kill). Only folders Agent
 *  creates are touched: `<base>/<pid>` and the legacy `<tmp>/agent-codex-<pid>`, never this process's own, and
 *  only when nothing in them changed for an hour (another VS Code window may still be using its folder; a
 *  removed folder is simply copied again on its next read). Returns the folders removed. */
export function sweepCodexCopies(o: { base?: string; tmp?: string; now?: number; pid?: number } = {}): string[] {
  const base = o.base ?? codexCopiesBase();
  const tmp = o.tmp ?? os.tmpdir();
  const now = o.now ?? Date.now();
  const own = String(o.pid ?? process.pid);
  const candidates: string[] = [];
  try {
    for (const n of fs.readdirSync(base)) if (/^\d+$/.test(n) && n !== own) candidates.push(path.join(base, n));
  } catch {
    /* no base yet */
  }
  try {
    for (const n of fs.readdirSync(tmp)) {
      const m = /^agent-codex-(\d+)$/.exec(n);
      if (m && m[1] !== own) candidates.push(path.join(tmp, n));
    }
  } catch {
    /* no tmp */
  }
  const removed: string[] = [];
  for (const dir of candidates) {
    try {
      if (!fs.statSync(dir).isDirectory() || now - newestMtime(dir) < SWEEP_IDLE_MS) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch {
      /* in use or gone: next start */
    }
  }
  return removed;
}

/** Temp copies of live sqlite files. A copy is refreshed only when the source size / mtime changed
 *  (big files at most every 10 min). dispose() deletes the folder. */
export class DbCopies {
  readonly dir: string;
  private sig = new Map<string, string>();
  private copiedAt = new Map<string, number>();

  constructor(dir = path.join(codexCopiesBase(), String(process.pid))) {
    this.dir = dir;
  }

  private signature(src: string): { sig: string; size: number } | undefined {
    try {
      const st = fs.statSync(src);
      let sig = `${st.size}:${st.mtimeMs}`;
      let size = st.size;
      for (const s of ['-wal', '-shm']) {
        try {
          const x = fs.statSync(src + s);
          sig += `|${s}${x.size}:${x.mtimeMs}`;
          size += x.size;
        } catch {
          sig += `|${s}none`;
        }
      }
      return { sig, size };
    } catch {
      return undefined;
    }
  }

  /** Returns the path of an up-to-date copy, or undefined when the source does not exist. */
  async ensure(src: string, name: string, now = Date.now()): Promise<string | undefined> {
    const dst = path.join(this.dir, name);
    const cur = this.signature(src);
    if (!cur) return undefined;
    const have = fs.existsSync(dst);
    if (have && this.sig.get(name) === cur.sig) return dst;
    if (have && cur.size > BIG && now - (this.copiedAt.get(name) ?? 0) < BIG_MIN_MS) return dst;
    await fs.promises.mkdir(this.dir, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      await fs.promises.copyFile(src, dst);
      for (const s of ['-wal', '-shm']) {
        if (fs.existsSync(src + s)) await fs.promises.copyFile(src + s, dst + s);
        else await fs.promises.rm(dst + s, { force: true });
      }
      const after = this.signature(src);
      if (after?.sig === cur.sig) break; // stable while copying
    }
    this.sig.set(name, cur.sig);
    this.copiedAt.set(name, now);
    return dst;
  }

  dispose(): void {
    try {
      fs.rmSync(this.dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    this.sig.clear();
    this.copiedAt.clear();
  }
}

// ---------------------------------------------------------------- helpers

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Column names that hold prompt or assistant text: never selected, whatever the table. */
export const FORBIDDEN_COLUMNS = new Set(['first_user_message', 'preview', 'objective', 'prompt', 'payload_json', 'item_json', 'error_json', 'feedback_log_body', 'summary', 'compact_summary', 'inbox_summary', 'inbox_title', 'thread_title', 'archived_user_message', 'archived_assistant_message', 'display_title', 'metadata', 'raw_memory']);

function columns(db: Db, table: string): Set<string> {
  if (!/^[a-z_][a-z0-9_]*$/i.test(table)) return new Set();
  try {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(r => String(r.name)));
  } catch {
    return new Set();
  }
}

/** SELECT of the whitelisted columns that exist (never `*`, never a forbidden column). */
export function selectSql(have: Set<string>, table: string, wanted: string[], tail = ''): string | undefined {
  const cols = wanted.filter(c => have.has(c) && !FORBIDDEN_COLUMNS.has(c));
  return cols.length ? `SELECT ${cols.join(', ')} FROM ${table}${tail ? ' ' + tail : ''}` : undefined;
}

const str = (v: unknown, max = 120): string | undefined => (typeof v === 'string' && v.trim() ? bounded(v, max) : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'bigint' ? Number(v) : undefined);
/** Epoch seconds or ms → ms. */
export function ms(v: unknown): number | undefined {
  const n = num(v);
  if (n === undefined || n <= 0) return undefined;
  return n < 1e12 ? Math.round(n * 1000) : n;
}

/** host/owner/repo only (no scheme, user, token, query). */
export function originRepo(url: unknown): string | undefined {
  if (typeof url !== 'string' || !url) return undefined;
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/\s]+@)?([a-z0-9.-]+)(?::\d+)?[:/]+([^?#\s]+?)(?:\.git)?\/?(?:[?#].*)?$/i.exec(url.trim());
  if (!m) return undefined;
  const parts = m[2].split('/').filter(Boolean);
  if (parts.length < 2) return undefined;
  return bounded(`${m[1].toLowerCase()}/${parts.slice(-2).join('/')}`, 120);
}

function readJson(file: string, max: number): unknown {
  try {
    const st = fs.statSync(file);
    if (st.size > max) return undefined;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- readers (exported for tests)

export function readThreads(db: Db): { threads: CodexThread[]; projects: CodexProject[]; edges: CodexEdge[] } {
  const have = columns(db, 'threads');
  const threads: CodexThread[] = [];
  if (have.has('id')) {
    // Title only when it is not a copy of the prompt; the comparison runs inside SQLite, the prompt is never returned.
    const same = ['first_user_message', 'preview'].filter(c => have.has(c)).map(c => ` OR title = ${c}`).join('');
    const titleExpr = have.has('title') ? `CASE WHEN title IS NULL OR title = ''${same} THEN NULL ELSE title END AS title_safe` : '';
    const base = selectSql(have, 'threads', ['id', 'name', 'model', 'reasoning_effort', 'tokens_used', 'git_branch', 'git_origin_url', 'cwd', 'project_id', 'is_pinned', 'archived', 'created_at', 'created_at_ms', 'updated_at', 'updated_at_ms', 'source', 'thread_source', 'agent_nickname', 'agent_role'])!;
    const sql = titleExpr ? base.replace(/^SELECT /, `SELECT ${titleExpr}, `) : base;
    for (const r of db.prepare(`${sql} LIMIT 20000`).all()) {
      const id = str(r.id, 80);
      if (!id) continue;
      threads.push({
        id,
        title: str(r.name, 100) ?? str(r.title_safe, 100),
        model: str(r.model, 60),
        effort: str(r.reasoning_effort, 20),
        tokens: num(r.tokens_used),
        branch: str(r.git_branch, 100),
        repo: originRepo(r.git_origin_url),
        cwd: str(r.cwd, 300),
        projectId: str(r.project_id, 80),
        pinned: !!num(r.is_pinned),
        archived: !!num(r.archived),
        createdAt: ms(r.created_at_ms) ?? ms(r.created_at),
        updatedAt: ms(r.updated_at_ms) ?? ms(r.updated_at),
        source: str(r.thread_source, 30) ?? str(r.source, 30),
        nickname: str(r.agent_nickname, 60),
        role: str(r.agent_role, 60),
      });
    }
  }
  const projects: CodexProject[] = [];
  const pc = columns(db, 'projects');
  const psql = selectSql(pc, 'projects', ['id', 'name', 'position']);
  if (psql && pc.has('id')) {
    const roots = new Map<string, string[]>();
    const rsql = selectSql(columns(db, 'project_roots'), 'project_roots', ['project_id', 'path', 'position'], 'ORDER BY position');
    if (rsql) for (const r of db.prepare(rsql).all()) {
      const id = str(r.project_id, 80);
      const p = str(r.path, 300);
      if (id && p) roots.set(id, [...(roots.get(id) ?? []), p]);
    }
    for (const r of db.prepare(psql).all()) {
      const id = str(r.id, 80);
      if (id) projects.push({ id, name: str(r.name, 80), position: num(r.position), roots: roots.get(id) ?? [] });
    }
    projects.sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9));
  }
  const edges: CodexEdge[] = [];
  const esql = selectSql(columns(db, 'thread_spawn_edges'), 'thread_spawn_edges', ['parent_thread_id', 'child_thread_id', 'status']);
  if (esql) for (const r of db.prepare(`${esql} LIMIT 20000`).all()) {
    const parent = str(r.parent_thread_id, 80);
    const child = str(r.child_thread_id, 80);
    if (parent && child) edges.push({ parent, child, status: str(r.status, 30) });
  }
  return { threads, projects, edges };
}

export function readAutomations(db: Db): CodexAutomation[] {
  const sql = selectSql(columns(db, 'automations'), 'automations', ['id', 'name', 'kind', 'status', 'rrule', 'next_run_at', 'last_run_at', 'model', 'reasoning_effort']);
  if (!sql) return [];
  const runs = new Map<string, Record<string, number>>();
  const rc = columns(db, 'automation_runs');
  if (rc.has('automation_id') && rc.has('status')) {
    for (const r of db.prepare('SELECT automation_id, status, COUNT(*) AS n FROM automation_runs GROUP BY automation_id, status').all()) {
      const id = str(r.automation_id, 80);
      if (!id) continue;
      const m = runs.get(id) ?? {};
      m[str(r.status, 30) ?? 'unknown'] = num(r.n) ?? 0;
      runs.set(id, m);
    }
  }
  const out: CodexAutomation[] = [];
  for (const r of db.prepare(`${sql} LIMIT 500`).all()) {
    const id = str(r.id, 80);
    if (!id) continue;
    out.push({ id, name: str(r.name, 80), kind: str(r.kind, 30), status: str(r.status, 30), rrule: str(r.rrule, 160), nextRunAt: ms(r.next_run_at), lastRunAt: ms(r.last_run_at), model: str(r.model, 60), effort: str(r.reasoning_effort, 20), runs: runs.get(id) ?? {} });
  }
  return out;
}

export function readGoals(db: Db): CodexGoal[] {
  const sql = selectSql(columns(db, 'thread_goals'), 'thread_goals', ['thread_id', 'status', 'token_budget', 'tokens_used', 'time_used_seconds', 'updated_at_ms']);
  if (!sql) return [];
  return db
    .prepare(`${sql} LIMIT 5000`)
    .all()
    .map(r => ({ thread: str(r.thread_id, 80) ?? '', status: str(r.status, 30), tokenBudget: num(r.token_budget), tokensUsed: num(r.tokens_used), timeUsedSec: num(r.time_used_seconds), updatedAt: ms(r.updated_at_ms) }))
    .filter(g => g.thread);
}

export function readQueue(db: Db): { queue: Record<string, number>; revisions: number } {
  const queue: Record<string, number> = {};
  if (columns(db, 'queued_items').has('thread_id')) {
    for (const r of db.prepare('SELECT thread_id, COUNT(*) AS n FROM queued_items GROUP BY thread_id').all()) {
      const id = str(r.thread_id, 80);
      if (id) queue[id] = num(r.n) ?? 0;
    }
  }
  let revisions = 0;
  if (columns(db, 'queued_thread_revisions').size) revisions = num(db.prepare('SELECT COUNT(*) AS n FROM queued_thread_revisions').all()[0]?.n) ?? 0;
  return { queue, revisions };
}

export function readTurns(db: Db, max = 20000): CodexTurn[] {
  const have = columns(db, 'thread_turns');
  const sql = selectSql(have, 'thread_turns', ['thread_id', 'status', 'started_at', 'duration_ms', 'completed_at']);
  if (!sql || !have.has('thread_id')) return [];
  const failed = have.has('error_json') ? `, (error_json IS NOT NULL AND error_json <> '' AND error_json <> 'null') AS has_error` : '';
  const order = have.has('started_at') ? ' ORDER BY started_at DESC' : '';
  return db
    .prepare(`${sql.replace(/ FROM thread_turns$/, `${failed} FROM thread_turns`)}${order} LIMIT ${Math.max(1, Math.floor(max))}`)
    .all()
    .map(r => {
      const startedAt = ms(r.started_at);
      const done = ms(r.completed_at);
      const durationMs = num(r.duration_ms) ?? (startedAt && done && done >= startedAt ? done - startedAt : undefined);
      const status = str(r.status, 30);
      return { thread: str(r.thread_id, 80) ?? '', status, startedAt, durationMs, failed: !!num(r.has_error) || /fail|error|abort/i.test(status ?? '') };
    })
    .filter(t => t.thread);
}

/** thread-writer-locks/<uuid>.lock: present while Codex writes that thread (INFERRED "running"). */
export function readLocks(root: string): CodexLock[] {
  const dir = path.join(root, 'thread-writer-locks');
  const out: CodexLock[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const f of names) {
    if (!f.endsWith('.lock')) continue;
    const id = f.slice(0, -5);
    if (!UUID.test(id)) continue;
    try {
      out.push({ id: id.toLowerCase(), mtime: fs.statSync(path.join(dir, f)).mtimeMs });
    } catch {
      /* vanished */
    }
  }
  return out;
}

export function readModels(root: string): CodexModel[] {
  const j = readJson(path.join(root, 'models_cache.json'), 4 * 1024 * 1024) as { models?: unknown[] } | undefined;
  if (!j || !Array.isArray(j.models)) return [];
  const out: CodexModel[] = [];
  for (const m of j.models.slice(0, 200)) {
    if (!m || typeof m !== 'object') continue;
    const o = m as Record<string, unknown>;
    const slug = str(o.slug, 60);
    if (!slug) continue;
    const levels = Array.isArray(o.supported_reasoning_levels) ? o.supported_reasoning_levels : [];
    const efforts = levels.map(l => (typeof l === 'string' ? l : (l as { effort?: unknown })?.effort)).filter((x): x is string => typeof x === 'string').map(x => bounded(x, 20));
    out.push({ slug, name: str(o.display_name, 60), context: num(o.context_window), maxContext: num(o.max_context_window), defaultEffort: str(o.default_reasoning_level, 20), efforts });
  }
  return out;
}

// ---------------------------------------------------------------- loader

interface DbSpec {
  id: string;
  label: string;
  file: string;
}
const DBS: DbSpec[] = [
  { id: 'codex.state', label: 'Codex app threads', file: 'state_5.sqlite' },
  { id: 'codex.automations', label: 'Codex automations', file: 'sqlite/codex-dev.db' },
  { id: 'codex.goals', label: 'Codex goals', file: 'goals_1.sqlite' },
  { id: 'codex.queue', label: 'Codex queue', file: 'queue_1.sqlite' },
  { id: 'codex.turns', label: 'Codex turn history', file: 'thread_history_1.sqlite' },
];

let shared: DbCopies | undefined;
let last: CodexState | undefined;
let exitHook = false;

/** Deletes the temp copies (extension deactivate / process exit). Without a live loader it still removes this
 *  process's own copy folder, in case an earlier loader was dropped without dispose. */
export function disposeCodexState(): void {
  shared?.dispose();
  shared = undefined;
  try {
    fs.rmSync(path.join(codexCopiesBase(), String(process.pid)), { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

export function lastCodexState(): CodexState | undefined {
  return last;
}

export interface LoadOpts {
  root: string;
  now?: number;
  copies?: DbCopies;
  /** Test hook: pretend node:sqlite is missing. */
  noSqlite?: boolean;
}

export async function loadCodexState(o: LoadOpts): Promise<CodexState> {
  const now = o.now ?? Date.now();
  const st: CodexState = { root: o.root, at: now, sqlite: false, threads: [], projects: [], edges: [], automations: [], goals: [], queue: {}, queueRevisions: 0, turns: [], locks: readLocks(o.root), models: readModels(o.root), sources: [] };
  const lib = o.noSqlite ? { reason: 'node:sqlite disabled' } : loadSqlite();
  st.sqlite = !!lib.ctor;
  st.sqliteReason = lib.reason;
  if (!lib.ctor) {
    for (const s of DBS) st.sources.push({ id: s.id, label: s.label, file: s.file, status: 'missing', detail: lib.reason ?? 'node:sqlite unavailable' });
  } else {
    let copies = o.copies;
    if (!copies) {
      copies = shared ??= new DbCopies();
      if (!exitHook) {
        exitHook = true;
        process.once('exit', disposeCodexState);
      }
    }
    for (const s of DBS) {
      const src = path.join(o.root, s.file);
      try {
        const copy = await copies.ensure(src, s.file.replace(/[\\/]/g, '_'), now);
        if (!copy) {
          st.sources.push({ id: s.id, label: s.label, file: s.file, status: 'missing', detail: `no ${s.file}` });
          continue;
        }
        const db = new lib.ctor(copy, { readOnly: true });
        let count = 0;
        try {
          if (s.id === 'codex.state') {
            const r = readThreads(db);
            Object.assign(st, r);
            count = r.threads.length;
          } else if (s.id === 'codex.automations') count = (st.automations = readAutomations(db)).length;
          else if (s.id === 'codex.goals') count = (st.goals = readGoals(db)).length;
          else if (s.id === 'codex.queue') {
            const q = readQueue(db);
            st.queue = q.queue;
            st.queueRevisions = q.revisions;
            count = Object.values(q.queue).reduce((a, b) => a + b, 0);
          } else count = (st.turns = readTurns(db)).length;
        } finally {
          db.close();
        }
        st.sources.push({ id: s.id, label: s.label, file: s.file, status: 'ready', detail: `${s.file} (copy, readOnly, whitelisted columns)`, count });
      } catch (e) {
        st.sources.push({ id: s.id, label: s.label, file: s.file, status: 'partial', detail: `${s.file}: ${bounded(String((e as Error)?.message ?? e), 120)}` });
      }
    }
  }
  const lockDir = fs.existsSync(path.join(o.root, 'thread-writer-locks'));
  st.sources.push({ id: 'codex.locks', label: 'Codex running threads', file: 'thread-writer-locks/', status: lockDir ? 'ready' : 'missing', detail: lockDir ? 'thread-writer-locks/*.lock present = writing now (INFERRED)' : 'no thread-writer-locks/', count: st.locks.length });
  st.sources.push({ id: 'codex.models', label: 'Codex model catalog', file: 'models_cache.json', status: st.models.length ? 'ready' : 'missing', detail: st.models.length ? 'models_cache.json (slug, display name, context window)' : 'no models_cache.json', count: st.models.length });
  last = st;
  return st;
}

const RECENT_MS = 5 * 60_000;

/** INFERRED running threads: a writer lock is held (the app keeps it while the thread is loaded) AND the thread
 *  has an inProgress turn or was updated in the last 5 min. Lock alone = "open in the app". */
export function threadActivity(st: CodexState, now: number): Map<string, 'running' | 'open'> {
  const inProgress = new Set(st.turns.filter(t => /progress|running/i.test(t.status ?? '') && !t.durationMs).map(t => t.thread));
  const upd = new Map(st.threads.map(t => [t.id, t.updatedAt ?? 0]));
  const out = new Map<string, 'running' | 'open'>();
  for (const l of st.locks) out.set(l.id, inProgress.has(l.id) || now - (upd.get(l.id) ?? 0) < RECENT_MS ? 'running' : 'open');
  return out;
}

/** Entries for the Sources screen: last load if any, otherwise availability only (cheap, sync). */
export function codexStateSources(root: string, at: number): SourceState[] {
  if (last && last.root === root) return last.sources.filter(s => s.id === 'codex.state' || s.id === 'codex.automations').map(s => ({ id: s.id, label: s.label, status: s.status, detail: `${s.detail} · undocumented, may change`, count: s.count, at: last!.at }));
  const lib = loadSqlite();
  return DBS.filter(s => s.id === 'codex.state' || s.id === 'codex.automations').map(s => {
    const exists = fs.existsSync(path.join(root, s.file));
    const status: SourceStatus = !exists ? 'missing' : lib.ctor ? 'partial' : 'missing';
    const detail = !exists ? `no ${s.file}` : lib.ctor ? `${s.file}: read when the Codex screen is open · undocumented, may change` : lib.reason ?? 'node:sqlite unavailable';
    return { id: s.id, label: s.label, status, detail, at };
  });
}
