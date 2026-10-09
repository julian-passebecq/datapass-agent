import * as path from 'path';
import { AgentSessionSnapshot, RateLimits, TodoList, TodoStatus, SessionFacts, SessionUsage, Evidence, EventType, EvidenceKind, Provider, TestObservation, TimelineEvent, sessionKey } from '../model';
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
  private lastUsage?: { id: string; total: number; out: number; cached: number; extra: CallUsageExtra };
  private nativeInputs: NonNullable<SessionFacts['nativeInputs']> = [];
  private requestedTrace: NonNullable<SessionFacts['requestedTrace']> = [];
  private nativeGoal?:SessionFacts['nativeGoal'];
  private goalCalls=new Set<string>();
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

  /** Inert native request observation; transport and security remain provider-owned. */
  nativeRequest(id: string | undefined, input: unknown, source: string, at?: number): void {
    if (!id || id.length > 160 || this.nativeInputs.some(q => q.id === id)) return;
    const value = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const ordinary = /(?:^|[._])request_user_input(?:_async)?$|^AskUserQuestion$/.test(source);
    const security = /permission|approval|security/i.test(source) || value.requestClass === 'SECURITY_PERMISSION';
    const questions = (Array.isArray(value.questions) ? value.questions : []).slice(0, 3).map(q => {
      const v = q && typeof q === 'object' ? q as Record<string, unknown> : {};
      return { id: typeof v.id==='string' && /^[a-zA-Z0-9._:/-]{1,160}$/.test(v.id)?v.id:null, text: bounded(v.question ?? v.title, 1000), options: (Array.isArray(v.options) ? v.options : []).slice(0, 10).map(o => bounded(typeof o === 'string' ? o : o?.label, 120)) };
    });
    this.nativeInputs.push({ id: bounded(id, 160), questionIds: questions.map(q => q.id).filter((value):value is string=>value!==null), at: at ?? null, requestClass: security ? 'SECURITY_PERMISSION' : ordinary ? 'ORDINARY_INPUT' : 'UNKNOWN', questions, state: 'REQUESTED', answer: null, answeredAt: null, source: bounded(source, 100) });
    this.nativeInputs = this.nativeInputs.slice(-50); this.fx.v++;
    this.ev('facts.nativeInputs', 'OBSERVED', 'bounded native request metadata and matching result');
  }
  nativeAnswer(id: string, result: unknown, at?: number, cancelled = false): void {
    const request = this.nativeInputs.find(q => q.id === id);
    if (!request) return;
    request.state = cancelled ? 'CANCELLED' : 'ANSWER_RECEIVED'; request.answeredAt = at ?? null;
    request.answer = request.requestClass === 'ORDINARY_INPUT' ? bounded(typeof result === 'string' ? result : JSON.stringify(result), 2000) : null;
    this.fx.v++;
  }
  nativeTrace(input: { model?: unknown; effort?: unknown; inheritance?: unknown; goal?: unknown; source: string }, at?: number): void {
    const trace = { model: bounded(input.model, 80) || null, effort: bounded(input.effort, 30) || null, inheritance: bounded(input.inheritance, 40) || null, goal: bounded(input.goal, 40) || null, source: bounded(input.source, 100), at: at ?? null };
    if (JSON.stringify(this.requestedTrace.at(-1)) === JSON.stringify(trace)) return;
    this.requestedTrace.push(trace); this.requestedTrace = this.requestedTrace.slice(-50); this.fx.v++;
  }
  nativeGoalRequest(id:string|undefined,name:string,status:unknown,at?:number):void {
    if(!id || id.length>160)return;
    this.goalCalls.add(id);if(this.goalCalls.size>50)this.goalCalls.delete(this.goalCalls.values().next().value!);
    this.nativeGoal={requested:name==='create_goal'?'active':typeof status==='string'?bounded(status,30):null,observed:null,nativeThreadId:null,source:'native '+name+' request; execution not yet observed',at:at ?? null};this.fx.v++;
  }
  nativeGoalResult(id:string,value:unknown,at?:number):void {
    if(!this.goalCalls.has(id))return;this.goalCalls.delete(id);
    let output:any=value;if(typeof value==='string'){if(value.length>65536)return;try{output=JSON.parse(value);}catch{return;}}
    const goal=output?.goal;
    if(!goal || !['active','paused','blocked','complete','budget_limit','usage_limit'].includes(goal.status))return;
    this.nativeGoal={requested:this.nativeGoal?.requested ?? null,observed:goal.status,nativeThreadId:typeof goal.threadId==='string' && /^[a-zA-Z0-9._:/-]{1,160}$/.test(goal.threadId)?goal.threadId:null,source:'recorded native Goal tool result; not inferred from Plan or prompt',at:at ?? null};this.fx.v++;
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
  addCallUsage(id: string, prompt: number, out: number, cached: number, extra: CallUsageExtra = {}): void {
    const u = (this.usage ??= { totalTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
    if (this.lastUsage?.id === id) {
      u.totalTokens -= this.lastUsage.total;
      u.outputTokens -= this.lastUsage.out;
      u.cachedInputTokens -= this.lastUsage.cached;
      for (const k of EXTRA_KEYS) if (this.lastUsage.extra[k] !== undefined) u[k] = (u[k] ?? 0) - this.lastUsage.extra[k]!;
    }
    this.lastUsage = { id, total: prompt + out, out, cached, extra: { ...extra } };
    u.totalTokens += prompt + out;
    u.outputTokens += out;
    u.cachedInputTokens += cached;
    // Optional fields exist only once the provider recorded them at least once.
    for (const k of EXTRA_KEYS) if (extra[k] !== undefined) u[k] = (u[k] ?? 0) + extra[k]!;
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
    if (id) {
      fx.resultNames.set(id, key);
      if (fx.resultNames.size > MAX_RESULT_NAMES) fx.resultNames.delete(fx.resultNames.keys().next().value!);
    }
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

  /** Size (characters) of the result of tool call `id`, as put back into the model context. Never the content.
   *  A result whose call was not seen is counted under 'unknown'; a repeated result id is counted once. */
  toolResult(id: string, chars: number, at: number | undefined): void {
    if (!Number.isFinite(chars) || chars < 0 || this.seenIds.has(`res:${id}`)) return;
    this.seenIds.add(`res:${id}`);
    if (this.seenIds.size > 5000) this.seenIds = new Set([...this.seenIds].slice(-2500));
    const fx = this.fx;
    const known = fx.resultNames.get(id);
    fx.resultNames.delete(id);
    const name = known ?? 'unknown';
    const key = fx.results.has(name) || fx.results.size < MAX_TOOL_KEYS ? name : 'other';
    let r = fx.results.get(key);
    if (!r) fx.results.set(key, (r = { calls: 0, chars: 0, max: 0, samples: [] }));
    r.calls++;
    r.chars += chars;
    if (chars > r.max) r.max = chars;
    r.samples.push([at ?? 0, chars]);
    if (r.samples.length > MAX_RESULT_SAMPLES * 1.25) r.samples = r.samples.slice(-MAX_RESULT_SAMPLES);
    fx.v++;
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

  /** Latest recorded value of a string fact (permission mode, sandbox, entrypoint, branch …).
   *  Mode fields also keep a bounded list of changes (`at` = record time, else the latest activity time). */
  setFact(field: StringFact, value: unknown, max = 60, at?: number): void {
    if (typeof value !== 'string' || !value) return;
    const v = bounded(value, max);
    const prev = this.fx.strings[field];
    if (prev === v) return;
    this.fx.strings[field] = v;
    this.fx.v++;
    if (field === 'permissionMode' || field === 'sessionMode' || field === 'collaborationMode') {
      const when = at ?? this.lastActivityAt;
      if (when === undefined) return;
      this.fx.modeChanges.push({ at: when, field, value: v });
      if (this.fx.modeChanges.length > MAX_MODE_CHANGES * 1.5) this.fx.modeChanges = this.fx.modeChanges.slice(-MAX_MODE_CHANGES);
      if (prev !== undefined) this.event(when, 'SESSION_ACTIVITY', `${MODE_LABEL[field]} → ${v}`, 'OBSERVED');
    }
  }

  /** A pull request the provider linked to this session (Claude `pr-link`). Deduplicated by URL, latest 20 kept. */
  prLink(at: number | undefined, url: unknown, num: unknown, repo: unknown): void {
    if (typeof url !== 'string' || !/^https?:\/\/[^\s<>"]{1,300}$/.test(url)) return;
    const fx = this.fx;
    const i = fx.prLinks.findIndex(p => p.url === url);
    if (i >= 0) fx.prLinks.splice(i, 1);
    const n = typeof num === 'number' && Number.isInteger(num) && num > 0 ? num : undefined;
    const r = typeof repo === 'string' && repo ? bounded(repo, 120) : undefined;
    fx.prLinks.push({ at: at ?? this.lastActivityAt ?? 0, url, ...(n !== undefined ? { number: n } : {}), ...(r ? { repository: r } : {}) });
    if (fx.prLinks.length > MAX_PR_LINKS) fx.prLinks.splice(0, fx.prLinks.length - MAX_PR_LINKS);
    fx.v++;
  }

  /** One queue-operation record (enqueue / dequeue / remove …), counted by operation (at most 10 keys). */
  queueOp(op: unknown): void {
    const k = typeof op === 'string' && /^[a-z_-]{1,20}$/i.test(op) ? op : 'other';
    const q = this.fx.queue;
    if (!(k in q) && Object.keys(q).length >= 10) return;
    q[k] = (q[k] ?? 0) + 1;
    this.fx.v++;
  }

  /** One context compaction with what the provider recorded about it (latest 50 kept). */
  compactInfo(c: CompactInfo): void {
    const e: CompactInfo = { at: c.at };
    if (typeof c.trigger === 'string' && c.trigger) e.trigger = bounded(c.trigger, 20);
    for (const k of ['preTokens', 'postTokens', 'durationMs', 'window'] as const) {
      const x = c[k];
      if (typeof x === 'number' && Number.isFinite(x) && x >= 0) e[k] = x;
    }
    this.fx.compacts.push(e);
    if (this.fx.compacts.length > MAX_COMPACTS * 1.5) this.fx.compacts = this.fx.compacts.slice(-MAX_COMPACTS);
    this.fx.v++;
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

  /** The agent wrote its whole todo / plan list (Claude TodoWrite, Codex update_plan). Replaces the previous list. */
  setTodos(at: number | undefined, source: string, raw: { text: unknown; status: unknown }[]): void {
    const items: TodoList['items'] = [];
    let dropped = 0;
    for (const r of raw) {
      const text = bounded(r.text, MAX_TODO_CHARS);
      if (!text) continue;
      if (items.length >= MAX_TODOS) dropped++;
      else items.push({ text, status: todoStatus(r.status) });
    }
    this.fx.todos = { at: at ?? this.fx.todos?.at ?? 0, source: bounded(source, 40), items, ...(dropped ? { dropped } : {}) };
    this.fx.todoIds = undefined;
    this.fx.v++;
  }

  /** Claude TaskCreate: one task appended. Claude numbers tasks 1, 2, 3 … per list, so the id is the creation order. */
  taskCreate(at: number | undefined, subject: unknown): void {
    const text = bounded(subject, MAX_TODO_CHARS);
    if (!text) return;
    const fx = this.fx;
    if (!fx.todos || !fx.todoIds) {
      fx.todos = { at: 0, source: 'TaskCreate', items: [] };
      fx.todoIds = [];
      fx.todoSeq = 0;
    }
    fx.todoSeq = (fx.todoSeq ?? 0) + 1;
    if (fx.todos.items.length < MAX_TODOS) {
      fx.todos.items.push({ text, status: 'pending' });
      fx.todoIds.push(String(fx.todoSeq));
    } else fx.todos.dropped = (fx.todos.dropped ?? 0) + 1;
    fx.todos.at = at ?? fx.todos.at;
    fx.todos.source = 'TaskCreate';
    fx.v++;
  }

  /** Claude TaskUpdate: status (or subject) of one task by id; "deleted" removes it. */
  taskUpdate(at: number | undefined, id: unknown, status: unknown, subject?: unknown): void {
    const fx = this.fx;
    if (!fx.todos || !fx.todoIds || (typeof id !== 'string' && typeof id !== 'number')) return;
    const i = fx.todoIds.indexOf(String(id));
    if (i < 0) return;
    if (status === 'deleted') {
      fx.todos.items.splice(i, 1);
      fx.todoIds.splice(i, 1);
    } else {
      if (status !== undefined) fx.todos.items[i].status = todoStatus(status);
      const text = bounded(subject, MAX_TODO_CHARS);
      if (text) fx.todos.items[i].text = text;
    }
    fx.todos.at = at ?? fx.todos.at;
    fx.todos.source = 'TaskUpdate';
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
      nativeGoal:this.nativeGoal ? {...this.nativeGoal}:undefined,
      nativeInputs: this.nativeInputs.length ? structuredClone(this.nativeInputs) : undefined,
      requestedTrace: this.requestedTrace.length ? structuredClone(this.requestedTrace) : undefined,
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
      approvalPolicy: fx.strings.approvalPolicy,
      permissionProfile: fx.strings.permissionProfile,
      collaborationMode: fx.strings.collaborationMode,
      sessionMode: fx.strings.sessionMode,
      modeChanges: fx.modeChanges.length ? fx.modeChanges.slice(-MAX_MODE_CHANGES).map(m => ({ ...m })) : undefined,
      prLinks: fx.prLinks.length ? fx.prLinks.map(p => ({ ...p })) : undefined,
      queueOps: Object.keys(fx.queue).length ? { ...fx.queue } : undefined,
      compacts: fx.compacts.length ? fx.compacts.slice(-MAX_COMPACTS).map(c => ({ ...c })) : undefined,
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
      todos: fx.todos && { ...fx.todos, items: fx.todos.items.map(t => ({ ...t })) },
      toolResultChars: fx.results.size
        ? Object.fromEntries([...fx.results].map(([k, r]) => [k, { calls: r.calls, chars: r.chars, max: r.max, samples: r.samples.slice(-MAX_RESULT_SAMPLES) }]))
        : undefined,
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
      nativeProcess: { alive: this.live.registryAlive ?? null, openTurn: this.live.openTurn ?? null, explicitEnded: this.live.explicitEnded ?? null, oneShotDone: this.live.oneShotDone ?? null },
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
export const MAX_TODOS = 30;
export const MAX_TODO_CHARS = 120;

function todoStatus(v: unknown): TodoStatus {
  const s = typeof v === 'string' ? v.toLowerCase() : '';
  if (s === 'completed' || s === 'complete' || s === 'done') return 'completed';
  if (s === 'in_progress' || s === 'in-progress' || s === 'active' || s === 'running') return 'in_progress';
  return 'pending';
}
export const MAX_RESULT_SAMPLES = 200;
const MAX_RESULT_NAMES = 500;

type AltField = 'prompts' | 'replies' | 'compactions' | 'web';
type StringFact = 'permissionMode' | 'sandbox' | 'entrypoint' | 'recordedBranch' | 'approvalPolicy' | 'permissionProfile' | 'collaborationMode' | 'sessionMode';
type ModeField = 'permissionMode' | 'sessionMode' | 'collaborationMode';
type CompactInfo = { at: number; trigger?: string; preTokens?: number; postTokens?: number; durationMs?: number; window?: number };
const MODE_LABEL: Record<ModeField, string> = { permissionMode: 'permission mode', sessionMode: 'mode', collaborationMode: 'collaboration mode' };
const MAX_MODE_CHANGES = 50;
const MAX_PR_LINKS = 20;
const MAX_COMPACTS = 50;

/** Optional per-call usage fields, summed only when the provider recorded them. */
export type CallUsageExtra = Partial<Pick<SessionUsage, 'inputTokens' | 'cacheCreationInputTokens' | 'cacheCreation5mTokens' | 'cacheCreation1hTokens' | 'reasoningOutputTokens'>>;
const EXTRA_KEYS = ['inputTokens', 'cacheCreationInputTokens', 'cacheCreation5mTokens', 'cacheCreation1hTokens', 'reasoningOutputTokens'] as const;

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
  strings: Partial<Record<StringFact, string>> = {};
  modeChanges: { at: number; field: ModeField; value: string }[] = [];
  prLinks: { at: number; url: string; number?: number; repository?: string }[] = [];
  queue: Record<string, number> = {};
  compacts: CompactInfo[] = [];
  agentDoneAt?: number;
  waitMaxMs = 0;
  waitTotalMs = 0;
  activeMs = 0;
  lastTick?: number;
  rate?: RateLimits;
  todos?: TodoList;
  /** Claude Task tool ids, parallel to todos.items (only while the list comes from TaskCreate). */
  todoIds?: string[];
  todoSeq?: number;
  /** tool call id → tool name, until its result is seen (bounded). */
  resultNames = new Map<string, string>();
  results = new Map<string, { calls: number; chars: number; max: number; samples: [number, number][] }>();
}

/** Evidence for the facts block: what is read vs computed. */
const FACT_EVIDENCE: Evidence[] = [
  { field: 'facts', kind: 'OBSERVED', source: 'tool calls, prompts, tokens, modes as recorded in the transcript / rollout' },
  { field: 'facts.activeMs', kind: 'DERIVED', source: 'sum of gaps < 5 min between recorded events' },
  { field: 'facts.waitMs', kind: 'DERIVED', source: 'gaps between the agent finishing a turn and the next human prompt' },
  { field: 'facts.todos', kind: 'OBSERVED', source: 'latest TodoWrite / TaskCreate+TaskUpdate (Claude) or update_plan (Codex) call input' },
  { field: 'facts.toolResultChars', kind: 'OBSERVED', source: 'character length of tool_result / function_call_output content (content never kept)' },
];

/** Cwd-relative display path (no filesystem access), forward slashes. */
function relPath(cwd: string | undefined, file: string): string {
  if (!cwd) return file;
  const rel = path.relative(cwd, file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.replace(/\\/g, '/') : file;
}
