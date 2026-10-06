// Add-on screen "Roles": which role each session played (recorded type, else title pattern) and how each
// role performs: table, scorecard, hand-off graph, file overlap between sessions, wave Gantt. Pure rendering.
import { duration } from '../../activity/activity';
import { compact, identityColor } from '../../activity/insights';
import {
  buildUnits, compileRules, DEFAULT_RULES, fileOverlap, FileOverlap, groupOf, handoffEdges, inPeriod, layers, OUTCOME_TEXT, OUTCOMES,
  RoleEdge, roleSlug, roleStats, RoleStats, RoleUnit,
} from '../../activity/roles';
import type { WorkflowsSnapshot } from '../../providers/claude/workflows';
import { base } from '../../activity/insights';
import { esc } from '../html';
import { kpi, WsData, WsState } from '../workspace';
import { Feed, feedValue } from './feeds';
import { ExtraView, opt, seg, toolbar } from './kit';
import { workflowsFeed } from './workflows';

const MAX_FILES = 40;
const MAX_COLS = 24;
const MAX_GANTT = 160;
const MAX_MEMBERS = 80;

const T_TOK = 'DERIVED: sum over model calls of prompt tokens incl. cache reads + output, as recorded per session / workflow agent';
const T_OUT = 'OBSERVED: output tokens recorded by the provider';
const T_COST = 'OBSERVED: cost recorded by Claude Code cost-state (count of units with a recorded cost); Codex and workflow agents record none';
const T_ACT = 'DERIVED: active time = sum of gaps < 5 min between events when recorded, else wall time';
const T_MED = 'DERIVED: median wall duration (start → last activity) of finished units';
const T_BASIS = 'OBSERVED = recorded worker / subagent / workflow agent type; INFERRED = title pattern (agent.roles.patterns) or lead / worker fallback';

const usd = (n: number) => `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`;
const OUT_COLOR: Record<string, string> = { committed: 'var(--ok)', changed: 'var(--accent)', nochange: 'var(--quiet)', unknown: 'var(--line)', live: 'var(--warn)' };

function roleChip(role: string): string {
  return `<span class="rl-chip" style="--rc:${identityColor(role)}">${esc(role)}</span>`;
}

function basisChip(u: RoleUnit): string {
  return `<span class="rl-b rl-b-${u.basis === 'OBSERVED' ? 'o' : 'i'}" title="${esc(`${u.basis}: ${u.basisText}`)}">${u.basis === 'OBSERVED' ? 'type' : 'guess'}</span>`;
}

const repoOfUnit = (u: RoleUnit) => (u.session ? base(u.session.repository) || base(u.session.cwd) : '') || '(no repo)';

function selAttr(u: RoleUnit, st: WsState): string {
  return u.session ? ` data-select="${esc(u.key)}" tabindex="0"${st.selected === u.key ? ' class="sel"' : ''}` : '';
}

// ---- (1) role table -------------------------------------------------------------------------------------

function roleTable(stats: RoleStats[], units: RoleUnit[], st: WsState, now: number): string {
  const focus = opt(st, 'roles.focus', '');
  const rows = stats.map(r => {
    const slug = roleSlug(r.role);
    const tests = r.pass + r.fail;
    return `<tr class="${slug === focus ? 'rl-on' : ''}">
<td><button class="link" data-opt="roles.focus" data-val="${esc(slug === focus ? '' : slug)}" title="Show the sessions of this role">${roleChip(r.role)}</button></td>
<td class="r" title="${esc(`${r.observed} OBSERVED type, ${r.inferred} INFERRED`)}">${r.units} <span class="muted">${r.observed ? `${r.observed}o` : ''}${r.inferred ? ` ${r.inferred}i` : ''}</span></td>
<td class="r">${r.live || ''}</td>
<td class="r" title="${esc(T_TOK)}">${compact(r.tokens)}</td>
<td class="r" title="${esc(T_OUT)}">${compact(r.output)}</td>
<td class="r" title="${esc(T_COST)}">${r.costUnits ? `${usd(r.cost)} <span class="muted">(${r.costUnits})</span>` : '—'}</td>
<td class="r" title="${esc(T_ACT)}">${duration(r.activeMs)}</td>
<td class="r">${r.commits || ''}</td>
<td class="r" title="OBSERVED test / build commands: pass / fail">${tests ? `<span class="rl-ok">${r.pass}</span> / <span class="${r.fail ? 'rl-bad' : ''}">${r.fail}</span>` : '—'}</td>
<td class="r" title="OBSERVED file edits recorded by the provider">${r.edits || ''}</td>
<td class="r" title="${esc(`${T_MED} (${r.finished} finished)`)}">${duration(r.medianMs)}</td>
</tr>`;
  }).join('');
  const head = `<tr><th title="${esc(T_BASIS)}">Role</th><th class="r" title="${esc(T_BASIS)}">Sessions</th><th class="r">Live</th><th class="r" title="${esc(T_TOK)}">Tokens Σ</th><th class="r" title="${esc(T_OUT)}">Output</th><th class="r" title="${esc(T_COST)}">Cost rec.</th><th class="r" title="${esc(T_ACT)}">Active</th><th class="r">Commits</th><th class="r">Tests ✓ / ✗</th><th class="r">Edits</th><th class="r" title="${esc(T_MED)}">Median dur.</th></tr>`;
  let h = `<table class="rl-t">${head}${rows}</table>`;
  const members = focus ? units.filter(u => roleSlug(u.role) === focus) : [];
  if (focus && members.length) {
    const list = [...members].sort((a, b) => (b.end ?? 0) - (a.end ?? 0)).slice(0, MAX_MEMBERS);
    h += `<h2>${roleChip(members[0].role)} · ${members.length} unit(s) <button class="link" data-opt="roles.focus" data-val="" title="Close">✕</button></h2>
<table class="rl-t rl-m"><tr><th>Session</th><th>Basis</th><th>Repo</th><th class="r">Tokens Σ</th><th class="r">Output</th><th class="r">Wall</th><th>Outcome</th><th>Ended</th></tr>${list
      .map(u => `<tr${selAttr(u, st)}><td class="rl-n" title="${esc(u.key)}"><span class="rl-pv" style="--pv:var(--${esc(u.provider)})"></span>${esc(u.label)}${u.session ? '' : ' <span class="muted" title="workflow agent not in the loaded session list">wf</span>'}</td><td>${basisChip(u)}</td><td>${esc(repoOfUnit(u))}</td><td class="r">${compact(u.tokens)}</td><td class="r">${compact(u.output)}</td><td class="r">${duration(u.start !== undefined && u.end !== undefined ? u.end - u.start : undefined)}</td><td><i class="rl-dot" style="--c:${OUT_COLOR[u.outcome]}"></i>${esc(OUTCOME_TEXT[u.outcome])}</td><td class="muted">${u.live ? 'live' : u.end ? `${duration(now - u.end)} ago` : '—'}</td></tr>`)
      .join('')}</table>${members.length > list.length ? `<div class="muted">… ${members.length - list.length} more</div>` : ''}`;
  }
  return h;
}

// ---- (2) scorecard --------------------------------------------------------------------------------------

function scorecard(stats: RoleStats[]): string {
  const rows = stats.map(r => {
    const segs = OUTCOMES.filter(o => r.mix[o]).map(o => `<i style="width:${(100 * r.mix[o]) / r.units}%;--c:${OUT_COLOR[o]}" title="${esc(`${OUTCOME_TEXT[o]}: ${r.mix[o]} of ${r.units}`)}"></i>`).join('');
    const t = r.pass + r.fail;
    const rate = t ? r.pass / t : undefined;
    const rateBar = rate === undefined ? '<span class="muted">no test observed</span>' : `<span class="rl-rate" title="${esc(`DERIVED: ${r.pass} pass / ${t} observed test runs`)}"><i style="width:${Math.round(rate * 100)}%;--c:${rate >= 0.8 ? 'var(--ok)' : rate >= 0.5 ? 'var(--warn)' : 'var(--bad)'}"></i></span> ${Math.round(rate * 100)}% <span class="muted">(${t})</span>`;
    const commitRate = r.finished ? `${(r.commits / Math.max(1, r.units)).toFixed(2)}` : '—';
    return `<tr><td>${roleChip(r.role)}</td><td class="r">${r.units}</td><td class="rl-mixc"><span class="rl-mix">${segs}</span></td><td>${rateBar}</td><td class="r" title="DERIVED: observed commits per unit">${commitRate}</td></tr>`;
  }).join('');
  const legend = `<div class="legend">${OUTCOMES.map(o => `<i class="rl-dot" style="--c:${OUT_COLOR[o]}"></i>${esc(OUTCOME_TEXT[o])}`).join(' ')} · outcome DERIVED from observed commits / edits; "not observed" = workflow agent known only from its journal</div>`;
  return `<table class="rl-t rl-sc"><tr><th>Role</th><th class="r">Units</th><th>Outcome mix</th><th>Test pass rate</th><th class="r">Commits / unit</th></tr>${rows}</table>${legend}`;
}

// ---- (3) hand-off graph ---------------------------------------------------------------------------------

function graph(edges: RoleEdge[], stats: RoleStats[], st: WsState): string {
  if (!edges.length) return '<div class="muted rl-empty">No parent → child link recorded in this period (workers record their parent session; workflow agents their run’s parent).</div>';
  const vertical = opt(st, 'roles.dir', 'lr') === 'tb';
  const nodes = [...new Set(edges.flatMap(e => [e.from, e.to]))];
  const lay = layers(nodes, edges);
  const byLayer = new Map<number, string[]>();
  const size = new Map(stats.map(s => [s.role, s.units]));
  for (const n of nodes.sort((a, b) => (size.get(b) ?? 0) - (size.get(a) ?? 0) || a.localeCompare(b))) {
    const l = lay.get(n)!;
    byLayer.set(l, [...(byLayer.get(l) ?? []), n]);
  }
  const NW = 150, NH = 30, GAP_L = 110, GAP_N = 22;
  const nLayers = Math.max(...byLayer.keys()) + 1;
  const maxIn = Math.max(...[...byLayer.values()].map(v => v.length));
  const along = (l: number) => 10 + l * ((vertical ? NH : NW) + GAP_L);
  const across = (i: number) => 10 + i * ((vertical ? NW : NH) + GAP_N);
  const pos = new Map<string, { x: number; y: number }>();
  for (const [l, list] of byLayer) list.forEach((n, i) => pos.set(n, vertical ? { x: across(i), y: along(l) } : { x: along(l), y: across(i) }));
  const W = vertical ? across(maxIn) : along(nLayers) - GAP_L + 20;
  const H = vertical ? along(nLayers) - GAP_L + 20 : across(maxIn);
  const maxC = Math.max(...edges.map(e => e.count));
  const paths = edges.map(e => {
    const a = pos.get(e.from)!, b = pos.get(e.to)!;
    const w = 1 + (4 * e.count) / maxC;
    const tip = esc(`${e.from} → ${e.to}: ${e.count} child unit(s) (OBSERVED parent link)`);
    if (e.from === e.to) {
      const x = a.x + NW, y = a.y + NH / 2;
      const d = vertical ? `M${a.x + NW - 20},${a.y + NH} c 0,24 30,24 20,0` : `M${x},${y - 6} c 26,-16 26,28 0,12`;
      return `<g class="rl-e"><title>${tip}</title><path d="${d}" stroke-width="${w.toFixed(1)}"/><text x="${vertical ? a.x + NW - 6 : x + 24}" y="${vertical ? a.y + NH + 26 : y + 4}">↻${e.count}</text></g>`;
    }
    const [x1, y1, x2, y2] = vertical ? [a.x + NW / 2, a.y + NH, b.x + NW / 2, b.y] : [a.x + NW, a.y + NH / 2, b.x, b.y + NH / 2];
    const back = vertical ? y2 <= y1 : x2 <= x1;
    const d = vertical ? `M${x1},${y1} C${x1},${(y1 + y2) / 2 + (back ? 60 : 0)} ${x2},${(y1 + y2) / 2 - (back ? 60 : 0)} ${x2},${y2}` : `M${x1},${y1} C${(x1 + x2) / 2 + (back ? 60 : 0)},${y1} ${(x1 + x2) / 2 - (back ? 60 : 0)},${y2} ${x2},${y2}`;
    return `<g class="rl-e"><title>${tip}</title><path d="${d}" stroke-width="${w.toFixed(1)}" marker-end="url(#rl-ar)"/><text x="${((x1 + x2) / 2).toFixed(0)}" y="${((y1 + y2) / 2 - 3).toFixed(0)}">${e.count}</text></g>`;
  }).join('');
  const boxes = nodes.map(n => {
    const p = pos.get(n)!;
    const label = n.length > 20 ? `${n.slice(0, 19)}…` : n;
    return `<g class="rl-nd"><title>${esc(`${n}: ${size.get(n) ?? 0} unit(s) in this period`)}</title><rect x="${p.x}" y="${p.y}" width="${NW}" height="${NH}" rx="6" style="--rc:${identityColor(n)}"/><text x="${p.x + NW / 2}" y="${p.y + NH / 2 + 4}">${esc(label)}${size.get(n) ? ` · ${size.get(n)}` : ''}</text></g>`;
  }).join('');
  const table = `<table class="rl-t rl-et"><tr><th>Parent role</th><th>Child role</th><th class="r">Links</th></tr>${edges.map(e => `<tr><td>${roleChip(e.from)}</td><td>${roleChip(e.to)}</td><td class="r">${e.count}</td></tr>`).join('')}</table>`;
  return `<div class="rl-gw"><svg class="rl-g" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Role hand-off graph"><defs><marker id="rl-ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z"/></marker></defs>${paths}${boxes}</svg></div>${table}<div class="legend">Edge = a unit of the child role whose recorded parent has the parent role; width ∝ count. Parent link OBSERVED, roles as in the Role table.</div>`;
}

// ---- (4) file overlap -----------------------------------------------------------------------------------

function overlapView(ov: FileOverlap[], units: RoleUnit[], st: WsState): string {
  const onlyConc = opt(st, 'roles.files', 'concurrent') === 'concurrent';
  const list = (onlyConc ? ov.filter(f => f.concurrentPairs.length) : ov).slice(0, MAX_FILES);
  if (!list.length) return `<div class="muted rl-empty">${onlyConc ? 'No file edited by two sessions with overlapping time windows in this period.' : 'No file edited by two or more sessions in this period.'} Edits come from provider-recorded file edits.</div>`;
  const byKey = new Map(units.map(u => [u.key, u]));
  const colKeys: string[] = [];
  for (const f of list) for (const k of f.edits.keys()) if (!colKeys.includes(k)) colKeys.push(k);
  const cols = colKeys.slice(0, MAX_COLS).map(k => byKey.get(k)!).filter(Boolean);
  const max = Math.max(...list.flatMap(f => [...f.edits.values()]));
  const head = `<tr><th>File</th><th title="DERIVED: two sessions edited this file and their session windows overlap">Concurrent</th>${cols.map(u => `<th class="rl-hc"${u.session ? ` data-select="${esc(u.key)}"` : ''} title="${esc(`${u.label} · ${u.role} · ${u.key}`)}"><span style="--rc:${identityColor(u.role)}">${esc(u.label.slice(0, 14))}</span></th>`).join('')}</tr>`;
  const rows = list.map(f => {
    const conc = new Set(f.concurrentPairs.flat());
    const p = f.path.length > 60 ? `…${f.path.slice(-59)}` : f.path;
    return `<tr><td class="rl-fp" title="${esc(f.path)}">${esc(p)}</td><td>${f.concurrentPairs.length ? `<span class="rl-flag" title="${esc(`DERIVED: ${f.concurrentPairs.length} pair(s) of sessions with overlapping windows edited this file`)}">concurrent edits · ${f.concurrentPairs.length}</span>` : '<span class="muted">sequential</span>'}</td>${cols
      .map(u => {
        const n = f.edits.get(u.key);
        if (!n) return '<td class="rl-c"></td>';
        const a = 0.2 + (0.8 * n) / max;
        return `<td class="rl-c${conc.has(u.key) ? ' rl-cc' : ''}"${u.session ? ` data-select="${esc(u.key)}"` : ''} title="${esc(`${u.label}: ${n} edit(s) of this file (OBSERVED)${conc.has(u.key) ? ' · overlapping window with another editor (DERIVED)' : ''}`)}" style="--a:${a.toFixed(2)}">${n}</td>`;
      })
      .join('')}</tr>`;
  }).join('');
  const more = ov.length > list.length || colKeys.length > cols.length ? `<div class="muted">Showing ${list.length} file(s) × ${cols.length} session(s) (caps ${MAX_FILES} × ${MAX_COLS}).</div>` : '';
  return `<div class="rl-hw"><table class="rl-t rl-hm">${head}${rows}</table></div>${more}<div class="legend">Cell = edits of the file by that session (OBSERVED). Outlined cells: the session window (start → last activity) overlaps another editor’s window (DERIVED, not proof of a conflict).</div>`;
}

// ---- (5) wave Gantt -------------------------------------------------------------------------------------

function gantt(units: RoleUnit[], st: WsState, now: number): string {
  const timed = units.filter(u => u.start !== undefined);
  if (!timed.length) return '<div class="muted rl-empty">No timed session in this period.</div>';
  const byKey = new Map(units.map(u => [u.key, u]));
  const groups = new Map<string, { label: string; kind: string; units: RoleUnit[] }>();
  for (const u of timed) {
    const g = groupOf(u, byKey);
    const e = groups.get(g.id) ?? { label: g.label, kind: g.kind, units: [] };
    e.units.push(u);
    groups.set(g.id, e);
  }
  const ordered = [...groups.values()].sort((a, b) => Math.max(...b.units.map(u => u.end ?? 0)) - Math.max(...a.units.map(u => u.end ?? 0)));
  const t0 = Math.min(...timed.map(u => u.start!));
  const t1 = Math.max(now, ...timed.map(u => u.end ?? u.start!));
  const span = Math.max(60_000, t1 - t0);
  const pct = (t: number) => ((t - t0) / span) * 100;
  let n = 0;
  let body = '';
  for (const g of ordered) {
    if (n >= MAX_GANTT) break;
    const rows = [...g.units].sort((a, b) => a.start! - b.start!);
    body += `<div class="rl-gh"><span>${g.kind === 'run' ? '⧉ ' : ''}${esc(g.label)}</span><span class="muted">${rows.length} unit(s)</span></div>`;
    for (const u of rows) {
      if (n++ >= MAX_GANTT) break;
      const l = pct(u.start!), w = Math.max(0.4, pct(u.end ?? u.start!) - l);
      body += `<div class="rl-gr${st.selected === u.key ? ' sel' : ''}"${u.session ? ` data-select="${esc(u.key)}"` : ''}><span class="rl-gl" title="${esc(`${u.label} · ${u.key}`)}">${u.parentKey ? '<span class="muted">↳</span> ' : ''}${esc(u.label)}</span><span class="rl-gt"><i class="rl-gb${u.live ? ' rl-live' : ''}" style="left:${l.toFixed(2)}%;width:${w.toFixed(2)}%;--rc:${identityColor(u.role)}" title="${esc(`${u.role} (${u.basis}) · ${duration((u.end ?? u.start!) - u.start!)} · ${compact(u.tokens)} tokens Σ`)}"></i></span></div>`;
    }
  }
  const roles = [...new Set(timed.map(u => u.role))].slice(0, 16);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => `<span style="left:${f * 100}%">${esc(new Date(t0 + f * span).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}</span>`).join('');
  return `<div class="rl-gan"><div class="rl-gr rl-ax"><span></span><span class="rl-gt">${ticks}<i class="rl-now" style="left:${pct(now).toFixed(2)}%"></i></span></div>${body}</div>${n > MAX_GANTT ? `<div class="muted">First ${MAX_GANTT} units.</div>` : ''}<div class="legend">${roles.map(r => roleChip(r)).join(' ')} · grouped by workflow run, else by the top of the recorded parent chain · start / last activity OBSERVED, live bars run to now</div>`;
}

// ---- screen ---------------------------------------------------------------------------------------------

export function renderRoles(d: WsData, st: WsState, snap: WorkflowsSnapshot | undefined): string {
  const tab = opt(st, 'roles.tab', 'table');
  const period = opt(st, 'roles.period', '7d');
  const rules = compileRules(d.config?.('agent.roles.patterns', DEFAULT_RULES) ?? DEFAULT_RULES);
  const all = buildUnits(d.sessions, snap, { rules, now: d.now });
  const units = inPeriod(all, period, d.now);
  const stats = roleStats(units);
  const bar = toolbar(
    seg(st, 'roles.tab', [['table', 'Role table'], ['score', 'Scorecard'], ['graph', 'Hand-off graph'], ['files', 'File overlap'], ['gantt', 'Wave Gantt']], 'table', 'View'),
    seg(st, 'roles.period', [['24h', '24 h'], ['7d', '7 d'], ['30d', '30 d'], ['all', 'All loaded']], '7d', 'Period (units active in it)'),
    tab === 'graph' ? seg(st, 'roles.dir', [['lr', 'Left → right'], ['tb', 'Top → down']], 'lr', 'Layout') : '',
    tab === 'files' ? seg(st, 'roles.files', [['concurrent', 'Concurrent only'], ['shared', 'All shared files']], 'concurrent', 'Files') : '',
  );
  const observed = units.filter(u => u.basis === 'OBSERVED').length;
  const wf = units.filter(u => !u.session).length;
  const k = `<div class="kpis">${kpi(stats.length, 'Roles')}${kpi(units.length, 'Units', '', 'sessions plus workflow agents not in the session list')}${kpi(observed, 'Typed', '', 'role from a recorded type (OBSERVED)')}${kpi(units.length - observed, 'Guessed', '', 'role from a title pattern or the lead / worker fallback (INFERRED)')}${kpi(units.filter(u => u.live).length, 'Live')}${wf ? kpi(wf, 'Workflow agents', '', 'from the workflow journal, not in the loaded session list') : ''}</div>`;
  const note = snap ? '' : '<div class="muted rl-note">Workflow scan pending: workflow agent types appear when it lands; sessions shown meanwhile.</div>';
  if (!units.length) return `${bar}${note}<div class="muted rl-empty">No session in this period.</div>`;
  let body: string;
  if (tab === 'score') body = scorecard(stats);
  else if (tab === 'graph') body = graph(handoffEdges(units, all), stats, st);
  else if (tab === 'files') body = overlapView(fileOverlap(units, repoOfUnit), units, st);
  else if (tab === 'gantt') body = gantt(units, st, d.now);
  else body = roleTable(stats, units, st, d.now);
  return `${bar}${note}${k}${body}<div class="legend rl-rules">Role = recorded worker / subagent / workflow agent type (OBSERVED), else the first title pattern of <code>agent.roles.patterns</code> (INFERRED: ${esc(rules.map(r => `/${r.match}/ → ${r.role}`).join(', ') || 'none')}), else lead / worker.</div>`;
}

export const rolesView: ExtraView = {
  id: 'roles',
  label: 'Roles',
  group: 'Agents',
  hint: 'Which role each session played (recorded type or title pattern) and how each role performs.',
  ready: true,
  feeds: [workflowsFeed as Feed],
  render: (d, st) => `<div class="rl">${renderRoles(d, st, feedValue<WorkflowsSnapshot>(workflowsFeed.id).value)}</div>`,
  css: `
.rl .r { text-align: right; }
.rl .rl-note, .rl .rl-empty { font-size: 11px; margin: 4px 0 8px; }
.rl .rl-t { font-size: 11px; margin-bottom: 8px; }
.rl .rl-t tr[data-select] { cursor: pointer; }
.rl .rl-t tr[data-select]:hover, .rl .rl-t tr.sel, .rl .rl-t tr.rl-on { background: var(--vscode-list-hoverBackground); }
.rl .rl-chip { display: inline-block; border-left: 3px solid var(--rc); padding: 0 5px; border-radius: 3px; background: color-mix(in srgb, var(--rc) 16%, transparent); white-space: nowrap; }
.rl .rl-b { font-size: 9px; text-transform: uppercase; letter-spacing: .04em; padding: 0 4px; border-radius: 3px; border: 1px solid var(--line); }
.rl .rl-b-o { color: var(--ok); } .rl .rl-b-i { color: var(--warn); }
.rl .rl-ok { color: var(--ok); } .rl .rl-bad { color: var(--bad); }
.rl .rl-n { max-width: 340px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rl .rl-pv { display: inline-block; width: 3px; height: 10px; margin-right: 4px; background: var(--pv); vertical-align: middle; }
.rl .rl-dot { display: inline-block; width: 8px; height: 8px; border-radius: 2px; background: var(--c); margin: 0 3px 0 4px; vertical-align: middle; }
.rl .rl-mixc { width: 40%; }
.rl .rl-mix, .rl .rl-rate { display: inline-flex; width: 100%; height: 10px; border-radius: 3px; overflow: hidden; background: color-mix(in srgb, var(--line) 50%, transparent); vertical-align: middle; }
.rl .rl-rate { width: 90px; }
.rl .rl-mix i, .rl .rl-rate i { display: block; height: 100%; background: var(--c); }
.rl .rl-gw { overflow: auto; border: 1px solid var(--line); border-radius: 6px; background: var(--raise); padding: 4px; margin-bottom: 8px; }
.rl .rl-g { display: block; font-size: 11px; }
.rl .rl-g rect { fill: color-mix(in srgb, var(--rc) 22%, var(--vscode-editor-background)); stroke: var(--rc); }
.rl .rl-g .rl-nd text { fill: var(--vscode-foreground); text-anchor: middle; }
.rl .rl-g .rl-e path { fill: none; stroke: var(--vscode-descriptionForeground); opacity: .7; }
.rl .rl-g .rl-e text { fill: var(--vscode-descriptionForeground); font-size: 10px; text-anchor: middle; }
.rl .rl-g marker path { fill: var(--vscode-descriptionForeground); }
.rl .rl-et { max-width: 420px; }
.rl .rl-hw { overflow: auto; }
.rl .rl-hm th.rl-hc { writing-mode: vertical-rl; transform: rotate(180deg); max-height: 110px; font-weight: normal; cursor: pointer; }
.rl .rl-hm th.rl-hc span { border-right: 3px solid var(--rc); padding-right: 2px; }
.rl .rl-fp { font-family: var(--vscode-editor-font-family); white-space: nowrap; }
.rl .rl-c { text-align: center; min-width: 18px; }
.rl .rl-c[data-select] { background: color-mix(in srgb, var(--accent) calc(var(--a) * 100%), transparent); cursor: pointer; }
.rl .rl-cc { outline: 2px solid var(--warn); outline-offset: -2px; }
.rl .rl-flag { color: var(--warn); white-space: nowrap; }
.rl .rl-gan { border: 1px solid var(--line); border-radius: 6px; background: var(--raise); padding: 4px 0; font-size: 11px; }
.rl .rl-gh { display: flex; gap: 8px; padding: 4px 6px 1px; font-weight: 600; border-top: 1px solid var(--line); }
.rl .rl-gh:first-of-type { border-top: none; }
.rl .rl-gr { display: grid; grid-template-columns: 240px 1fr; align-items: center; min-height: 16px; }
.rl .rl-gr[data-select] { cursor: pointer; }
.rl .rl-gr[data-select]:hover, .rl .rl-gr.sel { background: var(--vscode-list-hoverBackground); }
.rl .rl-gl { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-left: 10px; }
.rl .rl-gt { position: relative; height: 12px; margin-right: 8px; }
.rl .rl-gb { position: absolute; top: 2px; height: 8px; border-radius: 3px; background: var(--rc); }
.rl .rl-gb.rl-live { box-shadow: 0 0 0 1px var(--ok); }
.rl .rl-ax { border-bottom: 1px solid var(--line); min-height: 18px; }
.rl .rl-ax span[style] { position: absolute; top: 0; transform: translateX(-50%); font-size: 10px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
.rl .rl-ax span[style="left:0%"] { transform: none; } .rl .rl-ax span[style="left:100%"] { transform: translateX(-100%); }
.rl .rl-now { position: absolute; top: 0; bottom: -4px; width: 0; border-left: 2px solid var(--bad); }
.rl .rl-rules code { font-size: 10px; }
`,
};
