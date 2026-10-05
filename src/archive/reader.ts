// Reads Agent's durable archive (written by scripts/archive.ts) for the History and Backlog screens:
// the latest archived line of every session and the latest archived state of every backlog item. Read-only,
// size-capped, cached by file (path, size, mtime). Timeline events are dropped on read: screens only need the
// snapshot. No process, no network.
import * as fs from 'fs';
import * as path from 'path';
import type { AgentSessionSnapshot } from '../model';
import type { BacklogItem } from '../activity/backlog';
import type { Feed, FeedCtx } from '../render/extra/feeds';
import { archiveDir, ArchivedSession, BacklogSnapshot, DAY_RE, readIndex } from './archive';

export const ARCHIVE_FEED = 'archive.read';
const MAX_FILE = 64 << 20;
const MAX_BACKLOG_FILE = 16 << 20;

export interface ArchivedItem {
  root: string;
  repo: string;
  rel: string;
  item: BacklogItem;
  /** Last day the item was seen in a backlog snapshot. */
  day: string;
  /** First day seen. */
  first: string;
}

export interface ArchiveView {
  dir: string;
  exists: boolean;
  at: number;
  /** Latest line per session key, most recent activity first. */
  sessions: ArchivedSession[];
  /** Latest state per backlog item over the snapshots read. */
  items: ArchivedItem[];
  sessionDays: number;
  backlogDays: string[];
  errors: string[];
}

const cache = new Map<string, { size: number; mtime: number; recs: ArchivedSession[] }>();
const blCache = new Map<string, { size: number; mtime: number; snap?: BacklogSnapshot }>();

function list(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** sessions/YYYY/MM/YYYY-MM-DD.jsonl files, oldest first. */
export function sessionDayFiles(dir: string): { day: string; file: string }[] {
  const out: { day: string; file: string }[] = [];
  const base = path.join(dir, 'sessions');
  for (const y of list(base).filter(n => /^\d{4}$/.test(n)).sort())
    for (const m of list(path.join(base, y)).filter(n => /^\d{2}$/.test(n)).sort())
      for (const f of list(path.join(base, y, m)).sort()) {
        const day = f.replace(/\.jsonl$/, '');
        if (f.endsWith('.jsonl') && DAY_RE.test(day)) out.push({ day, file: path.join(base, y, m, f) });
      }
  return out;
}

function readDay(file: string, errors: string[]): ArchivedSession[] {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return [];
  }
  const hit = cache.get(file);
  if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) return hit.recs;
  if (st.size > MAX_FILE) {
    errors.push(`${path.basename(file)}: larger than ${MAX_FILE >> 20} MB, skipped`);
    return [];
  }
  const recs: ArchivedSession[] = [];
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o?.kind !== 'session' || typeof o.key !== 'string' || !o.s || typeof o.s !== 'object') continue;
        recs.push({ ...o, events: [] });
      } catch {
        /* torn or foreign line */
      }
    }
  } catch (e: any) {
    errors.push(`${path.basename(file)}: ${String(e?.code ?? e?.message ?? e).slice(0, 80)}`);
  }
  if (cache.size > 2000) cache.clear();
  cache.set(file, { size: st.size, mtime: st.mtimeMs, recs });
  return recs;
}

function readBacklog(file: string): BacklogSnapshot | undefined {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return undefined;
  }
  const hit = blCache.get(file);
  if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) return hit.snap;
  let snap: BacklogSnapshot | undefined;
  if (st.size <= MAX_BACKLOG_FILE) {
    try {
      const o = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (o && typeof o.day === 'string' && Array.isArray(o.files)) snap = o;
    } catch {
      /* skip */
    }
  }
  if (blCache.size > 1000) blCache.clear();
  blCache.set(file, { size: st.size, mtime: st.mtimeMs, snap });
  return snap;
}

const nk = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
export function itemKey(root: string, rel: string, it: Pick<BacklogItem, 'id' | 'title'>): string {
  return `${nk(root)}|${rel.toLowerCase()}|${(it.id ?? it.title).toLowerCase()}`;
}

/** Reads the newest `maxDays` session day files and `maxBacklog` backlog snapshots. */
export function readArchiveView(dir: string, opts: { maxDays?: number; maxBacklog?: number; now?: number } = {}): ArchiveView {
  const res: ArchiveView = { dir, exists: fs.existsSync(dir), at: opts.now ?? Date.now(), sessions: [], items: [], sessionDays: 0, backlogDays: [], errors: [] };
  if (!res.exists) return res;
  const days = sessionDayFiles(dir).slice(-Math.max(1, opts.maxDays ?? 400));
  res.sessionDays = days.length;
  const latest = new Map<string, ArchivedSession>();
  for (const d of days) for (const r of readDay(d.file, res.errors)) latest.set(r.key, r);
  res.sessions = [...latest.values()].sort((a, b) => (b.s.lastActivityAt ?? 0) - (a.s.lastActivityAt ?? 0));

  const blDir = path.join(dir, 'backlog');
  const blDays = list(blDir).filter(n => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort().slice(-Math.max(1, opts.maxBacklog ?? 120));
  const items = new Map<string, ArchivedItem>();
  for (const n of blDays) {
    const snap = readBacklog(path.join(blDir, n));
    if (!snap) continue;
    res.backlogDays.push(snap.day);
    for (const f of snap.files ?? []) {
      if (!f || typeof f.root !== 'string' || typeof f.rel !== 'string' || !Array.isArray(f.items)) continue;
      for (const it of f.items) {
        if (!it || typeof it.title !== 'string') continue;
        const k = itemKey(f.root, f.rel, it);
        const prev = items.get(k);
        items.set(k, { root: f.root, repo: f.repo, rel: f.rel, item: it, day: snap.day, first: prev?.first ?? snap.day });
      }
    }
  }
  res.items = [...items.values()];
  return res;
}

/** An archived line as a snapshot screens can render, labelled ARCHIVED (OBSERVED on the archive day). */
export function archivedSnapshot(r: ArchivedSession): AgentSessionSnapshot {
  const s = r.s;
  const live = s.status !== 'ENDED';
  return {
    ...s,
    commits: Array.isArray(s.commits) ? s.commits : [],
    changedFiles: Array.isArray(s.changedFiles) ? s.changedFiles : [],
    tests: Array.isArray(s.tests) ? s.tests : [],
    counts: s.counts ?? { tools: 0, commands: 0, fileEdits: 0, turns: 0 },
    status: live ? 'UNKNOWN' : 'ENDED',
    statusReason: `ARCHIVED: OBSERVED on ${r.day}${live ? ` (was ${s.status}; no longer read from provider files)` : ''}`,
    evidence: [...(Array.isArray(s.evidence) ? s.evidence : []), { field: 'archive', kind: 'OBSERVED', source: `Agent archive, line written ${r.day}` }],
    diagnostics: Array.isArray(s.diagnostics) ? s.diagnostics : [],
  };
}

/** Archived sessions that are not among `present` (e.g. deleted by the provider, or outside agent.historyDays). */
export function archivedOnly(view: ArchiveView | undefined, present: AgentSessionSnapshot[], keep?: (s: AgentSessionSnapshot) => boolean): { rec: ArchivedSession; s: AgentSessionSnapshot }[] {
  if (!view) return [];
  const have = new Set(present.map(s => s.key));
  const out: { rec: ArchivedSession; s: AgentSessionSnapshot }[] = [];
  for (const rec of view.sessions) {
    if (have.has(rec.key)) continue;
    const s = archivedSnapshot(rec);
    if (keep && !keep(s)) continue;
    out.push({ rec, s });
  }
  return out;
}

export const archiveFeed: Feed<ArchiveView> = {
  id: ARCHIVE_FEED,
  intervalMs: 5 * 60_000,
  async load(ctx: FeedCtx) {
    const dir = archiveDir(ctx.config<string>('agent.archive.dir', ''));
    const maxDays = Math.min(5000, Math.max(1, Number(ctx.config<number>('agent.archive.maxDays', 400)) || 400));
    return readArchiveView(dir, { maxDays, now: ctx.now });
  },
};

/** Index summary (first / last archived day per session) without reading day files. */
export function indexSummary(dir: string): { sessions: number; first?: string; last?: string } {
  const idx = readIndex(dir);
  const vals = Object.values(idx.sessions);
  const firsts = vals.map(v => v.first).sort();
  const lasts = vals.map(v => v.last).sort();
  return { sessions: vals.length, first: firsts[0], last: lasts[lasts.length - 1] };
}

export function clearArchiveCache(): void {
  cache.clear();
  blCache.clear();
}
