// Model benchmarks: a local, week-by-week database of coding-agent benchmark rows (~/.agent/benchmarks/YYYY-Www.json),
// fed by scripts/benchmarks.ts from three kinds of source:
//  - local:  "Local workload", DERIVED from Agent's own dispatch analytics (src/activity/dispatch.ts),
//  - public: opt-in fetched leaderboards, one parser per source in PARSERS (OBSERVED as the source records them),
//  - manual: files the user copies numbers into (~/.agent/benchmarks/manual/*.json).
// Pure logic, no fs, no network: the files are read / written by src/feeds/benchmarks.ts. No number is invented
// here: every value comes from a source file, the user's own data, or the user's price setting.
import type { Dispatch } from './dispatch';
import { groupStats } from './dispatch';
import { WEEK_RE } from './history';

export const BENCH_SCHEMA = 1;
export const BENCH_FILE_RE = /^(\d{4})-W(\d{2})\.json$/;

export type SourceKind = 'local' | 'public' | 'manual';

export interface BenchSource {
  id: string;
  name: string;
  kind: SourceKind;
  url?: string;
  license?: string;
  /** When the numbers were read (fetch time, file mtime, or computation time). */
  fetchedAt: number;
  /** What the score means. */
  metric: string;
  /** How cost per task was obtained (or why there is none). */
  costBasis: string;
}

export interface BenchRow {
  source: string;
  model: string;
  vendor: string;
  /** true when vendor was guessed from the model name (INFERRED). */
  vendorInferred?: boolean;
  effort?: string;
  score: number;
  scoreUnit: string;
  costPerTask?: number;
  costUnit: string;
  tokensPerTask?: number;
  n?: number;
  notes?: string;
}

export interface BenchSnapshot {
  schema?: number;
  week: string;
  /** First capture of this week. */
  capturedAt: number;
  /** Latest rerun of this week. */
  updatedAt?: number;
  sources: BenchSource[];
  rows: BenchRow[];
}

// ---- validation --------------------------------------------------------------------------------------------

const CTRL = /[\u0000-\u001f\u007f]/g;
function str(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.replace(CTRL, ' ').trim();
  return s ? s.slice(0, max) : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function pos(v: unknown): number | undefined {
  const n = num(v);
  return n !== undefined && n >= 0 ? n : undefined;
}

/** Lowercase id usable in an option value ([a-z0-9._:-], ≤ 40). */
export function benchSlug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || '-';
}

export function validateRow(o: any, sourceId?: string): BenchRow | undefined {
  if (!o || typeof o !== 'object') return undefined;
  const source = sourceId ?? str(o.source, 60);
  const model = str(o.model, 120);
  const score = num(o.score);
  if (!source || !model || score === undefined) return undefined;
  const vendor = str(o.vendor, 40);
  const r: BenchRow = {
    source,
    model,
    vendor: vendor ?? inferVendor(model),
    score,
    scoreUnit: str(o.scoreUnit, 40) ?? 'score',
    costUnit: str(o.costUnit, 16) ?? 'USD',
  };
  if (!vendor || o.vendorInferred === true) r.vendorInferred = true;
  const effort = o.effort === undefined || o.effort === null ? undefined : str(String(o.effort), 24);
  if (effort) r.effort = effort;
  const c = pos(o.costPerTask);
  if (c !== undefined) r.costPerTask = c;
  const t = pos(o.tokensPerTask);
  if (t !== undefined) r.tokensPerTask = t;
  const n = pos(o.n);
  if (n !== undefined) r.n = Math.round(n);
  const notes = str(o.notes, 200);
  if (notes) r.notes = notes;
  return r;
}

export function validateSource(o: any): BenchSource | undefined {
  if (!o || typeof o !== 'object') return undefined;
  const id = str(o.id, 60);
  const name = str(o.name, 80);
  if (!id || !name) return undefined;
  const kind: SourceKind = o.kind === 'local' || o.kind === 'manual' ? o.kind : 'public';
  const url = str(o.url, 300);
  const license = str(o.license, 80);
  return {
    id,
    name,
    kind,
    ...(url && /^https:\/\/[^\s"'<>]+$/i.test(url) ? { url } : {}),
    ...(license ? { license } : {}),
    fetchedAt: num(o.fetchedAt) ?? 0,
    metric: str(o.metric, 240) ?? 'not stated',
    costBasis: str(o.costBasis, 240) ?? 'not stated',
  };
}

export function validateSnapshot(o: any): BenchSnapshot | undefined {
  if (!o || typeof o !== 'object' || typeof o.week !== 'string' || !WEEK_RE.test(o.week)) return undefined;
  if (!Array.isArray(o.sources) || !Array.isArray(o.rows)) return undefined;
  const sources = (o.sources as unknown[]).map(validateSource).filter((s): s is BenchSource => !!s);
  const ids = new Set(sources.map(s => s.id));
  const rows = (o.rows as unknown[]).map(r => validateRow(r)).filter((r): r is BenchRow => !!r && ids.has(r.source));
  const updatedAt = num(o.updatedAt);
  return { schema: BENCH_SCHEMA, week: o.week, capturedAt: num(o.capturedAt) ?? 0, ...(updatedAt ? { updatedAt } : {}), sources, rows };
}

const rowKey = (r: BenchRow) => `${r.source}\u0000${r.model}\u0000${r.effort ?? ''}\u0000${r.notes ?? ''}`;

/**
 * Merges a run into a week: the sources refreshed in this run replace their earlier rows; other sources of the
 * week are kept. `dropKinds` also removes every earlier source of those kinds that this run did not refresh
 * (manual files deleted since). Deterministic order, so rerunning with the same inputs gives the same rows.
 */
export function mergeSnapshot(prev: BenchSnapshot | undefined, week: string, updates: { source: BenchSource; rows: BenchRow[] }[], now: number, dropKinds: SourceKind[] = []): BenchSnapshot {
  const fresh = new Set(updates.map(u => u.source.id));
  const keptSources = (prev?.sources ?? []).filter(s => !fresh.has(s.id) && !dropKinds.includes(s.kind));
  const keptIds = new Set(keptSources.map(s => s.id));
  const rows = [...(prev?.rows ?? []).filter(r => keptIds.has(r.source)), ...updates.flatMap(u => u.rows.map(r => ({ ...r, source: u.source.id })))];
  const uniq = new Map<string, BenchRow>();
  for (const r of rows) uniq.set(rowKey(r), r);
  const sources = [...keptSources, ...updates.map(u => u.source)].sort((a, b) => a.id.localeCompare(b.id));
  return {
    schema: BENCH_SCHEMA,
    week,
    capturedAt: prev?.capturedAt || now,
    updatedAt: now,
    sources,
    rows: [...uniq.values()].sort((a, b) => a.source.localeCompare(b.source) || a.model.localeCompare(b.model) || (a.effort ?? '').localeCompare(b.effort ?? '') || (a.notes ?? '').localeCompare(b.notes ?? '')),
  };
}

// ---- vendor ------------------------------------------------------------------------------------------------

const VENDORS: [RegExp, string][] = [
  [/claude|anthropic|opus|sonnet|haiku/i, 'Anthropic'],
  [/gpt|openai|chatgpt|codex|(^|[^a-z0-9])o[1-9]([^0-9]|$)/i, 'OpenAI'],
  [/gemini|gemma|google|palm/i, 'Google'],
  [/deepseek/i, 'DeepSeek'],
  [/grok|xai/i, 'xAI'],
  [/qwen|alibaba/i, 'Alibaba'],
  [/llama|meta/i, 'Meta'],
  [/mistral|codestral|devstral|magistral/i, 'Mistral'],
  [/kimi|moonshot/i, 'Moonshot'],
  [/glm|zhipu|z\.ai/i, 'Zhipu'],
  [/command|cohere/i, 'Cohere'],
  [/nova|amazon/i, 'Amazon'],
  [/minimax/i, 'MiniMax'],
];

/** INFERRED vendor from a model name (keyword match); "Other" when nothing matches. */
export function inferVendor(model: string): string {
  for (const [re, v] of VENDORS) if (re.test(model)) return v;
  return 'Other';
}

// ---- public parsers ----------------------------------------------------------------------------------------

/** Minimal YAML for a flat list of flat maps ("- key: value" / "  key: value"). Anything else is ignored. */
export function parseYamlList(text: string): Record<string, string | number>[] {
  const out: Record<string, string | number>[] = [];
  let cur: Record<string, string | number> | undefined;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const m = /^(\s*)(-\s+)?([A-Za-z_][A-Za-z0-9_]*):(?:\s+(.*))?$/.exec(raw);
    if (!m) continue;
    if (m[2]) out.push((cur = {}));
    else if (!cur || !m[1]) continue;
    let v = (m[4] ?? '').trim();
    if (!/^["']/.test(v)) v = v.replace(/\s+#.*$/, '');
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) v = v.slice(1, -1);
    const n = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v) ? Number(v) : NaN;
    cur[m[3]] = Number.isFinite(n) ? n : v;
  }
  return out;
}

export interface SourceParser {
  id: string;
  name: string;
  url: string;
  license: string;
  metric: string;
  costBasis: string;
  parse(text: string): BenchRow[];
}

const nOf = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Aider polyglot leaderboard (polyglot_leaderboard.yml): one entry per benchmark run. */
export function parseAiderPolyglot(text: string, sourceId = 'aider-polyglot'): BenchRow[] {
  const rows: BenchRow[] = [];
  for (const e of parseYamlList(text)) {
    const model = typeof e.model === 'string' ? e.model : undefined;
    const score = nOf(e.pass_rate_2);
    if (!model || score === undefined) continue;
    const cases = nOf(e.test_cases);
    const cost = nOf(e.total_cost);
    const pt = nOf(e.prompt_tokens);
    const ct = nOf(e.completion_tokens);
    const r = validateRow({
      source: sourceId,
      model,
      score,
      scoreUnit: '% pass (2nd try)',
      // A total_cost of 0 is how the leaderboard records free / untracked runs: not a price, so left out.
      costPerTask: cases && cost && cost > 0 ? cost / cases : undefined,
      costUnit: 'USD',
      tokensPerTask: cases && pt !== undefined && ct !== undefined ? Math.round((pt + ct) / cases) : undefined,
      n: cases,
      effort: e.reasoning_effort,
      notes: [e.edit_format ? `edit format ${e.edit_format}` : '', e.date ? `run ${e.date}` : '', cost === 0 ? 'total_cost 0 recorded (cost left out)' : ''].filter(Boolean).join(' · '),
    });
    if (r) rows.push(r);
  }
  return rows;
}

export const PARSERS: Record<string, SourceParser> = {
  'aider-polyglot': {
    id: 'aider-polyglot',
    name: 'Aider polyglot',
    url: 'https://raw.githubusercontent.com/Aider-AI/aider/main/aider/website/_data/polyglot_leaderboard.yml',
    license: 'Apache-2.0 (Aider-AI/aider repository)',
    metric: 'pass_rate_2: % of the polyglot exercises (test_cases) solved within 2 tries, as recorded by the leaderboard',
    costBasis: 'DERIVED: total_cost / test_cases as recorded by the leaderboard (USD per exercise); total_cost 0 left out',
    parse: t => parseAiderPolyglot(t, 'aider-polyglot'),
  },
};

// ---- local workload ----------------------------------------------------------------------------------------

export const LOCAL_SOURCE_ID = 'local-workload';

/**
 * DERIVED rows from Agent's own dispatches, one per model [+ effort]: verified rate as the score, median tokens per
 * dispatch, n finished; median cost only when the user set a price for that model (agent.dispatch.pricePerMTok).
 */
export function localRows(ds: Dispatch[], prices: Record<string, unknown> = {}): BenchRow[] {
  const groups = new Map<string, Dispatch[]>();
  for (const d of ds) {
    if (!d.model) continue;
    const k = `${d.model}\u0000${d.effort ?? ''}`;
    const list = groups.get(k);
    if (list) list.push(d);
    else groups.set(k, [d]);
  }
  const rows: BenchRow[] = [];
  for (const list of groups.values()) {
    const g = groupStats(list, 'model', prices)[0];
    if (!g || g.verifiedRate === undefined) continue;
    const d0 = list[0];
    const model = d0.model as string;
    rows.push({
      source: LOCAL_SOURCE_ID,
      model,
      vendor: inferVendor(model),
      vendorInferred: true,
      ...(d0.effort ? { effort: d0.effort } : {}),
      score: Math.round(g.verifiedRate * 1000) / 10,
      scoreUnit: '% verified dispatches',
      ...(g.medCost !== undefined ? { costPerTask: g.medCost } : {}),
      costUnit: 'USD',
      ...(g.medTokens !== undefined ? { tokensPerTask: Math.round(g.medTokens) } : {}),
      n: g.finished,
      notes: `success ${Math.round((g.successRate ?? 0) * 100)}% · ${g.n} dispatches, ${g.finished} finished${g.medCost !== undefined ? ` · ${g.priced} priced` : ''}`,
    });
  }
  return rows.sort((a, b) => a.model.localeCompare(b.model) || (a.effort ?? '').localeCompare(b.effort ?? ''));
}

export function localSource(now: number, days: number, priced: boolean): BenchSource {
  return {
    id: LOCAL_SOURCE_ID,
    name: 'Local workload',
    kind: 'local',
    fetchedAt: now,
    metric: `DERIVED from your own dispatches of the last ${days} day(s): % of finished dispatches verified (no failure signal, and a passing test or a commit observed)`,
    costBasis: priced ? 'DERIVED from your setting agent.dispatch.pricePerMTok: median over dispatches of tokens / 1e6 × your price' : 'none: agent.dispatch.pricePerMTok not set',
  };
}

// ---- chart math --------------------------------------------------------------------------------------------

export interface Pt {
  /** Cost (log axis). */
  cost: number;
  /** Other axis value. */
  value: number;
}

/**
 * Indices of the Pareto frontier: no other point is at least as cheap and at least as good with one strictly better.
 * `higherBetter` false for metrics where less is better (tokens per task). Returned sorted by cost ascending.
 */
export function pareto(pts: Pt[], higherBetter = true): number[] {
  const better = (a: number, b: number) => (higherBetter ? a > b : a < b);
  const idx = pts.map((_, i) => i).filter(i => Number.isFinite(pts[i].cost) && pts[i].cost > 0 && Number.isFinite(pts[i].value));
  idx.sort((a, b) => pts[a].cost - pts[b].cost || (better(pts[a].value, pts[b].value) ? -1 : better(pts[b].value, pts[a].value) ? 1 : 0));
  const out: number[] = [];
  let best: number | undefined;
  for (const i of idx) {
    if (best === undefined || better(pts[i].value, best)) {
      out.push(i);
      best = pts[i].value;
    }
  }
  return out;
}

export interface Axis {
  min: number;
  max: number;
  ticks: number[];
}

/** Log axis covering [lo, hi] (positive) with 1-2-5 ticks from the data range (powers of ten only when wide). */
export function logTicks(lo: number, hi: number): Axis {
  if (!(lo > 0) || !(hi > 0)) return { min: 1, max: 10, ticks: [1, 10] };
  if (hi < lo) [lo, hi] = [hi, lo];
  const e0 = Math.floor(Math.log10(lo));
  let e1 = Math.ceil(Math.log10(hi));
  if (e1 <= e0) e1 = e0 + 1;
  const decades = e1 - e0;
  const steps = decades > 3 ? [1] : decades > 1 ? [1, 2, 5] : [1, 2, 3, 5];
  const all: number[] = [];
  for (let e = e0; e <= e1; e++) for (const s of steps) all.push(+(s * 10 ** e).toPrecision(6));
  const cand = all.filter(t => t <= 10 ** e1 * 1.0001);
  // Tighten to the data: one tick at or below the lowest value, one at or above the highest.
  const min = cand.filter(t => t <= lo * 1.0001).pop() ?? cand[0];
  const max = cand.find(t => t >= hi * 0.9999) ?? cand[cand.length - 1];
  const ticks = cand.filter(t => t >= min && t <= max);
  return max > min ? { min, max, ticks } : { min, max: min * 10, ticks: [min, min * 10] };
}

/** 0 … 1 along a log axis. */
export function logFrac(v: number, ax: Axis): number {
  const r = Math.log10(ax.max / ax.min);
  return r > 0 ? Math.min(1, Math.max(0, Math.log10(v / ax.min) / r)) : 0;
}

/** Linear axis with round ticks covering [lo, hi]. */
export function linTicks(lo: number, hi: number, count = 5): Axis {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { min: 0, max: 1, ticks: [0, 1] };
  if (hi < lo) [lo, hi] = [hi, lo];
  if (hi === lo) {
    hi = lo + 1;
    lo = Math.max(0, lo - 1);
  }
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(f => f * mag).find(s => s >= raw) ?? 10 * mag;
  const min = Math.floor(lo / step) * step;
  const max = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = min; v <= max + step * 1e-9; v += step) ticks.push(+v.toPrecision(12));
  return { min, max, ticks };
}

export function linFrac(v: number, ax: Axis): number {
  return ax.max > ax.min ? Math.min(1, Math.max(0, (v - ax.min) / (ax.max - ax.min))) : 0;
}

/** Dollar text for an axis tick or a cell: $0.003, $0.25, $1.5, $12, $1,200. */
export function usd(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '$0';
  const trim = (s: string) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);
  if (n < 0.01) return `$${trim(n.toPrecision(2))}`;
  if (n < 1) return `$${trim(n.toFixed(n < 0.1 ? 3 : 2))}`;
  if (n < 100) return `$${trim(n.toFixed(n < 10 ? 2 : 1))}`;
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

/** Normalised model id for loose matching ("Claude Opus 4.5" ~ "claude-opus-4-5-20251101"). */
export function normModel(m: string): string {
  return m.toLowerCase().replace(/\(.*?\)/g, '').replace(/[-_]?\d{8}\b/g, '').replace(/[^a-z0-9]+/g, '');
}

/** INFERRED: a benchmark row's model is one of the local models (normalised equality or containment). */
export function usedLocally(model: string, local: string[]): boolean {
  const m = normModel(model);
  if (m.length < 3) return false;
  return local.some(l => {
    const n = normModel(l);
    return n.length >= 3 && (n === m || n.includes(m) || m.includes(n));
  });
}

export interface TrendPoint {
  week: string;
  score: number;
  cost?: number;
}

/** Best score (and its cost) per model [+ effort] per week, oldest week first; `source` undefined = every source. */
export function trend(weeks: BenchSnapshot[], keep: (r: BenchRow) => boolean = () => true): Map<string, TrendPoint[]> {
  const out = new Map<string, TrendPoint[]>();
  for (const w of [...weeks].sort((a, b) => a.week.localeCompare(b.week))) {
    const best = new Map<string, BenchRow>();
    for (const r of w.rows) {
      if (!keep(r)) continue;
      const k = trendKey(r);
      const b = best.get(k);
      if (!b || r.score > b.score) best.set(k, r);
    }
    for (const [k, r] of best) {
      const list = out.get(k) ?? [];
      list.push({ week: w.week, score: r.score, ...(r.costPerTask !== undefined ? { cost: r.costPerTask } : {}) });
      out.set(k, list);
    }
  }
  return out;
}

export const trendKey = (r: BenchRow) => `${r.model}${r.effort ? ` · ${r.effort}` : ''} [${r.source}]`;
