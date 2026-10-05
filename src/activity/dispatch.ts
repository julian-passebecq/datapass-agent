// Dispatches: one row per worker that a lead sent off (Claude subagent, workflow agent, Codex spawned agent),
// joined with the spawn call its parent recorded, with the usage and outcome the worker actually recorded.
// Pure functions of snapshots: no I/O, no pricing of its own (a money figure only comes from a user price).
import type { AgentSessionSnapshot, EvidenceKind } from '../model';
import type { WfAgent, WfRun, WorkflowsSnapshot } from '../providers/claude/workflows';
import { base, isLive, workerRole } from './insights';
import { quantile } from './forecast';

export type DispatchKind = 'subagent' | 'workflow' | 'codex';
export type DispatchState = 'live' | 'ok' | 'failed' | 'unknown';

export interface Dispatch {
  key: string;
  provider: 'claude' | 'codex';
  kind: DispatchKind;
  parentKey?: string;
  parentTitle?: string;
  /** Worker type (subagent type, workflow agentType, Codex spawn type / nickname). */
  type: string;
  typeKind: EvidenceKind;
  label: string;
  /** Short description the parent gave the spawn call (redacted upstream, bounded here). */
  description?: string;
  /** Spawn call time when matched (OBSERVED in the parent), else the worker's first record (OBSERVED). */
  dispatchedAt?: number;
  spawnMatched: boolean;
  start?: number;
  end?: number;
  durationMs?: number;
  live: boolean;
  model?: string;
  effort?: string;
  /** OBSERVED / DERIVED as recorded; undefined = not recorded. */
  tokens?: number;
  output?: number;
  tools: number;
  toolErrors: number;
  pass: number;
  fail: number;
  commits: number;
  files: number;
  repo: string;
  runName?: string;
  state: DispatchState;
  /** Why state is failed / unknown (evidence text). */
  reasons: string[];
  /** DERIVED: finished without a failure signal. undefined while live or when the end is not observed. */
  success?: boolean;
  /** DERIVED: finished, no failure signal, and a passing last test or a commit observed. */
  verified?: boolean;
  session?: AgentSessionSnapshot;
}

const DESC_MAX = 120;
const SPAWN_SLACK_MS = 10_000;

const bound = (s: string | undefined, n = DESC_MAX) => (s ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : undefined);

/** Matches each worker to one parent spawn call: latest unused spawn at or before the worker start (+10 s). */
function matchSpawns(workers: AgentSessionSnapshot[], byKey: Map<string, AgentSessionSnapshot>): Map<string, { at: number; type: string; description: string }> {
  const out = new Map<string, { at: number; type: string; description: string }>();
  const used = new Set<string>();
  const ordered = [...workers].filter(w => w.startedAt !== undefined).sort((a, b) => a.startedAt! - b.startedAt!);
  for (const w of ordered) {
    const p = w.parentSessionId ? byKey.get(w.parentSessionId) : undefined;
    const spawns = p?.facts?.spawns;
    if (!spawns?.length) continue;
    const role = w.provider === 'claude' ? workerRole(w) : '';
    let best: { at: number; type: string; description: string } | undefined;
    let bestIdx = -1;
    spawns.forEach((sp, i) => {
      const id = `${p!.key}#${i}`;
      if (used.has(id) || sp.at > w.startedAt! + SPAWN_SLACK_MS) return;
      // Prefer a spawn whose type equals the subagent type the worker recorded, then the latest.
      const score = (x: { type: string }) => (role && x.type === role ? 1 : 0);
      const better = !best || score(sp) > score(best) || (score(sp) === score(best) && sp.at > best.at);
      if (better) { best = sp; bestIdx = i; }
    });
    if (best) {
      used.add(`${p!.key}#${bestIdx}`);
      out.set(w.key, best);
    }
  }
  return out;
}

function lastTest(s: AgentSessionSnapshot) {
  return s.tests[s.tests.length - 1];
}

function judge(d: Pick<Dispatch, 'live' | 'end' | 'pass' | 'fail' | 'commits'>, fails: string[], lastTestPass: boolean, ended: boolean): Pick<Dispatch, 'state' | 'success' | 'verified' | 'reasons'> {
  if (d.live) return { state: 'live', reasons: [] };
  if (fails.length) return { state: 'failed', success: false, verified: false, reasons: fails };
  if (!ended) return { state: 'unknown', reasons: ['end not observed'] };
  return { state: 'ok', success: true, verified: lastTestPass || d.commits > 0, reasons: [] };
}

function fromSession(s: AgentSessionSnapshot, byKey: Map<string, AgentSessionSnapshot>, spawn: { at: number; type: string; description: string } | undefined, wf: { run: WfRun; agent: WfAgent } | undefined, now: number): Dispatch {
  const live = isLive(s) || wf?.agent.status === 'running';
  const start = s.startedAt ?? wf?.agent.firstAt ?? s.lastActivityAt;
  const endRaw = s.endedAt ?? s.lastActivityAt ?? wf?.agent.lastAt;
  const end = live ? now : endRaw;
  const parent = s.parentSessionId ? byKey.get(s.parentSessionId) : wf ? byKey.get(wf.run.parentKey) : undefined;
  const kind: DispatchKind = wf ? 'workflow' : s.provider === 'codex' ? 'codex' : 'subagent';
  let type: string;
  let typeKind: EvidenceKind = 'OBSERVED';
  if (wf?.agent.agentType) type = wf.agent.agentType;
  else if (s.provider === 'claude' && s.workerLabel && !/^a?[0-9a-f]{12,}$/i.test(workerRole(s))) type = workerRole(s);
  else if (spawn?.type) type = spawn.type;
  else if (s.provider === 'codex' && s.workerLabel) type = workerRole(s);
  else { type = 'worker'; typeKind = 'UNKNOWN'; }
  const t = lastTest(s);
  const fails: string[] = [];
  if (t?.outcome === 'FAIL') fails.push(`last test failed: ${bound(t.command, 60)}${t.exitCode !== undefined ? ` (exit ${t.exitCode})` : ''}`);
  if (wf?.agent.status === 'failed') fails.push(`workflow agent failed (${bound(wf.agent.statusBasis, 60) ?? 'journal'})`);
  const ended = s.status === 'ENDED' || wf?.agent.status === 'done' || wf?.agent.status === 'failed';
  const base0 = {
    live,
    pass: s.tests.filter(x => x.outcome === 'PASS').length,
    fail: s.tests.filter(x => x.outcome === 'FAIL').length,
    commits: s.commits.length,
  };
  return {
    key: s.key,
    provider: s.provider,
    kind,
    parentKey: parent?.key ?? s.parentSessionId ?? wf?.run.parentKey,
    parentTitle: parent ? bound(parent.title ?? parent.sessionId.slice(0, 8), 60) : undefined,
    type,
    typeKind,
    label: bound(s.title ?? wf?.agent.label ?? s.workerLabel ?? s.sessionId.slice(0, 8), 80)!,
    description: bound(spawn?.description ?? wf?.agent.description),
    dispatchedAt: spawn?.at ?? start,
    spawnMatched: !!spawn,
    start,
    durationMs: start !== undefined && end !== undefined ? Math.max(0, end - start) : undefined,
    model: s.model ?? wf?.agent.model,
    effort: s.effort,
    tokens: s.usage?.totalTokens ?? (wf ? wf.agent.tokens : undefined),
    output: s.usage?.outputTokens ?? (wf ? wf.agent.outputTokens : undefined),
    tools: s.counts.tools || (wf?.agent.tools ?? 0),
    toolErrors: s.facts?.toolErrors ?? wf?.agent.toolErrors ?? 0,
    files: s.facts?.files?.length ?? s.changedFiles.length,
    repo: base(s.repository) || base(s.cwd) || (parent ? base(parent.repository) || base(parent.cwd) : '') || '(no repo)',
    runName: wf?.run.name,
    session: s,
    ...base0,
    ...judge(base0, fails, t?.outcome === 'PASS', ended),
  };
}

function fromAgent(a: WfAgent, r: WfRun, byKey: Map<string, AgentSessionSnapshot>, now: number): Dispatch {
  const live = a.status === 'running';
  const start = a.firstAt ?? r.startedAt;
  const end = live ? now : (a.lastAt ?? undefined);
  const parent = byKey.get(r.parentKey);
  const fails = a.status === 'failed' ? [`workflow agent failed (${bound(a.statusBasis, 60) || 'journal'})`] : [];
  const base0 = { live, end, pass: 0, fail: 0, commits: 0 };
  return {
    key: a.sessionKey,
    provider: 'claude',
    kind: 'workflow',
    parentKey: r.parentKey,
    parentTitle: parent ? bound(parent.title ?? parent.sessionId.slice(0, 8), 60) : undefined,
    type: a.agentType ?? 'worker',
    typeKind: a.agentType ? 'OBSERVED' : 'UNKNOWN',
    label: bound(a.label, 80) ?? a.agentId,
    description: bound(a.description),
    dispatchedAt: start,
    spawnMatched: false,
    start,
    durationMs: start !== undefined && end !== undefined ? Math.max(0, end - start) : undefined,
    model: a.model,
    tokens: a.tokens,
    output: a.outputTokens,
    tools: a.tools,
    toolErrors: a.toolErrors,
    files: 0,
    repo: (parent ? base(parent.repository) || base(parent.cwd) : '') || '(no repo)',
    runName: r.name,
    ...base0,
    ...judge(base0, fails, false, a.status === 'done' || a.status === 'failed'),
  };
}

/** Every worker session (isWorker or with a parent) plus every workflow agent not loaded as a session. */
export function buildDispatches(sessions: AgentSessionSnapshot[], snap: WorkflowsSnapshot | undefined, now: number): Dispatch[] {
  const byKey = new Map(sessions.map(s => [s.key, s]));
  const workers = sessions.filter(s => s.isWorker || s.parentSessionId);
  const spawns = matchSpawns(workers, byKey);
  const wfOf = new Map<string, { run: WfRun; agent: WfAgent }>();
  for (const run of snap?.runs ?? []) for (const agent of run.agents) wfOf.set(agent.sessionKey, { run, agent });
  const out = workers.map(s => fromSession(s, byKey, spawns.get(s.key), wfOf.get(s.key), now));
  const seen = new Set(out.map(d => d.key));
  for (const run of snap?.runs ?? []) for (const a of run.agents) if (!seen.has(a.sessionKey)) { seen.add(a.sessionKey); out.push(fromAgent(a, run, byKey, now)); }
  return out.sort((a, b) => (b.dispatchedAt ?? 0) - (a.dispatchedAt ?? 0));
}

export const PERIOD_MS: Record<string, number> = { '24h': 86400_000, '7d': 7 * 86400_000, '30d': 30 * 86400_000, all: Infinity };

export function inPeriod(ds: Dispatch[], period: string, now: number): Dispatch[] {
  const span = PERIOD_MS[period] ?? PERIOD_MS['7d'];
  return span === Infinity ? ds : ds.filter(d => d.live || (d.dispatchedAt ?? d.end ?? 0) >= now - span);
}

/** Value usable in a seg option ([a-z0-9._:-], ≤ 40). */
export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || '-';
}

/** User price per million tokens for a model: exact id, then case-insensitive id or key containment. */
export function priceFor(model: string | undefined, prices: Record<string, unknown>): number | undefined {
  if (!model) return undefined;
  const ok = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
  if (ok(prices[model]) !== undefined) return ok(prices[model]);
  const m = model.toLowerCase();
  let best: { len: number; v: number } | undefined;
  for (const [k, v] of Object.entries(prices)) {
    const p = ok(v);
    const kk = k.toLowerCase().trim();
    if (p === undefined || !kk) continue;
    if ((m.includes(kk) || kk.includes(m)) && (!best || kk.length > best.len)) best = { len: kk.length, v: p };
  }
  return best?.v;
}

/** DERIVED: tokens Σ × user price per MTok. undefined when no price or no tokens. */
export function costOf(d: Dispatch, prices: Record<string, unknown>): number | undefined {
  const p = priceFor(d.model, prices);
  return p === undefined || d.tokens === undefined ? undefined : (d.tokens / 1e6) * p;
}

export type GroupBy = 'model' | 'model-effort' | 'type';

export function groupKey(d: Dispatch, by: GroupBy): string {
  const m = d.model ?? '(model not recorded)';
  if (by === 'type') return d.type;
  if (by === 'model-effort') return d.effort ? `${m} · ${d.effort}` : m;
  return m;
}

export interface DispatchGroup {
  key: string;
  /** Model part of the key (for connecting effort levels of one model). */
  model: string;
  n: number;
  finished: number;
  live: number;
  ok: number;
  verified: number;
  /** DERIVED rates over finished dispatches with a known end (undefined when none). */
  successRate?: number;
  verifiedRate?: number;
  medTokens?: number;
  p90Tokens?: number;
  medOutput?: number;
  medDurationMs?: number;
  /** DERIVED from the user's price setting; undefined when not set for this group. */
  medCost?: number;
  priced: number;
}

function med(xs: number[], p = 0.5): number | undefined {
  return xs.length ? quantile([...xs].sort((a, b) => a - b), p) : undefined;
}

export function groupStats(ds: Dispatch[], by: GroupBy, prices: Record<string, unknown> = {}): DispatchGroup[] {
  const m = new Map<string, Dispatch[]>();
  for (const d of ds) {
    const k = groupKey(d, by);
    m.set(k, [...(m.get(k) ?? []), d]);
  }
  const out: DispatchGroup[] = [];
  for (const [key, list] of m) {
    const judged = list.filter(d => d.success !== undefined);
    const fin = list.filter(d => !d.live);
    const tok = fin.map(d => d.tokens).filter((x): x is number => x !== undefined);
    const costs = fin.map(d => costOf(d, prices)).filter((x): x is number => x !== undefined);
    const ok = judged.filter(d => d.success).length;
    const ver = judged.filter(d => d.verified).length;
    out.push({
      key,
      model: by === 'type' ? key : (list[0].model ?? '(model not recorded)'),
      n: list.length,
      finished: judged.length,
      live: list.filter(d => d.live).length,
      ok,
      verified: ver,
      successRate: judged.length ? ok / judged.length : undefined,
      verifiedRate: judged.length ? ver / judged.length : undefined,
      medTokens: med(tok),
      p90Tokens: med(tok, 0.9),
      medOutput: med(fin.map(d => d.output).filter((x): x is number => x !== undefined)),
      medDurationMs: med(fin.map(d => d.durationMs).filter((x): x is number => x !== undefined)),
      medCost: med(costs),
      priced: costs.length,
    });
  }
  return out.sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));
}

/** Round axis ticks for [0, max]. */
export function niceTicks(max: number, count = 5): number[] {
  if (!(max > 0)) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(f => f * mag).find(s => s >= raw) ?? 10 * mag;
  const out: number[] = [];
  for (let v = 0; v <= max + step * 1e-9; v += step) out.push(+v.toPrecision(12));
  if (out[out.length - 1] < max) out.push(+(out[out.length - 1] + step).toPrecision(12));
  return out;
}

/** Dispatches started in the last 24 h (for the rail badge). */
export function last24h(ds: Dispatch[], now: number): number {
  return ds.filter(d => (d.dispatchedAt ?? 0) >= now - 86400_000).length;
}
