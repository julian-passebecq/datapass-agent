// Pure aggregation for the "Changes" screen: files changed by sessions, from three sources kept apart:
//  - git lines (DERIVED): git diff --numstat over each session's commit window (src/git/changes.ts),
//  - edit calls (OBSERVED): per-file edit tool calls the provider recorded (s.facts.files),
//  - uncommitted (DERIVED, now): staged / unstaged / untracked files in worktrees agents use.
import * as path from 'path';
import type { AgentSessionSnapshot, TimelineEvent } from '../model';
import type { ChangesData, NumstatRow, SessionDiff, WorktreeChanges, WtFileState } from '../git/changes';
import { cwdPrefix } from '../git/changes';
import { base, dayStart } from './insights';

export type Period = '24h' | '7d' | 'all';
export const PERIODS: Period[] = ['24h', '7d', 'all'];
export const isPeriod = (v: string): v is Period => (PERIODS as string[]).includes(v);

export function since(period: Period, now: number): number {
  return period === '24h' ? now - 86400_000 : period === '7d' ? now - 7 * 86400_000 : 0;
}

export interface Uncommitted {
  state: WtFileState;
  added: number;
  removed: number;
  worktree: string;
}

export interface FileRow {
  /** repo + "\0" + path */
  id: string;
  repo: string;
  /** Repo-relative path (forward slashes); a folder for grouped rows. */
  path: string;
  added: number;
  removed: number;
  binary: boolean;
  /** Edit tool calls recorded by providers (OBSERVED). */
  edits: number;
  /** Session keys that touched the file (commit window or edit calls). */
  sessions: string[];
  lastAt: number;
  /** Line counts come from git commit windows. */
  git: boolean;
  /** A provider recorded an edit call. */
  edited: boolean;
  /** Line totals may count the same commit twice (partially overlapping sessions in one worktree). */
  overlap: boolean;
  wt?: Uncommitted;
  /** Number of files in a grouped row. */
  files?: number;
}

const endOf = (s: AgentSessionSnapshot) => s.lastActivityAt ?? s.startedAt ?? 0;
const repoName = (s: AgentSessionSnapshot) => base(s.repository) || base(s.cwd) || '(no repo)';

/** Repo-relative path of a provider-recorded file (facts.files is cwd-relative or absolute). Pure path math. */
export function factPath(s: AgentSessionSnapshot, p: string): string {
  const fwd = p.replace(/\\/g, '/');
  if (path.isAbsolute(p) || /^[a-zA-Z]:\//.test(fwd)) {
    if (s.worktree) {
      const rel = path.relative(s.worktree.toLowerCase(), p.toLowerCase());
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return fwd.slice(fwd.length - rel.length).replace(/\\/g, '/');
    }
    return fwd;
  }
  return cwdPrefix(s) + fwd;
}

/**
 * Picks the commit-window diffs whose line counts are summed: identical windows count once and a session whose
 * window lies inside another included window of the same worktree (a worker inside its lead) is skipped.
 * Returns included session keys and the ones that partially overlap another included window.
 */
export function lineSources(sessions: AgentSessionSnapshot[], diffs: Record<string, SessionDiff>): { include: Set<string>; overlapping: Set<string> } {
  const byWt = new Map<string, AgentSessionSnapshot[]>();
  for (const s of sessions) {
    const d = diffs[s.key];
    if (!d) continue;
    const k = d.worktree.toLowerCase();
    byWt.set(k, [...(byWt.get(k) ?? []), s]);
  }
  const include = new Set<string>();
  const overlapping = new Set<string>();
  for (const ss of byWt.values()) {
    ss.sort((a, b) => endOf(b) - (b.startedAt ?? 0) - (endOf(a) - (a.startedAt ?? 0)));
    const kept: AgentSessionSnapshot[] = [];
    const seen = new Set<string>();
    for (const s of ss) {
      const d = diffs[s.key];
      const win = `${d.from}..${d.to}`;
      if (seen.has(win)) continue;
      const a = s.startedAt ?? 0, b = endOf(s);
      if (kept.some(o => (o.startedAt ?? 0) <= a && endOf(o) >= b)) continue;
      for (const o of kept) if ((o.startedAt ?? 0) < b && endOf(o) > a) {
        overlapping.add(s.key);
        overlapping.add(o.key);
      }
      kept.push(s);
      seen.add(win);
      include.add(s.key);
    }
  }
  return { include, overlapping };
}

function uncommitted(wt: WorktreeChanges): Map<string, Uncommitted> {
  const m = new Map<string, Uncommitted>();
  const add = (r: NumstatRow, st: 'staged' | 'unstaged') => {
    const e = m.get(r.path);
    if (e) {
      e.state = 'both';
      e.added += r.added;
      e.removed += r.removed;
    } else m.set(r.path, { state: st, added: r.added, removed: r.removed, worktree: wt.worktree });
  };
  for (const r of wt.staged) add(r, 'staged');
  for (const r of wt.unstaged) add(r, 'unstaged');
  for (const p of wt.untracked) if (!m.has(p)) m.set(p, { state: 'untracked', added: 0, removed: 0, worktree: wt.worktree });
  for (const p of wt.conflicts) m.set(p, { ...(m.get(p) ?? { added: 0, removed: 0, worktree: wt.worktree }), state: 'conflict' });
  return m;
}

/** One row per (repo, file): git lines over commit windows, edit calls, uncommitted state now. */
export function fileRows(sessions: AgentSessionSnapshot[], data: ChangesData | undefined, from: number): FileRow[] {
  const rows = new Map<string, FileRow & { diffKeys: Set<string> }>();
  const row = (repo: string, p: string) => {
    const id = `${repo}\0${p}`;
    let r = rows.get(id);
    if (!r) rows.set(id, (r = { id, repo, path: p, added: 0, removed: 0, binary: false, edits: 0, sessions: [], lastAt: 0, git: false, edited: false, overlap: false, diffKeys: new Set() }));
    return r;
  };
  const touch = (r: FileRow, s: AgentSessionSnapshot, at: number) => {
    if (!r.sessions.includes(s.key)) r.sessions.push(s.key);
    r.lastAt = Math.max(r.lastAt, at);
  };
  const inPeriod = sessions.filter(s => endOf(s) >= from);
  const diffs = data?.diffs ?? {};
  const { include, overlapping } = lineSources(inPeriod, diffs);
  for (const s of inPeriod) {
    const repo = repoName(s);
    const d = diffs[s.key];
    if (d) {
      for (const f of d.files) {
        const r = row(repo, f.path);
        touch(r, s, endOf(s));
        r.git = true;
        if (f.binary) r.binary = true;
        if (include.has(s.key) && !r.diffKeys.has(`${d.worktree.toLowerCase()}|${d.from}|${d.to}`)) {
          if (r.diffKeys.size && overlapping.has(s.key)) r.overlap = true;
          r.diffKeys.add(`${d.worktree.toLowerCase()}|${d.from}|${d.to}`);
          r.added += f.added;
          r.removed += f.removed;
        }
      }
    }
    for (const f of s.facts?.files ?? []) {
      const r = row(repo, factPath(s, f.path));
      touch(r, s, f.lastAt || endOf(s));
      r.edited = true;
      r.edits += f.edits;
    }
  }
  for (const wt of data?.worktrees ?? []) {
    const repo = base(wt.repository) || base(wt.worktree);
    for (const [p, u] of uncommitted(wt)) {
      const r = row(repo, p);
      if (r.wt) {
        r.wt = { ...r.wt, added: r.wt.added + u.added, removed: r.wt.removed + u.removed, state: r.wt.state === u.state ? u.state : r.wt.state === 'conflict' || u.state === 'conflict' ? 'conflict' : 'both' };
      } else r.wt = u;
    }
  }
  return [...rows.values()].map(({ diffKeys: _d, ...r }) => r);
}

export type GroupBy = 'file' | 'folder' | 'repo';

/** Folder of a path at the given depth ("src/render" for depth 2); files at the root group under ".". */
export function folderOf(p: string, depth: number): string {
  const parts = p.split('/');
  parts.pop();
  return parts.length ? parts.slice(0, Math.max(1, depth)).join('/') : '.';
}

export function groupRows(rows: FileRow[], by: GroupBy, depth = 2): FileRow[] {
  if (by === 'file') return rows;
  const m = new Map<string, FileRow>();
  for (const r of rows) {
    const p = by === 'repo' ? '' : folderOf(r.path, depth);
    const id = `${r.repo}\0${p}`;
    const g = m.get(id) ?? { id, repo: r.repo, path: p, added: 0, removed: 0, binary: false, edits: 0, sessions: [], lastAt: 0, git: false, edited: false, overlap: false, files: 0 };
    g.added += r.added;
    g.removed += r.removed;
    g.edits += r.edits;
    g.binary ||= r.binary;
    g.git ||= r.git;
    g.edited ||= r.edited;
    g.overlap ||= r.overlap;
    g.lastAt = Math.max(g.lastAt, r.lastAt);
    g.files = (g.files ?? 0) + 1;
    for (const k of r.sessions) if (!g.sessions.includes(k)) g.sessions.push(k);
    if (r.wt) g.wt = { state: g.wt && g.wt.state !== r.wt.state ? 'both' : r.wt.state, added: (g.wt?.added ?? 0) + r.wt.added, removed: (g.wt?.removed ?? 0) + r.wt.removed, worktree: r.wt.worktree };
    m.set(id, g);
  }
  return [...m.values()];
}

export type SortBy = 'churn' | 'edits' | 'recent' | 'name' | 'sessions';
export const churn = (r: FileRow) => r.added + r.removed;

export function sortRows(rows: FileRow[], by: SortBy): FileRow[] {
  const cmp: Record<SortBy, (a: FileRow, b: FileRow) => number> = {
    churn: (a, b) => churn(b) - churn(a) || b.edits - a.edits,
    edits: (a, b) => b.edits - a.edits || churn(b) - churn(a),
    recent: (a, b) => b.lastAt - a.lastAt,
    sessions: (a, b) => b.sessions.length - a.sessions.length || b.edits - a.edits,
    name: (a, b) => a.repo.localeCompare(b.repo) || a.path.localeCompare(b.path),
  };
  return [...rows].sort((a, b) => cmp[by](a, b) || a.path.localeCompare(b.path));
}

export interface SessionRow {
  s: AgentSessionSnapshot;
  added: number;
  removed: number;
  /** Files in its commit window (git) ∪ files it edited (provider). */
  files: number;
  edits: number;
  diff?: SessionDiff;
  /** Uncommitted state of its worktree now (live / recent sessions only). */
  wt?: WorktreeChanges;
  top: { path: string; added: number; removed: number; edits: number }[];
}

export function sessionRows(sessions: AgentSessionSnapshot[], data: ChangesData | undefined, from: number): SessionRow[] {
  const wtBy = new Map<string, WorktreeChanges>();
  for (const w of data?.worktrees ?? []) for (const k of w.sessions) wtBy.set(k, w);
  const out: SessionRow[] = [];
  for (const s of sessions) {
    if (endOf(s) < from) continue;
    const d = data?.diffs[s.key];
    const files = new Map<string, { path: string; added: number; removed: number; edits: number }>();
    for (const f of d?.files ?? []) files.set(f.path, { path: f.path, added: f.added, removed: f.removed, edits: 0 });
    for (const f of s.facts?.files ?? []) {
      const p = factPath(s, f.path);
      const e = files.get(p) ?? { path: p, added: 0, removed: 0, edits: 0 };
      e.edits += f.edits;
      files.set(p, e);
    }
    for (const p of s.changedFiles) if (!files.has(p.replace(/\\/g, '/'))) files.set(p.replace(/\\/g, '/'), { path: p.replace(/\\/g, '/'), added: 0, removed: 0, edits: 0 });
    const wt = wtBy.get(s.key);
    if (!files.size && !wt) continue;
    const list = [...files.values()];
    out.push({
      s,
      added: d ? d.files.reduce((a, f) => a + f.added, 0) : s.linesAdded ?? 0,
      removed: d ? d.files.reduce((a, f) => a + f.removed, 0) : s.linesRemoved ?? 0,
      files: files.size,
      edits: list.reduce((a, f) => a + f.edits, 0),
      diff: d,
      wt,
      top: list.sort((a, b) => b.added + b.removed - (a.added + a.removed) || b.edits - a.edits).slice(0, 300),
    });
  }
  return out;
}

export function wtCounts(w: WorktreeChanges): { staged: number; unstaged: number; untracked: number; conflicts: number; added: number; removed: number; dirty: boolean } {
  const added = [...w.staged, ...w.unstaged].reduce((a, r) => a + r.added, 0);
  const removed = [...w.staged, ...w.unstaged].reduce((a, r) => a + r.removed, 0);
  const n = { staged: w.staged.length, unstaged: w.unstaged.length, untracked: w.untracked.length, conflicts: w.conflicts.length };
  return { ...n, added, removed, dirty: n.staged + n.unstaged + n.untracked + n.conflicts > 0 };
}

export type Gran = 'hour' | 'day';

export interface Heat {
  /** Bucket start times. */
  buckets: number[];
  gran: Gran;
  rows: { id: string; repo: string; path: string; total: number; cells: number[]; sessions: number }[];
  /** FILE_CHANGE events not mapped to a single file (multi-file patches, unknown names). */
  unmatched: number;
  max: number;
}

const startOf = (t: number, g: Gran) => (g === 'day' ? dayStart(t) : Math.floor(t / 3600_000) * 3600_000);

/**
 * Edits per file per time bucket from FILE_CHANGE events ("edited x.ts", "wrote x.ts", "update x.ts").
 * Events carry a file name only; it is matched to the session's recorded files by name (DERIVED).
 */
export function heat(sessions: AgentSessionSnapshot[], events: TimelineEvent[], o: { from: number; now: number; gran: Gran; top: number; maxBuckets?: number }): Heat {
  const byKey = new Map(sessions.map(s => [s.key, s]));
  const nameIdx = new Map<string, Map<string, string[]>>();
  const namesOf = (s: AgentSessionSnapshot) => {
    let m = nameIdx.get(s.key);
    if (!m) {
      m = new Map();
      for (const f of s.facts?.files ?? []) {
        const p = factPath(s, f.path);
        const b = p.split('/').pop()!.toLowerCase();
        m.set(b, [...(m.get(b) ?? []), p]);
      }
      nameIdx.set(s.key, m);
    }
    return m;
  };
  const evs = events.filter(e => e.type === 'FILE_CHANGE' && e.at >= o.from && e.at <= o.now + 60_000 && byKey.has(e.sessionKey));
  const maxB = o.maxBuckets ?? (o.gran === 'hour' ? 48 : 31);
  const step = o.gran === 'hour' ? 3600_000 : 86400_000;
  const last = startOf(o.now, o.gran);
  const firstEv = evs.length ? Math.min(...evs.map(e => e.at)) : o.now;
  let first = startOf(Math.max(o.from, firstEv), o.gran);
  if ((last - first) / step + 1 > maxB) first = last - (maxB - 1) * step;
  const buckets: number[] = [];
  for (let t = first; t <= last; t = o.gran === 'day' ? dayStart(t + 36 * 3600_000) : t + step) buckets.push(t);
  const idx = (t: number) => {
    const b = startOf(t, o.gran);
    let lo = 0;
    while (lo < buckets.length - 1 && buckets[lo + 1] <= b) lo++;
    return b < buckets[0] ? -1 : lo;
  };
  const acc = new Map<string, { id: string; repo: string; path: string; total: number; cells: number[]; ss: Set<string> }>();
  let unmatched = 0;
  for (const e of evs) {
    const m = /^(?:edited|wrote|update|add|delete|changed|created|modified)\s+(.+)$/i.exec(e.label.trim());
    if (!m || /^\d+ files changed$/.test(e.label)) {
      unmatched++;
      continue;
    }
    const s = byKey.get(e.sessionKey)!;
    const name = m[1].trim();
    const cands = namesOf(s).get(name.toLowerCase());
    const p = cands?.[0] ?? name;
    const i = idx(e.at);
    if (i < 0) continue;
    const repo = repoName(s);
    const id = `${repo}\0${p}`;
    const r = acc.get(id) ?? { id, repo, path: p, total: 0, cells: buckets.map(() => 0), ss: new Set<string>() };
    r.total++;
    r.cells[i]++;
    r.ss.add(s.key);
    acc.set(id, r);
  }
  const rows = [...acc.values()].sort((a, b) => b.total - a.total || a.path.localeCompare(b.path)).slice(0, o.top).map(({ ss, ...r }) => ({ ...r, sessions: ss.size }));
  const max = Math.max(0, ...rows.flatMap(r => r.cells));
  return { buckets, gran: o.gran, rows, unmatched, max };
}
