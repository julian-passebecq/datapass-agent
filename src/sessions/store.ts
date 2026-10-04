import { AgentSessionSnapshot, ProviderState, TimelineEvent } from '../model';
import { ProviderAdapter } from '../providers/types';
import { correlate } from '../git/git';
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
}

/** In-memory, rebuildable projection. Provider artifacts and git stay the authority; nothing here is persisted. */
export class SessionStore {
  private accs = new Map<string, SessionAccumulator>(); // by session key
  private byArtifact = new Map<string, SessionAccumulator>();
  private snapshots = new Map<string, AgentSessionSnapshot>();
  private gitDone = new Map<string, string>(); // key → signature of last correlation
  private gitCache = new Map<string, Pick<AgentSessionSnapshot, 'repository' | 'worktree' | 'isLinkedWorktree' | 'branch' | 'detachedHead' | 'headBefore' | 'headAfter' | 'dirty' | 'commits' | 'changedFiles' | 'linesAdded' | 'linesRemoved' | 'evidence' | 'diagnostics'>>();
  private listeners: (() => void)[] = [];
  private running?: Promise<RefreshStats>;
  private again = false;
  lastStats?: RefreshStats;
  history: RefreshStats[] = [];
  providerStates: ProviderState[] = [];

  constructor(readonly adapters: ProviderAdapter[], public opts: StoreOptions, private clock: () => number = Date.now) {}

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
    for (const a of this.adapters) {
      const refs = a.listArtifacts(since, this.opts.maxSessions);
      artifacts += refs.length;
      let n = 0;
      for (const ref of refs) {
        const before = this.byArtifact.get(ref.path)?.cursor?.offset ?? 0;
        const acc = a.ingest(ref);
        if (!acc) continue;
        this.byArtifact.set(ref.path, acc);
        const after = acc.cursor?.offset ?? 0;
        if (after !== before) {
          ingested++;
          bytesRead += Math.max(0, after - before);
        }
        const prev = this.accs.get(acc.key);
        if (prev && prev !== acc) {
          // Same provider session id in two artifacts (e.g. archived copy): keep the most recent.
          if ((prev.lastActivityAt ?? 0) > (acc.lastActivityAt ?? 0)) continue;
        }
        this.accs.set(acc.key, acc);
        if (++n % 20 === 0) await yieldTick();
      }
    }
    for (const a of this.adapters) a.refreshLive(this.accs.values(), now);

    const idleMs = this.opts.idleMinutes * 60_000;
    const next = new Map<string, AgentSessionSnapshot>();
    for (const acc of this.accs.values()) {
      if ((acc.lastActivityAt ?? 0) < since) continue;
      const s = acc.toSnapshot();
      const st = deriveStatus(acc.live, now, idleMs);
      s.status = st.status;
      s.statusReason = st.reason;
      if (s.status === 'ENDED') {
        s.endedAt = s.lastActivityAt;
        s.evidence.push({ field: 'endedAt', kind: 'DERIVED', source: 'last recorded activity of an ended session' });
      }
      next.set(s.key, s);
    }
    this.snapshots = next;
    this.providerStates = this.adapters.map(a => a.detect());
    this.emit(); // fast first paint, git follows

    const g0 = performance.now();
    if (this.opts.git) await this.correlateAll(now);
    const gitMs = performance.now() - g0;

    const stats = { at: now, ms: Math.round(performance.now() - t0), artifacts, ingested, bytesRead, gitMs: Math.round(gitMs) };
    this.lastStats = stats;
    this.history.push(stats);
    if (this.history.length > 50) this.history.shift();
    this.emit();
    return stats;
  }

  private async correlateAll(now: number): Promise<void> {
    const jobs: Promise<void>[] = [];
    // Live sessions first so the cockpit fills in quickly; ended history after.
    const order = [...this.snapshots.values()].sort((a, b) => rank(a) - rank(b) || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
    let done = 0;
    for (const s of order) {
      const sig = `${s.status}|${s.lastActivityAt}|${s.cwd}|${s.changedFiles.length}|${Math.floor(now / 60_000)}`;
      const cached = this.gitCache.get(s.key);
      if (cached && (this.gitDone.get(s.key) === sig || (s.status === 'ENDED' && this.gitDone.get(s.key)?.startsWith('ENDED|')))) {
        Object.assign(s, { ...cached, evidence: [...s.evidence, ...cached.evidence], diagnostics: [...s.diagnostics, ...cached.diagnostics] });
        continue;
      }
      jobs.push((async () => {
        const evBefore = s.evidence.length, dBefore = s.diagnostics.length;
        await correlate(s, now, now - (this.opts.historyDays + 1) * 86400_000);
        this.gitCache.set(s.key, {
          repository: s.repository, worktree: s.worktree, isLinkedWorktree: s.isLinkedWorktree, branch: s.branch, detachedHead: s.detachedHead,
          headBefore: s.headBefore, headAfter: s.headAfter, dirty: s.dirty, commits: s.commits, changedFiles: s.changedFiles,
          linesAdded: s.linesAdded, linesRemoved: s.linesRemoved, evidence: s.evidence.slice(evBefore), diagnostics: s.diagnostics.slice(dBefore),
        });
        this.gitDone.set(s.key, sig);
      })());
      if (jobs.length >= 8) {
        await Promise.all(jobs.splice(0));
        if (++done === 1) this.emit();
      }
    }
    await Promise.all(jobs);
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

function rank(s: AgentSessionSnapshot): number {
  return s.status === 'RUNNING' || s.status === 'NEEDS_INPUT' ? 0 : s.status === 'IDLE' ? 1 : 2;
}

function yieldTick(): Promise<void> {
  return new Promise(r => setImmediate(r));
}
