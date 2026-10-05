// Add-on screen "Topology": lead → workers → nested workers, collapsible, with DERIVED rollups.
// Layouts: outline tree, dense indented list, org chart (vertical or horizontal). Pure rendering.
import type { AgentSessionSnapshot } from '../../model';
import { duration } from '../../activity/activity';
import { compact, identityColor, isLive, outcome } from '../../activity/insights';
import { buildTree, leads, orphans, orphanTree, pathTo, Rollup, shortId, SortBy, TopoNode, wallMs } from '../../activity/topology';
import { esc } from '../html';
import { statusText } from '../views';
import { kpi, prettyModel, repoOf, teamRoot, titleOf, WsData, WsState } from '../workspace';
import { ExtraView, opt, seg, toolbar } from './kit';

const MAX_KIDS = 60;
const MAX_LEADS = 12;
const MAX_ORPHANS = 6;

type Layout = 'tree' | 'list' | 'org';
type Metric = 'tokens' | 'time' | 'files' | 'none';

interface Ctx {
  d: WsData;
  st: WsState;
  limit: number;
  tag: string;
  forced: Set<string>;
  metric: Metric;
  max: number;
}

const usd = (n: number) => `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`;

function metricOf(n: TopoNode, m: Metric, now: number): number {
  if (!n.s) return 0;
  if (m === 'tokens') return n.s.usage?.totalTokens ?? 0;
  if (m === 'time') return wallMs(n.s, now) ?? 0;
  if (m === 'files') return n.s.changedFiles.length;
  return 0;
}

function maxMetric(n: TopoNode, m: Metric, now: number): number {
  return Math.max(metricOf(n, m, now), ...n.children.map(c => maxMetric(c, m, now)));
}

function toggled(c: Ctx, n: TopoNode): boolean {
  return opt(c.st, `topology.c.${shortId(n.key)}`, '') === c.tag;
}

function open(c: Ctx, n: TopoNode, level: number): boolean {
  if (!n.children.length) return false;
  return (level < c.limit || c.forced.has(n.key)) !== toggled(c, n);
}

/** Expand / collapse button; stores a per-node option tagged with the current depth so a depth change resets it. */
function fold(c: Ctx, n: TopoNode, isOpen: boolean): string {
  if (!n.children.length) return '<span class="tp-f"></span>';
  const hidden = n.roll.sessions - (n.s ? 1 : 0);
  return `<button class="tp-f" data-opt="topology.c.${esc(shortId(n.key))}" data-val="${toggled(c, n) ? '' : esc(c.tag)}" title="${isOpen ? 'Collapse' : `Expand ${hidden} session(s) below`}" aria-expanded="${isOpen}">${isOpen ? '▾' : `▸<i>${hidden}</i>`}</button>`;
}

function name(n: TopoNode): string {
  return n.s ? titleOf(n.s) : n.label ?? n.key;
}

function dot(n: TopoNode): string {
  return n.s ? `<span class="dot ${esc(n.s.status)}" title="${esc(`${statusText(n.s)} — ${n.s.statusReason}`)}"></span>` : `<span class="tp-gd" title="${n.key.startsWith('orphan:') ? 'Workers whose recorded parent is outside the loaded history' : 'Siblings grouped by recorded worker role'}"></span>`;
}

function roleChip(n: TopoNode): string {
  if (!n.role || !n.s) return '';
  return `<span class="tp-role" style="--rc:${identityColor(n.role)}" title="worker type as recorded by the provider (OBSERVED)">${esc(n.role)}</span>`;
}

function who(s: AgentSessionSnapshot | undefined): string {
  if (!s) return '';
  return [prettyModel(s.model), s.effort].filter(Boolean).join(' · ');
}

/** One-line result from observed facts only. */
function result(n: TopoNode, now: number): string {
  const s = n.s;
  if (!s) {
    const r = n.roll;
    return [`${r.sessions} session(s)`, r.live ? `${r.live} live` : '', r.files ? `${r.files} file(s)` : '', r.commits ? `${r.commits} commit(s)` : ''].filter(Boolean).join(' · ');
  }
  const tests = s.tests.length ? ` · tests ${s.tests.filter(t => t.outcome === 'PASS').length}/${s.tests.length}` : '';
  const o = outcome(s);
  if (o === 'live') {
    const ct = s.facts?.currentTool;
    if (ct) return `▸ ${ct.name}${ct.detail ? ` ${ct.detail}` : ''} · ${duration(now - ct.startedAt)}${tests}`;
    return `${s.lastAction ? `▸ ${s.lastAction}` : statusText(s)}${tests}`;
  }
  if (o === 'committed') {
    const last = s.commits[s.commits.length - 1];
    return `✓ ${s.commits.length} commit(s): ${last.subject}${tests}`;
  }
  if (o === 'changed') return `${s.changedFiles.length} file(s) edited, no commit${tests}`;
  return `${s.lastAction ? `last: ${s.lastAction}` : 'no file change observed'}${tests}`;
}

function resultTitle(n: TopoNode): string {
  if (!n.s) return 'DERIVED: rollup of the grouped sessions';
  const o = outcome(n.s);
  return o === 'live' ? (n.s.facts?.currentTool ? 'OBSERVED: tool call with no recorded result yet' : 'OBSERVED: latest recorded action') : o === 'committed' ? 'DERIVED: commit observed in git during the session window' : 'OBSERVED: provider-recorded file edits / actions';
}

function tokens(n: TopoNode): { own: string; sum: string } {
  const ownT = n.s?.usage?.totalTokens;
  return {
    own: n.s ? (ownT !== undefined ? compact(ownT) : '—') : '',
    sum: n.children.length ? compact(n.roll.tokens) : '',
  };
}

function cost(n: TopoNode, rolled: boolean): string {
  if (rolled) return n.roll.costSessions ? usd(n.roll.costUSD) : '—';
  const c = n.s?.usage?.costUSD;
  return c !== undefined ? usd(c) : '—';
}

function wall(n: TopoNode, now: number): string {
  if (n.s) return duration(wallMs(n.s, now));
  return n.roll.start !== undefined && n.roll.end !== undefined ? duration(n.roll.end - n.roll.start) : '—';
}

function bar(c: Ctx, n: TopoNode): string {
  if (c.metric === 'none' || !c.max || !n.s) return '';
  const v = metricOf(n, c.metric, c.d.now);
  const pct = Math.max(v ? 2 : 0, Math.round((100 * v) / c.max));
  return `<span class="tp-bar" title="${esc(`${c.metric}: share of the largest session in this tree`)}"><i style="width:${pct}%"></i></span>`;
}

const T_TOK = 'tokens recorded by the provider for this session (OBSERVED)';
const T_SUM = 'Σ subtree: sum of each session’s recorded total (DERIVED)';
const T_COST = 'cost recorded by Claude Code cost-state (OBSERVED); — = not recorded (UNKNOWN, Codex records none)';
const T_WALL = 'wall time start → end, or now while live (DERIVED)';

function provVar(n: TopoNode): string {
  return n.s ? `var(--${n.s.provider})` : 'var(--line)';
}

function selAttrs(c: Ctx, n: TopoNode, cls: string): string {
  const sel = n.s && c.st.selected === n.key ? ' tp-sel' : '';
  const live = n.s && isLive(n.s) ? ' tp-live' : '';
  return `class="${cls}${sel}${live}${n.s ? '' : ' tp-grp'}" style="--pv:${provVar(n)};--id:${identityColor(n.s ? repoOf(n.s) : n.role ?? 'group')}"${n.s ? ` data-select="${esc(n.key)}" tabindex="0"` : ''}`;
}

function kidsSlice(n: TopoNode): { shown: TopoNode[]; more: number } {
  return { shown: n.children.slice(0, MAX_KIDS), more: Math.max(0, n.children.length - MAX_KIDS) };
}

const moreNote = (more: number) => (more ? `<li class="tp-more">… ${more} more (raise depth or change sort)</li>` : '');

// ---------------------------------------------------------------- outline tree

function treeNode(c: Ctx, n: TopoNode, level: number): string {
  const isOpen = open(c, n, level);
  const t = tokens(n);
  const sub = [n.spawn ? `<span class="tp-spawn" title="INFERRED: parent's spawn call of the same type just before this worker started">“${esc(n.spawn)}”</span>` : '', `<span title="${esc(resultTitle(n))}">${esc(result(n, c.d.now))}</span>`].filter(Boolean).join(' ');
  const row = `<div ${selAttrs(c, n, 'tp-row')}>${fold(c, n, isOpen)}<div class="tp-m"><div class="tp-l1">${dot(n)}<b>${esc(name(n))}</b>${roleChip(n)}<span class="tp-who">${esc(who(n.s))}</span></div><div class="tp-l2">${sub}</div></div><div class="tp-n"><span title="${T_TOK}">${esc(t.own)}</span><span class="tp-sum" title="${T_SUM}">${t.sum ? `Σ ${esc(t.sum)}` : ''}</span><span title="${T_COST}">${esc(cost(n, !n.s))}</span><span title="${T_WALL}">${esc(wall(n, c.d.now))}</span>${bar(c, n)}</div></div>`;
  if (!isOpen) return `<li>${row}</li>`;
  const next = n.s ? level + 1 : level;
  const { shown, more } = kidsSlice(n);
  return `<li>${row}<ul>${shown.map(k => treeNode(c, k, next)).join('')}${moreNote(more)}</ul></li>`;
}

// ---------------------------------------------------------------- dense list

function listRows(c: Ctx, n: TopoNode, level: number, indent: number, out: string[]): void {
  const isOpen = open(c, n, level);
  const s = n.s;
  const t = tokens(n);
  const tests = s ? `${s.tests.filter(x => x.outcome === 'PASS').length}/${s.tests.length}` : `${n.roll.testsPass}/${n.roll.testsPass + n.roll.testsFail}`;
  const active = s?.facts?.activeMs !== undefined ? duration(s.facts.activeMs) : '—';
  out.push(`<tr ${selAttrs(c, n, 'tp-tr')}><td class="tp-nm" style="padding-left:${4 + indent * 14}px">${fold(c, n, isOpen)}${dot(n)} <b>${esc(name(n))}</b>${n.spawn ? ` <span class="tp-spawn" title="INFERRED spawn description">“${esc(n.spawn)}”</span>` : ''}</td><td>${s ? esc(s.status.toLowerCase().replace('_', ' ')) : ''}</td><td>${roleChip(n)}${s && !s.isWorker ? '<span class="tp-lead">lead</span>' : ''}</td><td class="tp-who">${esc(who(s))}</td><td class="r" title="${T_TOK}">${esc(t.own)}</td><td class="r tp-sum" title="${T_SUM}">${esc(t.sum)}</td><td class="r" title="${T_COST}">${esc(cost(n, !s))}</td><td class="r" title="${T_WALL}">${esc(wall(n, c.d.now))}</td><td class="r" title="active time: sum of gaps under 5 min (DERIVED)">${esc(active)}</td><td class="r">${s ? s.changedFiles.length || '' : n.roll.files || ''}</td><td class="r">${s ? s.commits.length || '' : n.roll.commits || ''}</td><td class="r${(s ? s.tests.some(x => x.outcome === 'FAIL') : n.roll.testsFail) ? ' tp-bad' : ''}">${tests === '0/0' ? '' : esc(tests)}</td><td class="tp-res" title="${esc(resultTitle(n))}">${esc(result(n, c.d.now))}</td><td>${bar(c, n)}</td></tr>`);
  if (!isOpen) return;
  const { shown, more } = kidsSlice(n);
  for (const k of shown) listRows(c, k, n.s ? level + 1 : level, indent + 1, out);
  if (more) out.push(`<tr class="tp-tr"><td colspan="14" class="tp-more" style="padding-left:${4 + (indent + 1) * 14}px">… ${more} more</td></tr>`);
}

function list(c: Ctx, root: TopoNode): string {
  const rows: string[] = [];
  listRows(c, root, 0, 0, rows);
  return `<div class="tp-tw"><table class="tp-tab"><thead><tr><th>Session</th><th>Status</th><th>Role</th><th>Model</th><th class="r">Tokens</th><th class="r">Σ tokens</th><th class="r">Cost</th><th class="r">Wall</th><th class="r">Active</th><th class="r">Files</th><th class="r">Commits</th><th class="r">Tests</th><th>Result</th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

// ---------------------------------------------------------------- org chart

function orgNode(c: Ctx, n: TopoNode, level: number): string {
  const isOpen = open(c, n, level);
  const t = tokens(n);
  const nums = [t.own && t.own !== '—' ? `<span title="${T_TOK}">${esc(t.own)}</span>` : '', t.sum ? `<span class="tp-sum" title="${T_SUM}">Σ ${esc(t.sum)}</span>` : '', `<span title="${T_WALL}">${esc(wall(n, c.d.now))}</span>`, cost(n, !n.s) !== '—' ? `<span title="${T_COST}">${esc(cost(n, !n.s))}</span>` : ''].filter(Boolean).join(' · ');
  const box = `<div ${selAttrs(c, n, 'tp-box')}><div class="tp-l1">${dot(n)}<b>${esc(name(n))}</b>${fold(c, n, isOpen)}</div><div class="tp-l1">${roleChip(n)}<span class="tp-who">${esc(who(n.s))}</span></div><div class="tp-nums">${nums}</div>${n.spawn ? `<div class="tp-spawn" title="INFERRED spawn description">“${esc(n.spawn)}”</div>` : ''}<div class="tp-res2" title="${esc(resultTitle(n))}">${esc(result(n, c.d.now))}</div>${bar(c, n)}</div>`;
  if (!isOpen) return `<li>${box}</li>`;
  const next = n.s ? level + 1 : level;
  const { shown, more } = kidsSlice(n);
  return `<li>${box}<ul>${shown.map(k => orgNode(c, k, next)).join('')}${moreNote(more)}</ul></li>`;
}

// ---------------------------------------------------------------- page

function rollKpis(r: Rollup, root: TopoNode, now: number): string {
  const workers = r.sessions - (root.s ? 1 : 0);
  const span = r.start !== undefined && r.end !== undefined ? duration(r.end - r.start) : '—';
  return `<div class="kpis tp-k">${kpi(workers, 'workers', '', 'sessions below the lead with a recorded parent (OBSERVED edges)')}${kpi(r.live, 'live', r.live ? 'k-run' : '')}${kpi(r.depth, 'depth', '', 'deepest nesting level (DERIVED)')}${kpi(compact(r.tokens), 'Σ tokens', '', T_SUM)}${kpi(r.costSessions ? usd(r.costUSD) : '—', 'Σ cost', '', `${T_COST}; ${r.costSessions} session(s) recorded a cost`)}${kpi(span, 'span', '', 'earliest start → latest activity in the tree (DERIVED)')}${kpi(r.files, 'files', '', 'files edited, summed per session (OBSERVED, may double-count shared files)')}${kpi(r.commits, 'commits')}${kpi(`${r.testsPass}/${r.testsPass + r.testsFail}`, 'tests pass', r.testsFail ? 'k-fail' : '')}</div>`;
}

function section(c: Ctx, root: TopoNode, layout: Layout, orient: string): string {
  c.forced = new Set(pathTo(root, c.st.selected).slice(0, -1));
  c.max = c.metric === 'none' ? 0 : maxMetric(root, c.metric, c.d.now);
  const s = root.s;
  const head = `<div class="tp-h" style="--pv:${provVar(root)}">${dot(root)}<b>${esc(name(root))}</b><span class="muted">${esc([s ? repoOf(s) : '', s?.branch ?? '', who(s)].filter(Boolean).join(' · '))}</span></div>${rollKpis(root.roll, root, c.d.now)}`;
  let body: string;
  if (layout === 'list') body = list(c, root);
  else if (layout === 'org' || orient === 'horizontal') body = `<div class="tp-ow"><ul class="tp-org ${orient === 'horizontal' ? 'tp-hz' : 'tp-vt'}">${orgNode(c, root, 0)}</ul></div>`;
  else body = `<ul class="tp-tree">${treeNode(c, root, 0)}</ul>`;
  return `<section class="tp-sec">${head}${body}</section>`;
}

function render(d: WsData, st: WsState): string {
  const layout = opt(st, 'topology.layout', 'tree') as Layout;
  const orient = opt(st, 'topology.orient', 'vertical');
  const depth = opt(st, 'topology.depth', 'all');
  const roots = opt(st, 'topology.roots', 'one');
  const grp = opt(st, 'topology.group', 'auto');
  const sort = opt(st, 'topology.sort', 'start') as SortBy;
  const metric = opt(st, 'topology.bar', 'tokens') as Metric;
  const grpd = (t: string, control: string) => `<span class="tp-tg"><span class="tp-lb">${t}</span>${control}</span>`;
  const tb = toolbar(
    grpd('layout', seg(st, 'topology.layout', [['tree', 'Tree'], ['list', 'List'], ['org', 'Org chart']], 'tree', 'Outline tree, dense indented table, or org chart')),
    grpd('direction', seg(st, 'topology.orient', [['vertical', 'Vertical'], ['horizontal', 'Horizontal']], 'vertical', 'Org chart / tree direction: top-down or left-to-right')),
    grpd('depth', seg(st, 'topology.depth', [['1', '1'], ['2', '2'], ['all', 'All']], 'all', 'Levels expanded by default; ▸ / ▾ toggles one node')),
    grpd('show', seg(st, 'topology.roots', [['one', 'Selected lead'], ['all', 'All leads']], 'one')),
    grpd('group', seg(st, 'topology.group', [['auto', 'Auto'], ['role', 'By role'], ['none', 'None']], 'auto', 'Group siblings by recorded worker role (Auto: above 8 siblings)')),
    grpd('sort', seg(st, 'topology.sort', [['start', 'Start'], ['tokens', 'Tokens'], ['live', 'Live first']], 'start')),
    grpd('bar', seg(st, 'topology.bar', [['tokens', 'Tokens'], ['time', 'Time'], ['files', 'Files'], ['none', 'Off']], 'tokens', 'Size bar per session, relative to the largest one in the tree')),
  );
  const o = { now: d.now, sort, groupAbove: grp === 'none' ? 0 : grp === 'role' ? 1 : 8 };
  const c: Ctx = { d, st, limit: depth === 'all' ? Infinity : Number(depth) || 1, tag: `d${depth}`, forced: new Set(), metric, max: 0 };
  const ls = leads(d.sessions);
  const orph = [...orphans(d.sessions)].sort((a, b) => Math.max(...b[1].map(s => s.lastActivityAt ?? 0)) - Math.max(...a[1].map(s => s.lastActivityAt ?? 0)));
  const workers = d.sessions.filter(s => s.isWorker).length;
  let h = tb;
  const totals = `<div class="tp-tot muted">${ls.length} lead(s) with workers · ${workers} worker session(s) loaded · ${d.sessions.filter(s => s.isWorker && isLive(s)).length} live${orph.length ? ` · ${orph.reduce((n, [, k]) => n + k.length, 0)} worker(s) whose parent is not loaded` : ''}</div>`;
  h += totals;
  if (!ls.length && !orph.length) return h + `<div class="empty">No session with recorded workers in the loaded history. Claude exposes subagents as subagents/ transcripts; Codex exposes them via parent_thread_id.</div>` + legend();
  const trees: TopoNode[] = [];
  if (roots === 'all') {
    for (const l of ls.slice(0, MAX_LEADS)) trees.push(buildTree(d.sessions, l, o));
    for (const [p, kids] of orph.slice(0, MAX_ORPHANS)) trees.push(orphanTree(d.sessions, p, kids, o));
    if (ls.length > MAX_LEADS) h += `<div class="muted">Showing the ${MAX_LEADS} most relevant of ${ls.length} leads (live first, then most recent).</div>`;
  } else {
    h += `<div class="pick">${ls.slice(0, 16).map(l => `<button class="pill${teamRoot(d, st.selected)?.key === l.key ? ' on' : ''}" data-select="${esc(l.key)}" style="--id:${identityColor(repoOf(l))}"><span class="dot ${esc(l.status)}"></span>${esc(titleOf(l).slice(0, 32))} <span class="muted">${d.sessions.filter(k => k.parentSessionId === l.key).length}</span></button>`).join('')}</div>`;
    const root = teamRoot(d, st.selected);
    if (root) trees.push(buildTree(d.sessions, root, o));
    else if (orph.length) trees.push(orphanTree(d.sessions, orph[0][0], orph[0][1], o));
  }
  h += trees.map(t => section(c, t, layout, orient)).join('');
  return h + legend();
}

function legend(): string {
  return `<div class="foot tp-leg">Edges are OBSERVED (parent recorded by the provider: Claude subagents/ transcripts, Codex parent_thread_id). Tokens and cost are provider-recorded (OBSERVED; cost only from Claude Code cost-state, else UNKNOWN “—”). Σ, wall time, depth and spans are DERIVED. Spawn descriptions in quotes are INFERRED (type + time match with the parent’s spawn call). Left border: provider (<span class="tp-sw" style="--pv:var(--claude)"></span>Claude <span class="tp-sw" style="--pv:var(--codex)"></span>Codex).</div>`;
}

const CSS = `
.tp-tg { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.tp-lb { color: var(--vscode-descriptionForeground); font-size: 10px; text-transform: uppercase; letter-spacing: .05em; margin-left: 4px; }
.tp-tot { font-size: 11px; margin: 0 0 6px; }
.tp-sec { border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; margin: 8px 0 12px; }
.tp-h { display: flex; gap: 6px; align-items: center; border-left: 3px solid var(--pv); padding-left: 7px; margin-bottom: 4px; flex-wrap: wrap; }
.tp-h b { font-size: 13px; }
.tp-k { margin: 4px 0 8px; }
.tp-k .kpi { min-width: 0; }
.tp-f { background: none; border: none; color: var(--vscode-descriptionForeground); cursor: pointer; font: inherit; font-size: 12px; padding: 0 2px; min-width: 14px; text-align: left; line-height: 1.2; }
.tp-f:hover { color: var(--vscode-foreground); }
.tp-f i { font-style: normal; font-size: 9px; margin-left: 1px; padding: 0 4px; border-radius: 6px; background: color-mix(in srgb, var(--accent) 22%, transparent); color: var(--vscode-foreground); }
.tp-gd { width: 8px; height: 8px; border-radius: 2px; display: inline-block; border: 1px dashed var(--vscode-descriptionForeground); }
.tp-role { font-size: 10px; padding: 0 5px; border-radius: 8px; border: 1px solid color-mix(in srgb, var(--rc) 60%, transparent); background: color-mix(in srgb, var(--rc) 16%, transparent); color: var(--vscode-foreground); white-space: nowrap; }
.tp-lead { font-size: 10px; padding: 0 5px; border-radius: 8px; border: 1px solid var(--line); color: var(--vscode-descriptionForeground); }
.tp-who { color: var(--vscode-descriptionForeground); font-size: 11px; white-space: nowrap; }
.tp-spawn { color: var(--vscode-descriptionForeground); font-style: italic; font-size: 11px; }
.tp-sum { color: var(--accent); }
.tp-bad { color: var(--bad); }
.tp-sel { outline: 1px solid var(--vscode-focusBorder); background: var(--vscode-list-activeSelectionBackground) !important; color: var(--vscode-list-activeSelectionForeground); }
.tp-bar { display: inline-block; width: 52px; height: 4px; border-radius: 2px; background: color-mix(in srgb, var(--line) 70%, transparent); overflow: hidden; vertical-align: middle; }
.tp-bar i { display: block; height: 100%; background: var(--pv, var(--accent)); }
.tp-more { color: var(--vscode-descriptionForeground); font-size: 11px; list-style: none; }
.tp-sw { display: inline-block; width: 3px; height: 10px; background: var(--pv); margin: 0 3px 0 6px; vertical-align: middle; }
/* outline tree */
.tp-tree, .tp-tree ul { list-style: none; margin: 0; padding: 0; }
.tp-tree ul { margin-left: 9px; padding-left: 12px; border-left: 1px solid var(--line); }
.tp-tree li { position: relative; }
.tp-tree ul > li::before { content: ''; position: absolute; left: -12px; top: 13px; width: 10px; border-top: 1px solid var(--line); }
.tp-row { display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; gap: 6px; align-items: start; padding: 2px 6px 2px 2px; margin: 1px 0; border-left: 3px solid var(--pv); border-radius: 3px; cursor: pointer; }
.tp-row:hover { background: var(--vscode-list-hoverBackground); }
.tp-row.tp-grp { cursor: default; border-left-style: dashed; }
.tp-row.tp-live { background: color-mix(in srgb, var(--ok) 7%, transparent); }
.tp-m { min-width: 0; }
.tp-l1 { display: flex; gap: 6px; align-items: center; min-width: 0; }
.tp-l1 b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.tp-l2 { font-size: 11px; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tp-n { display: grid; grid-template-columns: 44px 56px 46px 46px 52px; gap: 6px; align-items: center; font-size: 11px; font-variant-numeric: tabular-nums; text-align: right; padding-top: 2px; }
/* dense list */
.tp-tw { overflow-x: auto; }
.tp-tab { border-collapse: collapse; width: 100%; font-size: 12px; }
.tp-tab th { text-align: left; font-weight: 600; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--line); padding: 3px 6px; position: sticky; top: 0; background: var(--vscode-editor-background); white-space: nowrap; }
.tp-tab td { padding: 2px 6px; border-bottom: 1px solid color-mix(in srgb, var(--line) 50%, transparent); white-space: nowrap; }
.tp-tab .r { text-align: right; font-variant-numeric: tabular-nums; }
.tp-tr { cursor: pointer; }
.tp-tr:hover { background: var(--vscode-list-hoverBackground); }
.tp-tr td:first-child { border-left: 3px solid var(--pv); }
.tp-tr.tp-grp { cursor: default; color: var(--vscode-descriptionForeground); }
.tp-nm b { font-weight: 600; }
.tp-nm { max-width: 340px; overflow: hidden; text-overflow: ellipsis; }
.tp-res { max-width: 360px; overflow: hidden; text-overflow: ellipsis; color: var(--vscode-descriptionForeground); }
/* org chart */
.tp-ow { overflow-x: auto; padding-bottom: 6px; }
.tp-org, .tp-org ul { list-style: none; margin: 0; padding: 0; }
.tp-box { display: inline-grid; gap: 1px; text-align: left; width: 190px; padding: 5px 7px; border: 1px solid var(--line); border-left: 3px solid var(--pv); border-top: 2px solid var(--id); border-radius: 5px; background: var(--raise); cursor: pointer; font-size: 12px; vertical-align: top; }
.tp-box:hover { border-color: var(--vscode-focusBorder); }
.tp-box.tp-grp { cursor: default; border-style: dashed; }
.tp-box.tp-live { box-shadow: 0 0 0 1px color-mix(in srgb, var(--ok) 55%, transparent); }
.tp-box .tp-l1 b { flex: 1; }
.tp-nums { font-size: 11px; font-variant-numeric: tabular-nums; color: var(--vscode-descriptionForeground); }
.tp-res2 { font-size: 11px; color: var(--vscode-descriptionForeground); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.tp-box .tp-bar { width: 100%; margin-top: 2px; }
.tp-vt { display: flex; justify-content: center; width: max-content; min-width: 100%; }
.tp-vt ul { display: flex; justify-content: center; padding-top: 12px; position: relative; }
.tp-vt ul::before { content: ''; position: absolute; top: 0; left: 50%; height: 12px; border-left: 1px solid var(--line); }
.tp-vt li { position: relative; padding: 12px 4px 0; text-align: center; }
.tp-vt > li { padding-top: 0; }
.tp-vt ul > li::before, .tp-vt ul > li::after { content: ''; position: absolute; top: 0; width: 50%; height: 12px; border-top: 1px solid var(--line); }
.tp-vt ul > li::before { right: 50%; }
.tp-vt ul > li::after { left: 50%; border-left: 1px solid var(--line); }
.tp-vt ul > li:first-child::before, .tp-vt ul > li:last-child::after { border-top: none; }
.tp-vt ul > li:only-child::before { display: none; }
.tp-vt ul > li:only-child::after { border-top: none; }
.tp-vt ul > li.tp-more::before, .tp-vt ul > li.tp-more::after { display: none; }
.tp-hz li { display: flex; align-items: center; position: relative; padding: 3px 0 3px 14px; }
.tp-hz > li { padding-left: 0; }
.tp-hz ul { display: flex; flex-direction: column; position: relative; padding-left: 14px; }
.tp-hz ul::before { content: ''; position: absolute; left: 0; top: 50%; width: 14px; border-top: 1px solid var(--line); }
.tp-hz ul > li::before, .tp-hz ul > li::after { content: ''; position: absolute; left: 0; height: 50%; border-left: 1px solid var(--line); }
.tp-hz ul > li::before { top: 0; }
.tp-hz ul > li::after { bottom: 0; border-top: 1px solid var(--line); width: 14px; }
.tp-hz ul > li:first-child::before, .tp-hz ul > li:last-child::after { border-left: none; }
.tp-hz ul > li:only-child::after { border-left: none; }
.tp-hz ul > li:only-child::before { display: none; }
.tp-hz ul > li.tp-more::before, .tp-hz ul > li.tp-more::after { display: none; }
.tp-leg { line-height: 1.5; }
`;

export const topologyView: ExtraView = {
  id: 'topology',
  label: 'Topology',
  group: 'Sessions',
  hint: 'Lead → workers → nested workers as a collapsible tree, with rolled-up tokens, cost and time.',
  ready: true,
  render,
  css: CSS,
};
