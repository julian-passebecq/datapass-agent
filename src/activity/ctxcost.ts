// Context cost: how much each tool / method puts back into the agent's context, from the recorded size of tool
// results (facts.toolResultChars: characters only, the content is never kept). Pure functions of snapshots.
// Evidence: characters and call counts are OBSERVED; medians, p90 and shares are DERIVED from the recorded sizes;
// tokens are INFERRED as chars / 4 (no tokenizer, no provider count per tool result).
import type { AgentSessionSnapshot, ToolResultSize } from '../model';
import { inPeriod, Period, periodStart } from './explore';

export const CHARS_PER_TOKEN = 4;
export const GROUPS = ['tool', 'provider', 'repo'] as const;
export type CtxGroup = (typeof GROUPS)[number];
export const METRICS = ['p50', 'p90', 'total'] as const;
export type CtxMetric = (typeof METRICS)[number];
/** A single result at least this large (tokens, ≈) is called out in the tips. */
export const BIG_RESULT_TOKENS = 20_000;

export const tokensOf = (chars: number) => chars / CHARS_PER_TOKEN;

/** Display name of a recorded tool name: MCP tools grouped by server, Claude subagent calls named as such. */
export function toolLabel(name: string): string {
  if (name.startsWith('mcp__')) return `MCP ${name.split('__')[1] || 'server'}`;
  if (name === 'Task' || name === 'Agent') return 'Task (subagent result)';
  return name;
}

export interface CtxRow {
  key: string;
  label: string;
  /** Providers that contributed (for colour and the tool×provider split). */
  providers: string[];
  sessions: number;
  /** OBSERVED: result count and characters in the period. */
  calls: number;
  chars: number;
  maxChars: number;
  /** DERIVED from the recorded samples (latest 200 results per tool per session). */
  samples: number;
  p50Chars?: number;
  p90Chars?: number;
  /** Count of sampled results ≥ BIG_RESULT_TOKENS (≈). */
  big: number;
  /** True when some session had more results in the period than samples kept (totals then undercount). */
  partial: boolean;
  /** DERIVED: chars / all chars of the period. */
  share: number;
}

export interface CtxCost {
  rows: CtxRow[];
  totalChars: number;
  totalCalls: number;
  /** Sessions in the period, and those without any recorded tool-result size (UNKNOWN for this screen). */
  sessions: number;
  withoutData: number;
  partial: boolean;
}

/** Percentile (0–1) by nearest rank over a sorted copy. */
export function percentile(values: number[], q: number): number | undefined {
  if (!values.length) return undefined;
  const s = values.slice().sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
  return s[i];
}

interface Acc {
  key: string;
  label: string;
  providers: Set<string>;
  sessions: Set<string>;
  calls: number;
  chars: number;
  max: number;
  values: number[];
  partial: boolean;
}

function keyOf(group: CtxGroup, s: AgentSessionSnapshot, tool: string, repoOf: (s: AgentSessionSnapshot) => string): [string, string] {
  const label = toolLabel(tool);
  if (group === 'repo') return [`repo:${repoOf(s)}`, repoOf(s)];
  if (group === 'provider') return [`${label}|${s.provider}`, `${label} · ${s.provider === 'claude' ? 'Claude' : 'Codex'}`];
  return [label, label];
}

/** One session's contribution of one tool to the period: whole record when the session started inside it, else timed samples. */
function slice(s: AgentSessionSnapshot, r: ToolResultSize, since: number): { calls: number; chars: number; max: number; values: number[]; partial: boolean } {
  const all = since === -Infinity || (s.startedAt !== undefined && s.startedAt >= since);
  const inside = all ? r.samples : r.samples.filter(([at]) => at >= since);
  const values = inside.map(x => x[1]);
  if (all) return { calls: r.calls, chars: r.chars, max: r.max, values, partial: false };
  return { calls: values.length, chars: values.reduce((a, b) => a + b, 0), max: values.length ? Math.max(...values) : 0, values, partial: r.calls > r.samples.length };
}

export function ctxCost(
  sessions: AgentSessionSnapshot[],
  o: { period: Period; now: number; group: CtxGroup; repoOf: (s: AgentSessionSnapshot) => string },
): CtxCost {
  const since = periodStart(o.period, o.now);
  const list = inPeriod(sessions, { period: o.period, now: o.now });
  const by = new Map<string, Acc>();
  let withoutData = 0;
  for (const s of list) {
    const trc = s.facts?.toolResultChars;
    if (!trc || !Object.keys(trc).length) {
      withoutData++;
      continue;
    }
    for (const [tool, r] of Object.entries(trc)) {
      if (!r || typeof r.calls !== 'number' || !Array.isArray(r.samples)) continue;
      const part = slice(s, r, since);
      if (!part.calls) continue;
      const [key, label] = keyOf(o.group, s, tool, o.repoOf);
      let a = by.get(key);
      if (!a) by.set(key, (a = { key, label, providers: new Set(), sessions: new Set(), calls: 0, chars: 0, max: 0, values: [], partial: false }));
      a.providers.add(s.provider);
      a.sessions.add(s.key);
      a.calls += part.calls;
      a.chars += part.chars;
      if (part.max > a.max) a.max = part.max;
      for (const v of part.values) a.values.push(v);
      a.partial ||= part.partial;
    }
  }
  const totalChars = [...by.values()].reduce((n, a) => n + a.chars, 0);
  const bigChars = BIG_RESULT_TOKENS * CHARS_PER_TOKEN;
  const rows: CtxRow[] = [...by.values()].map(a => ({
    key: a.key,
    label: a.label,
    providers: [...a.providers].sort(),
    sessions: a.sessions.size,
    calls: a.calls,
    chars: a.chars,
    maxChars: a.max,
    samples: a.values.length,
    p50Chars: percentile(a.values, 0.5),
    p90Chars: percentile(a.values, 0.9),
    big: a.values.filter(v => v >= bigChars).length,
    partial: a.partial,
    share: totalChars ? a.chars / totalChars : 0,
  }));
  return {
    rows,
    totalChars,
    totalCalls: rows.reduce((n, r) => n + r.calls, 0),
    sessions: list.length,
    withoutData,
    partial: rows.some(r => r.partial),
  };
}

/** Value of a row for a metric, in characters. */
export function metricChars(r: CtxRow, m: CtxMetric): number | undefined {
  return m === 'p50' ? r.p50Chars : m === 'p90' ? r.p90Chars : r.chars;
}

/** Rows sorted by the metric, largest first; rows without a value last. */
export function sortRows(rows: CtxRow[], m: CtxMetric): CtxRow[] {
  return rows.slice().sort((a, b) => (metricChars(b, m) ?? -1) - (metricChars(a, m) ?? -1) || b.chars - a.chars || a.label.localeCompare(b.label));
}

/** Log-scale axis (powers of ten, in tokens) covering every positive value and the reference line. */
export function logAxis(values: number[], ref?: number): { lo: number; hi: number; ticks: number[] } {
  const pos = values.filter(v => v > 0);
  if (ref && ref > 0) pos.push(ref);
  if (!pos.length) return { lo: 0, hi: 1, ticks: [1, 10] };
  const lo = Math.floor(Math.log10(Math.max(1, Math.min(...pos))));
  const hi = Math.max(lo + 1, Math.ceil(Math.log10(Math.max(...pos)) + 1e-9));
  const ticks: number[] = [];
  for (let e = lo; e <= hi; e++) ticks.push(10 ** e);
  return { lo, hi, ticks };
}

/** Position 0–100 % of a value (tokens) on the log axis; values ≤ 1 sit at the left edge. */
export function logPos(v: number, ax: { lo: number; hi: number }): number {
  if (v <= 0) return 0;
  const p = ((Math.log10(Math.max(v, 10 ** ax.lo)) - ax.lo) / Math.max(1e-9, ax.hi - ax.lo)) * 100;
  return Math.min(100, Math.max(0, p));
}

/** "N× the smallest": value / smallest positive value among the shown rows. */
export function timesSmallest(v: number | undefined, smallest: number | undefined): number | undefined {
  if (v === undefined || !smallest || smallest <= 0 || v <= 0) return undefined;
  return v / smallest;
}

/** One data-only hint per row (no judgement beyond thresholds stated in the text), or '' when nothing stands out. */
export function tip(r: CtxRow, window: number): string {
  const tk = (c: number) => Math.round(tokensOf(c));
  if (r.big > 0) return `${r.big} result${r.big > 1 ? 's' : ''} ≥ ${fmt(BIG_RESULT_TOKENS)} tokens (≈) · largest ≈ ${fmt(tk(r.maxChars))}${tokensOf(r.maxChars) >= window ? ' · bigger than the context window' : ''}`;
  if (r.p50Chars && r.p90Chars && r.samples >= 5 && r.p90Chars >= 5 * r.p50Chars) return `spiky: p90 is ${Math.round(r.p90Chars / r.p50Chars)}× the median`;
  if (r.share >= 0.3) return `${Math.round(r.share * 100)} % of all tool-result context in the period`;
  return '';
}

/** Token count: 950, 12.5k, 272k, 1.2M. */
export function fmt(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1e5) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
  if (n < 1e6) return `${Math.round(n / 1e3)}k`;
  return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
}
