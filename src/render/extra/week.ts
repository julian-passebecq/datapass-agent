// Add-on screen "Week": sessions on a Monday–Sunday calendar (or work week / one day).
// Blocks are DERIVED from OBSERVED event times (see activity/week.ts); colours never encode status.
import type { AgentSessionSnapshot } from '../../model';
import type { WsData, WsState } from '../workspace';
import { kpi, prettyModel, repoOf, titleOf } from '../workspace';
import { esc } from '../html';
import { hhmm } from '../views';
import { duration } from '../../activity/activity';
import { endObserved } from '../../activity/audit';
import { identityColor, isLive, outcome, Outcome, OUTCOME_LABEL } from '../../activity/insights';
import { activeHours, DAY, dayAt, dayStarts, daySummaries, HOUR, peakConcurrency, WeekBlock, weekBlocks, weekStart } from '../../activity/week';
import { ExtraView, opt, seg, toolbar } from './kit';

const PROV: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };
const OUT_COLOR: Record<Outcome, string> = { live: 'var(--ok)', committed: 'var(--accent)', changed: 'var(--warn)', nochange: 'var(--quiet)' };
const GAPS: Record<string, number> = { '15m': 15 * 60_000, '30m': 30 * 60_000, '60m': 60 * 60_000, '2h': 2 * HOUR };
const MAX_LEGEND = 12;

type ColorBy = 'repo' | 'provider' | 'model' | 'outcome';

/** Colour key and css colour of a session for the chosen dimension. */
export function colorOf(s: AgentSessionSnapshot, by: string): [label: string, color: string] {
  switch (by as ColorBy) {
    case 'provider':
      return [PROV[s.provider] ?? s.provider, s.provider === 'codex' ? 'var(--codex)' : 'var(--claude)'];
    case 'model': {
      const m = prettyModel(s.model) || 'model not recorded';
      return [m, s.model ? identityColor(m) : 'var(--quiet)'];
    }
    case 'outcome': {
      const o = outcome(s);
      return [OUTCOME_LABEL[o], OUT_COLOR[o]];
    }
    default:
      return [repoOf(s), identityColor(repoOf(s))];
  }
}

function isoWeek(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const w1 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d.getTime() - w1.getTime()) / DAY - 3 + ((w1.getDay() + 6) % 7)) / 7);
}

/**
 * The block's end is not an observed end: it is the session's last block (or still growing while live) and the
 * provider recorded no end, so its length is a lower bound and is shown with "≥" (audit A3 P2-15).
 */
export function openEnd(s: AgentSessionSnapshot | undefined, b: WeekBlock): boolean {
  if (!s || b.cutEnd) return false;
  if (b.live) return true;
  if (endObserved(s)) return false;
  const last = s.lastActivityAt ?? s.startedAt;
  return last === undefined || b.b >= last - 1;
}

const atLeast = (open: boolean) => (open ? '≥ ' : '');

const fmtDay = (t: number, o: Intl.DateTimeFormatOptions) => new Date(t).toLocaleDateString(undefined, o);

function blockTip(s: AgentSessionSnapshot, b: WeekBlock, gapLabel: string): string {
  const pass = b.tests.filter(t => t.outcome === 'PASS').length, fail = b.tests.filter(t => t.outcome === 'FAIL').length;
  const lines = [
    titleOf(s),
    [PROV[s.provider], prettyModel(s.model), s.effort].filter(Boolean).join(' · ') + (s.isWorker ? ' · worker' : ''),
    [repoOf(s), s.branch].filter(Boolean).join(' · '),
    `${hhmm(b.a)}–${b.live ? 'now' : hhmm(b.b)} · ${atLeast(openEnd(s, b))}${duration(b.b - b.a)}${b.live ? ' · live' : openEnd(s, b) ? ' · ends at the last recorded activity (no end recorded)' : ''}`,
    ...b.commits.slice(0, 5).map(c => `commit ${c.sha.slice(0, 7)} ${c.subject}`),
    b.commits.length > 5 ? `… ${b.commits.length - 5} more commits` : '',
    b.prs ? `PR / MR create command observed (${b.prs})` : '',
    b.tests.length ? `tests ${pass} pass · ${fail} fail (observed)` : '',
    b.kind === 'INFERRED'
      ? 'INFERRED: only first and last activity recorded; span drawn between them'
      : `DERIVED: span of OBSERVED event times, split where idle > ${gapLabel}`,
  ];
  return lines.filter(Boolean).join('\n');
}

function chips(b: WeekBlock): string {
  const c: string[] = [];
  if (b.commits.length) c.push(`<span class="wk-chip wk-commit" title="${esc(`${b.commits.length} commit(s) observed in this block`)}">◆${b.commits.length > 1 ? b.commits.length : ''}</span>`);
  if (b.prs) c.push(`<span class="wk-chip wk-pr" title="PR / MR create command observed">PR</span>`);
  if (b.tests.some(t => t.outcome === 'FAIL')) c.push(`<span class="wk-chip wk-fail" title="a test / build command failed in this block (observed)">✗</span>`);
  return c.length ? `<span class="wk-chips">${c.join('')}</span>` : '';
}

function render(d: WsData, st: WsState): string {
  const range = opt(st, 'week.range', 'week');
  const orient = opt(st, 'week.orient', 'vertical');
  const colorBy = opt(st, 'week.color', 'repo');
  const gapKey = GAPS[opt(st, 'week.gap', '30m')] ? opt(st, 'week.gap', '30m') : '30m';
  const hoursMode = opt(st, 'week.hours', 'active');
  const workers = opt(st, 'week.workers', 'off') === 'on';
  const isDay = range === 'day';
  const offKey = isDay ? 'week.doff' : 'week.woff';
  const off = Math.max(-520, Math.min(52, parseInt(opt(st, offKey, '0'), 10) || 0));
  const from = isDay ? dayAt(d.now, off) : weekStart(d.now, off);
  const days = isDay ? 1 : range === 'work' ? 5 : 7;
  const bounds = dayStarts(from, days);
  const to = bounds[days];

  const events = d.timeline?.(undefined, 200_000) ?? d.events;
  const blocks = weekBlocks(d.sessions, events, { from, days, gapMs: GAPS[gapKey], now: d.now, workers });
  const by = new Map(d.sessions.map(s => [s.key, s]));
  const sums = daySummaries(blocks, from, days);
  const [h0, h1] = hoursMode === 'all' ? [0, 24] : activeHours(blocks, bounds);
  const span = h1 - h0;

  // ---- toolbar and navigation
  const label = isDay
    ? fmtDay(from, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    : `Week ${isoWeek(from)} · ${fmtDay(from, { day: 'numeric', month: 'short' })} – ${fmtDay(to - 1, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  const nav = `<span class="wk-nav"><button class="link" data-opt="${offKey}" data-val="${off - 1}" title="Previous ${isDay ? 'day' : 'week'}">←</button><button class="link${off === 0 ? ' wk-dim' : ''}" data-opt="${offKey}" data-val="0" title="Back to ${isDay ? 'today' : 'this week'}">Today</button><button class="link" data-opt="${offKey}" data-val="${off + 1}" title="Next ${isDay ? 'day' : 'week'}"${off >= 0 ? ' disabled' : ''}>→</button><b>${esc(label)}</b></span>`;
  let h = toolbar(
    nav,
    seg(st, 'week.range', [['week', 'Week'], ['work', 'Mon–Fri'], ['day', 'Day']], 'week', 'Range'),
    seg(st, 'week.orient', [['vertical', 'Days as columns'], ['horizontal', 'Days as rows']], 'vertical', 'Orientation'),
    seg(st, 'week.color', [['repo', 'Repo'], ['provider', 'Provider'], ['model', 'Model'], ['outcome', 'Outcome']], 'repo', 'Colour blocks by'),
    seg(st, 'week.hours', [['active', 'Active hours'], ['all', '24 h']], 'active', 'Hour range'),
    seg(st, 'week.gap', [['15m', 'idle 15m'], ['30m', '30m'], ['60m', '1h'], ['2h', '2h']], '30m', 'Split a session into blocks where no activity was recorded for longer than this'),
    seg(st, 'week.workers', [['off', 'Leads'], ['on', '+ workers']], 'off', 'Include worker / subagent sessions'),
  );

  // ---- KPIs
  const keys = new Set(blocks.map(b => b.key));
  const shas = new Set(blocks.flatMap(b => b.commits.map(c => c.sha)));
  const active = sums.reduce((n, x) => n + x.activeMs, 0);
  const busiest = [...sums].sort((a, b) => b.activeMs - a.activeMs)[0];
  const liveN = [...keys].filter(k => { const s = by.get(k); return s && isLive(s); }).length;
  const openAny = blocks.some(b => openEnd(by.get(b.key), b));
  const ge = atLeast(openAny);
  h += `<div class="kpis">${[
    kpi(keys.size, 'Sessions', '', 'DERIVED: distinct sessions with at least one activity block in this range'),
    kpi(liveN, 'Live', liveN ? 'k-run' : '', 'DERIVED: sessions of this range whose current status is running, idle or needs input (each status carries its own evidence)'),
    kpi(ge + duration(active), 'Agent time', '', `DERIVED: union of activity blocks per day (overlapping sessions count once)${openAny ? '; ≥ because some blocks end at the last recorded activity, not at a recorded end' : ''}`),
    kpi(shas.size, 'Commits', '', 'DERIVED: distinct commits from git log found inside activity blocks'),
    kpi(blocks.reduce((n, b) => n + b.prs, 0), 'PR / MR', '', 'OBSERVED: gh pr create / glab mr create commands recorded by the provider'),
    kpi(peakConcurrency(blocks), 'Peak parallel', '', 'DERIVED: most blocks overlapping at one instant'),
    !isDay && busiest?.activeMs ? kpi(fmtDay(busiest.start, { weekday: 'short' }), 'Busiest day', '', `DERIVED: day with the most agent time (${duration(busiest.activeMs)})`) : '',
  ].join('')}</div>`;

  const oldest = Math.min(...d.sessions.map(s => s.startedAt ?? s.lastActivityAt ?? Infinity));
  if (Number.isFinite(oldest) && oldest > from) h += `<div class="foot wk-note">Loaded history starts ${esc(fmtDay(oldest, { weekday: 'short', day: 'numeric', month: 'short' }))} ${esc(hhmm(oldest))}; earlier days of this range are empty because they are outside <code>agent.historyDays</code>, not because nothing ran.</div>`;
  if (!blocks.length) return h + `<div class="empty">No session activity in this ${isDay ? 'day' : 'range'}.</div>` + legend([], colorBy, gapKey);

  // ---- calendar body
  const todayIdx = bounds.findIndex((t, i) => i < days && d.now >= t && d.now < bounds[i + 1]);
  const pos = (t: number, day: number) => {
    const frac = ((t - bounds[day]) / (bounds[day + 1] - bounds[day])) * 24;
    return Math.max(0, Math.min(100, ((frac - h0) / span) * 100));
  };
  const hourTicks = Array.from({ length: span + 1 }, (_, i) => h0 + i);
  const tickStep = orient === 'horizontal' ? (span > 16 ? 2 : 1) : 1;
  const dayHead = (i: number) => {
    const x = sums[i];
    const t = bounds[i];
    const wd = fmtDay(t, { weekday: isDay ? 'long' : 'short' });
    const dm = fmtDay(t, { day: 'numeric', month: 'short' });
    const ge = atLeast(blocks.some(b => b.day === i && openEnd(by.get(b.key), b)));
    const stats = x.sessions ? `${x.sessions} · ${ge}${duration(x.activeMs)}${x.commits ? ` · ◆${x.commits}` : ''}` : '—';
    return `<div class="wk-dh${i === todayIdx ? ' wk-today' : ''}" title="${esc(`${x.sessions} session(s) · ${ge}${duration(x.activeMs)} agent time (DERIVED) · ${x.commits} commit(s) · peak ${x.peak} parallel`)}"><b>${esc(wd)}</b> <span class="muted">${esc(dm)}</span><span class="wk-ds">${esc(stats)}</span></div>`;
  };
  const sorted = [...blocks].sort((a, b) => a.day - b.day || a.a - b.a);
  const blockHtml = (b: WeekBlock, vertical: boolean, laneH: number) => {
    const s = by.get(b.key);
    if (!s) return '';
    const [, color] = colorOf(s, colorBy);
    const p0 = pos(b.a, b.day), p1 = pos(b.b, b.day);
    const len = Math.max(0, p1 - p0);
    const geom = vertical
      ? `top:${p0.toFixed(3)}%;height:${len.toFixed(3)}%;left:calc(${((100 * b.lane) / b.lanes).toFixed(3)}% + 1px);width:calc(${(100 / b.lanes).toFixed(3)}% - 2px)`
      : `left:${p0.toFixed(3)}%;width:${len.toFixed(3)}%;top:${b.lane * laneH}px;height:${laneH - 2}px`;
    const cls = ['wk-b', s.provider, b.live ? 'wk-live' : '', b.kind === 'INFERRED' ? 'wk-inf' : '', b.cutStart ? 'wk-cs' : '', b.cutEnd ? 'wk-ce' : '', st.selected === s.key ? 'sel' : '', s.isWorker ? 'wk-w' : ''].filter(Boolean).join(' ');
    const sub = [repoOf(s), prettyModel(s.model)].filter(Boolean).join(' · ');
    return `<div class="${cls}" style="${geom};--c:${color}" data-select="${esc(s.key)}" tabindex="0" title="${esc(blockTip(s, b, gapKey))}"><span class="wk-t">${esc(titleOf(s))}</span><span class="wk-s">${esc(sub)}</span>${chips(b)}</div>`;
  };

  if (orient === 'horizontal') {
    const laneH = isDay ? 22 : 16;
    h += `<div class="wk-h"><div class="wk-hh"><span></span><div class="wk-ht">${hourTicks.filter(x => (x - h0) % tickStep === 0).map(x => `<span style="left:${(((x - h0) / span) * 100).toFixed(3)}%">${String(x % 24).padStart(2, '0')}</span>`).join('')}</div></div>`;
    for (let i = 0; i < days; i++) {
      const list = sorted.filter(b => b.day === i);
      const lanes = Math.max(1, ...list.map(b => b.lanes));
      const now = i === todayIdx ? `<span class="wk-now" style="left:${pos(d.now, i).toFixed(3)}%" title="now ${esc(hhmm(d.now))}"></span>` : '';
      h += `<div class="wk-row${i === todayIdx ? ' wk-today' : ''}">${dayHead(i)}<div class="wk-track" style="height:${lanes * laneH + 4}px;--hours:${span}">${list.map(b => blockHtml(b, false, laneH)).join('')}${now}</div></div>`;
    }
    h += `</div>`;
  } else {
    const hourPx = isDay ? 44 : span > 14 ? 26 : 34;
    h += `<div class="wk-v" style="--days:${days}"><div></div>${Array.from({ length: days }, (_, i) => dayHead(i)).join('')}`;
    h += `<div class="wk-axis" style="height:${span * hourPx}px">${hourTicks.slice(0, -1).map(x => `<span style="top:${(((x - h0) / span) * 100).toFixed(3)}%">${String(x % 24).padStart(2, '0')}:00</span>`).join('')}</div>`;
    for (let i = 0; i < days; i++) {
      const now = i === todayIdx ? `<span class="wk-now" style="top:${pos(d.now, i).toFixed(3)}%" title="now ${esc(hhmm(d.now))}"></span>` : '';
      h += `<div class="wk-col${i === todayIdx ? ' wk-today' : ''}${isDay ? ' wk-wide' : ''}" style="height:${span * hourPx}px;--hp:${hourPx}px">${sorted.filter(b => b.day === i).map(b => blockHtml(b, true, 0)).join('')}${now}</div>`;
    }
    h += `</div>`;
  }

  // ---- legend
  const counts = new Map<string, { color: string; n: number }>();
  for (const k of keys) {
    const s = by.get(k);
    if (!s) continue;
    const [l, c] = colorOf(s, colorBy);
    counts.set(l, { color: c, n: (counts.get(l)?.n ?? 0) + 1 });
  }
  return h + legend([...counts].sort((a, b) => b[1].n - a[1].n), colorBy, gapKey);
}

function legend(items: [string, { color: string; n: number }][], colorBy: string, gapKey: string): string {
  const shown = items.slice(0, MAX_LEGEND);
  const more = items.length - shown.length;
  return `<div class="legend wk-legend"><span class="muted">${esc(colorBy)}:</span>${shown.map(([l, x]) => `<span class="wk-key"><i style="background:${x.color}"></i>${esc(l)} <span class="muted">${x.n}</span></span>`).join('')}${more > 0 ? `<span class="muted">+${more} more</span>` : ''}</div>
<div class="legend wk-legend"><span class="wk-key"><i class="wk-pb claude"></i>Claude</span><span class="wk-key"><i class="wk-pb codex"></i>Codex</span><span class="wk-key">border = provider</span><span class="wk-key"><span class="wk-chip wk-commit">◆</span>commit</span><span class="wk-key"><span class="wk-chip wk-pr">PR</span>PR / MR created</span><span class="wk-key"><span class="wk-chip wk-fail">✗</span>test failed</span><span class="wk-key"><i class="wk-sw-live"></i>live</span><span class="wk-key"><i class="wk-sw-inf"></i>INFERRED span</span></div>
<div class="foot">Blocks are DERIVED from OBSERVED event times (commands, tools, edits, model calls, commits); a session is split where no activity was recorded for more than ${esc(gapKey)}. Sessions with only a first and last record are drawn dashed (INFERRED). A duration marked ≥ ends at the last recorded activity because no end was recorded, so it is a lower bound. Agent time is not a productivity score.</div>`;
}

export const weekView: ExtraView = {
  id: 'week',
  label: 'Week',
  group: 'Time',
  hint: 'Sessions on a Monday–Sunday calendar.',
  ready: true,
  render,
  css: `
.wk-nav { display: inline-flex; align-items: center; gap: 4px; margin-right: 6px; } .wk-nav b { font-size: 12px; margin-left: 4px; } .wk-nav button[disabled] { opacity: .35; cursor: default; } .wk-dim { opacity: .55; }
.wk-note { margin: -2px 0 6px; }
.wk-dh { font-size: 11px; padding: 2px 4px 4px; border-bottom: 1px solid var(--line); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wk-dh .wk-ds { display: block; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; font-size: 10px; }
.wk-dh.wk-today b { color: var(--accent); }
.wk-v { display: grid; grid-template-columns: 42px repeat(var(--days), minmax(0, 1fr)); column-gap: 0; }
.wk-axis { position: relative; font-size: 10px; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
.wk-axis span { position: absolute; right: 5px; transform: translateY(-50%); }
.wk-axis span:first-child { transform: none; }
.wk-col { position: relative; border-left: 1px solid var(--line); background-image: repeating-linear-gradient(to bottom, transparent 0, transparent calc(var(--hp) - 1px), color-mix(in srgb, var(--line) 70%, transparent) calc(var(--hp) - 1px), color-mix(in srgb, var(--line) 70%, transparent) var(--hp)); }
.wk-col:last-child { border-right: 1px solid var(--line); }
.wk-col.wk-today, .wk-row.wk-today .wk-track { background-color: color-mix(in srgb, var(--accent) 5%, transparent); }
.wk-b { position: absolute; box-sizing: border-box; overflow: hidden; cursor: pointer; padding: 1px 4px 1px 5px; font-size: 10.5px; line-height: 13px; border-radius: 3px; color: var(--vscode-foreground);
  background: color-mix(in srgb, var(--c) 34%, var(--vscode-editor-background, transparent)); border: 1px solid color-mix(in srgb, var(--c) 70%, transparent); border-left: 3px solid var(--claude); min-height: 3px; min-width: 3px; }
.wk-b.codex { border-left-color: var(--codex); }
.wk-b:hover { z-index: 3; background: color-mix(in srgb, var(--c) 52%, var(--vscode-editor-background, transparent)); }
.wk-b.sel { outline: 2px solid var(--vscode-focusBorder); outline-offset: -1px; z-index: 4; }
.wk-b:focus-visible { outline: 2px solid var(--vscode-focusBorder); }
.wk-b.wk-inf { border-style: dashed; border-left-style: solid; background: color-mix(in srgb, var(--c) 16%, var(--vscode-editor-background, transparent)); }
.wk-b.wk-w { opacity: .8; }
.wk-v .wk-b.wk-cs { border-top-left-radius: 0; border-top-right-radius: 0; border-top-style: dotted; } .wk-v .wk-b.wk-ce { border-bottom-left-radius: 0; border-bottom-right-radius: 0; border-bottom-style: dotted; }
.wk-h .wk-b.wk-cs { border-top-left-radius: 0; border-bottom-left-radius: 0; } .wk-h .wk-b.wk-ce { border-top-right-radius: 0; border-bottom-right-radius: 0; border-right-style: dotted; }
.wk-b.wk-live { box-shadow: 0 0 0 0 color-mix(in srgb, var(--ok) 60%, transparent); animation: wk-pulse 2s ease-out infinite; border-color: var(--ok); }
@keyframes wk-pulse { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--ok) 55%, transparent); } 70% { box-shadow: 0 0 0 5px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
@media (prefers-reduced-motion: reduce) { .wk-b.wk-live { animation: none; box-shadow: 0 0 0 1px var(--ok); } }
.wk-t, .wk-s { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wk-t { font-weight: 600; } .wk-s { color: var(--vscode-descriptionForeground); font-size: 10px; }
.wk-h .wk-b { display: flex; align-items: center; gap: 6px; padding-right: 2px; } .wk-h .wk-t { flex: 0 1 auto; min-width: 0; } .wk-h .wk-s { flex: 1 1 0; min-width: 0; }
.wk-chips { position: absolute; right: 1px; bottom: 1px; display: inline-flex; gap: 1px; }
.wk-h .wk-chips { position: static; margin-left: auto; flex: none; }
.wk-chip { display: inline-block; font-size: 9px; line-height: 11px; padding: 0 3px; border-radius: 3px; font-weight: 700; background: var(--vscode-editor-background, #0000); border: 1px solid var(--line); }
.wk-chip.wk-commit { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 60%, transparent); }
.wk-chip.wk-pr { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 60%, transparent); }
.wk-chip.wk-fail { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 60%, transparent); }
.wk-now { position: absolute; z-index: 5; pointer-events: none; background: var(--bad); }
.wk-v .wk-now { left: -3px; right: 0; height: 2px; transform: translateY(-1px); } .wk-v .wk-now::before { content: ''; position: absolute; left: 0; top: -3px; width: 8px; height: 8px; border-radius: 50%; background: var(--bad); }
.wk-h .wk-now { top: 0; bottom: 0; width: 2px; transform: translateX(-1px); }
.wk-h { display: grid; gap: 0; }
.wk-hh, .wk-row { display: grid; grid-template-columns: 116px minmax(0, 1fr); }
.wk-ht { position: relative; height: 16px; font-size: 10px; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
.wk-ht span { position: absolute; transform: translateX(-50%); } .wk-ht span:first-child { transform: none; }
.wk-row { border-top: 1px solid var(--line); } .wk-row:last-child { border-bottom: 1px solid var(--line); }
.wk-row .wk-dh { border-bottom: none; border-right: 1px solid var(--line); }
.wk-track { position: relative; margin: 2px 0; background-image: repeating-linear-gradient(to right, transparent 0, transparent calc(100% / var(--hours) - 1px), color-mix(in srgb, var(--line) 70%, transparent) calc(100% / var(--hours) - 1px), color-mix(in srgb, var(--line) 70%, transparent) calc(100% / var(--hours))); }
.wk-legend { gap: 10px; } .wk-key { display: inline-flex; align-items: center; gap: 4px; }
.wk-key i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; }
.wk-key i.wk-pb { width: 4px; height: 12px; border-radius: 1px; } .wk-key i.wk-pb.claude { background: var(--claude); } .wk-key i.wk-pb.codex { background: var(--codex); }
.wk-key i.wk-sw-live { border: 1px solid var(--ok); box-shadow: 0 0 0 2px color-mix(in srgb, var(--ok) 35%, transparent); }
.wk-key i.wk-sw-inf { border: 1px dashed var(--vscode-descriptionForeground); }
`,
};
