// Forecast: Gantt items for running and recent work with projected end times from local history only.
// No AI, no network. Every estimate is INFERRED and carries its basis (sample size, key, quartiles).
// Levels: workflow run → phase → agent (src/providers/claude/workflows.ts) and lead session → workers.
import type { AgentSessionSnapshot, Provider } from '../model';
import type { WfAgent, WfRun } from '../providers/claude/workflows';
import { base, isLive } from './insights';

export type FcKind = 'run' | 'phase' | 'agent' | 'lead' | 'worker';
export type FcState = 'running' | 'done' | 'failed' | 'stale' | 'pending';

/** One history sample: a finished item's wall-clock duration. */
export interface Sample {
  id: string;
  dur: number;
  end: number;
  tokens?: number;
}

export interface Quartiles {
  n: number;
  p25: number;
  p50: number;
  p75: number;
  min: number;
  max: number;
}

/** A key of the fallback chain: specific first, wider after. */
export interface KeyStep {
  key: string;
  /** Human description of what "similar" means at this step. */
  label: string;
}

export interface Estimate {
  /** 'history': quartiles of similar finished items; 'composition': built from child estimates. */
  source: 'history' | 'composition';
  /** Samples used (after conditioning) and samples of the key. */
  n: number;
  total: number;
  keyLabel: string;
  /** Index in the fallback chain (0 = most specific). */
  step: number;
  /** Conditioned on "still running at this elapsed time" (only samples that lasted longer). */
  conditioned: boolean;
  /** Durations from the item's start (ms). Absent when overrun. */
  q?: Quartiles;
  etaAt?: number;
  lowAt?: number;
  highAt?: number;
  /** Already longer than (almost) every similar item: no ETA, said so. */
  overrun: boolean;
  basis: string;
  projectedTokens?: number;
}

export interface FcItem {
  id: string;
  parentId?: string;
  depth: number;
  kind: FcKind;
  label: string;
  detail: string;
  start: number;
  /** Actual end (done) or now (running); for pending items equal to the projected start. */
  end: number;
  state: FcState;
  /** Session key for data-select when the session is in the store. */
  selectKey?: string;
  /** Identity for colouring (repo or run name). */
  ident: string;
  provider?: Provider;
  tokens?: number;
  /** Tokens per minute: recent calls (last 10 min) when recorded, else average over elapsed. */
  ratePerMin?: number;
  rateBasis?: string;
  est?: Estimate;
  progress?: { done: number; total: number; phaseIdx?: number; phases?: number; phase?: string };
}

export interface AccuracyRow {
  id: string;
  kind: FcKind;
  label: string;
  start: number;
  actual: number;
  predicted?: number;
  low?: number;
  high?: number;
  n: number;
  keyLabel: string;
  /** (predicted − actual) / actual. */
  err?: number;
  inBand?: boolean;
  overrun: boolean;
}

export interface AccuracySummary {
  rows: AccuracyRow[];
  scored: number;
  medianAbsErr?: number;
  withinBand: number;
  overruns: number;
}

export interface Forecast {
  items: FcItem[];
  accuracy: AccuracySummary;
  samples: number;
}

export interface ForecastOptions {
  now: number;
  /** Minimum samples for a key to be used (default 3). */
  minSamples?: number;
  /** Max accuracy rows (newest first, default 60). */
  accuracyLimit?: number;
}

export const MIN_SAMPLES = 3;
const RATE_WINDOW_MS = 10 * 60_000;

// ---------- statistics ----------

/** Linear-interpolated quantile of a sorted array. */
export function quantile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

export function quartiles(xs: number[]): Quartiles | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return { n: s.length, p25: quantile(s, 0.25), p50: quantile(s, 0.5), p75: quantile(s, 0.75), min: s[0], max: s[s.length - 1] };
}

export function fmtDur(ms: number | undefined): string {
  if (ms === undefined || !isFinite(ms)) return '—';
  if (ms < 0) ms = 0;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h${String(m % 60).padStart(2, '0')}` : `${Math.floor(h / 24)}d${h % 24}h`;
}

/** Samples grouped by key. */
export class History {
  private m = new Map<string, Sample[]>();

  add(keys: KeyStep[], s: Sample): void {
    if (!(s.dur > 0) || !isFinite(s.dur)) return;
    for (const k of keys) {
      const arr = this.m.get(k.key);
      if (arr) arr.push(s);
      else this.m.set(k.key, [s]);
    }
  }

  get(key: string, before?: number, exclude?: string): Sample[] {
    const arr = this.m.get(key) ?? [];
    return before === undefined && exclude === undefined ? arr : arr.filter(s => (before === undefined || s.end <= before) && s.id !== exclude);
  }

  get size(): number {
    return this.m.size;
  }
}

export interface EstimateOptions {
  minSamples: number;
  /** Only samples finished at or before this time (for back-testing). */
  before?: number;
  exclude?: string;
  /** Noun for the basis text ("agents", "sessions"). */
  noun: string;
}

/**
 * ETA rule. Walks the key chain from specific to wide and uses the first key with ≥ minSamples samples.
 * Running items are conditioned on survival: only samples that lasted longer than the current elapsed time
 * count; with fewer than minSamples of those, the item is "overrun" (no ETA, said so).
 */
export function estimate(h: History, chain: KeyStep[], start: number, elapsed: number, o: EstimateOptions): Estimate | undefined {
  for (let step = 0; step < chain.length; step++) {
    const k = chain[step];
    const all = h.get(k.key, o.before, o.exclude);
    if (all.length < o.minSamples) continue;
    const durs = all.map(s => s.dur);
    const base = quartiles(durs)!;
    const longer = elapsed > 0 ? durs.filter(d => d > elapsed) : durs;
    const conditioned = longer.length < durs.length;
    if (longer.length < o.minSamples) {
      return {
        source: 'history', n: longer.length, total: all.length, keyLabel: k.label, step, conditioned, overrun: true,
        basis: `already ${fmtDur(elapsed)}: longer than ${all.length - longer.length} of ${all.length} similar ${o.noun} (${k.label}; typical ${fmtDur(base.p25)}–${fmtDur(base.p75)}, median ${fmtDur(base.p50)}); no ETA`,
      };
    }
    const q = quartiles(longer)!;
    const cond = conditioned ? ` that ran longer than ${fmtDur(elapsed)}` : '';
    return {
      source: 'history', n: q.n, total: all.length, keyLabel: k.label, step, conditioned, overrun: false, q,
      etaAt: start + q.p50, lowAt: start + q.p25, highAt: start + q.p75,
      basis: `median of ${q.n}${conditioned ? ` of ${all.length}` : ''} similar ${o.noun}${cond} (${k.label}): ${fmtDur(q.p50)}, p25–p75 ${fmtDur(q.p25)}–${fmtDur(q.p75)}`,
    };
  }
  return undefined;
}

// ---------- keys ----------

const norm = (x: string | undefined, fallback: string) => (x ?? '').trim().toLowerCase().slice(0, 60) || fallback;

/** First word of a label: "coder: forecast" → "coder", "review-3" → "review". */
export function labelPrefix(label: string): string {
  return norm(label.split(/[\s:#/(\[,.]+|[-_]\d/)[0]?.replace(/\d+$/, ''), '(none)');
}

export function agentChain(a: WfAgent): KeyStep[] {
  const type = norm(a.agentType, 'general');
  const pre = labelPrefix(a.label);
  const ph = norm(a.phase, '(no phase)');
  return [
    { key: `wfa|${type}|${pre}|${ph}`, label: `type ${type}, label "${pre}…", phase ${ph}` },
    { key: `wfa|${type}|${pre}`, label: `type ${type}, label "${pre}…"` },
    { key: `wfa|${type}|${ph}`, label: `type ${type}, phase ${ph}` },
    { key: `wfa|${type}`, label: `type ${type}` },
    { key: 'wfa|*', label: 'any workflow agent' },
  ];
}

export function phaseChain(runName: string, title: string): KeyStep[] {
  const r = norm(runName, '(unnamed)'), p = norm(title, '(no phase)');
  return [
    { key: `wfp|${r}|${p}`, label: `workflow ${r}, phase ${p}` },
    { key: `wfp|*|${p}`, label: `phase ${p}, any workflow` },
  ];
}

export function runChain(runName: string): KeyStep[] {
  const r = norm(runName, '(unnamed)');
  return [
    { key: `wfr|${r}`, label: `workflow ${r}` },
    { key: 'wfr|*', label: 'any workflow run' },
  ];
}

const repoKey = (s: AgentSessionSnapshot) => (base(s.repository) || base(s.cwd) || '(no repo)').toLowerCase();

/** Worker type: Claude subagent type; Codex workers carry nicknames, so they share one type. */
export function workerType(s: AgentSessionSnapshot): string {
  if (s.provider === 'codex') return 'codex worker';
  return norm((s.workerLabel ?? '').split(' · ')[0], 'worker');
}

export function sessionChain(s: AgentSessionSnapshot): KeyStep[] {
  const repo = repoKey(s);
  const p = s.provider;
  if (!s.isWorker) {
    return [
      { key: `sl|${p}|${repo}`, label: `${p} lead sessions in ${repo}` },
      { key: `sl|${p}`, label: `${p} lead sessions` },
      { key: 'sl|*', label: 'any lead session' },
    ];
  }
  const t = workerType(s);
  return [
    { key: `sw|${p}|${repo}|${t}`, label: `${p} ${t} workers in ${repo}` },
    { key: `sw|${p}|${t}`, label: `${p} ${t} workers` },
    { key: `sw|${p}`, label: `${p} workers` },
  ];
}

// ---------- items ----------

function sessionEnd(s: AgentSessionSnapshot): number | undefined {
  return s.endedAt ?? s.lastActivityAt;
}

function sessionRate(s: AgentSessionSnapshot, now: number): { rate?: number; basis?: string } {
  const calls = s.facts?.calls;
  if (calls?.length) {
    const recent = calls.filter(c => c[0] >= now - RATE_WINDOW_MS);
    if (recent.length) {
      const tok = recent.reduce((n, c) => n + c[1] + c[2], 0);
      return { rate: tok / (RATE_WINDOW_MS / 60_000), basis: `${recent.length} model calls in the last 10 min, prompt incl. cache + output (OBSERVED usage, DERIVED rate)` };
    }
  }
  const tok = s.usage?.totalTokens;
  const el = s.startedAt ? now - s.startedAt : 0;
  if (tok && el > 60_000) return { rate: tok / (el / 60_000), basis: 'average since start, prompt incl. cache + output (OBSERVED usage, DERIVED rate)' };
  return {};
}

function project(e: Estimate | undefined, tokens: number | undefined, rate: number | undefined, now: number): void {
  if (!e || e.etaAt === undefined || tokens === undefined || !rate) return;
  e.projectedTokens = Math.round(tokens + rate * Math.max(0, (e.etaAt - now) / 60_000));
}

function agentState(a: WfAgent): FcState {
  return a.status;
}

interface Ctx {
  now: number;
  min: number;
  hist: History;
}

function agentItem(a: WfAgent, run: WfRun, parentId: string, depth: number, known: Set<string>, c: Ctx): FcItem | undefined {
  if (!a.firstAt) return undefined;
  const running = a.status === 'running';
  const end = running ? c.now : a.lastAt ?? a.firstAt;
  const elapsed = end - a.firstAt;
  const rate = running && a.tokens && elapsed > 60_000 ? a.tokens / (elapsed / 60_000) : undefined;
  const it: FcItem = {
    id: `a:${run.runId}:${a.agentId}`, parentId, depth, kind: 'agent', label: a.label,
    detail: [a.agentType, a.phase].filter(Boolean).join(' · '), start: a.firstAt, end, state: agentState(a),
    selectKey: known.has(a.sessionKey) ? a.sessionKey : undefined, ident: run.name ?? run.runId, provider: 'claude',
    tokens: a.tokens, ratePerMin: rate, rateBasis: rate ? 'average since first record, prompt incl. cache + output (OBSERVED usage, DERIVED rate)' : undefined,
  };
  if (running) {
    it.est = estimate(c.hist, agentChain(a), a.firstAt, elapsed, { minSamples: c.min, noun: 'agents' });
    project(it.est, a.tokens, rate, c.now);
  }
  return it;
}

function runItems(run: WfRun, known: Set<string>, c: Ctx): FcItem[] {
  const out: FcItem[] = [];
  const name = run.name ?? '(unnamed)';
  const runId = `r:${run.runId}`;
  const starts = run.agents.map(a => a.firstAt).filter((t): t is number => !!t);
  const start = run.startedAt ?? (starts.length ? Math.min(...starts) : undefined);
  if (!start) return out;
  const running = run.status === 'running';
  const done = run.agents.filter(a => a.status === 'done' || a.status === 'failed').length;
  const tokens = run.agents.reduce((n, a) => n + a.tokens, 0);
  const runEnd = running ? c.now : run.lastAt ?? start;
  const runItem: FcItem = {
    id: runId, depth: 0, kind: 'run', label: name, detail: run.description ?? run.runId, start, end: runEnd,
    state: run.status === 'killed' ? 'failed' : (run.status as FcState), ident: name, provider: 'claude', tokens,
    progress: { done, total: run.agents.length, phases: run.phases.length },
  };
  out.push(runItem);
  // Phases in declared order; agents without phase form their own group.
  const titles = run.phases.map(p => p.title);
  for (const a of run.agents) if (a.phase && !titles.includes(a.phase)) titles.push(a.phase);
  const loose = run.agents.filter(a => !a.phase);
  let curIdx = -1;
  titles.forEach((t, i) => { if (run.agents.some(a => a.phase === t)) curIdx = i; });
  if (curIdx >= 0) Object.assign(runItem.progress!, { phaseIdx: curIdx + 1, phase: titles[curIdx], phases: titles.length });
  let cursor: number | undefined; // projected end of the latest started phase
  let composable = running;
  const phaseEtas: string[] = [];
  titles.forEach((t, i) => {
    const ag = run.agents.filter(a => a.phase === t);
    const pid = `p:${run.runId}:${i}`;
    if (!ag.length) {
      // Pending phase: only a projection, placed after the previous phase's projected end.
      if (!running || i < curIdx) return;
      const e = estimate(c.hist, phaseChain(name, t), 0, 0, { minSamples: c.min, noun: 'phases' });
      if (!e?.q || cursor === undefined) {
        // Cannot place it in time: no history for this phase or the previous phase has no ETA.
        composable = false;
        cursor = undefined;
        return;
      }
      const ps = Math.max(cursor, c.now);
      out.push({
        id: pid, parentId: runId, depth: 1, kind: 'phase', label: t, detail: 'not started', start: ps, end: ps, state: 'pending', ident: name, provider: 'claude',
        est: { ...e, etaAt: ps + e.q.p50, lowAt: ps + e.q.p25, highAt: ps + e.q.p75, basis: `${e.basis}; placed after the previous phase's projected end` },
      });
      cursor = ps + e.q.p50;
      phaseEtas.push(`${t} +${fmtDur(e.q.p50)}`);
      return;
    }
    const pStarts = ag.map(a => a.firstAt).filter((x): x is number => !!x);
    if (!pStarts.length) return;
    const pStart = Math.min(...pStarts);
    const pRunning = ag.some(a => a.status === 'running');
    const pEnd = pRunning ? c.now : Math.max(...ag.map(a => a.lastAt ?? a.firstAt ?? pStart));
    const pDone = ag.filter(a => a.status === 'done' || a.status === 'failed').length;
    const state: FcState = pRunning ? 'running' : ag.some(a => a.status === 'failed') ? 'failed' : ag.every(a => a.status === 'done') ? 'done' : 'stale';
    const pItem: FcItem = { id: pid, parentId: runId, depth: 1, kind: 'phase', label: t, detail: `${pDone}/${ag.length} agents`, start: pStart, end: pEnd, state, ident: name, provider: 'claude', tokens: ag.reduce((n, a) => n + a.tokens, 0), progress: { done: pDone, total: ag.length } };
    out.push(pItem);
    const kids = ag.map(a => agentItem(a, run, pid, 2, known, c)).filter((x): x is FcItem => !!x);
    if (pRunning) {
      // Composition: phase ends when its slowest running agent ends (agents of a phase run in parallel).
      const runKids = kids.filter(k => k.state === 'running');
      if (runKids.length && runKids.every(k => k.est?.etaAt !== undefined)) {
        const slow = runKids.reduce((m, k) => (k.est!.etaAt! > m.est!.etaAt! ? k : m));
        const low = Math.max(...runKids.map(k => k.est!.lowAt!)), high = Math.max(...runKids.map(k => k.est!.highAt!));
        pItem.est = {
          source: 'composition', n: Math.min(...runKids.map(k => k.est!.n)), total: runKids.length, keyLabel: 'running agents of this phase', step: 0, conditioned: true, overrun: false,
          etaAt: slow.est!.etaAt, lowAt: low, highAt: high,
          basis: `latest agent ETA among ${runKids.length} running (${slow.label}: ${slow.est!.basis})`,
        };
      } else {
        const e = estimate(c.hist, phaseChain(name, t), pStart, c.now - pStart, { minSamples: c.min, noun: 'phases' });
        if (e) pItem.est = e;
      }
      if (pItem.est?.etaAt !== undefined) {
        cursor = Math.max(cursor ?? 0, pItem.est.etaAt);
        phaseEtas.push(`${t} → ${fmtDur(pItem.est.etaAt - c.now)} left`);
      } else {
        composable = false;
        cursor = undefined;
      }
    } else if (i <= curIdx) cursor = Math.max(cursor ?? 0, pEnd);
    out.push(...kids);
  });
  if (loose.length) {
    const pid = `p:${run.runId}:loose`;
    const ls = loose.map(a => a.firstAt).filter((x): x is number => !!x);
    if (ls.length) {
      const lr = loose.some(a => a.status === 'running');
      out.push({ id: pid, parentId: runId, depth: 1, kind: 'phase', label: '(no phase)', detail: `${loose.length} agents`, start: Math.min(...ls), end: lr ? c.now : Math.max(...loose.map(a => a.lastAt ?? a.firstAt ?? 0)), state: lr ? 'running' : 'done', ident: name, provider: 'claude', progress: { done: loose.filter(a => a.status !== 'running' && a.status !== 'stale').length, total: loose.length } });
      out.push(...loose.map(a => agentItem(a, run, pid, 2, known, c)).filter((x): x is FcItem => !!x));
      if (lr) composable = false;
    }
  }
  if (running) {
    const elapsed = c.now - start;
    const rate = tokens && elapsed > 60_000 ? tokens / (elapsed / 60_000) : undefined;
    runItem.ratePerMin = rate;
    runItem.rateBasis = rate ? 'average since first agent (OBSERVED usage, DERIVED rate)' : undefined;
    if (composable && cursor !== undefined && cursor >= c.now && phaseEtas.length) {
      const phases = out.filter(x => x.parentId === runId && x.est?.etaAt !== undefined);
      const lowAt = Math.max(...phases.map(p => p.est!.lowAt ?? p.est!.etaAt!)), highAt = Math.max(...phases.map(p => p.est!.highAt ?? p.est!.etaAt!));
      runItem.est = {
        source: 'composition', n: phases.length, total: titles.length, keyLabel: 'phase estimates in order', step: 0, conditioned: true, overrun: false,
        etaAt: cursor, lowAt: Math.min(lowAt, cursor), highAt: Math.max(highAt, cursor),
        basis: `sum along the phase order: ${phaseEtas.join(', ')}`,
      };
    } else runItem.est = estimate(c.hist, runChain(name), start, elapsed, { minSamples: c.min, noun: 'runs of this workflow' });
    project(runItem.est, tokens, rate, c.now);
  }
  return out;
}

function sessionItem(s: AgentSessionSnapshot, depth: number, parentId: string | undefined, c: Ctx): FcItem | undefined {
  if (!s.startedAt) return undefined;
  const live = isLive(s);
  const end = live ? c.now : sessionEnd(s) ?? s.startedAt;
  const r = sessionRate(s, c.now);
  const it: FcItem = {
    id: `s:${s.key}`, parentId, depth, kind: s.isWorker ? 'worker' : 'lead',
    label: s.title ?? s.workerLabel ?? s.sessionId.slice(0, 8),
    detail: [s.provider, s.isWorker ? workerType(s) : repoKey(s), s.model].filter(Boolean).join(' · '),
    start: s.startedAt, end, state: live ? 'running' : 'done', selectKey: s.key, ident: repoKey(s), provider: s.provider,
    tokens: s.usage?.totalTokens, ratePerMin: live ? r.rate : undefined, rateBasis: live ? r.basis : undefined,
  };
  if (live) {
    it.est = estimate(c.hist, sessionChain(s), s.startedAt, c.now - s.startedAt, { minSamples: c.min, noun: s.isWorker ? 'workers' : 'sessions' });
    project(it.est, it.tokens, it.ratePerMin, c.now);
  }
  return it;
}

/** History from every finished item: workflow agents, phases, runs, sessions. */
export function buildHistory(sessions: AgentSessionSnapshot[], runs: WfRun[], wfKeys: Set<string>): History {
  const h = new History();
  for (const run of runs) {
    const name = run.name ?? '(unnamed)';
    for (const a of run.agents) {
      if (a.status === 'done' && a.firstAt && a.lastAt) h.add(agentChain(a), { id: `a:${run.runId}:${a.agentId}`, dur: a.lastAt - a.firstAt, end: a.lastAt, tokens: a.tokens });
    }
    const phaseTitles = new Set(run.agents.map(a => a.phase).filter((p): p is string => !!p));
    for (const t of phaseTitles) {
      const ag = run.agents.filter(a => a.phase === t);
      if (!ag.every(a => a.status === 'done')) continue;
      const s = Math.min(...ag.map(a => a.firstAt ?? Infinity)), e = Math.max(...ag.map(a => a.lastAt ?? 0));
      if (isFinite(s) && e > s) h.add(phaseChain(name, t), { id: `p:${run.runId}:${t}`, dur: e - s, end: e });
    }
    if (run.status === 'done' && run.startedAt && run.lastAt) h.add(runChain(name), { id: `r:${run.runId}`, dur: run.lastAt - run.startedAt, end: run.lastAt });
  }
  for (const s of sessions) {
    if (isLive(s) || !s.startedAt || wfKeys.has(s.key)) continue;
    const e = sessionEnd(s);
    if (e && e > s.startedAt) h.add(sessionChain(s), { id: `s:${s.key}`, dur: e - s.startedAt, end: e, tokens: s.usage?.totalTokens });
  }
  return h;
}

/** Back-test: what the ETA rule would have said at 50 % of each finished item, using only samples finished by then. */
export function accuracy(sessions: AgentSessionSnapshot[], runs: WfRun[], h: History, wfKeys: Set<string>, o: { minSamples: number; limit: number }): AccuracySummary {
  const cand: { id: string; kind: FcKind; label: string; start: number; end: number; chain: KeyStep[]; noun: string }[] = [];
  for (const run of runs) {
    for (const a of run.agents) if (a.status === 'done' && a.firstAt && a.lastAt && a.lastAt > a.firstAt) cand.push({ id: `a:${run.runId}:${a.agentId}`, kind: 'agent', label: a.label, start: a.firstAt, end: a.lastAt, chain: agentChain(a), noun: 'agents' });
    if (run.status === 'done' && run.startedAt && run.lastAt && run.lastAt > run.startedAt) cand.push({ id: `r:${run.runId}`, kind: 'run', label: run.name ?? run.runId, start: run.startedAt, end: run.lastAt, chain: runChain(run.name ?? '(unnamed)'), noun: 'runs' });
  }
  for (const s of sessions) {
    if (isLive(s) || !s.startedAt || wfKeys.has(s.key)) continue;
    const e = sessionEnd(s);
    if (e && e > s.startedAt) cand.push({ id: `s:${s.key}`, kind: s.isWorker ? 'worker' : 'lead', label: s.title ?? s.workerLabel ?? s.sessionId.slice(0, 8), start: s.startedAt, end: e, chain: sessionChain(s), noun: s.isWorker ? 'workers' : 'sessions' });
  }
  cand.sort((a, b) => b.end - a.end);
  const rows: AccuracyRow[] = [];
  for (const x of cand) {
    if (rows.length >= o.limit) break;
    const actual = x.end - x.start;
    const half = x.start + actual / 2;
    const e = estimate(h, x.chain, x.start, actual / 2, { minSamples: o.minSamples, before: half, exclude: x.id, noun: x.noun });
    if (!e) continue;
    const row: AccuracyRow = { id: x.id, kind: x.kind, label: x.label, start: x.start, actual, n: e.total, keyLabel: e.keyLabel, overrun: e.overrun };
    if (e.q) {
      row.predicted = e.q.p50;
      row.low = e.q.p25;
      row.high = e.q.p75;
      row.err = (e.q.p50 - actual) / actual;
      row.inBand = actual >= e.q.p25 && actual <= e.q.p75;
    }
    rows.push(row);
  }
  const scored = rows.filter(r => r.err !== undefined);
  const abs = quartiles(scored.map(r => Math.abs(r.err!)));
  return { rows, scored: scored.length, medianAbsErr: abs?.p50, withinBand: scored.filter(r => r.inBand).length, overruns: rows.filter(r => r.overrun).length };
}

/** Builds every Gantt item (runs first, then lead sessions with their workers) plus the accuracy back-test. */
export function buildForecast(sessions: AgentSessionSnapshot[], runs: WfRun[], o: ForecastOptions): Forecast {
  const min = Math.max(1, o.minSamples ?? MIN_SAMPLES);
  const wfKeys = new Set(runs.flatMap(r => r.agents.map(a => a.sessionKey)));
  const hist = buildHistory(sessions, runs, wfKeys);
  const c: Ctx = { now: o.now, min, hist };
  const known = new Set(sessions.map(s => s.key));
  const items: FcItem[] = [];
  for (const run of [...runs].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))) items.push(...runItems(run, known, c));
  const rest = sessions.filter(s => !wfKeys.has(s.key));
  const keys = new Set(rest.map(s => s.key));
  const kids = new Map<string, AgentSessionSnapshot[]>();
  for (const s of rest) if (s.parentSessionId && keys.has(s.parentSessionId)) (kids.get(s.parentSessionId) ?? kids.set(s.parentSessionId, []).get(s.parentSessionId)!).push(s);
  const seen = new Set<string>();
  const walk = (s: AgentSessionSnapshot, depth: number, parent?: string) => {
    if (seen.has(s.key) || depth > 6) return;
    seen.add(s.key);
    const it = sessionItem(s, depth, parent, c);
    if (!it) return;
    items.push(it);
    for (const k of (kids.get(s.key) ?? []).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))) walk(k, depth + 1, it.id);
  };
  const roots = rest.filter(s => !s.parentSessionId || !keys.has(s.parentSessionId)).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  for (const r of roots) walk(r, 0);
  return { items, accuracy: accuracy(sessions, runs, hist, wfKeys, { minSamples: min, limit: o.accuracyLimit ?? 60 }), samples: hist.size };
}
