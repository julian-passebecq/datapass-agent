import { AgentSessionSnapshot, ProviderState, TimelineEvent } from '../model';
import { ProviderAdapter } from '../providers/types';
import { correlate, gitSignal } from '../git/git';
import { SessionAccumulator } from './accumulator';
import { deriveStatus } from './classify';

export interface StoreOptions {
  historyDays: number;
  maxSessions: number;
  idleMinutes: number;
  /** Git correlation is disabled in untrusted workspaces. */
  git: boolean;
}

export interface RefreshStats {
  at: number;
  ms: number;
  artifacts: number;
  ingested: number;
  bytesRead: number;
  gitMs: number;
  /** Longest synchronous stretch of this pass inside the store (ms, host-measured): how long views had to wait. */
  longestSyncMs?: number;
  /** Sessions whose git correlation was (re)computed in this pass; the others reused an unchanged result. */
  gitCorrelated?: number;
}

/** Progress of the git correlation phase (OBSERVED: counted while it runs). `done === total` when idle. */
export interface GitProgress {
  done: number;
  total: number;
}

type GitFields = Pick<AgentSessionSnapshot, 'repository' | 'worktree' | 'isLinkedWorktree' | 'branch' | 'detachedHead' | 'headBefore' | 'headAfter' | 'dirty' | 'commits' | 'changedFiles' | 'linesAdded' | 'linesRemoved' | 'evidence' | 'diagnostics'>;

/** Time slice after which a refresh yields to the event loop (UI messages, timers, git callbacks). */
const SLICE_MS = 16;
/** Non-ended sessions are re-asked to git at least this often even without a change signal (catches edits that only
 *  touch the working tree, i.e. `dirty`). There is no per-minute bucket: git state is otherwise keyed on real change
 *  signals (HEAD, reflog, index, branch ref, packed-refs) and on the session's own activity. */
export const LIVE_GIT_MAX_AGE_MS = 15 * 60_000;
/** Minimum spacing of progress notifications during the git phase. */
const GIT_EMIT_MS = 250;

/** In-memory, rebuildable projection. Provider artifacts and git stay the authority; nothing here is persisted. */
export class SessionStore {
  private accs = new Map<string, SessionAccumulator>(); // by session key
  private byArtifact = new Map<string, SessionAccumulator>();
  private snapshots = new Map<string, AgentSessionSnapshot>();
  private gitDone = new Map<string, { sig: string; at: number }>(); // key → signature + wall time of last correlation
  private gitCache = new Map<string, GitFields>();
  /** Per session: fingerprint of the accumulator state its current snapshot was built from. */
  private built = new Map<string, string>();
  private listeners: (() => void)[] = [];
  private running?: Promise<RefreshStats>;
  private again = false;
  private providerSig = '';
  lastStats?: RefreshStats;
  history: RefreshStats[] = [];
  providerStates: ProviderState[] = [];
  /** Bumped only when the projection (snapshots, git fields, provider states) changed. Views may skip a render when
   *  it did not; every refresh still notifies once at its end so the refresh line stays current. */
  version = 0;
  gitProgress: GitProgress = { done: 0, total: 0 };

  constructor(readonly adapters: ProviderAdapter[], public opts: StoreOptions, private clock: () => number = Date.now, private wall: () => number = Date.now) {}

  private disposed = false;

  onDidChange(fn: () => void): { dispose(): void } {
    this.listeners.push(fn);
    return { dispose: () => (this.listeners = this.listeners.filter(l => l !== fn)) };
  }

  /** Stops notifying views (window reload/shutdown); an in-flight refresh finishes silently. */
  dispose(): void {
    this.disposed = true;
    this.listeners = [];
  }

  /** Coalesces concurrent calls: at most one refresh runs, one more is queued. */
  refresh(): Promise<RefreshStats> {
    if (this.disposed) return Promise.resolve(this.lastStats ?? { at: this.clock(), ms: 0, artifacts: 0, ingested: 0, bytesRead: 0, gitMs: 0 });
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.doRefresh().finally(() => {
      this.running = undefined;
      if (this.again) {
        this.again = false;
        void this.refresh();
      }
    });
    return this.running;
  }

  private async doRefresh(): Promise<RefreshStats> {
    const t0 = performance.now();
    const now = this.clock();
    const since = now - this.opts.historyDays * 86400_000;
    let artifacts = 0, ingested = 0, bytesRead = 0;
    // Time-sliced: yield whenever the current synchronous stretch passed SLICE_MS, so a refresh never holds the host
    // for the whole history. A single huge artifact is still one stretch (the adapter reads it in one call).
    let slice = performance.now(), longest = 0;
    const maybeYield = async (): Promise<void> => {
      const d = performance.now() - slice;
      if (d < SLICE_MS) return;
      longest = Math.max(longest, d);
      await yieldTick();
      slice = performance.now();
    };
    for (const a of this.adapters) {
      const refs = a.listArtifacts(since, this.opts.maxSessions);
      artifacts += refs.length;
      await maybeYield();
      for (const ref of refs) {
        const prevAcc = this.byArtifact.get(ref.path);
        const before = prevAcc?.cursor?.offset ?? 0; // read before ingest: the adapter advances the same cursor
        // Same size and mtime as the cursor: nothing new to parse, skip the adapter call.
        const acc = prevAcc?.cursor && prevAcc.cursor.size === ref.size && prevAcc.cursor.mtimeMs === ref.mtimeMs ? prevAcc : a.ingest(ref);
        if (acc) {
          this.byArtifact.set(ref.path, acc);
          const after = acc.cursor?.offset ?? 0;
          if (after !== before) {
            ingested++;
            bytesRead += Math.max(0, after - before);
          }
          const prev = this.accs.get(acc.key);
          // Same provider session id in two artifacts (e.g. archived copy): keep the most recent.
          if (!(prev && prev !== acc && (prev.lastActivityAt ?? 0) > (acc.lastActivityAt ?? 0))) this.accs.set(acc.key, acc);
        }
        await maybeYield();
      }
    }
    for (const a of this.adapters) a.refreshLive(this.accs.values(), now);
    await maybeYield();

    const idleMs = this.opts.idleMinutes * 60_000;
    const next = new Map<string, AgentSessionSnapshot>();
    const built = new Map<string, string>();
    let changed = false;
    for (const acc of this.accs.values()) {
      if ((acc.lastActivityAt ?? 0) < since) continue;
      const st = deriveStatus(acc.live, now, idleMs);
      const fp = fingerprint(acc, st.status, st.reason);
      const old = this.snapshots.get(acc.key);
      if (old && this.built.get(acc.key) === fp) {
        // Nothing the snapshot is built from changed: keep it, with the git fields already on it.
        next.set(acc.key, old);
        built.set(acc.key, fp);
        continue;
      }
      changed = true;
      const s = baseSnapshot(acc, st);
      // A rebuilt snapshot has no git fields yet: carry the last result over until correlation confirms or redoes it.
      const cached = this.gitCache.get(s.key);
      if (cached) Object.assign(s, { ...cached, changedFiles: [...cached.changedFiles], evidence: [...s.evidence, ...cached.evidence], diagnostics: [...s.diagnostics, ...cached.diagnostics] });
      next.set(s.key, s);
      built.set(s.key, fp);
      await maybeYield();
    }
    if (next.size !== this.snapshots.size) changed = true;
    this.snapshots = next;
    this.built = built;
    this.providerStates = this.adapters.map(a => a.detect());
    // Source timestamps move on every pass; they are not a change of the projection.
    const psig = JSON.stringify(this.providerStates.map(p => ({ ...p, sources: p.sources?.map(x => ({ ...x, at: 0 })) })));
    if (psig !== this.providerSig) {
      this.providerSig = psig;
      changed = true;
    }
    longest = Math.max(longest, performance.now() - slice);
    if (changed) this.bump(); // fast first paint, git follows

    const g0 = performance.now();
    const gitCorrelated = this.opts.git ? await this.correlateAll(now) : 0;
    const gitMs = performance.now() - g0;

    const stats: RefreshStats = { at: now, ms: Math.round(performance.now() - t0), artifacts, ingested, bytesRead, gitMs: Math.round(gitMs), longestSyncMs: Math.round(longest), gitCorrelated };
    this.lastStats = stats;
    this.history.push(stats);
    if (this.history.length > 50) this.history.shift();
    this.emit();
    return stats;
  }

  /** Git correlation, progressive: results land per batch (live sessions first, then the last 24 h, then older
   *  history) with a throttled notification, instead of one notification when everything is done. */
  private async correlateAll(now: number): Promise<number> {
    const wall = this.wall();
    const order = [...this.snapshots.values()].sort((a, b) => rank(a, now) - rank(b, now) || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
    const todo: { s: AgentSessionSnapshot; sig: string }[] = [];
    const sigs = new Map<string, string>(); // git signal per cwd, once per pass
    for (const s of order) {
      const acc = this.accs.get(s.key);
      if (!acc) continue;
      const ended = s.status === 'ENDED';
      // ENDED sessions are correlated once (their window is closed); others when their git signal or activity moved.
      let sig = 'ENDED|';
      if (!ended) {
        const cwd = s.cwd ?? '';
        let g = sigs.get(cwd);
        if (g === undefined) sigs.set(cwd, (g = gitSignal(s.cwd)));
        sig = `${s.status}|${s.lastActivityAt}|${s.cwd}|${acc.files.size}|${g}`;
      }
      const prev = this.gitDone.get(s.key);
      const fresh = prev && this.gitCache.has(s.key) && (ended ? prev.sig.startsWith('ENDED|') : prev.sig === sig && wall - prev.at < LIVE_GIT_MAX_AGE_MS);
      if (!fresh) todo.push({ s, sig });
    }
    this.gitProgress = { done: 0, total: todo.length };
    if (!todo.length) return 0;
    let lastEmit = performance.now();
    let first = true;
    let i = 0;
    while (i < todo.length) {
      // Wider batches for live/recent sessions, narrower for old history so it never starves the host.
      const batch = todo.slice(i, i + (rank(todo[i].s, now) < 2 ? 8 : 4));
      i += batch.length;
      const jobs: Promise<void>[] = [];
      for (const { s, sig } of batch) {
        // Starting a process blocks the thread (notably on Windows): one spawn start per tick, not a burst.
        await yieldTick();
        jobs.push(this.correlateOne(s, sig, now));
      }
      await Promise.all(jobs);
      this.gitProgress = { done: i, total: todo.length };
      const t = performance.now();
      if (i < todo.length && (first || t - lastEmit >= GIT_EMIT_MS)) {
        first = false;
        lastEmit = t;
        this.bump();
      }
    }
    this.version++;
    return todo.length;
  }

  private async correlateOne(s: AgentSessionSnapshot, sig: string, now: number): Promise<void> {
    const acc = this.accs.get(s.key);
    if (!acc) return;
    // Correlate a clean projection (no carried-over git fields) so the result never depends on a previous one.
    const work = baseSnapshot(acc, { status: s.status, reason: s.statusReason });
    const evBefore = work.evidence.length, dBefore = work.diagnostics.length;
    await correlate(work, now, now - (this.opts.historyDays + 1) * 86400_000);
    this.gitCache.set(s.key, {
      repository: work.repository, worktree: work.worktree, isLinkedWorktree: work.isLinkedWorktree, branch: work.branch, detachedHead: work.detachedHead,
      headBefore: work.headBefore, headAfter: work.headAfter, dirty: work.dirty, commits: work.commits, changedFiles: work.changedFiles,
      linesAdded: work.linesAdded, linesRemoved: work.linesRemoved, evidence: work.evidence.slice(evBefore), diagnostics: work.diagnostics.slice(dBefore),
    });
    this.gitDone.set(s.key, { sig, at: this.wall() });
    // A newer pass may have replaced the snapshot meanwhile (it carries this result over); else swap in the result.
    if (this.snapshots.get(s.key) === s) this.snapshots.set(s.key, work);
  }

  private bump(): void {
    this.version++;
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch {
        /* a broken view must not break ingestion */
      }
    }
  }

  all(): AgentSessionSnapshot[] {
    return [...this.snapshots.values()].sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
  }

  get(key: string): AgentSessionSnapshot | undefined {
    return this.snapshots.get(key);
  }

  children(key: string): AgentSessionSnapshot[] {
    return this.all().filter(s => s.parentSessionId === key);
  }

  timeline(key?: string, limit = 300): TimelineEvent[] {
    const keys = key ? [key, ...this.children(key).map(c => c.key)] : [...this.snapshots.keys()];
    const out: TimelineEvent[] = [];
    for (const k of keys) {
      const acc = this.accs.get(k);
      const s = this.snapshots.get(k);
      if (!acc || !s) continue;
      const ev = acc.timeline();
      if (s.startedAt && !ev.some(e => e.type === 'SESSION_STARTED')) ev.unshift({ at: s.startedAt, type: 'SESSION_STARTED', label: 'first recorded activity', provider: s.provider, sessionKey: k, kind: 'DERIVED' });
      for (const c of s.commits) ev.push({ at: c.at, type: 'COMMIT', label: `${c.sha.slice(0, 7)} ${c.subject}`, provider: s.provider, sessionKey: k, kind: 'DERIVED' });
      if (s.status === 'ENDED' && s.endedAt) ev.push({ at: s.endedAt, type: 'SESSION_ENDED', label: s.isWorker ? 'worker ended' : 'session ended', provider: s.provider, sessionKey: k, kind: 'DERIVED' });
      out.push(...ev);
    }
    out.sort((a, b) => a.at - b.at);
    return out.slice(-limit);
  }
}

/** Accumulator projection plus derived status (no git fields). */
function baseSnapshot(acc: SessionAccumulator, st: { status: AgentSessionSnapshot['status']; reason: string }): AgentSessionSnapshot {
  const s = acc.toSnapshot();
  s.status = st.status;
  s.statusReason = st.reason;
  if (s.status === 'ENDED') {
    s.endedAt = s.lastActivityAt;
    s.evidence.push({ field: 'endedAt', kind: 'DERIVED', source: 'last recorded activity of an ended session' });
  }
  return s;
}

/** What a snapshot is built from: the artifact cursor (every ingest moves it), the live signal and derived status, and
 *  the fields `refreshLive` may set without moving the cursor (title, version, status evidence). */
export function fingerprint(acc: SessionAccumulator, status: string, reason: string): string {
  const c = acc.cursor;
  const ev = acc.evidence.get('status');
  return [c?.offset, c?.size, c?.mtimeMs, status, reason, JSON.stringify(acc.live), acc.title, acc.providerVersion, acc.evidence.size, ev?.kind, ev?.source, acc.parentSessionId, acc.workerLabel, acc.isWorker, acc.files.size, acc.tests.length, acc.events.length, acc.diagnostics.length, acc.malformed, acc.startedAt, acc.lastActivityAt, acc.cwd].join('\u0001');
}

/** 0 live, 1 idle or active in the last 24 h, 2 older history. */
function rank(s: AgentSessionSnapshot, now: number): number {
  if (s.status === 'RUNNING' || s.status === 'NEEDS_INPUT') return 0;
  return s.status === 'IDLE' || now - (s.lastActivityAt ?? 0) < 86400_000 ? 1 : 2;
}

function yieldTick(): Promise<void> {
  return new Promise(r => setImmediate(r));
}
