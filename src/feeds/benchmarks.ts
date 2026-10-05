// Model benchmarks database on disk (~/.agent/benchmarks by default, setting agent.benchmarks.dir): one JSON snapshot
// per ISO week (YYYY-Www.json), written only by scripts/benchmarks.ts (run by the user), read by the screen feed.
// Agent's own folder only: provider files are never written; older weeks are never deleted. The network helper
// (fetchText) is used only by the script with --fetch; the feed never touches the network.
import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { BENCH_FILE_RE, BenchRow, BenchSnapshot, BenchSource, benchSlug, mergeSnapshot, SourceKind, validateRow, validateSnapshot, validateSource } from '../activity/benchmarks';
import { isPlausibleLocalPath } from '../util/paths';
import type { Feed, FeedCtx } from '../render/extra/feeds';

export const BENCH_FEED = 'benchmarks.db';
const MAX_FILE = 8 * 1024 * 1024;
const MAX_MANUAL = 2 * 1024 * 1024;
const MAX_FETCH = 5 * 1024 * 1024;

export function defaultBenchDir(): string {
  return path.join(os.homedir(), '.agent', 'benchmarks');
}

/** The configured folder when it is a plausible absolute local path, else ~/.agent/benchmarks. */
export function benchDir(configured: unknown): string {
  return typeof configured === 'string' && configured.trim() && isPlausibleLocalPath(configured.trim()) ? path.normalize(configured.trim()) : defaultBenchDir();
}

export interface BenchDb {
  dir: string;
  exists: boolean;
  /** Oldest first. */
  weeks: BenchSnapshot[];
  files: number;
  /** Files in manual/ (not yet imported ones included). */
  manualFiles: number;
  errors: { file: string; error: string }[];
  at: number;
}

export function readSnapshotFile(file: string): BenchSnapshot | undefined {
  try {
    if (fs.statSync(file).size > MAX_FILE) return undefined;
    return validateSnapshot(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return undefined;
  }
}

/** Reads the newest `maxWeeks` snapshots (size-capped, validated). */
export function readBenchDb(dir: string, maxWeeks = 104, now = Date.now()): BenchDb {
  const res: BenchDb = { dir, exists: false, weeks: [], files: 0, manualFiles: 0, errors: [], at: now };
  let names: string[];
  try {
    names = fs.readdirSync(dir);
    res.exists = true;
  } catch {
    return res;
  }
  try {
    res.manualFiles = fs.readdirSync(path.join(dir, 'manual')).filter(n => n.toLowerCase().endsWith('.json')).length;
  } catch {
    /* no manual folder */
  }
  const files = names.filter(n => BENCH_FILE_RE.test(n)).sort().reverse();
  res.files = files.length;
  for (const n of files.slice(0, Math.max(1, maxWeeks))) {
    const p = path.join(dir, n);
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) continue;
      if (st.size > MAX_FILE) {
        res.errors.push({ file: n, error: `larger than ${MAX_FILE >> 20} MB, skipped` });
        continue;
      }
      const w = validateSnapshot(JSON.parse(fs.readFileSync(p, 'utf8')));
      if (!w || `${w.week}.json` !== n) {
        res.errors.push({ file: n, error: 'not a valid benchmark snapshot (schema or week id)' });
        continue;
      }
      res.weeks.push(w);
    } catch (e: any) {
      res.errors.push({ file: n, error: String(e?.code ?? e?.message ?? e).slice(0, 120) });
    }
  }
  res.weeks.sort((a, b) => a.week.localeCompare(b.week));
  return res;
}

export const benchmarksFeed: Feed<BenchDb> = {
  id: BENCH_FEED,
  intervalMs: 60_000,
  async load(ctx: FeedCtx) {
    return readBenchDb(benchDir(ctx.config<string>('agent.benchmarks.dir', '')), 104, ctx.now);
  },
};

/** Write via a temp file + rename so a reader never sees half a file. */
export function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* already gone */
    }
    throw e;
  }
}

/**
 * Merges one run into the week's snapshot (creating the folder) and writes it atomically. Earlier weeks are never
 * touched. Returns the merged snapshot (also when `dry`).
 */
export function writeWeek(dir: string, week: string, updates: { source: BenchSource; rows: BenchRow[] }[], now: number, dropKinds: SourceKind[] = [], dry = false): { file: string; snapshot: BenchSnapshot } {
  const file = path.join(dir, `${week}.json`);
  const prev = fs.existsSync(file) ? readSnapshotFile(file) : undefined;
  if (fs.existsSync(file) && !prev) throw new Error(`${file} exists but is not a valid snapshot: fix or move it, nothing written`);
  const snapshot = mergeSnapshot(prev, week, updates, now, dropKinds);
  if (!dry) {
    fs.mkdirSync(dir, { recursive: true });
    writeAtomic(file, `${JSON.stringify(snapshot, null, 1)}\n`);
  }
  return { file, snapshot };
}

export interface ManualRead {
  updates: { source: BenchSource; rows: BenchRow[] }[];
  errors: { file: string; error: string }[];
}

/**
 * Reads ~/.agent/benchmarks/manual/*.json. A file is either an array of rows, or {source: {name, url?, license?,
 * metric?, costBasis?}, rows: [...]}. Each file becomes one source "manual:<file name>".
 */
export function readManual(dir: string): ManualRead {
  const res: ManualRead = { updates: [], errors: [] };
  const mdir = path.join(dir, 'manual');
  let names: string[];
  try {
    names = fs.readdirSync(mdir).filter(n => n.toLowerCase().endsWith('.json')).sort();
  } catch {
    return res;
  }
  for (const n of names) {
    const p = path.join(mdir, n);
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) continue;
      if (st.size > MAX_MANUAL) {
        res.errors.push({ file: n, error: 'larger than 2 MB, skipped' });
        continue;
      }
      const o = JSON.parse(fs.readFileSync(p, 'utf8'));
      const rawRows: unknown[] = Array.isArray(o) ? o : Array.isArray(o?.rows) ? o.rows : [];
      const meta = Array.isArray(o) ? {} : (o?.source ?? {});
      const id = `manual:${benchSlug(n.replace(/\.json$/i, ''))}`;
      const source = validateSource({
        ...meta,
        id,
        name: typeof meta.name === 'string' && meta.name.trim() ? meta.name : n.replace(/\.json$/i, ''),
        kind: 'manual',
        fetchedAt: typeof meta.fetchedAt === 'number' ? meta.fetchedAt : st.mtimeMs,
        metric: meta.metric ?? 'as copied by you from the source',
        costBasis: meta.costBasis ?? 'as copied by you from the source',
      }) as BenchSource;
      const rows = rawRows.map(r => validateRow(r, id)).filter((r): r is BenchRow => !!r);
      if (rawRows.length && !rows.length) res.errors.push({ file: n, error: 'no valid row (each needs model and a numeric score)' });
      else if (rows.length < rawRows.length) res.errors.push({ file: n, error: `${rawRows.length - rows.length} row(s) skipped (missing model or numeric score)` });
      res.updates.push({ source, rows });
    } catch (e: any) {
      res.errors.push({ file: n, error: String(e?.message ?? e).slice(0, 120) });
    }
  }
  return res;
}

/** HTTPS GET (opt-in, script only): 20 s timeout, 5 MB cap, at most 3 https redirects. */
export function fetchText(url: string, redirects = 3): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!/^https:\/\//i.test(url)) return reject(new Error(`refusing non-https URL ${url}`));
    const req = https.get(url, { headers: { 'user-agent': 'agent-vscode-benchmarks' }, timeout: 20_000 }, res => {
      const code = res.statusCode ?? 0;
      if (code >= 300 && code < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(fetchText(new URL(res.headers.location, url).toString(), redirects - 1));
      }
      if (code !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${code} for ${url}`));
      }
      let size = 0;
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_FETCH) {
          req.destroy(new Error(`response larger than ${MAX_FETCH >> 20} MB`));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`timeout fetching ${url}`)));
    req.on('error', reject);
  });
}
