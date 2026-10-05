// Usage limits: Codex rate-limit windows as the rollout records them (OBSERVED), and Claude 5-hour blocks
// derived from per-call tokens like ccusage does (DERIVED). Claude Code records no limit: every comparison is
// against the user's own past blocks (INFERRED), never an official quota. Pure functions, no I/O.
import type { AgentSessionSnapshot, RateLimits, RateWindow } from '../model';

const MIN = 60_000;
const HOUR = 60 * MIN;
export const BLOCK_MS = 5 * HOUR;
export const BURN_WINDOW_MS = 15 * MIN;
/** Projection uses a longer, smoother rate so a short burst does not dominate (DERIVED). */
export const PROJ_WINDOW_MS = 60 * MIN;
/** Alerts on the projection only once the block has this much history. */
export const SETTLE_MS = 30 * MIN;

// ---------------------------------------------------------------- Codex

function num(x: unknown): number | undefined {
  return typeof x === 'number' && Number.isFinite(x) ? x : undefined;
}

function window(raw: unknown, at: number): RateWindow | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const used = num(r.used_percent);
  if (used === undefined || used < 0) return undefined;
  const w: RateWindow = { usedPercent: Math.min(used, 1000) };
  const wm = num(r.window_minutes);
  if (wm !== undefined && wm > 0) w.windowMinutes = wm;
  const ra = num(r.resets_at);
  const rin = num(r.resets_in_seconds);
  if (ra !== undefined && ra > 0) w.resetsAt = ra > 1e12 ? ra : ra * 1000; // seconds (current) or ms
  else if (rin !== undefined && rin >= 0) w.resetsAt = at + rin * 1000;
  return w;
}

/** `event_msg.token_count.rate_limits` → RateLimits, or undefined when nothing usable is recorded. */
export function parseRateLimits(raw: unknown, at: number): RateLimits | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const primary = window(r.primary, at);
  const secondary = window(r.secondary, at);
  if (!primary && !secondary) return undefined;
  const out: RateLimits = { at };
  if (primary) out.primary = primary;
  if (secondary) out.secondary = secondary;
  if (typeof r.plan_type === 'string' && /^[\w.-]{1,60}$/.test(r.plan_type)) out.planType = r.plan_type;
  return out;
}

export type WindowKind = '5h' | 'weekly' | 'other';

/** Which window a sample describes: by its recorded length (older rollouts: primary 300 + secondary 10080; newer: weekly only). */
export function windowKind(w: RateWindow, slot: 'primary' | 'secondary'): WindowKind {
  const m = w.windowMinutes;
  if (m === undefined) return slot === 'primary' ? '5h' : 'weekly';
  if (m <= 6 * 60) return '5h';
  if (m >= 6 * 1440 && m <= 8 * 1440) return 'weekly';
  return 'other';
}

export interface CodexGauge {
  kind: WindowKind;
  usedPercent: number;
  windowMinutes?: number;
  resetsAt?: number;
  /** When the sample was recorded and by which session. */
  at: number;
  sessionKey: string;
  /** The reset time passed since the sample: the window has restarted, the % is no longer current. */
  stale: boolean;
}

export interface CodexLimits {
  gauges: Partial<Record<WindowKind, CodexGauge>>;
  planType?: string;
  at?: number;
  /** Used % over time per window kind, merged from every session's history (sorted by time). */
  trend: Partial<Record<WindowKind, [number, number][]>>;
}

/** Latest Codex rate-limit sample across sessions, split by window, plus the used-% trend since `since`. */
export function codexLimits(sessions: AgentSessionSnapshot[], now: number, since = now - 7 * 24 * HOUR): CodexLimits {
  const out: CodexLimits = { gauges: {}, trend: {} };
  const trend: Partial<Record<WindowKind, [number, number][]>> = {};
  for (const s of sessions) {
    const rl = s.provider === 'codex' ? s.facts?.rateLimits : undefined;
    if (!rl) continue;
    if (out.at === undefined || rl.at > out.at) {
      out.at = rl.at;
      out.planType = rl.planType;
    }
    // Latest sample per window kind (a newer rollout may record the weekly window only).
    for (const slot of ['primary', 'secondary'] as const) {
      const w = rl[slot];
      if (!w) continue;
      const kind = windowKind(w, slot);
      const cur = out.gauges[kind];
      if (cur && cur.at >= rl.at) continue;
      out.gauges[kind] = { kind, usedPercent: w.usedPercent, windowMinutes: w.windowMinutes, resetsAt: w.resetsAt, at: rl.at, sessionKey: s.key, stale: w.resetsAt !== undefined && w.resetsAt <= now };
    }
    for (const [at, p, q] of rl.history ?? []) {
      if (at < since) continue;
      if (p !== null) (trend['5h'] ??= []).push([at, p]);
      if (q !== null) (trend.weekly ??= []).push([at, q]);
    }
  }
  for (const k of Object.keys(trend) as WindowKind[]) out.trend[k] = trend[k]!.sort((a, b) => a[0] - b[0]);
  return out;
}

/** Highest current (not stale) Codex used %, or undefined. */
export function codexPeak(sessions: AgentSessionSnapshot[], now: number): number | undefined {
  const g = Object.values(codexLimits(sessions, now, now).gauges).filter(x => x && !x.stale) as CodexGauge[];
  return g.length ? Math.max(...g.map(x => x.usedPercent)) : undefined;
}

// ---------------------------------------------------------------- Claude 5-hour blocks

export interface Call {
  at: number;
  tokens: number;
  output: number;
}

export interface Block {
  /** Floored to the hour of the first call. */
  start: number;
  /** start + 5 h. */
  end: number;
  firstAt: number;
  lastAt: number;
  tokens: number;
  output: number;
  calls: number;
  /** now < end and the last call is less than 5 h old (ccusage rule). */
  active: boolean;
}

/** Every recorded Claude model call ([at, prompt, output]) across sessions, oldest first. */
export function claudeCalls(sessions: AgentSessionSnapshot[]): Call[] {
  const out: Call[] = [];
  for (const s of sessions) {
    if (s.provider !== 'claude') continue;
    for (const [at, p, o] of s.facts?.calls ?? []) if (at > 0) out.push({ at, tokens: p + o, output: o });
  }
  return out.sort((a, b) => a.at - b.at);
}

export function floorHour(t: number): number {
  return Math.floor(t / HOUR) * HOUR;
}

/**
 * ccusage-style blocks: a block starts at the first call (floored to the UTC hour) and lasts 5 h; a call after the
 * block's end, or after a gap ≥ 5 h since the previous call, starts a new block.
 */
export function blocks(calls: Call[], now: number): Block[] {
  const out: Block[] = [];
  let cur: Block | undefined;
  for (const c of calls) {
    if (!cur || c.at >= cur.end || c.at - cur.lastAt >= BLOCK_MS) {
      const start = floorHour(c.at);
      cur = { start, end: start + BLOCK_MS, firstAt: c.at, lastAt: c.at, tokens: 0, output: 0, calls: 0, active: false };
      out.push(cur);
    }
    cur.lastAt = c.at;
    cur.tokens += c.tokens;
    cur.output += c.output;
    cur.calls++;
  }
  for (const b of out) b.active = now < b.end && now - b.lastAt < BLOCK_MS;
  return out;
}

/** p-th percentile (nearest rank), undefined for an empty list. */
export function percentile(values: number[], p: number): number | undefined {
  if (!values.length) return undefined;
  const v = [...values].sort((a, b) => a - b);
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1))];
}

export interface BlockNow {
  block: Block;
  /** Tokens per minute over the last 15 min of calls (or since the first call if the block is younger). */
  burnPerMin: number;
  burnOutputPerMin: number;
  /** tokens + burn × minutes left. */
  projected: number;
  projectedOutput: number;
  msLeft: number;
  /** Block old enough for its projection to be meaningful (≥ 30 min since its first call). */
  settled: boolean;
}

export interface ClaudeLimits {
  blocks: Block[];
  current?: BlockNow;
  /** Over finished blocks only (the current one excluded). */
  past: { n: number; max?: number; p90?: number; maxOutput?: number; p90Output?: number; median?: number };
}

export function currentBlock(b: Block, calls: Call[], now: number): BlockNow {
  const from = Math.max(now - BURN_WINDOW_MS, b.firstAt);
  const mins = Math.max(1, (now - from) / MIN);
  let t = 0, o = 0;
  for (const c of calls) if (c.at >= from && c.at <= now && c.at >= b.start && c.at < b.end) {
    t += c.tokens;
    o += c.output;
  }
  const msLeft = Math.max(0, b.end - now);
  const burn = t / mins, burnO = o / mins;
  // Projection rate: average over the last 60 min of the block (at least 15 min of span).
  const pFrom = Math.max(now - PROJ_WINDOW_MS, b.firstAt);
  const pMins = Math.max(15, (now - pFrom) / MIN);
  let pt = 0, po = 0;
  for (const c of calls) if (c.at >= pFrom && c.at <= now && c.at >= b.start && c.at < b.end) {
    pt += c.tokens;
    po += c.output;
  }
  return { block: b, burnPerMin: burn, burnOutputPerMin: burnO, projected: Math.round(b.tokens + (pt / pMins) * (msLeft / MIN)), projectedOutput: Math.round(b.output + (po / pMins) * (msLeft / MIN)), msLeft, settled: now - b.firstAt >= SETTLE_MS };
}

export function claudeLimits(sessions: AgentSessionSnapshot[], now: number): ClaudeLimits {
  const calls = claudeCalls(sessions);
  const bl = blocks(calls, now);
  const active = bl.find(b => b.active);
  const done = bl.filter(b => !b.active);
  const tok = done.map(b => b.tokens), out = done.map(b => b.output);
  return {
    blocks: bl,
    current: active && currentBlock(active, calls, now),
    past: { n: done.length, max: tok.length ? Math.max(...tok) : undefined, p90: percentile(tok, 90), median: percentile(tok, 50), maxOutput: out.length ? Math.max(...out) : undefined, p90Output: percentile(out, 90) },
  };
}

// ---------------------------------------------------------------- thresholds

export interface Thresholds {
  warn: number;
  alert: number;
}

export function thresholds(config?: <T>(key: string, fallback: T) => T): Thresholds {
  const pick = (k: string, d: number) => {
    const v = config?.<unknown>(`agent.limits.${k}`, d);
    return typeof v === 'number' && v > 0 && v <= 100 ? v : d;
  };
  const warn = pick('warnPercent', 70);
  const alert = Math.max(warn, pick('alertPercent', 90));
  return { warn, alert };
}

export type Level = 'ok' | 'warn' | 'alert';
export function level(pct: number, t: Thresholds): Level {
  return pct >= t.alert ? 'alert' : pct >= t.warn ? 'warn' : 'ok';
}
