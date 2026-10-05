// Lead → workers → nested workers as a tree, with DERIVED rollups. Edges exist only where the provider
// recorded the parent (Claude subagents/ transcripts, Codex parent_thread_id); nothing is guessed.
import { AgentSessionSnapshot } from '../model';
import { isLive, workerRole } from './insights';

export interface Rollup {
  /** Nodes in the subtree, the root included (pseudo group nodes excluded). */
  sessions: number;
  live: number;
  /** Provider-recorded totals summed over the subtree. */
  tokens: number;
  outputTokens: number;
  /** Sum of recorded costs and how many sessions recorded one (Claude cost-state only). */
  costUSD: number;
  costSessions: number;
  files: number;
  commits: number;
  testsPass: number;
  testsFail: number;
  /** Deepest level below this node (0 = leaf). */
  depth: number;
  /** Earliest start and latest activity in the subtree (epoch ms). */
  start?: number;
  end?: number;
}

export interface TopoNode {
  /** Session key, or `group:<parent>:<role>` for a role group, or `orphan:<parent>` for workers whose parent is not loaded. */
  key: string;
  s?: AgentSessionSnapshot;
  /** Label for pseudo nodes. */
  label?: string;
  role?: string;
  /** Short description of the spawn that probably produced this worker (INFERRED: type + time match). */
  spawn?: string;
  children: TopoNode[];
  roll: Rollup;
}

export type SortBy = 'start' | 'tokens' | 'live';

export function emptyRollup(): Rollup {
  return { sessions: 0, live: 0, tokens: 0, outputTokens: 0, costUSD: 0, costSessions: 0, files: 0, commits: 0, testsPass: 0, testsFail: 0, depth: 0 };
}

/** Own (single-session) rollup. */
export function own(s: AgentSessionSnapshot, now: number): Rollup {
  const r = emptyRollup();
  r.sessions = 1;
  r.live = isLive(s) ? 1 : 0;
  r.tokens = s.usage?.totalTokens ?? 0;
  r.outputTokens = s.usage?.outputTokens ?? 0;
  if (s.usage?.costUSD !== undefined) {
    r.costUSD = s.usage.costUSD;
    r.costSessions = 1;
  }
  r.files = s.changedFiles.length;
  r.commits = s.commits.length;
  r.testsPass = s.tests.filter(t => t.outcome === 'PASS').length;
  r.testsFail = s.tests.filter(t => t.outcome === 'FAIL').length;
  r.start = s.startedAt;
  r.end = isLive(s) ? now : s.endedAt ?? s.lastActivityAt;
  return r;
}

function add(a: Rollup, b: Rollup): void {
  a.sessions += b.sessions;
  a.live += b.live;
  a.tokens += b.tokens;
  a.outputTokens += b.outputTokens;
  a.costUSD += b.costUSD;
  a.costSessions += b.costSessions;
  a.files += b.files;
  a.commits += b.commits;
  a.testsPass += b.testsPass;
  a.testsFail += b.testsFail;
  if (b.start !== undefined) a.start = a.start === undefined ? b.start : Math.min(a.start, b.start);
  if (b.end !== undefined) a.end = a.end === undefined ? b.end : Math.max(a.end, b.end);
}

/** Wall time of a session: start → end (or now while live). DERIVED. */
export function wallMs(s: AgentSessionSnapshot, now: number): number | undefined {
  if (s.startedAt === undefined) return undefined;
  const end = isLive(s) ? now : s.endedAt ?? s.lastActivityAt;
  return end === undefined ? undefined : Math.max(0, end - s.startedAt);
}

/**
 * Pairs each worker with the parent's recorded spawn call (Claude Task / Codex spawn_agent) of the same
 * type that happened last before the worker started (≤ 10 s after is tolerated). Each spawn is used once.
 */
export function matchSpawns(parent: AgentSessionSnapshot, kids: AgentSessionSnapshot[]): Map<string, string> {
  const out = new Map<string, string>();
  const spawns = (parent.facts?.spawns ?? []).map((x, i) => ({ ...x, i })).sort((a, b) => a.at - b.at);
  if (!spawns.length) return out;
  const used = new Set<number>();
  for (const k of [...kids].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))) {
    if (k.startedAt === undefined) continue;
    const role = workerRole(k).toLowerCase();
    let best: (typeof spawns)[number] | undefined;
    for (const sp of spawns) {
      if (used.has(sp.i) || sp.at > k.startedAt + 10_000) continue;
      if (sp.type.toLowerCase() !== role && !(role === 'worker' && !sp.type)) continue;
      if (!best || sp.at > best.at) best = sp;
    }
    if (best?.description) {
      used.add(best.i);
      out.set(k.key, best.description);
    }
  }
  return out;
}

function sortKids(kids: TopoNode[], by: SortBy): TopoNode[] {
  const start = (n: TopoNode) => n.roll.start ?? 0;
  if (by === 'tokens') return kids.sort((a, b) => b.roll.tokens - a.roll.tokens || start(a) - start(b));
  if (by === 'live') return kids.sort((a, b) => b.roll.live - a.roll.live || (b.roll.end ?? 0) - (a.roll.end ?? 0));
  return kids.sort((a, b) => start(a) - start(b));
}

export interface BuildOptions {
  now: number;
  sort?: SortBy;
  /** Group siblings by worker role when a node has more than this many children (0 = never). */
  groupAbove?: number;
}

/** Builds the subtree under `root`. Cycle-safe: a session appears at most once. */
export function buildTree(sessions: AgentSessionSnapshot[], root: AgentSessionSnapshot, o: BuildOptions): TopoNode {
  const kidsOf = new Map<string, AgentSessionSnapshot[]>();
  for (const s of sessions) if (s.parentSessionId) kidsOf.set(s.parentSessionId, [...(kidsOf.get(s.parentSessionId) ?? []), s]);
  const seen = new Set<string>();
  const make = (s: AgentSessionSnapshot, spawn?: string): TopoNode => {
    seen.add(s.key);
    const kids = (kidsOf.get(s.key) ?? []).filter(k => !seen.has(k.key));
    const spawns = matchSpawns(s, kids);
    const nodes = kids.filter(k => !seen.has(k.key)).map(k => make(k, spawns.get(k.key)));
    const n: TopoNode = { key: s.key, s, role: s.isWorker ? workerRole(s) : undefined, spawn, children: group(s.key, nodes, o), roll: own(s, o.now) };
    for (const c of n.children) {
      add(n.roll, c.roll);
      n.roll.depth = Math.max(n.roll.depth, c.roll.depth + (c.s ? 1 : 0));
    }
    return n;
  };
  return make(root);
}

function group(parentKey: string, nodes: TopoNode[], o: BuildOptions): TopoNode[] {
  const by = o.sort ?? 'start';
  if (!o.groupAbove || nodes.length <= o.groupAbove) return sortKids(nodes, by);
  const roles = new Map<string, TopoNode[]>();
  for (const n of nodes) roles.set(n.role ?? 'worker', [...(roles.get(n.role ?? 'worker') ?? []), n]);
  if (roles.size === nodes.length) return sortKids(nodes, by);
  const out: TopoNode[] = [];
  for (const [role, list] of roles) {
    if (list.length === 1) {
      out.push(list[0]);
      continue;
    }
    const g: TopoNode = { key: `group:${parentKey}:${role}`, label: `${role} ×${list.length}`, role, children: sortKids(list, by), roll: emptyRollup() };
    for (const c of list) {
      add(g.roll, c.roll);
      g.roll.depth = Math.max(g.roll.depth, c.roll.depth + 1);
    }
    out.push(g);
  }
  return sortKids(out, by);
}

/** Top-level sessions that have at least one recorded worker, live first then most recent. */
export function leads(sessions: AgentSessionSnapshot[]): AgentSessionSnapshot[] {
  const keys = new Set(sessions.map(s => s.key));
  const parents = new Set(sessions.map(s => s.parentSessionId).filter((k): k is string => !!k && keys.has(k)));
  const roots = sessions.filter(s => parents.has(s.key) && !(s.parentSessionId && keys.has(s.parentSessionId)));
  const liveKids = (s: AgentSessionSnapshot) => sessions.filter(c => c.parentSessionId === s.key && isLive(c)).length;
  return roots.sort((a, b) => liveKids(b) - liveKids(a) || Number(isLive(b)) - Number(isLive(a)) || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
}

/** Workers whose recorded parent is not in the loaded set, grouped by that parent key. */
export function orphans(sessions: AgentSessionSnapshot[]): Map<string, AgentSessionSnapshot[]> {
  const keys = new Set(sessions.map(s => s.key));
  const out = new Map<string, AgentSessionSnapshot[]>();
  for (const s of sessions) if (s.parentSessionId && !keys.has(s.parentSessionId)) out.set(s.parentSessionId, [...(out.get(s.parentSessionId) ?? []), s]);
  return out;
}

/** Pseudo root for workers whose parent session is outside the loaded history. */
export function orphanTree(sessions: AgentSessionSnapshot[], parentKey: string, kids: AgentSessionSnapshot[], o: BuildOptions): TopoNode {
  const nodes = kids.map(k => buildTree(sessions, k, o));
  const n: TopoNode = { key: `orphan:${parentKey}`, label: `parent not loaded · ${parentKey.split(':')[1]?.slice(0, 8) ?? parentKey}`, children: group(`orphan:${parentKey}`, nodes, o), roll: emptyRollup() };
  for (const c of n.children) {
    add(n.roll, c.roll);
    n.roll.depth = Math.max(n.roll.depth, c.roll.depth + (c.s ? 1 : 0));
  }
  return n;
}

/** Keys from the root down to `key` (inclusive), or [] when `key` is not in the tree. */
export function pathTo(root: TopoNode, key: string | undefined): string[] {
  if (!key) return [];
  if (root.key === key) return [root.key];
  for (const c of root.children) {
    const p = pathTo(c, key);
    if (p.length) return [root.key, ...p];
  }
  return [];
}

/** Short stable id for a node key, usable in an option name ([a-z0-9]). */
export function shortId(key: string): string {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
