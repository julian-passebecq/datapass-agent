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
  /** A load running longer than this is abandoned by a forced reload (refresh / Retry). Default FEED_TIMEOUT_MS. */
  timeoutMs?: number;
  load(ctx: FeedCtx): Promise<T>;
}

/** Default feed timeout; matches the 60 s after which the webview turns a loading marker into Retry (kit.LOAD_TIMEOUT_S). */
export const FEED_TIMEOUT_MS = 60_000;

export interface FeedState<T> {
  value?: T;
  at?: number;
  ms?: number;
  error?: string;
  running?: boolean;
  /** When the running load started (ctx.now). */
  startedAt?: number;
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

/** True when the feed is running and started more than its timeout ago. */
export function feedTimedOut(f: Pick<Feed, 'timeoutMs'>, st: FeedState<unknown>, now: number): boolean {
  return !!st.running && st.startedAt !== undefined && now - st.startedAt > (f.timeoutMs ?? FEED_TIMEOUT_MS);
}

/**
 * Loads every stale feed (not running, older than its interval, or `force`). Calls onUpdate after each lands.
 * A forced reload also restarts a feed whose load has run past its timeout; the abandoned load's late result is dropped.
 */
export function pump(feeds: Feed[], ctx: FeedCtx, onUpdate: () => void, force = false): void {
  for (const f of feeds) {
    const key = k(f.id);
    const st = cache.get(key) ?? {};
    if (st.running && !(force && feedTimedOut(f, st, ctx.now))) continue;
    if (!st.running && !force && st.at !== undefined && ctx.now - st.at < f.intervalMs) continue;
    const prev: FeedState<unknown> = { ...st, running: undefined, startedAt: undefined };
    const mine: FeedState<unknown> = { ...prev, running: true, startedAt: ctx.now };
    cache.set(key, mine);
    const t0 = Date.now();
    // Only the current load may write: a restarted (timed-out) load that lands late is ignored.
    const settle = (next: FeedState<unknown>) => {
      if (cache.get(key) !== mine) return false;
      cache.set(key, next);
      return true;
    };
    let p: Promise<unknown>;
    try {
      p = Promise.resolve(f.load(ctx));
    } catch (err) {
      p = Promise.reject(err);
    }
    p.then(
      value => settle({ value, at: Date.now(), ms: Date.now() - t0 }),
      err => settle({ ...prev, at: Date.now(), ms: Date.now() - t0, error: String((err as Error)?.message ?? err).slice(0, 300) }),
    ).then(changed => {
      if (changed) onUpdate();
    });
  }
}

/** Test helper. */
export function setFeedValue<T>(id: string, value: T, at = Date.now()): void {
  cache.set(k(id), { value, at });
}

/** Scoped companion panels cannot run collectors that discover provider-wide roots. */
export function scopedPanelFeed(id:string):boolean {
  return ['compact.backlog','compact.assets','transcript.settings','hud.lessons','health.config','runs.config'].includes(id);
}
export function unavailableFeed(id:string):void {
  cache.set(k(id),{error:'UNKNOWN — this collector requires independent local-source review; no scoped provider-wide scan was performed.',at:Date.now()});
}

export function clearFeeds(): void {
  cache.clear();
}
