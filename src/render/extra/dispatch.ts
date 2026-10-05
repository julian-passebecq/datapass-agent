// Add-on screen "Dispatches": every worker a lead sent off, joined with the parent's spawn call, with the
// usage and outcome it actually recorded (Log), and cost vs outcome per model / effort / worker type. Pure rendering.
import { duration } from '../../activity/activity';
import {
  buildDispatches, costOf, Dispatch, DispatchGroup, GroupBy, groupStats, inPeriod, last24h, niceTicks, slug,
} from '../../activity/dispatch';
import { compact, identityColor } from '../../activity/insights';
import type { WorkflowsSnapshot } from '../../providers/claude/workflows';
import { esc } from '../html';
import { kpi, prettyModel, WsData, WsState } from '../workspace';
import { Feed, feedValue } from './feeds';
import { ExtraView, opt, seg, toolbar } from './kit';
import { workflowsFeed } from './workflows';

const MAX_ROWS = 300;
const MAX_CHOICES = 6;
export const MIN_N = 5;

const T_TOK = 'tokens Σ: sum over model calls of prompt tokens incl. cache reads + output, as the provider recorded them (OBSERVED for sessions, DERIVED from the journal for workflow agents)';
const T_OUT = 'OBSERVED: output tokens recorded by the provider';
const T_DISP = 'OBSERVED: time of the matching spawn call in the parent (Task / spawn_agent), else the worker’s first record';
const T_DUR = 'DERIVED: worker first record → last activity (live: → now)';
const T_COST = 'DERIVED from your setting agent.dispatch.pricePerMTok: tokens Σ / 1e6 × your price for the model. Agent has no prices of its own.';
const SUCCESS_DEF = 'Success (DERIVED) = the dispatch finished (session ENDED or workflow agent done / failed recorded) with no failure signal. Failure signals (OBSERVED): the last test / build command observed failed, or the workflow journal records the agent as failed. A finished dispatch with no test observed counts as success ("no tests needed"); tool errors alone do not count as failure. Verified (DERIVED) = success and (last test passed or a commit observed). Live dispatches and dispatches whose end is not observed are left out of the rates.';

const STATE_TEXT: Record<Dispatch['state'], string> = { live: 'running', ok: 'ended', failed: 'failed', unknown: 'end not observed' };
const STATE_COLOR: Record<Dispatch['state'], string> = { live: 'var(--warn)', ok: 'var(--ok)', failed: 'var(--bad)', unknown: 'var(--quiet)' };
const KIND_TEXT: Record<Dispatch['kind'], string> = { subagent: 'subagent', workflow: 'workflow', codex: 'Codex agent' };

const pct = (x: number | undefined) => (x === undefined ? '—' : `${Math.round(x * 100)}%`);
const usd = (n: number) => `$${n < 0.1 ? n.toFixed(3) : n < 10 ? n.toFixed(2) : n.toFixed(0)}`;
const when = (t: number | undefined) => (t ? new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const modelText = (m: string | undefined) => (m ? prettyModel(m) : '—');

function prices(d: WsData): Record<string, unknown> {
  const p = d.config?.('agent.dispatch.pricePerMTok', {} as Record<string, unknown>);
  return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
}

function snapOf(): WorkflowsSnapshot | undefined {
  return feedValue<WorkflowsSnapshot>(workflowsFeed.id).value;
}

/** Top values of a field as seg choices (slugged), "all" first. */
function choices(ds: Dispatch[], f: (d: Dispatch) => string, pretty: (v: string) => string = v => v): [string, string][] {
  const n = new Map<string, { label: string; c: number }>();
  for (const d of ds) {
    const v = f(d);
    const k = slug(v);
    n.set(k, { label: pretty(v), c: (n.get(k)?.c ?? 0) + 1 });
  }
  const top = [...n].sort((a, b) => b[1].c - a[1].c).slice(0, MAX_CHOICES);
  return [['all', 'All'], ...top.map(([k, v]) => [k, `${v.label.length > 18 ? `${v.label.slice(0, 17)}…` : v.label} ${v.c}`] as [string, string])];
}

const F_MODEL = (d: Dispatch) => d.model ?? '(none)';
const F_TYPE = (d: Dispatch) => d.type;
const F_REPO = (d: Dispatch) => d.repo;
const F_STATE = (d: Dispatch) => d.state;

function filterLog(ds: Dispatch[], st: WsState): Dispatch[] {
  const pick: [string, (d: Dispatch) => string][] = [['dispatch.model', F_MODEL], ['dispatch.type', F_TYPE], ['dispatch.repo', F_REPO], ['dispatch.outcome', F_STATE]];
  let out = ds;
  for (const [name, f] of pick) {
    const v = opt(st, name, 'all');
    if (v !== 'all') out = out.filter(d => slug(f(d)) === v);
  }
  const sort = opt(st, 'dispatch.sort', 'time');
  const key: Record<string, (d: Dispatch) => number> = { time: d => d.dispatchedAt ?? 0, tokens: d => d.tokens ?? -1, duration: d => d.durationMs ?? -1, tools: d => d.tools };
  const k = key[sort] ?? key.time;
  return [...out].sort((a, b) => k(b) - k(a));
}

// ---- Log ------------------------------------------------------------------------------------------------

function logView(all: Dispatch[], st: WsState, pr: Record<string, unknown>): string {
  const filters = toolbar(
    seg(st, 'dispatch.sort', [['time', 'Newest'], ['tokens', 'Tokens'], ['duration', 'Duration'], ['tools', 'Tools']], 'time', 'Sort'),
    seg(st, 'dispatch.model', choices(all, F_MODEL, v => (v === '(none)' ? 'no model' : prettyModel(v))), 'all', 'Model'),
    seg(st, 'dispatch.type', choices(all, F_TYPE), 'all', 'Worker type'),
    seg(st, 'dispatch.repo', choices(all, F_REPO), 'all', 'Repo'),
    seg(st, 'dispatch.outcome', choices(all, F_STATE, v => STATE_TEXT[v as Dispatch['state']] ?? v), 'all', 'Outcome'),
  );
  const list = filterLog(all, st);
  if (!list.length) return `${filters}<div class="muted dp-empty">No dispatch matches these filters.</div>`;
  const anyPrice = list.some(d => costOf(d, pr) !== undefined);
  const rows = list.slice(0, MAX_ROWS).map(d => {
    const sel = d.session ? ` data-select="${esc(d.key)}" tabindex="0"${st.selected === d.key ? ' class="sel"' : ''}` : '';
    const c = costOf(d, pr);
    const tests = d.pass + d.fail;
    const why = d.reasons.length ? ` · ${d.reasons.join('; ')}` : '';
    return `<tr${sel}>
<td class="dp-tm" title="${esc(`${T_DISP}${d.spawnMatched ? ' · spawn call matched' : ' · no spawn call matched: worker first record'}`)}">${esc(when(d.dispatchedAt))}${d.spawnMatched ? '' : ' <span class="muted">*</span>'}</td>
<td class="dp-p" title="${esc(d.parentKey ?? 'no parent recorded')}">${esc(d.parentTitle ?? (d.parentKey ? d.parentKey.slice(0, 16) : '—'))}</td>
<td><span class="dp-k dp-k-${d.kind}" title="${esc(`${KIND_TEXT[d.kind]} · ${d.provider}`)}">${esc(KIND_TEXT[d.kind])}</span> <span class="dp-ty" style="--rc:${identityColor(d.type)}" title="${esc(`${d.typeKind}: ${d.typeKind === 'UNKNOWN' ? 'no worker type recorded' : 'worker type recorded by the provider'}`)}">${esc(d.type)}</span></td>
<td class="dp-l" title="${esc(`${d.label}${d.description ? ` · spawn description: ${d.description}` : ''}${d.runName ? ` · run ${d.runName}` : ''}`)}">${esc(d.label)}${d.description && d.description !== d.label ? `<div class="muted">${esc(d.description)}</div>` : ''}</td>
<td title="OBSERVED: model and effort recorded by the worker">${esc(modelText(d.model))}${d.effort ? ` <span class="muted">· ${esc(d.effort)}</span>` : ''}</td>
<td class="r" title="${esc(T_DUR)}">${duration(d.durationMs)}</td>
<td class="r" title="${esc(T_TOK)}">${d.tokens === undefined ? '<span class="muted" title="UNKNOWN: no usage recorded">—</span>' : compact(d.tokens)}</td>
<td class="r" title="${esc(T_OUT)}">${d.output === undefined ? '—' : compact(d.output)}</td>
${anyPrice ? `<td class="r" title="${esc(T_COST)}">${c === undefined ? '—' : usd(c)}</td>` : ''}
<td class="r" title="OBSERVED: tool calls (provider-flagged errors)">${d.tools || ''}${d.toolErrors ? ` <span class="dp-bad">(${d.toolErrors})</span>` : ''}</td>
<td title="${esc(`DERIVED: ${STATE_TEXT[d.state]}${why}`)}"><i class="dp-dot" style="--c:${STATE_COLOR[d.state]}"></i>${esc(STATE_TEXT[d.state])}${d.state === 'ok' && d.verified ? ' <span class="dp-ok" title="DERIVED: last test passed or commit observed">✓</span>' : ''}</td>
<td class="r" title="OBSERVED test / build commands: pass / fail">${tests ? `<span class="dp-ok">${d.pass}</span> / <span class="${d.fail ? 'dp-bad' : ''}">${d.fail}</span>` : '—'}</td>
<td class="r" title="OBSERVED commits during the worker">${d.commits || ''}</td>
<td class="r" title="OBSERVED files the worker edited">${d.files || ''}</td>
<td>${esc(d.repo)}</td>
</tr>`;
  }).join('');
  const head = `<tr><th title="${esc(T_DISP)}">Dispatched</th><th>Parent</th><th>Worker</th><th>Label / task</th><th>Model · effort</th><th class="r" title="${esc(T_DUR)}">Duration</th><th class="r" title="${esc(T_TOK)}">Tokens Σ</th><th class="r" title="${esc(T_OUT)}">Output</th>${anyPrice ? `<th class="r" title="${esc(T_COST)}">$ (your price)</th>` : ''}<th class="r">Tools</th><th>Outcome</th><th class="r">Tests ✓ / ✗</th><th class="r">Commits</th><th class="r">Files</th><th>Repo</th></tr>`;
  return `${filters}<div class="dp-tw"><table class="dp-t">${head}${rows}</table></div>${list.length > MAX_ROWS ? `<div class="muted">First ${MAX_ROWS} of ${list.length}.</div>` : ''}<div class="legend">* no matching spawn call in the parent: dispatch time = the worker’s first record. Spawn match: the latest unused Task / spawn call of the parent at or before the worker start (+10 s), preferring the same worker type. ${esc(SUCCESS_DEF)}</div>`;
}

// ---- Cost vs outcome ------------------------------------------------------------------------------------

interface Pt { g: DispatchGroup; x: number; y: number }

function chart(groups: DispatchGroup[], st: WsState, by: GroupBy, useCost: boolean): string {
  const yName = opt(st, 'dispatch.y', 'success');
  const logX = opt(st, 'dispatch.xscale', 'lin') === 'log';
  const yOf = (g: DispatchGroup) => (yName === 'verified' ? g.verifiedRate : g.successRate);
  const xOf = (g: DispatchGroup) => (useCost ? g.medCost : g.medTokens);
  const pts: Pt[] = groups.flatMap(g => {
    const x = xOf(g), y = yOf(g);
    return x !== undefined && y !== undefined && (!logX || x > 0) ? [{ g, x, y }] : [];
  });
  const skipped = groups.length - pts.length;
  if (!pts.length) return `<div class="muted dp-empty">No group has both a ${useCost ? 'priced cost' : 'token count'} and a finished dispatch yet.</div>`;
  const W = 680, H = 340, L = 56, R = 24, T = 16, B = 44;
  const pw = W - L - R, ph = H - T - B;
  const xmax = Math.max(...pts.map(p => p.x));
  let xs: (v: number) => number;
  let ticks: number[];
  if (logX) {
    const lo = Math.floor(Math.log10(Math.min(...pts.map(p => p.x))));
    const hi = Math.max(lo + 1, Math.ceil(Math.log10(xmax)));
    ticks = Array.from({ length: hi - lo + 1 }, (_, i) => 10 ** (lo + i));
    xs = v => L + ((Math.log10(v) - lo) / (hi - lo)) * pw;
  } else {
    ticks = niceTicks(xmax);
    const top = ticks[ticks.length - 1] || 1;
    xs = v => L + (v / top) * pw;
  }
  const ys = (v: number) => T + (1 - v) * ph;
  const fmtX = (v: number) => (useCost ? usd(v) : compact(Math.round(v)));
  const grid = [0, 0.25, 0.5, 0.75, 1].map(v => `<line class="dp-gl" x1="${L}" x2="${W - R}" y1="${ys(v)}" y2="${ys(v)}"/><text class="dp-ax" x="${L - 6}" y="${ys(v) + 3}" text-anchor="end">${v * 100}%</text>`).join('')
    + ticks.map(v => `<line class="dp-gl" x1="${xs(v).toFixed(1)}" x2="${xs(v).toFixed(1)}" y1="${T}" y2="${T + ph}"/><text class="dp-ax" x="${xs(v).toFixed(1)}" y="${T + ph + 14}" text-anchor="middle">${esc(fmtX(v))}</text>`).join('');
  // Connect effort levels of one model (model + effort grouping), like a model's score / cost curve.
  let lines = '';
  if (by === 'model-effort') {
    const byModel = new Map<string, Pt[]>();
    for (const p of pts) byModel.set(p.g.model, [...(byModel.get(p.g.model) ?? []), p]);
    for (const [m, ps] of byModel) if (ps.length > 1) {
      const sorted = [...ps].sort((a, b) => a.x - b.x);
      lines += `<polyline class="dp-ln" style="--c:${identityColor(m)}" points="${sorted.map(p => `${xs(p.x).toFixed(1)},${ys(p.y).toFixed(1)}`).join(' ')}"/>`;
    }
  }
  const dots = [...pts].sort((a, b) => b.g.n - a.g.n).map(p => {
    const r = Math.min(18, 4 + 2.2 * Math.sqrt(p.g.n));
    const few = p.g.finished < MIN_N;
    const cx = xs(p.x), cy = ys(p.y);
    const name = by === 'type' ? p.g.key : p.g.key.replace(p.g.model, prettyModel(p.g.model));
    const label = `${name.length > 26 ? `${name.slice(0, 25)}…` : name} · n=${p.g.finished}${few ? ' (n<5)' : ''}`;
    const right = cx < L + pw * 0.7;
    const tip = `${p.g.key}: ${p.g.finished} finished dispatch(es) of ${p.g.n}; ${yName === 'verified' ? 'verified' : 'success'} ${pct(p.y)} (DERIVED); median ${useCost ? `cost ${usd(p.x)} (DERIVED from your price)` : `tokens Σ ${compact(Math.round(p.x))}`}${few ? ' · n < 5: not enough data' : ''}`;
    return `<g class="dp-pt${few ? ' dp-few' : ''}" style="--c:${identityColor(p.g.model)}"><title>${esc(tip)}</title><circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}"/><text x="${(cx + (right ? r + 4 : -r - 4)).toFixed(1)}" y="${(cy + 3).toFixed(1)}" text-anchor="${right ? 'start' : 'end'}">${esc(label)}</text></g>`;
  }).join('');
  const axes = `<text class="dp-axt" x="${L + pw / 2}" y="${H - 6}" text-anchor="middle">${esc(useCost ? 'median cost per dispatch ($, DERIVED from your price)' : 'median tokens Σ per dispatch')}${logX ? ' · log scale' : ''}</text><text class="dp-axt" transform="translate(12 ${T + ph / 2}) rotate(-90)" text-anchor="middle">${esc(yName === 'verified' ? 'verified rate (DERIVED)' : 'success rate (DERIVED)')}</text>`;
  return `<div class="dp-cw"><svg class="dp-c" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Success rate versus cost per dispatch">${grid}${lines}${dots}${axes}</svg></div>${skipped ? `<div class="muted">${skipped} group(s) not plotted (no ${useCost ? 'price set' : 'token count'} or no finished dispatch).</div>` : ''}`;
}

function groupTable(groups: DispatchGroup[], useCost: boolean): string {
  const rows = groups.map(g => {
    const few = g.finished < MIN_N;
    const rate = (x: number | undefined, what: string) => (few ? `<span class="muted" title="n < ${MIN_N}: not enough data">${pct(x)} · n &lt; 5</span>` : `<span title="${esc(`DERIVED: ${what}`)}">${pct(x)}</span>`);
    return `<tr><td><span class="dp-ty" style="--rc:${identityColor(g.model)}">${esc(g.key === g.model ? modelText(g.key) : g.key.replace(g.model, prettyModel(g.model)))}</span></td>
<td class="r">${g.n}</td><td class="r" title="finished with an observed end (used for the rates)">${g.finished}</td><td class="r">${g.live || ''}</td>
<td class="r">${rate(g.successRate, `${g.ok} of ${g.finished} finished without a failure signal`)}</td>
<td class="r">${rate(g.verifiedRate, `${g.verified} of ${g.finished} with a passing last test or a commit`)}</td>
<td class="r" title="${esc(T_TOK)}">${g.medTokens === undefined ? '—' : compact(Math.round(g.medTokens))}</td>
<td class="r" title="${esc(T_TOK)}">${g.p90Tokens === undefined ? '—' : compact(Math.round(g.p90Tokens))}</td>
<td class="r" title="${esc(T_OUT)}">${g.medOutput === undefined ? '—' : compact(Math.round(g.medOutput))}</td>
<td class="r" title="${esc(T_DUR)}">${duration(g.medDurationMs)}</td>
${useCost ? `<td class="r" title="${esc(T_COST)}">${g.medCost === undefined ? '—' : `${usd(g.medCost)}${g.priced < g.n - g.live ? ` <span class="muted">(${g.priced})</span>` : ''}`}</td>` : ''}</tr>`;
  }).join('');
  return `<table class="dp-t dp-gt"><tr><th>Group</th><th class="r">n</th><th class="r">Finished</th><th class="r">Live</th><th class="r">Success</th><th class="r">Verified</th><th class="r">Median tokens Σ</th><th class="r">p90 tokens Σ</th><th class="r">Median output</th><th class="r">Median duration</th>${useCost ? '<th class="r">Median $ (your price)</th>' : ''}</tr>${rows}</table>`;
}

function costView(ds: Dispatch[], st: WsState, pr: Record<string, unknown>): string {
  const by = opt(st, 'dispatch.by', 'model') as GroupBy;
  const groups = groupStats(ds, by === 'model-effort' || by === 'type' ? by : 'model', pr);
  const hasPrice = Object.keys(pr).length > 0 && groups.some(g => g.medCost !== undefined);
  const useCost = hasPrice && opt(st, 'dispatch.x', 'tokens') === 'cost';
  const bar = toolbar(
    seg(st, 'dispatch.by', [['model', 'Model'], ['model-effort', 'Model + effort'], ['type', 'Worker type']], 'model', 'Group dispatches by'),
    seg(st, 'dispatch.y', [['success', 'Success'], ['verified', 'Verified']], 'success', 'Y axis'),
    hasPrice ? seg(st, 'dispatch.x', [['tokens', 'Tokens'], ['cost', '$ (your price)']], 'tokens', 'X axis') : '',
    seg(st, 'dispatch.xscale', [['lin', 'Linear'], ['log', 'Log']], 'lin', 'X scale'),
  );
  const priceNote = hasPrice
    ? `Money figures are DERIVED from your setting <code>agent.dispatch.pricePerMTok</code> (tokens Σ / 1e6 × your price); tokens Σ include cache reads, so this overstates real billing when caching is heavy.`
    : 'No money shown: set <code>agent.dispatch.pricePerMTok</code> (e.g. {"claude-opus-5-5": 1.5}) to plot a cost you choose. Agent never prices tokens by itself.';
  return `${bar}${chart(groups, st, by, useCost)}${groupTable(groups, useCost)}<div class="legend">Point = one group; size ∝ number of dispatches; hollow dashed = fewer than ${MIN_N} finished dispatches (n &lt; 5: not enough data, shown for honesty only). ${by === 'model-effort' ? 'Lines join the effort levels of one model. ' : ''}${esc(SUCCESS_DEF)} ${priceNote}</div>`;
}

// ---- screen ---------------------------------------------------------------------------------------------

export function renderDispatch(d: WsData, st: WsState, snap: WorkflowsSnapshot | undefined): string {
  const tab = opt(st, 'dispatch.tab', 'log');
  const period = opt(st, 'dispatch.period', '7d');
  const pr = prices(d);
  const ds = inPeriod(buildDispatches(d.sessions, snap, d.now), period, d.now);
  const bar = toolbar(
    seg(st, 'dispatch.tab', [['log', 'Log'], ['cost', 'Cost vs outcome']], 'log', 'View'),
    seg(st, 'dispatch.period', [['24h', '24 h'], ['7d', '7 d'], ['30d', '30 d'], ['all', 'All loaded']], '7d', 'Period (dispatched in it, or live)'),
  );
  const note = snap ? '' : '<div class="muted dp-note">Workflow scan pending: workflow agents not in the session list appear when it lands.</div>';
  if (!ds.length) return `${bar}${note}<div class="muted dp-empty">No dispatch in this period. A dispatch is a worker session (Claude subagent, workflow agent, Codex spawned agent) with a recorded parent.</div>`;
  const judged = ds.filter(x => x.success !== undefined);
  const ok = judged.filter(x => x.success).length;
  const tok = ds.filter(x => !x.live && x.tokens !== undefined).map(x => x.tokens!).sort((a, b) => a - b);
  const medTok = tok.length ? tok[Math.floor((tok.length - 1) / 2)] : undefined;
  const k = `<div class="kpis">${kpi(ds.length, 'Dispatches')}${kpi(ds.filter(x => x.live).length, 'Running')}${kpi(judged.length, 'Finished', '', 'with an observed end')}${kpi(judged.length >= MIN_N ? pct(ok / judged.length) : `${pct(judged.length ? ok / judged.length : undefined)}`, 'Success', judged.length && judged.length < MIN_N ? 'muted' : '', `DERIVED: ${ok} of ${judged.length} finished without a failure signal${judged.length < MIN_N ? ' · n < 5: not enough data' : ''}`)}${kpi(medTok === undefined ? '—' : compact(medTok), 'Median tokens Σ', '', T_TOK)}${kpi(ds.filter(x => x.spawnMatched).length, 'Spawn matched', '', 'OBSERVED: dispatches joined with the parent’s Task / spawn call')}</div>`;
  const body = tab === 'cost' ? costView(ds, st, pr) : logView(ds, st, pr);
  return `${bar}${note}${k}${body}`;
}

export const dispatchView: ExtraView = {
  id: 'dispatch',
  label: 'Dispatches',
  group: 'Usage',
  hint: 'Every worker dispatch with the spawn it came from, the tokens it actually used and its outcome; success rate vs cost per model.',
  ready: true,
  feeds: [workflowsFeed as Feed],
  render: (d, st) => `<div class="dp">${renderDispatch(d, st, snapOf())}</div>`,
  badge: d => String(last24h(buildDispatches(d.sessions, snapOf(), d.now), d.now) || ''),
  css: `
.dp .r { text-align: right; }
.dp .dp-note, .dp .dp-empty { font-size: 11px; margin: 4px 0 8px; }
.dp .dp-tw { overflow: auto; }
.dp .dp-t { font-size: 11px; margin-bottom: 8px; }
.dp .dp-t tr[data-select] { cursor: pointer; }
.dp .dp-t tr[data-select]:hover, .dp .dp-t tr.sel { background: var(--vscode-list-hoverBackground); }
.dp .dp-tm { white-space: nowrap; }
.dp .dp-p { max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dp .dp-l { max-width: 320px; overflow: hidden; text-overflow: ellipsis; }
.dp .dp-l .muted { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 10px; }
.dp .dp-k { font-size: 9px; text-transform: uppercase; letter-spacing: .04em; padding: 0 4px; border-radius: 3px; border: 1px solid var(--line); white-space: nowrap; }
.dp .dp-k-subagent { color: var(--claude); } .dp .dp-k-workflow { color: var(--accent); } .dp .dp-k-codex { color: var(--codex); }
.dp .dp-ty { display: inline-block; border-left: 3px solid var(--rc); padding: 0 5px; border-radius: 3px; background: color-mix(in srgb, var(--rc) 16%, transparent); white-space: nowrap; }
.dp .dp-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--c); margin-right: 4px; vertical-align: middle; }
.dp .dp-ok { color: var(--ok); } .dp .dp-bad { color: var(--bad); }
.dp .dp-cw { overflow: auto; border: 1px solid var(--line); border-radius: 6px; background: var(--raise); padding: 4px; margin-bottom: 8px; }
.dp .dp-c { display: block; font-size: 10px; }
.dp .dp-gl { stroke: var(--line); stroke-width: 1; }
.dp .dp-ax { fill: var(--vscode-descriptionForeground); }
.dp .dp-axt { fill: var(--vscode-descriptionForeground); font-size: 11px; }
.dp .dp-ln { fill: none; stroke: var(--c); stroke-width: 1.5; opacity: .7; }
.dp .dp-pt circle { fill: color-mix(in srgb, var(--c) 55%, transparent); stroke: var(--c); stroke-width: 1.5; }
.dp .dp-pt text { fill: var(--vscode-foreground); }
.dp .dp-few circle { fill: none; stroke-dasharray: 3 2; }
.dp .dp-few text { fill: var(--vscode-descriptionForeground); }
.dp .dp-gt { max-width: 980px; }
.dp code { font-size: 10px; }
`,
};
