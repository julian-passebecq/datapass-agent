// Company → project → repository mapping for sessions. Pure and deterministic.
// Mapping comes from the `agent.projects` setting (rules) or, when no rule matches, from the path (INFERRED).
import type { AgentSessionSnapshot } from '../model';
import { dayStart, isLive } from './insights';

export interface ProjectRule {
  /** Path prefix (D:\PROJ\foo), glob (D:/PROJ/datapass-*, **\/clients/**) or a bare repo folder name / glob. */
  match: string;
  company?: string;
  project?: string;
}

export type ProjectInfer = 'folder' | 'prefix';
export type MapSource = 'rule' | 'inferred';

export interface ProjectPlace {
  company: string;
  project: string;
  repo: string;
  /** Main repository path (or cwd without a worktree suffix). */
  path?: string;
  source: MapSource;
  /** Index of the rule that matched. */
  rule?: number;
}

export interface ProjStats {
  sessions: number;
  workers: number;
  live: number;
  liveWorkers: number;
  today: number;
  tokens: number;
  outputTokens: number;
  commits: number;
  claude: number;
  codex: number;
  lastAt: number;
}

export interface ProjNode {
  level: 'company' | 'project' | 'repo';
  name: string;
  source: MapSource;
  /** Repo node only: path of the repository. */
  path?: string;
  children: ProjNode[];
  sessions: AgentSessionSnapshot[];
  stats: ProjStats;
}

export interface ProjectsResult {
  companies: ProjNode[];
  /** Rules that matched no session in the period (to help fix typos). */
  unusedRules: number[];
  total: ProjStats;
}

const MAX_RULES = 200;

/** Accepts the raw setting value; drops anything malformed. */
export function parseRules(raw: unknown): ProjectRule[] {
  if (!Array.isArray(raw)) return [];
  const out: ProjectRule[] = [];
  for (const r of raw.slice(0, MAX_RULES)) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const match = typeof o.match === 'string' ? o.match.trim().slice(0, 300) : '';
    const company = typeof o.company === 'string' && o.company.trim() ? o.company.trim().slice(0, 80) : undefined;
    const project = typeof o.project === 'string' && o.project.trim() ? o.project.trim().slice(0, 80) : undefined;
    if (match && (company || project)) out.push({ match, company, project });
  }
  return out;
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const segs = (p: string) => p.split(/[\\/]/).filter(Boolean);
const WT = /[\\/](?:\.claude[\\/]worktrees|\.worktrees|worktrees)[\\/][^\\/]+(?:[\\/].*)?$/i;

/** Repository path of a session: git main root when known, else cwd without a linked-worktree suffix. */
export function repoPath(s: AgentSessionSnapshot): string | undefined {
  if (s.repository) return s.repository;
  if (!s.cwd) return undefined;
  return s.cwd.replace(WT, '') || s.cwd;
}

/** Folder name of repoPath (so a session in a deleted linked worktree still lands on its main repo). */
export function repoName(s: AgentSessionSnapshot): string {
  const p = repoPath(s);
  return (p ? segs(p).pop() : undefined) || '(no repo)';
}

function globRe(g: string): string {
  let out = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      out += '.*';
      i++;
      if (g[i + 1] === '/') i++;
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return out;
}

/** How specific a rule is (literal characters); the most specific match wins, ties go to the earlier rule. */
function specificity(m: string): number {
  return m.replace(/[*?]/g, '').length;
}

/** True when the rule matches the repository path (or, for a bare name, the repo folder name). */
export function ruleMatches(rule: ProjectRule, path: string | undefined, name: string): boolean {
  const m = norm(rule.match);
  const glob = /[*?]/.test(m);
  if (!m.includes('/') && !m.includes(':')) {
    const n = name.toLowerCase();
    return glob ? new RegExp(`^${globRe(m)}$`).test(n) : n === m;
  }
  if (!path) return false;
  const p = norm(path);
  if (glob) return new RegExp(`^${globRe(m)}(?:/|$)`).test(p);
  return p === m || p.startsWith(m + '/');
}

const GENERIC = new Set(['src', 'code', 'dev', 'git', 'github', 'gitlab', 'repos', 'repo', 'projects', 'work', 'workspace', 'workspaces']);

/** Path heuristic: company = parent folder (or drive), project = repo folder (or its name prefix). */
export function inferPlace(path: string | undefined, name: string, infer: ProjectInfer): Omit<ProjectPlace, 'source'> {
  const parts = path ? segs(path) : [];
  let company = '(unknown)';
  if (parts.length >= 2) {
    const parent = parts[parts.length - 2];
    company = /^[a-z]:$/i.test(parent) ? parent.toUpperCase() : parent;
    // A generic container under a drive root ("D:\src\foo") is still named by the folder, not the drive.
    if (GENERIC.has(parent.toLowerCase()) && parts.length >= 3 && !/^[a-z]:$/i.test(parts[parts.length - 3])) company = parts[parts.length - 3];
  } else if (parts.length === 1) company = parts[0];
  const project = infer === 'prefix' ? (name.split(/[-_. ]/).find(Boolean) ?? name) : name;
  return { company, project, repo: name, path };
}

export function placeOf(s: AgentSessionSnapshot, rules: ProjectRule[], infer: ProjectInfer = 'folder'): ProjectPlace {
  const path = repoPath(s);
  const name = repoName(s);
  const guess = inferPlace(path, name, infer);
  let best = -1;
  for (let i = 0; i < rules.length; i++) {
    if (!ruleMatches(rules[i], path, name)) continue;
    if (best < 0 || specificity(rules[i].match) > specificity(rules[best].match)) best = i;
  }
  if (best < 0) return { ...guess, source: 'inferred' };
  const r = rules[best];
  return { company: r.company ?? guess.company, project: r.project ?? guess.project, repo: name, path, source: 'rule', rule: best };
}

function emptyStats(): ProjStats {
  return { sessions: 0, workers: 0, live: 0, liveWorkers: 0, today: 0, tokens: 0, outputTokens: 0, commits: 0, claude: 0, codex: 0, lastAt: 0 };
}

function add(st: ProjStats, s: AgentSessionSnapshot, today: number): void {
  const live = isLive(s);
  if (s.isWorker) {
    st.workers++;
    if (live) st.liveWorkers++;
  } else {
    st.sessions++;
    if (live) st.live++;
  }
  const at = s.lastActivityAt ?? s.startedAt ?? 0;
  if (at >= today) st.today++;
  st.tokens += s.usage?.totalTokens ?? 0;
  st.outputTokens += s.usage?.outputTokens ?? 0;
  st.commits += s.commits.length;
  st[s.provider]++;
  st.lastAt = Math.max(st.lastAt, at);
}

function merge(into: ProjStats, x: ProjStats): void {
  for (const k of Object.keys(into) as (keyof ProjStats)[]) into[k] = k === 'lastAt' ? Math.max(into[k], x[k]) : into[k] + x[k];
}

export type ProjSort = 'recent' | 'tokens' | 'name' | 'live';

function sorter(sort: ProjSort): (a: ProjNode, b: ProjNode) => number {
  if (sort === 'name') return (a, b) => a.name.localeCompare(b.name);
  if (sort === 'tokens') return (a, b) => b.stats.tokens - a.stats.tokens || b.stats.lastAt - a.stats.lastAt;
  if (sort === 'live') return (a, b) => b.stats.live + b.stats.liveWorkers - (a.stats.live + a.stats.liveWorkers) || b.stats.lastAt - a.stats.lastAt;
  return (a, b) => b.stats.lastAt - a.stats.lastAt;
}

export interface BuildOpts {
  now: number;
  /** Only sessions active at or after this time. */
  since?: number;
  infer?: ProjectInfer;
  sort?: ProjSort;
}

/** Groups sessions into company → project → repo with rolled-up counts. */
export function buildProjects(sessions: AgentSessionSnapshot[], rules: ProjectRule[], o: BuildOpts): ProjectsResult {
  const today = dayStart(o.now);
  const used = new Set<number>();
  const comp = new Map<string, ProjNode>();
  const total = emptyStats();
  const node = (level: ProjNode['level'], name: string, source: MapSource): ProjNode => ({ level, name, source, children: [], sessions: [], stats: emptyStats() });
  for (const s of sessions) {
    const at = s.lastActivityAt ?? s.startedAt ?? 0;
    if (o.since !== undefined && at < o.since && !isLive(s)) continue;
    const p = placeOf(s, rules, o.infer ?? 'folder');
    if (p.rule !== undefined) used.add(p.rule);
    const ck = p.company.toLowerCase();
    let c = comp.get(ck);
    if (!c) comp.set(ck, (c = node('company', p.company, p.source)));
    if (p.source === 'rule') c.source = 'rule';
    let pr = c.children.find(x => x.name.toLowerCase() === p.project.toLowerCase());
    if (!pr) c.children.push((pr = node('project', p.project, p.source)));
    if (p.source === 'rule') pr.source = 'rule';
    let r = pr.children.find(x => x.name.toLowerCase() === p.repo.toLowerCase());
    if (!r) pr.children.push((r = { ...node('repo', p.repo, p.source), path: p.path }));
    if (!r.path && p.path) r.path = p.path;
    r.sessions.push(s);
    add(r.stats, s, today);
  }
  const by = sorter(o.sort ?? 'recent');
  const companies = [...comp.values()];
  for (const c of companies) {
    for (const pr of c.children) {
      for (const r of pr.children) {
        merge(pr.stats, r.stats);
        r.sessions.sort((a, b) => Number(isLive(b)) - Number(isLive(a)) || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
        pr.sessions.push(...r.sessions);
      }
      pr.children.sort(by);
      merge(c.stats, pr.stats);
      c.sessions.push(...pr.sessions);
    }
    c.children.sort(by);
    merge(total, c.stats);
  }
  companies.sort(by);
  return { companies, unusedRules: rules.map((_, i) => i).filter(i => !used.has(i)), total };
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Squarified treemap (Bruls et al.) of values into a rectangle. Output order = input order; zero values get empty rects. */
export function squarify(values: number[], box: Rect): Rect[] {
  const out: Rect[] = values.map(() => ({ x: box.x, y: box.y, w: 0, h: 0 }));
  const sum = values.reduce((a, v) => a + Math.max(0, v), 0);
  if (sum <= 0 || box.w <= 0 || box.h <= 0) return out;
  const scale = (box.w * box.h) / sum;
  const items = values.map((v, i) => ({ i, a: Math.max(0, v) * scale })).filter(x => x.a > 0).sort((a, b) => b.a - a.a);
  let { x, y, w, h } = box;
  const worst = (row: number[], side: number) => {
    const s = row.reduce((a, b) => a + b, 0);
    const mx = Math.max(...row), mn = Math.min(...row);
    return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn));
  };
  let row: typeof items = [];
  const layout = (r: typeof items) => {
    const s = r.reduce((a, b) => a + b.a, 0);
    if (w >= h) {
      const cw = s / h;
      let cy = y;
      for (const it of r) {
        const ch = it.a / cw;
        out[it.i] = { x, y: cy, w: cw, h: ch };
        cy += ch;
      }
      x += cw;
      w -= cw;
    } else {
      const rh = s / w;
      let cx = x;
      for (const it of r) {
        const cw = it.a / rh;
        out[it.i] = { x: cx, y, w: cw, h: rh };
        cx += cw;
      }
      y += rh;
      h -= rh;
    }
  };
  for (const it of items) {
    const side = Math.min(w, h);
    if (!row.length || worst([...row, it].map(r => r.a), side) <= worst(row.map(r => r.a), side)) row.push(it);
    else {
      layout(row);
      row = [it];
    }
  }
  if (row.length) layout(row);
  return out;
}
