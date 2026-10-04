import { AgentSessionSnapshot, Evidence, EventType, EvidenceKind, Provider, TestObservation, TimelineEvent, sessionKey } from '../model';
import { Cursor } from '../util/jsonl';
import { LiveSignal } from './classify';

export const MAX_EVENTS = 400;
export const MAX_FILES = 500;
export const MAX_DIAG = 20;

/** Mutable per-artifact ingestion state. Holds only bounded, redacted facts — never transcript bodies. */
export class SessionAccumulator {
  key: string;
  cursor?: Cursor;
  startedAt?: number;
  lastActivityAt?: number;
  providerVersion?: string;
  model?: string;
  effort?: string;
  title?: string;
  firstPrompt?: string;
  cwd?: string;
  branch?: string;
  headBefore?: string;
  parentSessionId?: string;
  workerLabel?: string;
  isWorker = false;
  files = new Set<string>();
  tests: TestObservation[] = [];
  events: TimelineEvent[] = [];
  evidence = new Map<string, Evidence>();
  diagnostics: string[] = [];
  counts = { tools: 0, commands: 0, fileEdits: 0, turns: 0 };
  live: LiveSignal = {};
  linesAdded?: number;
  linesRemoved?: number;
  ranGitCommit = false;
  malformed = 0;
  seenIds = new Set<string>();
  /** Long-lived one-shot markers (e.g. "start", "meta"); never trimmed. */
  flags = new Set<string>();

  constructor(public provider: Provider, public sessionId: string, public artifactPath: string) {
    this.key = sessionKey(provider, sessionId);
  }

  ev(field: string, kind: EvidenceKind, source: string): void {
    // First observation of a field wins unless a stronger kind arrives.
    const rank: Record<EvidenceKind, number> = { OBSERVED: 3, DERIVED: 2, INFERRED: 1, UNKNOWN: 0 };
    const prev = this.evidence.get(field);
    if (!prev || rank[kind] > rank[prev.kind]) this.evidence.set(field, { field, kind, source });
  }

  touch(at: number | undefined): void {
    if (at === undefined) return;
    if (this.startedAt === undefined || at < this.startedAt) this.startedAt = at;
    if (this.lastActivityAt === undefined || at > this.lastActivityAt) this.lastActivityAt = at;
  }

  event(at: number | undefined, type: EventType, label: string, kind: EvidenceKind = 'OBSERVED', dedupeId?: string): void {
    if (at === undefined) return;
    if (dedupeId) {
      if (this.seenIds.has(dedupeId)) return;
      this.seenIds.add(dedupeId);
      if (this.seenIds.size > 5000) this.seenIds = new Set([...this.seenIds].slice(-2500));
    }
    this.events.push({ at, type, label, provider: this.provider, sessionKey: this.key, kind });
    if (this.events.length > MAX_EVENTS * 1.5) {
      // Keep the session start plus the newest events.
      const first = this.events.filter(e => e.type === 'SESSION_STARTED').slice(0, 1);
      this.events = [...first, ...this.events.slice(-MAX_EVENTS)];
    }
  }

  file(p: string): void {
    if (this.files.size < MAX_FILES) this.files.add(p);
  }

  diag(msg: string): void {
    if (this.diagnostics.length < MAX_DIAG && !this.diagnostics.includes(msg)) this.diagnostics.push(msg);
  }

  /** Projection without git. Status is filled by the store. */
  toSnapshot(): AgentSessionSnapshot {
    return {
      key: this.key,
      provider: this.provider,
      sessionId: this.sessionId,
      providerVersion: this.providerVersion,
      model: this.model,
      effort: this.effort,
      title: this.title ?? this.firstPrompt,
      startedAt: this.startedAt,
      lastActivityAt: this.lastActivityAt,
      status: 'UNKNOWN',
      statusReason: '',
      cwd: this.cwd,
      branch: this.branch,
      headBefore: this.headBefore,
      commits: [],
      changedFiles: [...this.files],
      linesAdded: this.linesAdded,
      linesRemoved: this.linesRemoved,
      tests: [...this.tests],
      parentSessionId: this.parentSessionId,
      workerLabel: this.workerLabel,
      isWorker: this.isWorker,
      counts: { ...this.counts },
      evidence: [...this.evidence.values(), ...(this.ranGitCommit ? [{ field: 'commit-command', kind: 'OBSERVED' as const, source: 'provider recorded a git commit command' }] : [])],
      artifactPath: this.artifactPath,
      diagnostics: [...this.diagnostics, ...(this.malformed ? [`${this.malformed} malformed/oversize line(s) skipped`] : [])],
    };
  }

  timeline(): TimelineEvent[] {
    return [...this.events].sort((a, b) => a.at - b.at);
  }
}
