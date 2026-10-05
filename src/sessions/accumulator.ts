import * as path from 'path';
import { AgentSessionSnapshot, RateLimits, SessionFacts, SessionUsage, Evidence, EventType, EvidenceKind, Provider, TestObservation, TimelineEvent, sessionKey } from '../model';
import { Cursor } from '../util/jsonl';
import { bounded } from '../util/redact';
import { LiveSignal } from './classify';
import { windowKind } from '../activity/limits';

export const MAX_EVENTS = 400;
export const MAX_FILES = 500;
export const MAX_DIAG = 20;
const ACTION_TYPES = new Set<EventType>(['PROCESS_ACTIVITY', 'FILE_CHANGE', 'TEST', 'WORKER_STARTED', 'WORKER_ENDED', 'COMMIT']);

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
  usage?: SessionUsage;
  lastAction?: string;
  lastActionAt?: number;
  private lastUsage?: { id: string; total: number; out: number; cached: number };
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
    this.tick(at);
  }

  event(at: number | undefined, type: EventType, label: string, kind: EvidenceKind = 'OBSERVED', dedupeId?: string): void {
    if (at === undefined) return;
    if (dedupeId) {
      if (this.seenIds.has(dedupeId)) return;
      this.seenIds.add(dedupeId);
      if (this.seenIds.size > 5000) this.seenIds = new Set([...this.seenIds].slice(-2500));
    }
    this.events.push({ at, type, label, provider: this.provider, sessionKey: this.key, kind });
    if (ACTION_TYPES.has(type) && (this.lastActionAt === undefined || at >= this.lastActionAt)) {
      this.lastAction = label;
      this.lastActionAt = at;
    }
    if (this.events.length > MAX_EVENTS * 1.5) {
      // Keep the session start plus the newest events.
      const first = this.events.filter(e => e.type === 'SESSION_STARTED').slice(0, 1);
      this.events = [...first, ...this.events.slice(-MAX_EVENTS)];
    }
  }

  /** Adds one model call's usage. A repeated id (one message split over several records) replaces its earlier contribution. */
  addCallUsage(id: string, prompt: number, out: number, cached: number): void {
    const u = (this.usage ??= { totalTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
    if (this.lastUsage?.id === id) {
      u.totalTokens -= this.lastUsage.total;
      u.outputTokens -= this.lastUsage.out;
      u.cachedInputTokens -= this.lastUsage.cached;
    }
    this.lastUsage = { id, total: prompt + out, out, cached };
    u.totalTokens += prompt + out;
    u.outputTokens += out;
    u.cachedInputTokens += cached;
    u.contextTokens = prompt;
  }

  file(p: string): void {
    if (this.files.size < MAX_FILES) this.files.add(p);
  }

  diag(msg: string): void {
    if (this.diagnostics.length < MAX_DIAG && !this.diagnostics.includes(msg)) this.diagnostics.push(msg);
  }

  // ---------- SessionFacts (data package) ----------
  private fx = new FactsState();
  private factsCache?: { v: number; cwd?: string; facts: SessionFacts };

  /** One tool call requested by the model. `id` links it to its result (toolEnd). */
  toolStart(name: string, detail: string, at: number | undefined, id?: string): void {
    const fx = this.fx;
    fx.v++;
    const key = fx.toolCounts.has(name) || fx.toolCounts.size < MAX_TOOL_KEYS ? name : 'other';
    fx.toolCounts.set(key, (fx.toolCounts.get(key) ?? 0) + 1);
    if (id && at !== undefined) {
      fx.pending.set(id, { name, detail, startedAt: at });
      if (fx.pending.size > 50) fx.pending.delete(fx.pending.keys().next().value!);
    }
  }

  /** The result of a tool call was recorded. `isError` only when the provider flagged it. */
  toolEnd(id: string, isError?: boolean): void {
    const fx = this.fx;
    if (fx.pending.delete(id)) fx.v++;
    if (isError) this.toolError();
  }

  toolError(): void {
    this.fx.v++;
    this.fx.toolErrors++;
  }

  /** Turn ended or the user interrupted: nothing is running any more. */
  clearPendingTools(): void {
    if (this.fx.pending.size) {
      this.fx.pending.clear();
      this.fx.v++;
    }
  }

  /** Counts per source; the fact is the max over sources (two records describing the same thing never double count). */
  bump(field: AltField, source = ''): void {
    const m = (this.fx.alt[field] ??= {});
    m[source] = (m[source] ?? 0) + 1;
    this.fx.v++;
  }

  /** A human prompt (or a new turn, `source` null = not counted as a prompt) at `at`:
   *  closes a wait that started when the agent last finished. */
  humanPrompt(at: number | undefined, source: string | null = ''): void {
    if (source !== null) this.bump('prompts', source);
    else this.fx.v++;
    this.fx.pending.clear();
    const idle = this.fx.agentDoneAt;
    if (at !== undefined && idle !== undefined && at > idle) {
      const gap = at - idle;
      this.fx.waitTotalMs += gap;
      if (gap > this.fx.waitMaxMs) this.fx.waitMaxMs = gap;
    }
    this.fx.agentDoneAt = undefined;
  }

  /** The agent finished a turn (or produced a reply) at `at`: waiting on the user may start here. */
  agentDone(at: number | undefined): void {
    if (at === undefined) return;
    if (this.fx.agentDoneAt === undefined || at > this.fx.agentDoneAt) this.fx.agentDoneAt = at;
    this.fx.v++;
  }

  /** Active time: every in-order gap shorter than ACTIVE_GAP_MS between timestamped records. */
  tick(at: number | undefined): void {
    if (at === undefined) return;
    const last = this.fx.lastTick;
    if (last === undefined || at > last) {
      if (last !== undefined && at - last < ACTIVE_GAP_MS) this.fx.activeMs += at - last;
      this.fx.lastTick = at;
      this.fx.v++;
    }
  }

  editedFile(p: string, at: number | undefined): void {
    const f = this.fx.files.get(p);
    if (f) {
      f.edits++;
      if (at !== undefined && at > f.lastAt) f.lastAt = at;
    } else if (this.fx.files.size < MAX_FACT_FILES) this.fx.files.set(p, { path: p, edits: 1, lastAt: at ?? 0 });
    this.fx.v++;
  }

  /** One model call's tokens. A repeated id replaces the earlier record of the same call. */
  modelCall(id: string | undefined, at: number | undefined, prompt: number, out: number, model?: string): void {
    const fx = this.fx;
    fx.v++;
    const m = model ?? this.model ?? 'unknown';
    if (id !== undefined && fx.lastCall?.id === id) {
      const prev = fx.lastCall;
      fx.modelTokens.set(prev.model, (fx.modelTokens.get(prev.model) ?? 0) - prev.total);
      if (prev.idx >= 0 && fx.calls[prev.idx]) fx.calls.splice(prev.idx, 1);
    }
    fx.modelTokens.set(m, (fx.modelTokens.get(m) ?? 0) + prompt + out);
    let idx = -1;
    if (at !== undefined) {
      fx.calls.push([at, prompt, out]);
      if (fx.calls.length > MAX_CALLS * 1.25) fx.calls = fx.calls.slice(-MAX_CALLS);
      idx = fx.calls.length - 1;
    }
    fx.lastCall = { id: id ?? '', model: m, total: prompt + out, idx };
  }

  spawn(at: number | undefined, type: string, description: string): void {
    if (this.fx.spawns.length >= MAX_SPAWNS) return;
    this.fx.spawns.push({ at: at ?? 0, type: type || 'agent', description });
    this.fx.v++;
  }

  mcp(server: string): void {
    const k = this.fx.mcp.has(server) || this.fx.mcp.size < MAX_TOOL_KEYS ? server : 'other';
    this.fx.mcp.set(k, (this.fx.mcp.get(k) ?? 0) + 1);
    this.fx.v++;
  }

  /** Latest recorded value of a string fact (permission mode, sandbox, entrypoint, branch). */
  setFact(field: 'permissionMode' | 'sandbox' | 'entrypoint' | 'recordedBranch', value: unknown, max = 60): void {
    if (typeof value !== 'string' || !value) return;
    const v = bounded(value, max);
    if (this.fx.strings[field] !== v) {
      this.fx.strings[field] = v;
      this.fx.v++;
    }
  }

  /** Latest provider rate-limit sample (Codex token_count.rate_limits); keeps a short used-% history. */
  rateLimits(rl: RateLimits): void {
    const fx = this.fx;
    const prev = fx.rate;
    if (prev && rl.at < prev.at) return;
    const hist = prev?.history ?? [];
    let p: number | null = null, q: number | null = null;
    for (const slot of ['primary', 'secondary'] as const) {
      const w = rl[slot];
      const k = w && windowKind(w, slot);
      if (k === '5h') p = w!.usedPercent;
      else if (k === 'weekly') q = w!.usedPercent;
    }
    const last = hist[hist.length - 1];
    if (!last || last[1] !== p || last[2] !== q) {
      hist.push([rl.at, p, q]);
      if (hist.length > 360) hist.splice(0, hist.length - 300);
    }
    fx.rate = { ...rl, history: hist };
    fx.v++;
  }

  /** Read-only view for tests and adapters. */
  get pendingToolCount(): number {
    return this.fx.pending.size;
  }

  private buildFacts(): SessionFacts | undefined {
    const fx = this.fx;
    if (this.factsCache && this.factsCache.v === fx.v && this.factsCache.cwd === this.cwd) return this.factsCache.facts;
    if (fx.v === 0) return undefined;
    const alt = (f: AltField) => {
      const m = fx.alt[f];
      return m ? Math.max(...Object.values(m)) : undefined;
    };
    const rec = (m: Map<string, number>) => (m.size ? Object.fromEntries(m) : undefined);
    let current: SessionFacts['currentTool'];
    for (const p of fx.pending.values()) if (!current || p.startedAt >= current.startedAt) current = p;
    const cwd = this.cwd;
    const facts: SessionFacts = {
      toolCounts: rec(fx.toolCounts),
      toolErrors: fx.toolCounts.size || fx.toolErrors ? fx.toolErrors : undefined,
      currentTool: current && { ...current },
      prompts: alt('prompts'),
      replies: alt('replies'),
      files: fx.files.size ? [...fx.files.values()].map(f => ({ ...f, path: relPath(cwd, f.path) })).sort((a, b) => b.lastAt - a.lastAt) : undefined,
      modelTokens: fx.modelTokens.size ? Object.fromEntries([...fx.modelTokens].filter(([, n]) => n > 0)) : undefined,
      calls: fx.calls.length ? fx.calls.slice(-MAX_CALLS) : undefined,
      permissionMode: fx.strings.permissionMode,
      sandbox: fx.strings.sandbox,
      recordedBranch: fx.strings.recordedBranch,
      compactions: alt('compactions'),
      spawns: fx.spawns.length ? fx.spawns.slice() : undefined,
      web: alt('web'),
      mcp: rec(fx.mcp),
      waitMaxMs: fx.waitMaxMs || undefined,
      waitTotalMs: fx.waitTotalMs || undefined,
      activeMs: fx.lastTick !== undefined ? fx.activeMs : undefined,
      entrypoint: fx.strings.entrypoint,
      rateLimits: fx.rate && { ...fx.rate, history: fx.rate.history?.slice(-300) },
    };
    for (const k of Object.keys(facts) as (keyof SessionFacts)[]) if (facts[k] === undefined) delete facts[k];
    this.factsCache = { v: fx.v, cwd, facts };
    return facts;
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
      usage: this.usage && { ...this.usage },
      lastAction: this.lastAction,
      lastActionAt: this.lastActionAt,
      facts: this.buildFacts(),
      evidence: [...this.evidence.values(), ...(this.fx.v ? FACT_EVIDENCE : []), ...(this.ranGitCommit ? [{ field: 'commit-command', kind: 'OBSERVED' as const, source: 'provider recorded a git commit command' }] : [])],
      artifactPath: this.artifactPath,
      artifactBytes: this.cursor?.size,
      diagnostics: [...this.diagnostics, ...(this.malformed ? [`${this.malformed} malformed/oversize line(s) skipped`] : [])],
    };
  }

  timeline(): TimelineEvent[] {
    return [...this.events].sort((a, b) => a.at - b.at);
  }
}

export const MAX_CALLS = 2000;
export const MAX_FACT_FILES = 300;
export const ACTIVE_GAP_MS = 5 * 60_000;
const MAX_TOOL_KEYS = 80;
const MAX_SPAWNS = 200;

type AltField = 'prompts' | 'replies' | 'compactions' | 'web';

class FactsState {
  /** Bumped on every change; the built SessionFacts object is cached per version. */
  v = 0;
  toolCounts = new Map<string, number>();
  toolErrors = 0;
  pending = new Map<string, { name: string; detail: string; startedAt: number }>();
  alt: Partial<Record<AltField, Record<string, number>>> = {};
  files = new Map<string, { path: string; edits: number; lastAt: number }>();
  modelTokens = new Map<string, number>();
  calls: [number, number, number][] = [];
  lastCall?: { id: string; model: string; total: number; idx: number };
  spawns: { at: number; type: string; description: string }[] = [];
  mcp = new Map<string, number>();
  strings: { permissionMode?: string; sandbox?: string; entrypoint?: string; recordedBranch?: string } = {};
  agentDoneAt?: number;
  waitMaxMs = 0;
  waitTotalMs = 0;
  activeMs = 0;
  lastTick?: number;
  rate?: RateLimits;
}

/** Evidence for the facts block: what is read vs computed. */
const FACT_EVIDENCE: Evidence[] = [
  { field: 'facts', kind: 'OBSERVED', source: 'tool calls, prompts, tokens, modes as recorded in the transcript / rollout' },
  { field: 'facts.activeMs', kind: 'DERIVED', source: 'sum of gaps < 5 min between recorded events' },
  { field: 'facts.waitMs', kind: 'DERIVED', source: 'gaps between the agent finishing a turn and the next human prompt' },
];

/** Cwd-relative display path (no filesystem access), forward slashes. */
function relPath(cwd: string | undefined, file: string): string {
  if (!cwd) return file;
  const rel = path.relative(cwd, file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.replace(/\\/g, '/') : file;
}
