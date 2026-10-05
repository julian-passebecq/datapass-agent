// Async data for add-on screens (git, CI CLIs, config files, archive). Rendering stays synchronous:
// a screen reads the last cached value with feedValue(); the workspace panel pumps the feeds of the
// visible screen and re-renders when a value lands. No vscode import here, so tests can drive it.
import type { AgentSessionSnapshot } from '../../model';

export interface FeedCtx {
  sessions: AgentSessionSnapshot[];
  /** False in untrusted workspaces: feeds that run processes (git, gh, glab) must return early. */
  trusted: boolean;
  /** Reads an `agent.*` setting. */
  config<T>(key: string, fallback: T): T;
  now: number;
}

export interface Feed<T = unknown> {
  id: string;
  /** Minimum time between loads. */
  intervalMs: number;
  load(ctx: FeedCtx): Promise<T>;
}

export interface FeedState<T> {
  value?: T;
  at?: number;
  ms?: number;
  error?: string;
  running?: boolean;
}

const cache = new Map<string, FeedState<unknown>>();
/** Scope of the panel being rendered: feeds load from scoped sessions, so each scope has its own cache entry. */
let scope = '';
export function setFeedScope(s: string | undefined): void {
  scope = s ?? '';
}
const k = (id: string) => `${id}|${scope}`;

export function feedValue<T>(id: string): FeedState<T> {
  return (cache.get(k(id)) as FeedState<T>) ?? {};
}

/** Loads every stale feed (not running, older than its interval, or `force`). Calls onUpdate after each lands. */
export function pump(feeds: Feed[], ctx: FeedCtx, onUpdate: () => void, force = false): void {
  for (const f of feeds) {
    const key = k(f.id);
    const st = cache.get(key) ?? {};
    if (st.running || (!force && st.at !== undefined && ctx.now - st.at < f.intervalMs)) continue;
    cache.set(key, { ...st, running: true });
    const t0 = Date.now();
    f.load(ctx).then(
      value => cache.set(key, { value, at: Date.now(), ms: Date.now() - t0 }),
      err => cache.set(key, { ...st, at: Date.now(), ms: Date.now() - t0, error: String(err?.message ?? err).slice(0, 300) }),
    ).finally(onUpdate);
  }
}

/** Test helper. */
export function setFeedValue<T>(id: string, value: T, at = Date.now()): void {
  cache.set(k(id), { value, at });
}

export function clearFeeds(): void {
  cache.clear();
}
