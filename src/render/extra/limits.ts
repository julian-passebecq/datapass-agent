// Add-on screen "Limits": Codex rate-limit gauges (5 h / weekly used %, reset countdown, trend) as recorded in
// rollouts, and Claude 5-hour blocks derived from per-call tokens (ccusage rule) compared with the user's own past
// blocks. Claude Code records no limit: nothing here claims an official quota. Logic in src/activity/limits.ts.
import { duration } from '../../activity/activity';
import { compact } from '../../activity/insights';
import {
  Block, claudeLimits, ClaudeLimits, CodexGauge, codexLimits, CodexLimits, codexPeak, level, Level, thresholds, Thresholds, WindowKind,
} from '../../activity/limits';
import { esc } from '../html';
import type { WsData, WsState } from '../workspace';
import { kpi } from '../workspace';
import { ExtraView, opt, seg, toolbar } from './kit';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const KIND_LABEL: Record<WindowKind, string> = { '5h': '5-hour window', weekly: 'Weekly window', other: 'Other window' };
const EV: Record<string, string> = {
  OBSERVED: 'OBSERVED: read from the provider artifact as recorded.',
  DERIVED: 'DERIVED: computed deterministically from recorded values.',
  INFERRED: 'INFERRED: a heuristic or comparison with your own history, not a provider fact.',
};

function ev(kind: 'OBSERVED' | 'DERIVED' | 'INFERRED', basis: string): string {
  return `<span class="lm-ev ${kind}" title="${esc(`${EV[kind]} ${basis}`)}">${kind.toLowerCase()}</span>`;
}

function hm(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function dayHm(t: number, now: number): string {
  const d = new Date(t);
  const same = new Date(now).toDateString() === d.toDateString();
  return same ? hm(t) : `${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })} ${hm(t)}`;
}

function levelCls(l: Level): string {
  return l === 'alert' ? 'lm-bad' : l === 'warn' ? 'lm-warn' : 'lm-ok';
}

// ---------------------------------------------------------------- Codex

function spark(points: [number, number][], from: number, to: number, t: Thresholds): string {
  if (points.length < 2) return '<div class="muted lm-note">Not enough samples for a trend yet.</div>';
  const W = 320, H = 46;
  const x = (at: number) => ((at - from) / Math.max(1, to - from)) * W;
  const y = (p: number) => H - (Math.min(100, Math.max(0, p)) / 100) * H;
  const d = points.map(([at, p], i) => `${i ? 'L' : 'M'}${x(at).toFixed(1)},${y(p).toFixed(1)}`).join(' ');
  const line = (p: number, cls: string) => `<line class="${cls}" x1="0" x2="${W}" y1="${y(p).toFixed(1)}" y2="${y(p).toFixed(1)}"/>`;
  return `<svg class="lm-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="used percent over time">${line(t.warn, 'lm-tw')}${line(t.alert, 'lm-ta')}<path d="${d}"/></svg>`;
}

function gauge(g: CodexGauge | undefined, kind: WindowKind, cx: CodexLimits, d: WsData, t: Thresholds): string {
  if (!g) {
    return `<div class="lm-g lm-none"><div class="lm-gh"><b>${esc(KIND_LABEL[kind])}</b></div><div class="muted lm-note">Not recorded by the Codex version in the loaded rollouts${kind === '5h' ? ' (newer rollouts carry the weekly window only)' : ''}.</div></div>`;
  }
  const pct = g.stale ? 0 : g.usedPercent;
  const lv = level(pct, t);
  const reset = g.resetsAt !== undefined ? (g.stale ? `reset at ${dayHm(g.resetsAt, d.now)} (passed)` : `resets in ${duration(g.resetsAt - d.now)} · ${dayHm(g.resetsAt, d.now)}`) : 'reset time not recorded';
  const span = g.kind === 'weekly' ? 7 * DAY : 5 * HOUR;
  const pts = cx.trend[kind] ?? [];
  const from = d.now - (g.kind === 'weekly' ? 7 * DAY : DAY);
  return `<div class="lm-g ${levelCls(lv)}">
<div class="lm-gh"><b>${esc(KIND_LABEL[kind])}</b>${g.windowMinutes ? `<span class="muted">${esc(duration(g.windowMinutes * MIN))}</span>` : ''}${ev('OBSERVED', `token_count.rate_limits used_percent / resets_at, sample at ${new Date(g.at).toLocaleString()} from ${g.sessionKey}`)}</div>
<div class="lm-big">${g.stale ? '<span class="muted">reset</span>' : `${esc(pct.toFixed(pct < 10 ? 1 : 0))}<small>%</small>`}</div>
<div class="lm-bar" title="${esc(`${pct.toFixed(1)} % used · warn ${t.warn} % · alert ${t.alert} %`)}"><i style="width:${Math.min(100, pct).toFixed(1)}%"></i><s style="left:${t.warn}%"></s><s style="left:${t.alert}%"></s></div>
<div class="lm-gl">${esc(reset)}</div>
<div class="lm-gl muted">sample ${esc(duration(d.now - g.at))} ago${g.stale ? ' · window restarted since' : ''}${g.resetsAt !== undefined && !g.stale ? ` · ${esc(((1 - (g.resetsAt - d.now) / span) * 100).toFixed(0))} % of the window elapsed` : ''}</div>
<div class="lm-tr"><span class="muted">Trend · ${g.kind === 'weekly' ? '7 d' : '24 h'}</span>${spark(pts.filter(p => p[0] >= from), from, d.now, t)}</div>
</div>`;
}

function codexSection(cx: CodexLimits, d: WsData, t: Thresholds): string {
  let h = `<h2>Codex · rate limits ${cx.planType ? `<span class="muted lm-plan">plan ${esc(cx.planType)}</span>` : ''}</h2>`;
  if (cx.at === undefined) return h + '<div class="muted lm-note">No Codex rollout in the loaded history records <code>rate_limits</code>.</div>';
  h += `<div class="lm-gs">${gauge(cx.gauges['5h'], '5h', cx, d, t)}${gauge(cx.gauges.weekly, 'weekly', cx, d, t)}${cx.gauges.other ? gauge(cx.gauges.other, 'other', cx, d, t) : ''}</div>`;
  return h;
}

// ---------------------------------------------------------------- Claude

function cmpLine(v: number, ref: number | undefined, label: string): string {
  if (!ref) return '';
  return `<div class="lm-cmp"><span>${esc(label)}</span><span class="lm-bar sm"><i style="width:${Math.min(100, (v / ref) * 100).toFixed(1)}%"></i></span><b>${esc(((v / ref) * 100).toFixed(0))} %</b></div>`;
}

function claudeCard(cl: ClaudeLimits, d: WsData, t: Thresholds, basis: 'all' | 'output'): string {
  const c = cl.current;
  const p = cl.past;
  if (!c) {
    const last = cl.blocks[cl.blocks.length - 1];
    return `<div class="lm-cb"><div class="lm-gh"><b>Current 5-hour block</b>${ev('DERIVED', 'blocks from recorded per-call tokens')}</div><div class="muted lm-note">No active block${last ? ` · last block ended ${esc(dayHm(last.end, d.now))} (${esc(compact(last.tokens))} tokens)` : ''}.</div></div>`;
  }
  const b = c.block;
  const v = basis === 'output' ? b.output : b.tokens;
  const proj = basis === 'output' ? c.projectedOutput : c.projected;
  const burn = basis === 'output' ? c.burnOutputPerMin : c.burnPerMin;
  const ref = basis === 'output' ? p.maxOutput : p.max;
  const p90 = basis === 'output' ? p.p90Output : p.p90;
  const lv: Level = ref ? level((proj / ref) * 100, t) : 'ok';
  const ofMax = ref ? `${((proj / ref) * 100).toFixed(0)} % of your largest past block` : 'no past block to compare';
  return `<div class="lm-cb ${levelCls(lv)}">
<div class="lm-gh"><b>Current 5-hour block</b><span class="muted">${esc(hm(b.start))}–${esc(hm(b.end))}</span>${ev('DERIVED', 'ccusage rule: block starts at the first call floored to the hour, lasts 5 h; a gap ≥ 5 h starts a new one')}</div>
<div class="kpis">${kpi(compact(v), basis === 'output' ? 'Output tokens' : 'Tokens', '', 'sum of recorded prompt (incl. cache) + output tokens of Claude calls in this block')}${kpi(b.calls, 'Calls')}${kpi(`${compact(Math.round(burn))}/min`, 'Burn · 15 min', '', 'DERIVED: tokens of calls in the last 15 minutes ÷ minutes')}${kpi(compact(proj), 'Projected at end', levelCls(lv), 'INFERRED: current + burn × minutes left; assumes the last 15 min rate continues')}${kpi(duration(c.msLeft), 'Ends in', '', `block ends at ${new Date(b.end).toLocaleTimeString()}`)}</div>
<div class="lm-gl">${esc(ofMax)} ${ev('INFERRED', `compared with ${p.n} finished block(s) in the loaded history; Claude Code records no official limit`)}</div>
${cmpLine(proj, p90, 'Projected vs your p90')}${cmpLine(proj, ref, 'Projected vs your max')}${cmpLine(v, ref, 'So far vs your max')}
</div>`;
}

function historyBars(cl: ClaudeLimits, d: WsData, orient: string, basis: 'all' | 'output'): string {
  const from = d.now - 7 * DAY;
  const bl = cl.blocks.filter(b => b.end > from);
  if (!bl.length) return '<div class="muted lm-note">No Claude call with tokens in the last 7 days of the loaded history.</div>';
  const val = (b: Block) => (basis === 'output' ? b.output : b.tokens);
  const max = Math.max(...bl.map(val), 1);
  const p90 = basis === 'output' ? cl.past.p90Output : cl.past.p90;
  const tip = (b: Block) => `${new Date(b.start).toLocaleString()} → ${hm(b.end)} · ${compact(b.tokens)} tokens (${compact(b.output)} output) · ${b.calls} calls · first ${hm(b.firstAt)}, last ${hm(b.lastAt)}${b.active ? ' · active' : ''}`;
  const cls = (b: Block) => (b.active ? 'lm-act' : '');
  if (orient === 'vertical') {
    const p = p90 ? `<s class="lm-p90" style="bottom:${((p90 / max) * 100).toFixed(1)}%" title="your p90 block ${esc(compact(p90))}"></s>` : '';
    return `<div class="lm-vb">${p}${bl.map(b => `<div class="lm-vc ${cls(b)}" title="${esc(tip(b))}"><i style="height:${((val(b) / max) * 100).toFixed(1)}%"></i><span>${esc(new Date(b.start).toLocaleDateString(undefined, { weekday: 'narrow' }))}${esc(String(new Date(b.start).getHours()))}</span></div>`).join('')}</div>`;
  }
  return `<div class="lm-hb">${bl.slice().reverse().map(b => `<div class="lm-hr ${cls(b)}" title="${esc(tip(b))}"><span class="lm-hl">${esc(dayHm(b.start, d.now))}</span><span class="lm-ht"><i style="width:${((val(b) / max) * 100).toFixed(1)}%"></i>${p90 ? `<s style="left:${((p90 / max) * 100).toFixed(1)}%"></s>` : ''}</span><b>${esc(compact(val(b)))}</b><span class="muted">${b.calls} calls</span></div>`).join('')}</div>`;
}

function claudeSection(cl: ClaudeLimits, d: WsData, st: WsState, t: Thresholds): string {
  const basis = opt(st, 'limits.basis', 'all') === 'output' ? 'output' : 'all';
  const orient = opt(st, 'limits.orient', 'horizontal') === 'vertical' ? 'vertical' : 'horizontal';
  let h = `<h2>Claude Code · 5-hour blocks ${ev('DERIVED', 'Claude Code records no rate limit; blocks are rebuilt from per-call tokens across all loaded Claude sessions and workers')}</h2>`;
  h += toolbar(seg(st, 'limits.basis', [['all', 'All tokens'], ['output', 'Output only']], 'all', 'Token basis'), seg(st, 'limits.orient', [['horizontal', 'Horizontal'], ['vertical', 'Vertical']], 'horizontal', 'Block history orientation'));
  h += claudeCard(cl, d, t, basis);
  const p = cl.past;
  h += `<div class="lm-gl muted">Your past blocks: ${p.n}${p.max ? ` · max ${esc(compact(basis === 'output' ? p.maxOutput ?? 0 : p.max))} · p90 ${esc(compact((basis === 'output' ? p.p90Output : p.p90) ?? 0))} · median ${esc(compact(p.median ?? 0))} (all tokens)` : ''} ${ev('INFERRED', 'percentiles over finished blocks in the loaded history (per-session calls are capped at the latest 2000)')}</div>`;
  h += `<h3>Blocks · last 7 days</h3>${historyBars(cl, d, orient, basis)}`;
  return h;
}

// ---------------------------------------------------------------- alerts + screen

function alerts(cx: CodexLimits, cl: ClaudeLimits, t: Thresholds): string {
  const out: string[] = [];
  for (const g of Object.values(cx.gauges)) {
    if (!g || g.stale) continue;
    const lv = level(g.usedPercent, t);
    if (lv !== 'ok') out.push(`<div class="lm-al ${levelCls(lv)}"><b>${lv === 'alert' ? 'Alert' : 'Warning'}</b> Codex ${esc(KIND_LABEL[g.kind].toLowerCase())} at ${esc(g.usedPercent.toFixed(0))} % (threshold ${lv === 'alert' ? t.alert : t.warn} %) ${ev('OBSERVED', 'token_count.rate_limits')}</div>`);
  }
  const c = cl.current;
  // Only when the block is settled and there is enough history to compare with (≥ 5 past blocks).
  if (c && c.settled && cl.past.max && cl.past.n >= 5) {
    const pct = (c.projected / cl.past.max) * 100;
    const lv = level(pct, t);
    if (lv !== 'ok') out.push(`<div class="lm-al ${levelCls(lv)}"><b>${lv === 'alert' ? 'Alert' : 'Warning'}</b> Claude block projected at ${esc(pct.toFixed(0))} % of your largest past block ${ev('INFERRED', 'projection (60-min average rate) vs your own past blocks, not an official limit')}</div>`);
  }
  return out.join('');
}

function render(d: WsData, st: WsState): string {
  const t = thresholds(d.config);
  const cx = codexLimits(d.sessions, d.now);
  const cl = claudeLimits(d.sessions, d.now);
  let h = `<div class="lm">`;
  h += `<div class="lm-gl muted">Thresholds: warn ${t.warn} % · alert ${t.alert} % (settings <code>agent.limits.warnPercent</code> / <code>agent.limits.alertPercent</code>).</div>`;
  h += alerts(cx, cl, t);
  h += codexSection(cx, d, t);
  h += claudeSection(cl, d, st, t);
  return h + '</div>';
}

const CSS = `
.lm h2 { display: flex; gap: 8px; align-items: center; }
.lm h3 { font-size: 12px; margin: 12px 0 4px; }
.lm-note { font-size: 11px; margin: 4px 0; }
.lm-plan { font-size: 11px; font-weight: normal; }
.lm-ev { font-size: 9px; text-transform: uppercase; letter-spacing: .04em; border: 1px solid var(--line); border-radius: 3px; padding: 0 4px; color: var(--vscode-descriptionForeground); cursor: help; }
.lm-ev.OBSERVED { border-color: var(--ok); }
.lm-ev.DERIVED { border-color: var(--accent); }
.lm-ev.INFERRED { border-color: var(--warn); border-style: dashed; }
.lm-gs { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px; }
.lm-g, .lm-cb { border: 1px solid var(--line); border-left: 3px solid var(--lmc, var(--ok)); border-radius: 4px; padding: 8px 10px; background: var(--raise); }
.lm-none { --lmc: var(--line); }
.lm-ok { --lmc: var(--ok); }
.lm-warn { --lmc: var(--warn); }
.lm-bad { --lmc: var(--bad); }
.lm-gh { display: flex; gap: 8px; align-items: center; margin-bottom: 4px; }
.lm-gh .lm-ev { margin-left: auto; }
.lm-big { font-size: 26px; font-weight: 600; color: var(--lmc); }
.lm-big small { font-size: 13px; margin-left: 1px; }
.lm-bar { position: relative; display: block; height: 8px; border-radius: 4px; background: color-mix(in srgb, var(--line) 60%, transparent); overflow: hidden; margin: 4px 0; }
.lm-bar i { position: absolute; left: 0; top: 0; bottom: 0; background: var(--lmc, var(--accent)); }
.lm-bar s { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--vscode-foreground); opacity: .45; }
.lm-bar.sm { height: 6px; flex: 1; margin: 0 6px; }
.lm-gl { font-size: 11px; margin: 2px 0; }
.lm-tr { margin-top: 6px; font-size: 10px; }
.lm-spark { display: block; width: 100%; height: 46px; }
.lm-spark path { fill: none; stroke: var(--lmc, var(--accent)); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.lm-spark .lm-tw { stroke: var(--warn); stroke-dasharray: 3 3; vector-effect: non-scaling-stroke; }
.lm-spark .lm-ta { stroke: var(--bad); stroke-dasharray: 3 3; vector-effect: non-scaling-stroke; }
.lm-cmp { display: flex; align-items: center; font-size: 11px; margin: 2px 0; }
.lm-cmp span:first-child { width: 150px; }
.lm-cmp b { width: 44px; text-align: right; }
.lm-al { border: 1px solid var(--lmc); border-radius: 4px; padding: 4px 8px; margin: 6px 0; font-size: 12px; display: flex; gap: 8px; align-items: center; }
.lm-al b { color: var(--lmc); }
.lm-hb { display: flex; flex-direction: column; gap: 2px; }
.lm-hr { display: grid; grid-template-columns: 110px 1fr 56px 64px; gap: 6px; align-items: center; font-size: 11px; }
.lm-ht { position: relative; height: 10px; background: color-mix(in srgb, var(--line) 40%, transparent); border-radius: 2px; }
.lm-ht i { position: absolute; left: 0; top: 0; bottom: 0; background: var(--claude); border-radius: 2px; }
.lm-ht s { position: absolute; top: -2px; bottom: -2px; width: 1px; background: var(--warn); }
.lm-act .lm-ht i, .lm-act.lm-vc i { outline: 1px solid var(--vscode-foreground); }
.lm-vb { position: relative; display: flex; align-items: flex-end; gap: 2px; height: 140px; border-bottom: 1px solid var(--line); overflow-x: auto; padding-bottom: 14px; }
.lm-vc { position: relative; flex: 0 0 14px; height: 100%; display: flex; flex-direction: column; justify-content: flex-end; }
.lm-vc i { display: block; background: var(--claude); border-radius: 2px 2px 0 0; min-height: 1px; }
.lm-vc span { position: absolute; bottom: -14px; font-size: 8px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
.lm-p90 { position: absolute; left: 0; right: 0; height: 0; border-top: 1px dashed var(--warn); margin-bottom: 14px; }
`;

export const limitsView: ExtraView = {
  id: 'limits',
  label: 'Limits',
  group: 'Usage',
  hint: 'Codex rate-limit windows as recorded, and Claude 5-hour blocks derived from your calls, compared with your own past blocks.',
  ready: true,
  render,
  css: CSS,
  badge: d => {
    const peak = codexPeak(d.sessions, d.now);
    return peak !== undefined && peak >= thresholds(d.config).warn ? `${Math.round(peak)}%` : '';
  },
};
