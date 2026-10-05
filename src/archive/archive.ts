// Durable local archive (~/.agent/archive by default, setting agent.archive.dir). Claude Code deletes
// transcripts older than cleanupPeriodDays and Codex rotates its data, so Agent keeps its own copy of what it
// read: per-session snapshots (no prompt or reply text, titles only when the provider named the session),
// backlog snapshots and workflow run summaries. Append-only across days, idempotent within a day:
//
//   sessions/YYYY/MM/YYYY-MM-DD.jsonl   one line per session archived (or changed) that day, upserted by key
//   backlog/YYYY-MM-DD.json             plan items seen that day (closed items stay visible later)
//   workflows/YYYY-MM-DD.jsonl          workflow run summaries changed that day, upserted by run id
//   index.json                          session key → first / last archived day (+ change signature)
//   raw/<provider>/<relative path>.gz   optional gzip copies of transcripts / rollouts (opt-in, size-capped)
//
// Provider files are only read. Every write goes under the archive folder, through a temp file + rename,
// and a lock file keeps two runs from interleaving. No process, no network.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { pipeline } from 'stream/promises';
import type { AgentSessionSnapshot, TimelineEvent } from '../model';
import type { BacklogItem, BacklogReport } from '../activity/backlog';
import type { WfRun } from '../providers/claude/workflows';
import { isInside, isPlausibleLocalPath } from '../util/paths';
import { bounded, redact } from '../util/redact';

export const ARCHIVE_VERSION = 1;
export const MAX_EVENTS = 2000;
export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const LOCK_STALE_MS = 30 * 60_000;

export function defaultArchiveDir(): string {
  return path.join(os.homedir(), '.agent', 'archive');
}

/** The configured folder when it is a plausible absolute local path, else ~/.agent/archive. */
export function archiveDir(configured: unknown): string {
  return typeof configured === 'string' && configured.trim() && isPlausibleLocalPath(configured.trim()) ? path.normalize(configured.trim()) : defaultArchiveDir();
}

/** Local calendar day YYYY-MM-DD. */
export function dayOf(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function sessionDayFile(dir: string, day: string): string {
  return path.join(dir, 'sessions', day.slice(0, 4), day.slice(5, 7), `${day}.jsonl`);
}

// ---------------------------------------------------------------- records

export interface ArchivedSession {
  v: number;
  kind: 'session';
  key: string;
  /** Day this line was written (local). */
  day: string;
  archivedAt: number;
  /** Snapshot as Agent read it, redacted; title only when the provider named the session. */
  s: AgentSessionSnapshot;
  /** Timeline of this session (oldest first, latest MAX_EVENTS). */
  events: TimelineEvent[];
  eventsTotal: number;
}

export interface ArchivedRun {
  v: number;
  kind: 'workflow';
  runId: string;
  day: string;
  archivedAt: number;
  parentKey: string;
  name?: string;
  description?: string;
  status: string;
  finalStatus?: string;
  error?: string;
  startedAt?: number;
  lastAt?: number;
  phases: string[];
  tokens: number;
  outputTokens: number;
  agents: {
    agentId: string;
    label: string;
    phase?: string;
    agentType?: string;
    model?: string;
    status: string;
    firstAt?: number;
    lastAt?: number;
    tokens: number;
    outputTokens: number;
    calls: number;
    tools: number;
    toolErrors: number;
    sessionKey: string;
  }[];
}

export interface ArchivedPlanFile {
  root: string;
  repo: string;
  rel: string;
  mtime: number;
  archive: boolean;
  skipped?: string;
  items: BacklogItem[];
}

export interface BacklogSnapshot {
  v: number;
  day: string;
  at: number;
  roots: string[];
  files: ArchivedPlanFile[];
}

export interface IndexEntry {
  first: string;
  last: string;
  /** Change signature of the last archived line. */
  sig: string;
  provider: string;
  lastActivityAt?: number;
}

export interface ArchiveIndex {
  v: number;
  updatedAt: number;
  sessions: Record<string, IndexEntry>;
  workflows: Record<string, { first: string; last: string; sig: string }>;
  backlogDays: string[];
}

export function emptyIndex(): ArchiveIndex {
  return { v: ARCHIVE_VERSION, updatedAt: 0, sessions: {}, workflows: {}, backlogDays: [] };
}

// ---------------------------------------------------------------- sanitising

/** Every string value through redact (titles, commands, labels, paths). */
export function deepRedact<T>(v: T): T {
  if (typeof v === 'string') return redact(v) as unknown as T;
  if (Array.isArray(v)) return v.map(deepRedact) as unknown as T;
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (x !== undefined) out[k] = deepRedact(x);
    return out as T;
  }
  return v;
}

/**
 * Snapshot fit for the archive. Providers fall back to the first user prompt as a title: that title is
 * dropped unless the provider itself named the session (evidence on `title`) or it is a worker label.
 */
export function sanitizeSnapshot(s: AgentSessionSnapshot): AgentSessionSnapshot {
  const named = s.evidence.some(e => e.field === 'title');
  const title = named ? bounded(s.title, 80) : s.isWorker && s.workerLabel ? bounded(s.workerLabel, 80) : undefined;
  return deepRedact({ ...s, title });
}

export function sessionSig(s: AgentSessionSnapshot): string {
  return [s.lastActivityAt ?? 0, s.status, s.usage?.totalTokens ?? 0, s.commits.length, s.tests.length, s.artifactBytes ?? 0, s.counts.tools, s.changedFiles.length].join('|');
}

export function toArchivedSession(s: AgentSessionSnapshot, events: TimelineEvent[], day: string, now: number): ArchivedSession {
  const own = events.filter(e => e.sessionKey === s.key);
  return {
    v: ARCHIVE_VERSION,
    kind: 'session',
    key: s.key,
    day,
    archivedAt: now,
    s: sanitizeSnapshot(s),
    events: deepRedact(own.slice(-MAX_EVENTS).map(e => ({ ...e, label: bounded(e.label, 160) }))),
    eventsTotal: own.length,
  };
}

export function toArchivedRun(r: WfRun, day: string, now: number): ArchivedRun {
  const agents = r.agents.map(a => ({
    agentId: a.agentId, label: bounded(a.label, 120), phase: a.phase && bounded(a.phase, 80), agentType: a.agentType && bounded(a.agentType, 60), model: a.model,
    status: a.status, firstAt: a.firstAt, lastAt: a.lastAt, tokens: a.tokens, outputTokens: a.outputTokens, calls: a.calls, tools: a.tools, toolErrors: a.toolErrors, sessionKey: a.sessionKey,
  }));
  return deepRedact({
    v: ARCHIVE_VERSION, kind: 'workflow', runId: r.runId, day, archivedAt: now, parentKey: r.parentKey,
    name: r.name && bounded(r.name, 80), description: r.description && bounded(r.description, 160), status: r.status, finalStatus: r.finalStatus,
    error: r.error && bounded(r.error, 160), startedAt: r.startedAt, lastAt: r.lastAt, phases: r.phases.map(p => bounded(p.title, 80)),
    tokens: agents.reduce((a, x) => a + x.tokens, 0), outputTokens: agents.reduce((a, x) => a + x.outputTokens, 0), agents,
  }) as ArchivedRun;
}

export function runSig(r: WfRun): string {
  return [r.status, r.finalStatus ?? '', r.lastAt ?? 0, r.agents.length, r.agents.reduce((a, x) => a + x.tokens, 0), r.agents.filter(a => a.status === 'done').length].join('|');
}

export function toBacklogSnapshot(rep: BacklogReport, day: string, now: number): BacklogSnapshot {
  return deepRedact({
    v: ARCHIVE_VERSION, day, at: now, roots: rep.roots,
    files: rep.files.map(f => ({ root: f.root, repo: f.repo, rel: f.rel, mtime: f.mtime, archive: f.archive, skipped: f.skipped, items: f.items })),
  });
}

// ---------------------------------------------------------------- fs helpers

/** Write via a temp file + rename so a reader never sees half a file. */
export function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw e;
  }
}

/** Lines of a JSONL file keyed by `keyOf` (later lines win). Unparseable lines are dropped. */
export function readKeyed<T>(file: string, keyOf: (o: any) => string | undefined): Map<string, T> {
  const m = new Map<string, T>();
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return m;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      const k = keyOf(o);
      if (k) m.set(k, o);
    } catch {
      /* skip */
    }
  }
  return m;
}

export function readIndex(dir: string): ArchiveIndex {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
    if (o && typeof o === 'object' && o.sessions && typeof o.sessions === 'object') return { ...emptyIndex(), ...o };
  } catch {
    /* none yet */
  }
  return emptyIndex();
}

/** Exclusive lock on the archive folder. The lock file is created atomically ('wx') and holds a per-run token;
 *  a lock whose mtime is older than 30 min is stale. A stale lock is taken over by renaming it away (atomic: of two
 *  runs that both saw it stale, only one rename succeeds), checking the renamed file is still that stale lock, then
 *  retrying the 'wx' create once. Release removes the lock only while it still holds this run's token. */
export function acquireLock(dir: string, now = Date.now()): () => void {
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, '.lock');
  const token = `${process.pid}:${now}:${Math.random().toString(36).slice(2, 10)}`;
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(lock, token, { flag: 'wx' });
      return () => {
        try {
          if (fs.readFileSync(lock, 'utf8') === token) fs.unlinkSync(lock);
        } catch {
          /* already gone */
        }
      };
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
    }
    if (i > 0) break;
    let age: number;
    try {
      age = now - fs.statSync(lock).mtimeMs;
    } catch {
      continue; // released between our create and stat: retry the create once
    }
    if (age < LOCK_STALE_MS) throw new Error(`another archive run holds ${lock} (started ${Math.round(age / 1000)} s ago)`);
    const grabbed = `${lock}.stale.${token.replace(/:/g, '-')}`;
    try {
      fs.renameSync(lock, grabbed);
    } catch {
      continue; // another run took the stale lock over first; the create below decides
    }
    let stillStale = false;
    try {
      stillStale = now - fs.statSync(grabbed).mtimeMs >= LOCK_STALE_MS;
    } catch {
      /* vanished */
    }
    if (!stillStale) {
      // We renamed a lock another run created after our stat: put it back (link fails if a newer lock exists).
      try {
        fs.linkSync(grabbed, lock);
      } catch {
        /* a newer lock is in place */
      }
      fs.rmSync(grabbed, { force: true });
      throw new Error(`another archive run holds ${lock} (just taken over)`);
    }
    fs.rmSync(grabbed, { force: true });
  }
  throw new Error(`could not take ${lock}`);
}

// ---------------------------------------------------------------- write

export interface ArchiveInput {
  sessions: AgentSessionSnapshot[];
  /** Timeline events of every session (any order); grouped by sessionKey here. */
  events: TimelineEvent[];
  workflows?: WfRun[];
  backlog?: BacklogReport;
  now: number;
}

export interface ArchiveResult {
  dir: string;
  day: string;
  /** Sessions written to today's file (new or changed). */
  written: number;
  /** Sessions read now but unchanged since their last archived line. */
  unchanged: number;
  /** Sessions in the index that the providers no longer expose (kept from earlier days). */
  kept: number;
  totalArchived: number;
  workflows: number;
  backlogItems: number;
  raw?: RawResult;
}

/** Writes today's archive lines. Synchronous; the raw copy (async) is separate: copyRaw. */
export function writeArchiveDay(dir: string, input: ArchiveInput, dry = false): ArchiveResult {
  const day = dayOf(input.now);
  const idx = readIndex(dir);
  const file = sessionDayFile(dir, day);
  const today = readKeyed<ArchivedSession>(file, o => (o?.kind === 'session' && typeof o.key === 'string' ? o.key : undefined));
  const byKey = new Map<string, TimelineEvent[]>();
  for (const e of input.events) {
    const l = byKey.get(e.sessionKey);
    if (l) l.push(e);
    else byKey.set(e.sessionKey, [e]);
  }
  let written = 0, unchanged = 0;
  const seen = new Set<string>();
  for (const s of input.sessions) {
    seen.add(s.key);
    const sig = sessionSig(s);
    const prev = idx.sessions[s.key];
    // Unchanged since an earlier day: that day's line already holds it. Today's line is always refreshed.
    if (prev && prev.sig === sig && prev.last !== day && !today.has(s.key)) {
      unchanged++;
      continue;
    }
    const ev = (byKey.get(s.key) ?? []).sort((a, b) => a.at - b.at);
    today.set(s.key, toArchivedSession(s, ev, day, input.now));
    idx.sessions[s.key] = { first: prev?.first ?? day, last: day, sig, provider: s.provider, lastActivityAt: s.lastActivityAt };
    written++;
  }
  const kept = Object.keys(idx.sessions).filter(k => !seen.has(k)).length;

  let wf = 0;
  const wfFile = path.join(dir, 'workflows', `${day}.jsonl`);
  const wfToday = readKeyed<ArchivedRun>(wfFile, o => (o?.kind === 'workflow' && typeof o.runId === 'string' ? o.runId : undefined));
  for (const r of input.workflows ?? []) {
    const sig = runSig(r);
    const prev = idx.workflows[r.runId];
    if (prev && prev.sig === sig && prev.last !== day && !wfToday.has(r.runId)) continue;
    wfToday.set(r.runId, toArchivedRun(r, day, input.now));
    idx.workflows[r.runId] = { first: prev?.first ?? day, last: day, sig };
    wf++;
  }

  let backlogItems = 0;
  const bl = input.backlog ? toBacklogSnapshot(input.backlog, day, input.now) : undefined;
  if (bl) {
    backlogItems = bl.files.reduce((a, f) => a + f.items.length, 0);
    if (!idx.backlogDays.includes(day)) idx.backlogDays = [...idx.backlogDays, day].sort();
  }

  const res: ArchiveResult = { dir, day, written, unchanged, kept, totalArchived: Object.keys(idx.sessions).length, workflows: wf, backlogItems };
  if (dry) return res;
  if (written || today.size) writeAtomic(file, [...today.values()].map(x => JSON.stringify(x)).join('\n') + '\n');
  if (wfToday.size) writeAtomic(wfFile, [...wfToday.values()].map(x => JSON.stringify(x)).join('\n') + '\n');
  if (bl) writeAtomic(path.join(dir, 'backlog', `${day}.json`), JSON.stringify(bl));
  idx.updatedAt = input.now;
  idx.v = ARCHIVE_VERSION;
  writeAtomic(path.join(dir, 'index.json'), JSON.stringify(idx));
  return res;
}

// ---------------------------------------------------------------- raw copies (opt-in)

/** Names never copied, whatever folder they are in. */
export const SECRET_NAME = /(auth|credential|secret|token|password|\.env|apikey|api[-_]key|\.pem$|\.key$)/i;

export interface RawSource {
  provider: string;
  /** Provider root the file must be inside (e.g. ~/.claude, ~/.codex). */
  root: string;
  file: string;
}

export interface RawResult {
  copied: number;
  skipped: number;
  refused: number;
  bytes: number;
  totalBytes: number;
  capped: boolean;
}

interface RawManifest {
  v: number;
  files: Record<string, { size: number; mtime: number; gz: number; at: number }>;
}

/** True when the file may be copied: a .jsonl transcript / rollout inside its provider root, with no secret-like name. */
export function rawAllowed(src: RawSource): boolean {
  const base = path.basename(src.file);
  if (!base.endsWith('.jsonl') || SECRET_NAME.test(base)) return false;
  return isInside(src.root, src.file);
}

/** Raw copies hold whole transcripts: owner read/write only. */
export const RAW_FILE_MODE = 0o600;

/**
 * Restricts a raw copy to its owner. POSIX: chmod 0o600 (the create mode is also masked by umask, so set it
 * explicitly). Windows: chmod only toggles the read-only bit, so it is skipped; the file inherits the ACL of
 * ~/.agent (by default the user profile, readable by the user, SYSTEM and Administrators) and is left as is.
 */
export function ownerOnly(file: string): void {
  if (process.platform === 'win32') return;
  try {
    fs.chmodSync(file, RAW_FILE_MODE);
  } catch {
    /* best effort: the copy itself succeeded */
  }
}

/** Gzip-copies new or grown transcripts into raw/, oldest first, until the total reaches maxBytes. */
export async function copyRaw(dir: string, sources: RawSource[], maxBytes: number, now = Date.now()): Promise<RawResult> {
  const rawDir = path.join(dir, 'raw');
  const manFile = path.join(rawDir, 'manifest.json');
  let man: RawManifest = { v: 1, files: {} };
  try {
    const o = JSON.parse(fs.readFileSync(manFile, 'utf8'));
    if (o?.files && typeof o.files === 'object') man = o;
  } catch {
    /* first run */
  }
  let total = Object.values(man.files).reduce((a, f) => a + (f.gz || 0), 0);
  const res: RawResult = { copied: 0, skipped: 0, refused: 0, bytes: 0, totalBytes: total, capped: false };
  const seen = new Set<string>();
  const list: { src: RawSource; rel: string; st: fs.Stats }[] = [];
  for (const src of sources) {
    if (!rawAllowed(src)) {
      res.refused++;
      continue;
    }
    const rel = path.relative(src.root, src.file);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      res.refused++;
      continue;
    }
    const id = `${src.provider}/${rel.replace(/\\/g, '/')}`;
    if (seen.has(id)) continue;
    seen.add(id);
    let st: fs.Stats;
    try {
      st = fs.statSync(src.file);
    } catch {
      continue;
    }
    list.push({ src, rel: id, st });
  }
  list.sort((a, b) => a.st.mtimeMs - b.st.mtimeMs);
  for (const { src, rel, st } of list) {
    const prev = man.files[rel];
    if (prev && prev.size === st.size && prev.mtime === st.mtimeMs) {
      res.skipped++;
      continue;
    }
    if (total - (prev?.gz ?? 0) >= maxBytes) {
      res.capped = true;
      break;
    }
    const dest = path.join(rawDir, ...rel.split('/')) + '.gz';
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.${process.pid}.tmp`;
    try {
      // Read only up to the size seen now: the provider may still be appending.
      const end = st.size - 1;
      if (end < 0) {
        res.skipped++;
        continue;
      }
      await pipeline(fs.createReadStream(src.file, { start: 0, end }), zlib.createGzip(), fs.createWriteStream(tmp, { mode: RAW_FILE_MODE }));
      const gz = fs.statSync(tmp).size;
      if (total - (prev?.gz ?? 0) + gz > maxBytes) {
        fs.rmSync(tmp, { force: true });
        res.capped = true;
        break;
      }
      fs.renameSync(tmp, dest);
      ownerOnly(dest);
      total += gz - (prev?.gz ?? 0);
      man.files[rel] = { size: st.size, mtime: st.mtimeMs, gz, at: now };
      res.copied++;
      res.bytes += gz;
    } catch {
      fs.rmSync(tmp, { force: true });
      res.skipped++;
    }
  }
  res.totalBytes = total;
  if (res.copied) {
    writeAtomic(manFile, JSON.stringify(man));
    ownerOnly(manFile);
  }
  return res;
}

// ---------------------------------------------------------------- collect (script and screen)

export interface Collected {
  sessions: AgentSessionSnapshot[];
  events: TimelineEvent[];
  workflows: WfRun[];
  backlog?: BacklogReport;
  roots: { claude: string; codex: string };
  ms: number;
  diagnostics: string[];
}

/** Reads all local Claude / Codex history (subagents and Codex archived sessions included), workflow runs and plan files. */
export async function collectForArchive(opts: { days: number; maxSessions: number; git: boolean; backlog: boolean; now?: number }): Promise<Collected> {
  const { ClaudeAdapter, claudeRoot } = await import('../providers/claude/claude');
  const { CodexAdapter, codexRoot } = await import('../providers/codex/codex');
  const { SessionStore } = await import('../sessions/store');
  const t0 = Date.now();
  const roots = { claude: claudeRoot(), codex: codexRoot() };
  const store = new SessionStore([new ClaudeAdapter(roots.claude), new CodexAdapter(roots.codex)], { historyDays: opts.days, maxSessions: opts.maxSessions, idleMinutes: 10, git: opts.git });
  const diagnostics: string[] = [];
  try {
    await store.refresh();
    const sessions = store.all();
    const events = store.timeline(undefined, Number.MAX_SAFE_INTEGER);
    let workflows: WfRun[] = [];
    try {
      const { WorkflowScanner } = await import('../providers/claude/workflows');
      const snap = await new WorkflowScanner(path.join(roots.claude, 'projects')).scan(opts.now ?? Date.now());
      workflows = snap.runs;
      diagnostics.push(...snap.diagnostics);
    } catch (e: any) {
      diagnostics.push(`workflows: ${String(e?.message ?? e).slice(0, 120)}`);
    }
    let backlog: BacklogReport | undefined;
    if (opts.backlog) {
      const { repoRootOf } = await import('../activity/backlog');
      const { scanBacklog, uniqueRoots } = await import('../feeds/backlog');
      const ordered = [...sessions].sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)).map(repoRootOf).filter((x): x is string => !!x);
      const rs = await uniqueRoots(ordered, 200);
      backlog = await scanBacklog({ roots: rs, now: opts.now ?? Date.now(), archive: true });
    }
    return { sessions, events, workflows, backlog, roots, ms: Date.now() - t0, diagnostics };
  } finally {
    store.dispose();
  }
}

/** Raw-copy candidates: session artifacts and workflow agent transcripts. */
export function rawSources(c: Pick<Collected, 'sessions' | 'workflows' | 'roots'>): RawSource[] {
  const out: RawSource[] = [];
  for (const s of c.sessions) if (s.artifactPath) out.push({ provider: s.provider, root: s.provider === 'claude' ? c.roots.claude : c.roots.codex, file: s.artifactPath });
  for (const r of c.workflows) for (const a of r.agents) if (a.transcript) out.push({ provider: 'claude', root: c.roots.claude, file: a.transcript });
  return out;
}
