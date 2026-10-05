// History archive on disk (~/.agent/history by default, setting agent.history.dir): read by the History
// screen feed, written by scripts/weekly.ts and by the screen's "Build now" action. Agent's own folder only:
// provider files are read, never written. No process, no network.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentSessionSnapshot } from '../model';
import { HistWeek, mergeWeek, rowsByWeek, validateWeek, WEEK_FILE_RE, weeklyMarkdown, WeekSource, shiftWeek } from '../activity/history';
import { isPlausibleLocalPath } from '../util/paths';
import type { Feed, FeedCtx } from '../render/extra/feeds';

export const HISTORY_FEED = 'history.archive';
const MAX_FILE = 8 * 1024 * 1024;

export function defaultHistoryDir(): string {
  return path.join(os.homedir(), '.agent', 'history');
}

/** The configured folder when it is a plausible absolute local path, else ~/.agent/history. */
export function historyDir(configured: unknown): string {
  return typeof configured === 'string' && configured.trim() && isPlausibleLocalPath(configured.trim()) ? path.normalize(configured.trim()) : defaultHistoryDir();
}

export interface ArchiveRead {
  dir: string;
  exists: boolean;
  /** Oldest first. */
  weeks: HistWeek[];
  /** Week ids that also have a markdown report. */
  reports: string[];
  /** Week files on disk (before the maxWeeks cap). */
  files: number;
  errors: { file: string; error: string }[];
  at: number;
}

/** Reads the newest `maxWeeks` week files (size-capped, validated). */
export function readArchive(dir: string, maxWeeks = 52, now = Date.now()): ArchiveRead {
  const res: ArchiveRead = { dir, exists: false, weeks: [], reports: [], files: 0, errors: [], at: now };
  let names: string[];
  try {
    names = fs.readdirSync(dir);
    res.exists = true;
  } catch {
    return res;
  }
  const weekFiles = names.filter(n => WEEK_FILE_RE.test(n)).sort().reverse();
  res.files = weekFiles.length;
  const mds = new Set(names.filter(n => /^\d{4}-W\d{2}\.md$/.test(n)).map(n => n.slice(0, 8)));
  for (const n of weekFiles.slice(0, Math.max(1, maxWeeks))) {
    const p = path.join(dir, n);
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) continue;
      if (st.size > MAX_FILE) {
        res.errors.push({ file: n, error: `larger than ${MAX_FILE >> 20} MB, skipped` });
        continue;
      }
      const w = validateWeek(JSON.parse(fs.readFileSync(p, 'utf8')));
      if (!w || `${w.week}.json` !== n) {
        res.errors.push({ file: n, error: 'not a valid week file (schema or week id)' });
        continue;
      }
      res.weeks.push(w);
      if (mds.has(w.week)) res.reports.push(w.week);
    } catch (e: any) {
      res.errors.push({ file: n, error: String(e?.code ?? e?.message ?? e).slice(0, 120) });
    }
  }
  res.weeks.sort((a, b) => a.start - b.start);
  return res;
}

export const historyFeed: Feed<ArchiveRead> = {
  id: HISTORY_FEED,
  intervalMs: 60_000,
  async load(ctx: FeedCtx) {
    const dir = historyDir(ctx.config<string>('agent.history.dir', ''));
    const max = Math.min(520, Math.max(1, Number(ctx.config<number>('agent.history.maxWeeks', 52)) || 52));
    return readArchive(dir, max, ctx.now);
  },
};

function readWeekFile(file: string): HistWeek | undefined {
  try {
    if (fs.statSync(file).size > MAX_FILE) return undefined;
    return validateWeek(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return undefined;
  }
}

/** Write via a temp file + rename so a reader never sees half a file. */
function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

export interface BuildResult {
  dir: string;
  weeks: string[];
  rows: number;
  kept: number;
  sessions: number;
}

/**
 * Merges the sessions into the week files of `dir` (creating it) and rewrites each touched week's
 * JSON and markdown report. Only weeks with at least one session are written.
 */
export function writeArchive(dir: string, sessions: AgentSessionSnapshot[], source: Omit<WeekSource, 'sessions'>, now = Date.now(), dry = false): BuildResult {
  const byWeek = rowsByWeek(sessions, source.git);
  const res: BuildResult = { dir, weeks: [], rows: 0, kept: 0, sessions: sessions.length };
  if (!dry) fs.mkdirSync(dir, { recursive: true });
  const ids = [...byWeek.keys()].sort();
  for (const id of ids) {
    const file = path.join(dir, `${id}.json`);
    const prev = fs.existsSync(file) ? readWeekFile(file) : undefined;
    const w = mergeWeek(id, prev, byWeek.get(id)!, { ...source, sessions: sessions.length }, now);
    res.weeks.push(id);
    res.rows += w.rows.length;
    res.kept += w.kept;
    if (dry) continue;
    writeAtomic(file, JSON.stringify(w));
    const prevId = shiftWeek(id, -1);
    const before = prevId ? readWeekFile(path.join(dir, `${prevId}.json`)) : undefined;
    writeAtomic(path.join(dir, `${id}.md`), weeklyMarkdown(w, before));
  }
  return res;
}

/** Reads all local Claude / Codex history (including Codex archived sessions) into snapshots. */
export async function collectAll(opts: { days: number; maxSessions: number; git: boolean }): Promise<{ sessions: AgentSessionSnapshot[]; ms: number }> {
  // Lazy imports: the screen bundle only pays for the providers when a build is requested.
  const { ClaudeAdapter } = await import('../providers/claude/claude');
  const { CodexAdapter } = await import('../providers/codex/codex');
  const { SessionStore } = await import('../sessions/store');
  const t0 = Date.now();
  const store = new SessionStore([new ClaudeAdapter(), new CodexAdapter()], { historyDays: opts.days, maxSessions: opts.maxSessions, idleMinutes: 10, git: opts.git });
  try {
    await store.refresh();
    return { sessions: store.all(), ms: Date.now() - t0 };
  } finally {
    store.dispose();
  }
}
