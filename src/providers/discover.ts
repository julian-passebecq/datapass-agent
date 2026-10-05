// Folder listings for provider discovery, cached by directory mtime.
// Adding, removing or renaming an entry changes a directory's mtime; appending to a file inside does not, so file
// sizes / mtimes are still stat'ed by the caller. A directory changed in the last RECENT_MS is always re-listed
// (mtime granularity on some file systems is coarse). Read-only: only stat and readdir.
import * as fs from 'fs';

export interface DirEntry {
  name: string;
  dir: boolean;
  file: boolean;
}

interface Cached {
  mtimeMs: number;
  entries: DirEntry[];
  /** Refresh generation that last used this listing (listings unused for a whole refresh are pruned). */
  gen: number;
}

export interface DirCacheStats {
  /** Listings served from the cache (stat only, no readdir). */
  hits: number;
  /** readdir calls made. */
  reads: number;
  /** Directories that did not exist or could not be read. */
  missing: number;
}

const RECENT_MS = 2000;
const MAX_DIRS = 20_000;

export class DirCache {
  private dirs = new Map<string, Cached>();
  private gen = 0;
  stats: DirCacheStats = { hits: 0, reads: 0, missing: 0 };

  constructor(private readonly now: () => number = Date.now) {}

  /** Starts a refresh (one discovery pass): listings not used during the previous pass are dropped. */
  begin(): void {
    const prev = this.gen++;
    for (const [d, c] of this.dirs) if (c.gen < prev) this.dirs.delete(d);
  }

  /** Entries of `dir`, or undefined when it does not exist or is not a directory. */
  list(dir: string): DirEntry[] | undefined {
    let st: fs.Stats | undefined;
    try {
      st = fs.statSync(dir, { throwIfNoEntry: false });
    } catch {
      st = undefined;
    }
    if (!st || !st.isDirectory()) return this.miss(dir);
    const c = this.dirs.get(dir);
    if (c && c.mtimeMs === st.mtimeMs && this.now() - st.mtimeMs > RECENT_MS) {
      c.gen = this.gen;
      this.stats.hits++;
      return c.entries;
    }
    let entries: DirEntry[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).map(e => ({ name: e.name, dir: e.isDirectory(), file: e.isFile() }));
    } catch {
      return this.miss(dir);
    }
    this.stats.reads++;
    if (!c && this.dirs.size >= MAX_DIRS) this.dirs.delete(this.dirs.keys().next().value as string);
    this.dirs.set(dir, { mtimeMs: st.mtimeMs, entries, gen: this.gen });
    return entries;
  }

  /** Entry names of `dir` ([] when missing). */
  names(dir: string): string[] {
    return (this.list(dir) ?? []).map(e => e.name);
  }

  get size(): number {
    return this.dirs.size;
  }

  private miss(dir: string): undefined {
    this.dirs.delete(dir);
    this.stats.missing++;
    return undefined;
  }
}

/** size + mtime of a file, undefined when it vanished (no exception thrown for the common ENOENT case). */
export function statFile(p: string): { size: number; mtimeMs: number } | undefined {
  try {
    const st = fs.statSync(p, { throwIfNoEntry: false });
    return st && st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : undefined;
  } catch {
    return undefined;
  }
}
