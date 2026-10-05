// Long-term weekly rollups ("History"). Pure logic, no fs: the archive files are read and written by
// src/feeds/history.ts (screen feed, in-workspace build) and scripts/weekly.ts (by hand / Task Scheduler).
//
// One file per ISO week (local time, Monday 00:00 → next Monday): ~/.agent/history/YYYY-Www.json.
// It keeps one compact row per session active that week (no title, no prompt text, no command line):
// provider, repository folder name, model, effort, worker type, outcome and, per metric, the 7 daily
// values (Mon … Sun) of what the session recorded that week. Rows are merged by session key on every
// run, so a week survives the providers' own transcript cleanup.
import type { AgentSessionSnapshot, Provider } from '../model';
import { contributions, Metric, METRICS } from './explore';
import { base, isLive, Outcome, outcome, workerRole } from './insights';
import { weekStart } from './week';

export const HISTORY_SCHEMA = 1;
export const WEEK_RE = /^(\d{4})-W(\d{2})$/;
export const WEEK_FILE_RE = /^(\d{4})-W(\d{2})\.json$/;

export type Daily = number[]; // 7 values, Monday first

export interface HistRow {
  /** Session key provider:id. */
  k: string;
  p: Provider;
  /** Repository (or cwd) folder name. */
  repo: string;
  model?: string;
  effort?: string;
  /** 1 for a worker (subagent / spawned agent). */
  w?: 1;
  /** Worker type as the provider labels it (subagent type, Codex nickname). */
  wt?: string;
  /** Outcome when the row was last written (live sessions get re-read on the next run). */
  o: Outcome;
  /** First / last recorded activity (epoch ms), whole session. */
  st?: number;
  la?: number;
  /** 1 when commits came from git correlation (the script with git on); 0 when git was not read. */
  g: 0 | 1;
  /** Per metric, the daily values of this week (only metrics with a non-zero value). */
  d: Partial<Record<Metric, Daily>>;
}

export interface WeekSource {
  /** Who wrote the file last. */
  by: 'script' | 'workspace';
  git: boolean;
  /** Days of provider history scanned by that run. */
  days: number;
  /** Session artifacts found by that run (all weeks). */
  sessions: number;
}

export interface Breakdown {
  [key: string]: Partial<Record<Metric, number>>;
}

export interface HistWeek {
  schema: number;
  week: string;
  /** Local Monday 00:00 and next Monday 00:00 (epoch ms). */
  start: number;
  end: number;
  generatedAt: number;
  /** Number of runs merged into this file. */
  runs: number;
  source: WeekSource;
  /** Rows kept from earlier runs whose session the last run did not see (cleaned up or outside its window). */
  kept: number;
  rows: HistRow[];
  /** DERIVED rollups (also computable from rows; stored for other readers of the file). */
  totals: Partial<Record<Metric, number>>;
  byDay: Partial<Record<Metric, Daily>>;
  byProvider: Breakdown;
  byRepo: Breakdown;
  byModel: Breakdown;
  outcomes: Partial<Record<Outcome, number>>;
}

// ---------------------------------------------------------------- weeks

const DAY = 86400_000;

/** ISO week id (YYYY-Www) of a local time. */
export function weekId(t: number): string {
  const mon = weekStart(t);
  const thu = new Date(mon);
  thu.setDate(thu.getDate() + 3);
  const year = thu.getFullYear();
  const w1 = weekStart(new Date(year, 0, 4).getTime());
  const n = 1 + Math.round((mon - w1) / (7 * DAY));
  return `${year}-W${String(n).padStart(2, '0')}`;
}

/** Local Monday 00:00 of a week id, or undefined when malformed. */
export function weekStartOf(id: string): number | undefined {
  const m = WEEK_RE.exec(id);
  if (!m) return undefined;
  const year = +m[1], n = +m[2];
  if (n < 1 || n > 53) return undefined;
  const d = new Date(weekStart(new Date(year, 0, 4).getTime()));
  d.setDate(d.getDate() + (n - 1) * 7);
  const t = d.getTime();
  return weekId(t) === id ? t : undefined;
}

export function weekEndOf(start: number): number {
  const d = new Date(start);
  d.setDate(d.getDate() + 7);
  return d.getTime();
}

/** Week id `n` weeks after (negative: before) `id`. */
export function shiftWeek(id: string, n: number): string | undefined {
  const s = weekStartOf(id);
  if (s === undefined) return undefined;
  const d = new Date(s);
  d.setDate(d.getDate() + 7 * n);
  return weekId(d.getTime());
}

/** Monday-first day index 0 … 6. */
export const dayIndex = (t: number) => (new Date(t).getDay() + 6) % 7;

export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** "29 Sep – 5 Oct" for a week start. */
export function weekLabel(start: number): string {
  const a = new Date(start), b = new Date(weekEndOf(start) - 1);
  const mo = (d: Date) => d.toLocaleString('en-GB', { month: 'short' });
  return a.getMonth() === b.getMonth() ? `${a.getDate()}–${b.getDate()} ${mo(b)}` : `${a.getDate()} ${mo(a)} – ${b.getDate()} ${mo(b)}`;
}

// ---------------------------------------------------------------- metric meaning in the archive

export const HIST_METRICS = METRICS;
export type HMetric = Metric;

export const HIST_BASIS: Record<Metric, { label: string; kind: 'OBSERVED' | 'DERIVED'; basis: string }> = {
  sessions: { label: 'Sessions', kind: 'DERIVED', basis: 'sessions with recorded activity in the week (one spanning two weeks counts in both), on the day of its first activity that week' },
  tokens: { label: 'Tokens', kind: 'OBSERVED', basis: 'provider-recorded prompt + output tokens, per model call at call time; otherwise the session total at its last activity' },
  output: { label: 'Output tokens', kind: 'OBSERVED', basis: 'provider-recorded output tokens, per model call at call time; otherwise the session total' },
  cost: { label: 'Cost recorded', kind: 'OBSERVED', basis: 'Claude Code cost-state total of the session at its last activity; Codex records none; Agent never prices' },
  active: { label: 'Active time', kind: 'DERIVED', basis: 'sum of gaps < 5 min between events when exposed, else first → last activity; at the last activity' },
  commits: { label: 'Commits', kind: 'DERIVED', basis: 'git log within the session window at commit time (only when the run read git)' },
  pass: { label: 'Tests pass', kind: 'OBSERVED', basis: 'test / build commands with a pass result, at run time' },
  fail: { label: 'Tests fail', kind: 'OBSERVED', basis: 'test / build commands with a fail result, at run time' },
  edits: { label: 'Edits', kind: 'OBSERVED', basis: 'file edit tool calls recorded by the provider, at the last activity' },
  tools: { label: 'Tool calls', kind: 'OBSERVED', basis: 'tool calls recorded by the provider, at the last activity' },
  prompts: { label: 'Prompts', kind: 'OBSERVED', basis: 'human prompts recorded by the provider (absent when not exposed), at the last activity' },
};

// ---------------------------------------------------------------- sessions → rows

const zero7 = (): Daily => [0, 0, 0, 0, 0, 0, 0];
const round = (m: Metric, v: number) => (m === 'cost' ? Math.round(v * 10_000) / 10_000 : Math.round(v));

/** Splits every session into week rows. `git` says whether commits come from git correlation. */
export function rowsByWeek(sessions: AgentSessionSnapshot[], git: boolean): Map<string, HistRow[]> {
  const out = new Map<string, HistRow[]>();
  for (const s of sessions) for (const [wk, row] of sessionRows(s, git)) {
    const list = out.get(wk) ?? [];
    list.push(row);
    out.set(wk, list);
  }
  return out;
}

/** Week id → row of one session. */
export function sessionRows(s: AgentSessionSnapshot, git: boolean): Map<string, HistRow> {
  const rows = new Map<string, HistRow>();
  const first = new Map<string, number>(); // week → earliest piece
  const row = (wk: string): HistRow => {
    let r = rows.get(wk);
    if (!r) {
      r = baseRow(s, git);
      rows.set(wk, r);
    }
    return r;
  };
  const note = (wk: string, at: number) => {
    if (!(first.get(wk)! <= at)) first.set(wk, at);
  };
  for (const m of METRICS) {
    if (m === 'sessions') continue;
    if (m === 'commits' && !git) continue;
    for (const [at, v] of contributions(s, m)) {
      if (!Number.isFinite(at) || at <= 0 || !(v > 0)) continue;
      const wk = weekId(at);
      const r = row(wk);
      (r.d[m] ??= zero7())[dayIndex(at)] += v;
      note(wk, at);
    }
  }
  const start = s.startedAt ?? s.lastActivityAt;
  if (start && start > 0) {
    row(weekId(start));
    note(weekId(start), start);
  }
  for (const [wk, r] of rows) {
    (r.d.sessions = zero7())[dayIndex(first.get(wk) ?? start ?? 0)] = 1;
    for (const m of Object.keys(r.d) as Metric[]) r.d[m] = r.d[m]!.map(v => round(m, v));
  }
  return rows;
}

function baseRow(s: AgentSessionSnapshot, git: boolean): HistRow {
  const r: HistRow = { k: s.key, p: s.provider, repo: base(s.repository) || base(s.cwd) || '(no repo)', o: outcomeOf(s, git), g: git ? 1 : 0, d: {} };
  if (s.model) r.model = s.model;
  if (s.effort) r.effort = s.effort;
  if (s.isWorker) {
    r.w = 1;
    r.wt = workerRole(s);
  }
  if (s.startedAt) r.st = s.startedAt;
  if (s.lastActivityAt) r.la = s.lastActivityAt;
  return r;
}

function outcomeOf(s: AgentSessionSnapshot, git: boolean): Outcome {
  if (isLive(s)) return 'live';
  const o = outcome(s);
  return o === 'committed' && !git ? 'changed' : o;
}

// ---------------------------------------------------------------- merge and rollups

/**
 * Merges freshly computed rows into a week (the previous file, if any). Rows are matched by session key:
 * the fresh row wins, except that commits and a "committed" outcome read with git are not lost when the
 * fresh row was computed without git. Rows the fresh run did not produce are kept (counted in `kept`).
 */
export function mergeWeek(week: string, prev: HistWeek | undefined, fresh: HistRow[], source: WeekSource, now: number): HistWeek {
  const start = weekStartOf(week);
  if (start === undefined) throw new Error(`bad week id ${week}`);
  const by = new Map<string, HistRow>();
  for (const r of prev?.rows ?? []) by.set(r.k, r);
  const seen = new Set<string>();
  for (const r0 of fresh) {
    seen.add(r0.k);
    const old = by.get(r0.k);
    let r = r0;
    if (old && old.g === 1 && r0.g === 0) {
      r = { ...r0, g: 1, d: { ...r0.d } };
      if (old.d.commits) r.d.commits = old.d.commits;
      if (old.o === 'committed' && r0.o !== 'live') r.o = 'committed';
    }
    by.set(r.k, r);
  }
  const rows = [...by.values()].sort((a, b) => (a.st ?? a.la ?? 0) - (b.st ?? b.la ?? 0) || a.k.localeCompare(b.k));
  const kept = rows.filter(r => !seen.has(r.k)).length;
  return { schema: HISTORY_SCHEMA, week, start, end: weekEndOf(start), generatedAt: now, runs: (prev?.runs ?? 0) + 1, source, kept, rows, ...rollup(rows) };
}

export function rollup(rows: HistRow[]): Pick<HistWeek, 'totals' | 'byDay' | 'byProvider' | 'byRepo' | 'byModel' | 'outcomes'> {
  const totals: Partial<Record<Metric, number>> = {};
  const byDay: Partial<Record<Metric, Daily>> = {};
  const byProvider: Breakdown = {}, byRepo: Breakdown = {}, byModel: Breakdown = {};
  const outcomes: Partial<Record<Outcome, number>> = {};
  const add = (b: Breakdown, k: string, m: Metric, v: number) => {
    const g = (b[k] ??= {});
    g[m] = round(m, (g[m] ?? 0) + v);
  };
  for (const r of rows) {
    if (!r.w) outcomes[r.o] = (outcomes[r.o] ?? 0) + 1;
    for (const m of Object.keys(r.d) as Metric[]) {
      const days = r.d[m]!;
      const v = days.reduce((a, b) => a + b, 0);
      totals[m] = round(m, (totals[m] ?? 0) + v);
      const bd = (byDay[m] ??= zero7());
      days.forEach((x, i) => (bd[i] = round(m, bd[i] + x)));
      add(byProvider, r.p, m, v);
      add(byRepo, r.repo, m, v);
      add(byModel, r.model ?? '(not recorded)', m, v);
    }
  }
  return { totals, byDay, byProvider, byRepo, byModel, outcomes };
}

// ---------------------------------------------------------------- queries used by the screen

export type HDim = 'provider' | 'repo' | 'model' | 'effort' | 'outcome' | 'worker';
export const HDIMS: HDim[] = ['provider', 'repo', 'model', 'effort', 'outcome', 'worker'];

export const rowValue = (r: HistRow, m: Metric) => (r.d[m] ?? []).reduce((a, b) => a + b, 0);

export function rowKey(r: HistRow, dim: HDim): string {
  switch (dim) {
    case 'provider':
      return r.p === 'codex' ? 'Codex' : 'Claude Code';
    case 'repo':
      return r.repo;
    case 'model':
      return prettyModelName(r.model) || '(not recorded)';
    case 'effort':
      return r.effort || '(not recorded)';
    case 'outcome':
      return OUT_LABEL[r.o];
    case 'worker':
      return r.w ? r.wt || 'worker' : 'lead';
  }
}

export const OUT_LABEL: Record<Outcome, string> = { live: 'Still live', committed: 'Commit observed', changed: 'Files edited, no commit', nochange: 'No file change observed' };

export function prettyModelName(m: string | undefined): string {
  if (!m) return '';
  const c = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(m);
  return c ? `${c[1][0].toUpperCase()}${c[1].slice(1)} ${c[2]}.${c[3]}` : m;
}

const keep = (rows: HistRow[], leadsOnly: boolean) => (leadsOnly ? rows.filter(r => !r.w) : rows);

export function total(rows: HistRow[], m: Metric, leadsOnly = false): number {
  let t = 0;
  for (const r of keep(rows, leadsOnly)) t += rowValue(r, m);
  return round(m, t);
}

export function daily(rows: HistRow[], m: Metric, leadsOnly = false): Daily {
  const d = zero7();
  for (const r of keep(rows, leadsOnly)) (r.d[m] ?? []).forEach((v, i) => (d[i] += v));
  return d.map(v => round(m, v));
}

/** Group → value, biggest first. */
export function breakdown(rows: HistRow[], m: Metric, dim: HDim, leadsOnly = false): [string, number][] {
  const g = new Map<string, number>();
  for (const r of keep(rows, leadsOnly)) {
    const v = rowValue(r, m);
    if (v) g.set(rowKey(r, dim), (g.get(rowKey(r, dim)) ?? 0) + v);
  }
  return [...g].map(([k, v]) => [k, round(m, v)] as [string, number]).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Percent change, undefined when the base is 0. */
export function delta(cur: number, prev: number): number | undefined {
  return prev ? ((cur - prev) / prev) * 100 : undefined;
}

// ---------------------------------------------------------------- validation of files read from disk

const str = (v: unknown, max = 200) => (typeof v === 'string' && v.length <= max ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const OUTCOMES = new Set<Outcome>(['live', 'committed', 'changed', 'nochange']);
const METRIC_SET = new Set<string>(METRICS);

function daily7(v: unknown): Daily | undefined {
  if (!Array.isArray(v) || v.length !== 7) return undefined;
  const out = v.map(x => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : NaN));
  return out.some(Number.isNaN) ? undefined : out;
}

function validRow(v: any): HistRow | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const k = str(v.k, 160), repo = str(v.repo, 200);
  if (!k || !repo || (v.p !== 'claude' && v.p !== 'codex') || !OUTCOMES.has(v.o)) return undefined;
  const d: HistRow['d'] = {};
  if (v.d && typeof v.d === 'object') for (const [m, arr] of Object.entries(v.d)) {
    if (!METRIC_SET.has(m)) continue;
    const x = daily7(arr);
    if (x) d[m as Metric] = x;
  }
  const r: HistRow = { k, p: v.p, repo, o: v.o, g: v.g === 1 ? 1 : 0, d };
  const model = str(v.model, 80), effort = str(v.effort, 40), wt = str(v.wt, 80), st = num(v.st), la = num(v.la);
  if (model) r.model = model;
  if (effort) r.effort = effort;
  if (v.w === 1) r.w = 1;
  if (wt) r.wt = wt;
  if (st) r.st = st;
  if (la) r.la = la;
  return r;
}

/** Validates a parsed week file; rollups are recomputed from the valid rows (never trusted from disk). */
export function validateWeek(v: any): HistWeek | undefined {
  if (!v || typeof v !== 'object' || v.schema !== HISTORY_SCHEMA || typeof v.week !== 'string') return undefined;
  const start = weekStartOf(v.week);
  if (start === undefined || !Array.isArray(v.rows)) return undefined;
  const rows = (v.rows as unknown[]).slice(0, 50_000).map(validRow).filter((r): r is HistRow => !!r);
  const s = v.source ?? {};
  const source: WeekSource = { by: s.by === 'workspace' ? 'workspace' : 'script', git: s.git === true, days: num(s.days) ?? 0, sessions: num(s.sessions) ?? 0 };
  return { schema: HISTORY_SCHEMA, week: v.week, start, end: weekEndOf(start), generatedAt: num(v.generatedAt) ?? 0, runs: num(v.runs) ?? 1, source, kept: num(v.kept) ?? 0, rows, ...rollup(rows) };
}

// ---------------------------------------------------------------- markdown audit

const fmtN = (m: Metric, v: number): string => {
  if (m === 'cost') return `$${v.toFixed(2)}`;
  if (m === 'active') {
    const min = Math.round(v / 60_000);
    return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
  }
  return Math.round(v).toLocaleString('en-US');
};

const pct = (d: number | undefined) => (d === undefined ? '—' : `${d >= 0 ? '+' : ''}${d.toFixed(0)} %`);
const mdCell = (s: string) => s.replace(/[|\r\n]/g, ' ').slice(0, 80);

/** Weekly audit report (Markdown). Counts and labels only: no prompt, title or command text. */
export function weeklyMarkdown(w: HistWeek, prev?: HistWeek): string {
  const L: string[] = [];
  const leads = w.rows.filter(r => !r.w);
  L.push(`# Agent weekly audit · ${w.week} (${weekLabel(w.start)})`, '');
  L.push(`Generated ${new Date(w.generatedAt).toISOString()} by the ${w.source.by === 'script' ? 'weekly script' : 'Agent workspace'} · git ${w.source.git ? 'read' : 'not read (commits not counted)'} · ${w.rows.length} session rows (${leads.length} leads, ${w.rows.length - leads.length} workers)${w.kept ? ` · ${w.kept} kept from earlier runs` : ''}.`, '');
  L.push('Local only. Values are what Claude Code and Codex recorded (OBSERVED) or arithmetic over them (DERIVED); nothing is priced, estimated or judged.', '');
  L.push('## Totals', '', `| Metric | ${w.week} | ${prev ? prev.week : 'previous'} | Change | Basis |`, '|---|--:|--:|--:|---|');
  for (const m of METRICS) {
    const cur = w.totals[m] ?? 0, old = prev?.totals[m];
    if (!cur && !old) continue;
    L.push(`| ${HIST_BASIS[m].label} | ${fmtN(m, cur)} | ${old === undefined ? '—' : fmtN(m, old)} | ${old === undefined ? '—' : pct(delta(cur, old))} | ${HIST_BASIS[m].kind} |`);
  }
  L.push('', '## Per day', '', `| | ${DAYS.join(' | ')} |`, `|---|${DAYS.map(() => '--:').join('|')}|`);
  for (const m of ['sessions', 'tokens', 'active', 'commits'] as Metric[]) {
    const d = w.byDay[m];
    if (d && d.some(Boolean)) L.push(`| ${HIST_BASIS[m].label} | ${d.map(v => (v ? fmtN(m, v) : '·')).join(' | ')} |`);
  }
  const table = (title: string, dim: HDim, n: number) => {
    const ses = new Map(breakdown(w.rows, 'sessions', dim));
    const tok = breakdown(w.rows, 'tokens', dim);
    const keys = [...new Set([...tok.map(([k]) => k), ...ses.keys()])].slice(0, n);
    if (!keys.length) return;
    const tm = new Map(tok), act = new Map(breakdown(w.rows, 'active', dim)), com = new Map(breakdown(w.rows, 'commits', dim));
    L.push('', `## ${title}`, '', '| | Sessions | Tokens | Active | Commits |', '|---|--:|--:|--:|--:|');
    for (const k of keys) L.push(`| ${mdCell(k)} | ${ses.get(k) ?? 0} | ${fmtN('tokens', tm.get(k) ?? 0)} | ${fmtN('active', act.get(k) ?? 0)} | ${com.get(k) ?? 0} |`);
  };
  table('Providers', 'provider', 5);
  table('Repositories (top 15 by tokens)', 'repo', 15);
  table('Models', 'model', 10);
  table('Worker types', 'worker', 10);
  L.push('', '## Outcomes (lead sessions)', '');
  for (const o of ['committed', 'changed', 'nochange', 'live'] as Outcome[]) if (w.outcomes[o]) L.push(`- ${OUT_LABEL[o]}: ${w.outcomes[o]}`);
  const top = [...w.rows].sort((a, b) => rowValue(b, 'tokens') - rowValue(a, 'tokens')).slice(0, 10).filter(r => rowValue(r, 'tokens') > 0);
  if (top.length) {
    L.push('', '## Largest sessions by tokens', '', '| Session | Repo | Provider | Model | Tokens | Active | Outcome |', '|---|---|---|---|--:|--:|---|');
    for (const r of top) L.push(`| \`${mdCell(r.k.split(':')[1]?.slice(0, 8) ?? r.k)}\`${r.w ? ` (${mdCell(r.wt ?? 'worker')})` : ''} | ${mdCell(r.repo)} | ${r.p} | ${mdCell(prettyModelName(r.model) || '—')} | ${fmtN('tokens', rowValue(r, 'tokens'))} | ${fmtN('active', rowValue(r, 'active'))} | ${OUT_LABEL[r.o]} |`);
  }
  L.push('', '## Basis', '');
  for (const m of METRICS) L.push(`- **${HIST_BASIS[m].label}** (${HIST_BASIS[m].kind}): ${HIST_BASIS[m].basis}.`);
  return L.join('\n') + '\n';
}
