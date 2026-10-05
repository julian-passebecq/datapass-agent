// Scope map baseline: the backlog snapshot Agent's archive wrote about a week ago (scripts/archive.ts →
// <archive>/backlog/YYYY-MM-DD.json), reduced to item key → state. Async, read-only, size-capped, cached by
// (path, size, mtime). No process, no network.
import * as fs from 'fs';
import * as path from 'path';
import type { ItemState } from '../activity/backlog';
import { STATES } from '../activity/backlog';
import { pickBaseline } from '../activity/scope';
import { archiveDir, dayOf } from '../archive/archive';
import { itemKey } from '../archive/reader';
import type { Feed, FeedCtx } from '../render/extra/feeds';

export const BASELINE_FEED = 'scope.baseline';
const MAX_FILE = 16 << 20;
const MAX_ITEMS = 50_000;

export interface Baseline {
  /** Snapshot day used as the baseline. */
  day: string;
  /** Snapshot days available (count). */
  days: number;
  states: Map<string, ItemState>;
}

const cache = new Map<string, { size: number; mtime: number; states: Map<string, ItemState> }>();

/** Baseline from an archive folder; undefined when the folder or a usable snapshot is missing. */
export async function readBaseline(dir: string, now: number): Promise<Baseline | undefined> {
  const blDir = path.join(dir, 'backlog');
  let names: string[];
  try {
    names = await fs.promises.readdir(blDir);
  } catch {
    return undefined;
  }
  const days = names.filter(n => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).map(n => n.slice(0, 10));
  const day = pickBaseline(days, dayOf(now));
  if (!day) return undefined;
  const file = path.join(blDir, `${day}.json`);
  let st: fs.Stats;
  try {
    st = await fs.promises.stat(file);
  } catch {
    return undefined;
  }
  if (!st.isFile() || st.size > MAX_FILE) return undefined;
  const hit = cache.get(file);
  if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) return { day, days: days.length, states: hit.states };
  const states = new Map<string, ItemState>();
  try {
    const o = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    for (const f of Array.isArray(o?.files) ? o.files : []) {
      if (!f || typeof f.root !== 'string' || typeof f.rel !== 'string' || !Array.isArray(f.items)) continue;
      for (const it of f.items) {
        if (states.size >= MAX_ITEMS) break;
        if (!it || typeof it.title !== 'string' || !(STATES as string[]).includes(it.state)) continue;
        states.set(itemKey(f.root, f.rel, it), it.state);
      }
    }
  } catch {
    return undefined;
  }
  if (cache.size > 50) cache.clear();
  cache.set(file, { size: st.size, mtime: st.mtimeMs, states });
  return { day, days: days.length, states };
}

export const baselineFeed: Feed<Baseline | undefined> = {
  id: BASELINE_FEED,
  intervalMs: 10 * 60_000,
  async load(ctx: FeedCtx) {
    return readBaseline(archiveDir(ctx.config<string>('agent.archive.dir', '')), ctx.now);
  },
};
