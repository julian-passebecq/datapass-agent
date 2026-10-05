// Roles: what part each session (or workflow agent) played, and how each role performs.
// Role = recorded worker / subagent / workflow agent type (OBSERVED), else a configurable title pattern
// (INFERRED), else "lead" for top-level sessions and "worker" for workers (INFERRED). Pure functions.
import type { AgentSessionSnapshot } from '../model';
import type { WfRun, WorkflowsSnapshot } from '../providers/claude/workflows';
import { isLive, outcome, workerRole } from './insights';

export interface RoleRule {
  match: string;
  role: string;
}

export const DEFAULT_RULES: RoleRule[] = [
  { match: '^PM\\b|\\bPM\\b', role: 'PM' },
  { match: 'coordinat', role: 'coordinator' },
  { match: 'architect', role: 'architect' },
  { match: 'review', role: 'reviewer' },
];

export interface CompiledRule {
  re: RegExp;
  role: string;
  match: string;
}

/** Validates the `agent.roles.patterns` setting; invalid or oversized entries are skipped (never thrown). */
export function compileRules(raw: unknown): CompiledRule[] {
  const list = Array.isArray(raw) ? raw : DEFAULT_RULES;
  const out: CompiledRule[] = [];
  for (const r of list.slice(0, 50)) {
    if (!r || typeof r !== 'object') continue;
    const { match, role } = r as Partial<RoleRule>;
    if (typeof match !== 'string' || typeof role !== 'string' || !match || !role.trim() || match.length > 200) continue;
    try {
      out.push({ re: new RegExp(match, 'i'), role: role.trim().slice(0, 40), match });
    } catch {
      /* invalid pattern: skipped */
    }
  }
  return out;
}

export type Basis = 'OBSERVED' | 'INFERRED';
export type UnitOutcome = 'live' | 'committed' | 'changed' | 'nochange' | 'unknown';
export const OUTCOMES: UnitOutcome[] = ['committed', 'changed', 'nochange', 'unknown', 'live'];
export const OUTCOME_TEXT: Record<UnitOutcome, string> = { committed: 'committed', changed: 'changed, no commit', nochange: 'no change', unknown: 'not observed', live: 'live' };

/** One session or one workflow agent with its role and the facts the role screen needs. */
export interface RoleUnit {
  key: string;
  label: string;
  provider: string;
  role: string;
  basis: Basis;
  /** Why this role: "worker type (transcript)", "title matches /coordinat/" … */
  basisText: string;
  /** Session key of the session that started this one (recorded). */
  parentKey?: string;
  /** Workflow run id when the unit is a workflow agent. */
  runId?: string;
  runName?: string;
  isWorker: boolean;
  start?: number;
  end?: number;
  live: boolean;
  tokens: number;
  output: number;
  cost?: number;
  activeMs: number;
  commits: number;
  pass: number;
  fail: number;
  edits: number;
  outcome: UnitOutcome;
  files: { path: string; edits: number; lastAt: number }[];
  /** Present when the unit is a loaded session (rows then carry data-select). */
  session?: AgentSessionSnapshot;
}

interface TypeInfo {
  type: string;
  source: string;
}

/** Recorded worker types for sessions: workflow agents and background agents carry agentType. */
function recordedTypes(snap: WorkflowsSnapshot | undefined): Map<string, TypeInfo> {
  const m = new Map<string, TypeInfo>();
  for (const r of snap?.runs ?? []) for (const a of r.agents) if (a.agentType) m.set(a.sessionKey, { type: a.agentType, source: 'workflow agent type (journal / agent meta)' });
  for (const b of snap?.background ?? []) if (b.agentType && !m.has(b.sessionKey)) m.set(b.sessionKey, { type: b.agentType, source: 'background agent type (agent meta)' });
  return m;
}

/** Spawn type the parent recorded for this worker: last spawn of a typed worker before it started (≤ 10 s after tolerated). */
function spawnType(s: AgentSessionSnapshot, byKey: Map<string, AgentSessionSnapshot>): string | undefined {
  const p = s.parentSessionId ? byKey.get(s.parentSessionId) : undefined;
  if (!p?.facts?.spawns?.length || s.startedAt === undefined) return undefined;
  let best: { at: number; type: string } | undefined;
  for (const sp of p.facts.spawns) if (sp.type && sp.at <= s.startedAt + 10_000 && (!best || sp.at > best.at)) best = sp;
  return best?.type;
}

export function roleOf(s: AgentSessionSnapshot, rules: CompiledRule[], types: Map<string, TypeInfo>, byKey: Map<string, AgentSessionSnapshot>): { role: string; basis: Basis; basisText: string } {
  const t = types.get(s.key);
  if (t) return { role: t.type, basis: 'OBSERVED', basisText: t.source };
  if (s.isWorker) {
    if (s.provider === 'claude' && s.workerLabel && !/^a?[0-9a-f]{12,}$/i.test(workerRole(s))) return { role: workerRole(s), basis: 'OBSERVED', basisText: 'subagent type recorded in the transcript' };
    const sp = spawnType(s, byKey);
    if (sp) return { role: sp, basis: 'OBSERVED', basisText: 'worker type recorded by the parent spawn call' };
  }
  const title = s.title ?? '';
  for (const r of rules) if (title && r.re.test(title)) return { role: r.role, basis: 'INFERRED', basisText: `title matches /${r.match}/ (agent.roles.patterns)` };
  return s.isWorker ? { role: 'worker', basis: 'INFERRED', basisText: 'worker with no recorded type' } : { role: 'lead', basis: 'INFERRED', basisText: 'top-level session, no type or title pattern' };
}

function sessionUnit(s: AgentSessionSnapshot, r: { role: string; basis: Basis; basisText: string }, now: number, run?: WfRun): RoleUnit {
  const live = isLive(s);
  const start = s.startedAt ?? s.lastActivityAt;
  const end = live ? now : (s.endedAt ?? s.lastActivityAt ?? start);
  const files = s.facts?.files?.length ? s.facts.files : s.changedFiles.map(path => ({ path, edits: 1, lastAt: s.lastActivityAt ?? start ?? 0 }));
  return {
    key: s.key,
    label: s.title ?? s.workerLabel ?? s.sessionId.slice(0, 8),
    provider: s.provider,
    ...r,
    parentKey: s.parentSessionId,
    runId: run?.runId,
    runName: run?.name,
    isWorker: s.isWorker,
    start,
    end,
    live,
    tokens: s.usage?.totalTokens ?? 0,
    output: s.usage?.outputTokens ?? 0,
    cost: s.usage?.costUSD,
    activeMs: s.facts?.activeMs ?? (start !== undefined && end !== undefined ? Math.max(0, end - start) : 0),
    commits: s.commits.length,
    pass: s.tests.filter(t => t.outcome === 'PASS').length,
    fail: s.tests.filter(t => t.outcome === 'FAIL').length,
    edits: s.counts.fileEdits,
    outcome: outcome(s) === 'nochange' && files.length ? 'changed' : outcome(s),
    files,
    session: s,
  };
}

export interface UnitOptions {
  rules: CompiledRule[];
  now: number;
}

/** Every loaded session plus every workflow agent that is not a loaded session. */
export function buildUnits(sessions: AgentSessionSnapshot[], snap: WorkflowsSnapshot | undefined, o: UnitOptions): RoleUnit[] {
  const byKey = new Map(sessions.map(s => [s.key, s]));
  const types = recordedTypes(snap);
  const runOf = new Map<string, WfRun>();
  for (const r of snap?.runs ?? []) for (const a of r.agents) runOf.set(a.sessionKey, r);
  const out = sessions.map(s => sessionUnit(s, roleOf(s, o.rules, types, byKey), o.now, runOf.get(s.key)));
  for (const r of snap?.runs ?? []) {
    for (const a of r.agents) {
      if (byKey.has(a.sessionKey)) continue;
      let role = a.agentType;
      let basis: Basis = 'OBSERVED';
      let basisText = 'workflow agent type (journal / agent meta)';
      if (!role) {
        const rule = o.rules.find(x => x.re.test(a.label));
        role = rule?.role ?? 'worker';
        basis = 'INFERRED';
        basisText = rule ? `label matches /${rule.match}/ (agent.roles.patterns)` : 'workflow agent with no recorded type';
      }
      const live = a.status === 'running';
      const start = a.firstAt ?? r.startedAt;
      const end = live ? o.now : (a.lastAt ?? start);
      out.push({
        key: a.sessionKey,
        label: a.label,
        provider: 'claude',
        role,
        basis,
        basisText,
        parentKey: r.parentKey,
        runId: r.runId,
        runName: r.name,
        isWorker: true,
        start,
        end,
        live,
        tokens: a.tokens,
        output: a.outputTokens,
        activeMs: start !== undefined && end !== undefined ? Math.max(0, end - start) : 0,
        commits: 0,
        pass: 0,
        fail: 0,
        edits: 0,
        outcome: live ? 'live' : 'unknown',
        files: [],
      });
    }
  }
  return out;
}

export const PERIOD_MS: Record<string, number> = { '24h': 86400_000, '7d': 7 * 86400_000, '30d': 30 * 86400_000, all: Infinity };

export function inPeriod(units: RoleUnit[], period: string, now: number): RoleUnit[] {
  const ms = PERIOD_MS[period] ?? Infinity;
  if (ms === Infinity) return units;
  return units.filter(u => u.live || (u.end ?? u.start ?? 0) >= now - ms);
}

export interface RoleStats {
  role: string;
  units: number;
  observed: number;
  inferred: number;
  live: number;
  tokens: number;
  output: number;
  cost: number;
  costUnits: number;
  activeMs: number;
  commits: number;
  pass: number;
  fail: number;
  edits: number;
  /** Median wall duration of finished units (DERIVED). */
  medianMs?: number;
  finished: number;
  mix: Record<UnitOutcome, number>;
}

export function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function roleStats(units: RoleUnit[]): RoleStats[] {
  const m = new Map<string, RoleStats & { durs: number[] }>();
  for (const u of units) {
    let r = m.get(u.role);
    if (!r) m.set(u.role, (r = { role: u.role, units: 0, observed: 0, inferred: 0, live: 0, tokens: 0, output: 0, cost: 0, costUnits: 0, activeMs: 0, commits: 0, pass: 0, fail: 0, edits: 0, finished: 0, mix: { live: 0, committed: 0, changed: 0, nochange: 0, unknown: 0 }, durs: [] }));
    r.units++;
    if (u.basis === 'OBSERVED') r.observed++;
    else r.inferred++;
    if (u.live) r.live++;
    r.tokens += u.tokens;
    r.output += u.output;
    if (u.cost !== undefined) {
      r.cost += u.cost;
      r.costUnits++;
    }
    r.activeMs += u.activeMs;
    r.commits += u.commits;
    r.pass += u.pass;
    r.fail += u.fail;
    r.edits += u.edits;
    r.mix[u.outcome]++;
    if (!u.live && u.start !== undefined && u.end !== undefined) {
      r.finished++;
      r.durs.push(Math.max(0, u.end - u.start));
    }
  }
  return [...m.values()]
    .map(({ durs, ...r }) => ({ ...r, medianMs: median(durs) }))
    .sort((a, b) => b.units - a.units || b.tokens - a.tokens || a.role.localeCompare(b.role));
}

export interface RoleEdge {
  from: string;
  to: string;
  count: number;
}

/** Parent role → child role, counted per child whose parent is known (loaded session or workflow parent). */
export function handoffEdges(units: RoleUnit[], all: RoleUnit[] = units): RoleEdge[] {
  const byKey = new Map(all.map(u => [u.key, u]));
  const m = new Map<string, RoleEdge>();
  for (const u of units) {
    if (!u.parentKey) continue;
    const p = byKey.get(u.parentKey);
    const from = p?.role ?? '(parent not loaded)';
    const k = `${from}\u0000${u.role}`;
    const e = m.get(k) ?? { from, to: u.role, count: 0 };
    e.count++;
    m.set(k, e);
  }
  return [...m.values()].sort((a, b) => b.count - a.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

/** Layer of each role for a left→right layout: BFS from roles with no incoming edge (cycles fall back to layer 0). */
export function layers(nodes: string[], edges: RoleEdge[]): Map<string, number> {
  const incoming = new Map(nodes.map(n => [n, 0]));
  for (const e of edges) if (e.from !== e.to) incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);
  const layer = new Map<string, number>();
  const queue = nodes.filter(n => !incoming.get(n));
  if (!queue.length && nodes.length) queue.push(nodes[0]);
  for (const n of queue) layer.set(n, 0);
  while (queue.length) {
    const n = queue.shift()!;
    for (const e of edges) {
      if (e.from !== n || e.from === e.to || layer.has(e.to)) continue;
      layer.set(e.to, layer.get(n)! + 1);
      queue.push(e.to);
    }
  }
  for (const n of nodes) if (!layer.has(n)) layer.set(n, 0);
  return layer;
}

export interface FileOverlap {
  path: string;
  /** unit key → edits of this file. */
  edits: Map<string, number>;
  /** Pairs of units whose session windows overlap (DERIVED). */
  concurrentPairs: [string, string][];
}

const overlaps = (a: RoleUnit, b: RoleUnit) => a.start !== undefined && b.start !== undefined && a.start < (b.end ?? b.start) && b.start < (a.end ?? a.start);

/**
 * Files edited by ≥ 2 units. A pair is "concurrent" when both session windows overlap in time.
 * Paths are compared as recorded (repo-relative when the provider allows), prefixed by the repo when known.
 */
export function fileOverlap(units: RoleUnit[], repoOf: (u: RoleUnit) => string): FileOverlap[] {
  const byFile = new Map<string, { units: RoleUnit[]; edits: Map<string, number> }>();
  for (const u of units) {
    for (const f of u.files) {
      const p = `${repoOf(u)}/${f.path.replace(/\\/g, '/')}`;
      let e = byFile.get(p);
      if (!e) byFile.set(p, (e = { units: [], edits: new Map() }));
      if (!e.edits.has(u.key)) e.units.push(u);
      e.edits.set(u.key, (e.edits.get(u.key) ?? 0) + Math.max(1, f.edits));
    }
  }
  const out: FileOverlap[] = [];
  for (const [path, e] of byFile) {
    if (e.units.length < 2) continue;
    const pairs: [string, string][] = [];
    for (let i = 0; i < e.units.length; i++) for (let j = i + 1; j < e.units.length; j++) if (overlaps(e.units[i], e.units[j])) pairs.push([e.units[i].key, e.units[j].key]);
    out.push({ path, edits: e.edits, concurrentPairs: pairs });
  }
  return out.sort((a, b) => b.concurrentPairs.length - a.concurrentPairs.length || b.edits.size - a.edits.size || a.path.localeCompare(b.path));
}

/** Gantt group of a unit: its workflow run, else the top of its recorded parent chain. */
export function groupOf(u: RoleUnit, byKey: Map<string, RoleUnit>): { id: string; label: string; kind: 'run' | 'lead' } {
  if (u.runId) return { id: `run:${u.runId}`, label: u.runName ? `workflow ${u.runName}` : `workflow ${u.runId.slice(0, 8)}`, kind: 'run' };
  let top = u;
  const seen = new Set<string>([u.key]);
  while (top.parentKey && byKey.has(top.parentKey) && !seen.has(top.parentKey)) {
    top = byKey.get(top.parentKey)!;
    seen.add(top.key);
  }
  return { id: `lead:${top.key}`, label: top.label, kind: 'lead' };
}

/** Lowercase option value for a role name (seg values allow [a-z0-9._:-]). */
export function roleSlug(role: string): string {
  return role.toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').slice(0, 40);
}
