// Add-on screen "Live": who does what right now. One row per live session and worker: provider, model · effort,
// permission mode, current tool + elapsed, last action, tokens / min, context, prompts, files, workers.
// Layouts: dense table, cards, swimlanes (by repo / provider / model, horizontal or vertical). Pure rendering.
import type { AgentSessionSnapshot, EvidenceKind } from '../../model';
import { duration } from '../../activity/activity';
import { compact, identityColor } from '../../activity/insights';
import { lanes, LiveRow, liveRows, LiveSort, liveTotals } from '../../activity/live';
import { esc } from '../html';
import { statusText } from '../views';
import { kpi, prettyModel, repoOf, titleOf, WsData, WsState } from '../workspace';
import { ExtraView, opt, seg, toolbar } from './kit';

const MIN = 60_000;
const MAX_ROWS = 200;
const SPARK_MIN = 15;

type Layout = 'table' | 'cards' | 'lanes';
type Basis = 'total' | 'output';

interface Cfg {
  layout: Layout;
  show: string;
  workers: 'nested' | 'flat' | 'hide';
  win: number;
  basis: Basis;
  sort: LiveSort;
  laneBy: 'repo' | 'provider' | 'model' | 'status';
  orient: 'horizontal' | 'vertical';
}

const RECENT: Record<string, number> = { live: 0, '30m': 30 * MIN, '2h': 120 * MIN };

function cfg(st: WsState): Cfg {
  const pick = <T extends string>(name: string, ok: readonly T[], fb: T): T => {
    const v = opt(st, `live.${name}`, fb) as T;
    return ok.includes(v) ? v : fb;
  };
  return {
    layout: pick('layout', ['table', 'cards', 'lanes'] as const, 'table'),
    show: pick('show', ['live', '30m', '2h'] as const, 'live'),
    workers: pick('workers', ['nested', 'flat', 'hide'] as const, 'nested'),
    win: Number(pick('win', ['1', '5', '15'] as const, '5')),
    basis: pick('basis', ['total', 'output'] as const, 'total'),
    sort: pick('sort', ['activity', 'status', 'rate', 'tokens', 'start'] as const, 'activity'),
    laneBy: pick('laneby', ['repo', 'provider', 'model', 'status'] as const, 'repo'),
    orient: pick('orient', ['horizontal', 'vertical'] as const, 'horizontal'),
  };
}

// ---------------------------------------------------------------- small parts

const PROV: Record<string, string> = { claude: 'Claude', codex: 'Codex' };

/** Short elapsed: seconds under a minute, then the shared duration format. */
function el(ms: number | undefined): string {
  if (ms === undefined) return '—';
  return ms < MIN ? `${Math.max(0, Math.round(ms / 1000))}s` : duration(ms);
}

function rateOf(r: LiveRow, c: Cfg): number | undefined {
  return c.basis === 'output' ? r.outRate : r.rate;
}

function rateText(v: number | undefined): string {
  if (v === undefined) return '—';
  if (v === 0) return '0';
  return v < 10 ? v.toFixed(1) : compact(Math.round(v));
}

const T_RATE = (c: Cfg) => `${c.basis === 'output' ? 'output' : 'prompt + output'} tokens per minute over the last ${c.win} min, from provider-recorded model calls (DERIVED from OBSERVED token counts); — = no per-call record`;
const T_TOOL = 'OBSERVED: tool call with no recorded result yet; elapsed since the call (DERIVED)';
const T_LAST = 'OBSERVED: latest recorded action (no tool call open)';
const T_CTX = 'context = prompt size of the latest model call (OBSERVED); % only when the provider records the window (Codex), else UNKNOWN';
const T_MODE = 'Claude permission mode; Codex approval policy and collaboration mode (plan = Codex plan mode); sandbox — as recorded in the transcript or rollout (evidence chip per value)';

function who(s: AgentSessionSnapshot): string {
  return [prettyModel(s.model), s.effort].filter(Boolean).join(' · ');
}

/** One recorded provider mode fact (permission mode, approval policy, collaboration mode, sandbox) with its evidence. */
export interface ModeFact {
  field: 'permissionMode' | 'approvalPolicy' | 'collaborationMode' | 'sandbox';
  label: string;
  value: string;
  kind: EvidenceKind;
  basis: string;
}

const MODE_BASIS: Record<ModeFact['field'], string> = {
  permissionMode: 'transcript permissionMode (latest)',
  approvalPolicy: 'rollout turn_context.approval_policy (an approval policy, not a permission mode)',
  collaborationMode: 'rollout turn_context.collaboration_mode.mode / task_started.collaboration_mode_kind (plan = Codex plan mode)',
  sandbox: 'sandbox policy as recorded',
};

/**
 * Provider mode facts of a session, in display order. Claude: permission mode. Codex: approval policy (falls back to the
 * legacy permissionMode alias), collaboration mode. Both: sandbox. Evidence comes from the session's own evidence list
 * (field `facts.<name>`) when the provider adapter recorded one, else OBSERVED (facts are read from the provider record).
 */
export function modeFacts(s: AgentSessionSnapshot): ModeFact[] {
  const f = s.facts;
  if (!f) return [];
  const out: ModeFact[] = [];
  const add = (field: ModeFact['field'], label: string, value: string | undefined, basis = MODE_BASIS[field]) => {
    if (typeof value !== 'string' || !value) return;
    const e = s.evidence?.find(x => x.field === `facts.${field}`);
    out.push({ field, label, value, kind: e?.kind ?? 'OBSERVED', basis: e?.source ?? basis });
  };
  if (s.provider === 'codex') {
    if (f.approvalPolicy) add('approvalPolicy', 'approval', f.approvalPolicy);
    else add('approvalPolicy', 'approval', f.permissionMode, 'rollout turn_context.approval_policy (legacy permissionMode alias)');
    add('collaborationMode', 'collaboration', f.collaborationMode);
  } else {
    add('permissionMode', 'permission', f.permissionMode);
  }
  add('sandbox', 'sandbox', f.sandbox);
  return out;
}

/** Evidence chip (global .chip.ev styles): KIND with the basis as tooltip. */
export function modeChip(kind: EvidenceKind, basis: string): string {
  return `<span class="chip ev ${esc(kind)}" title="${esc(`${kind}: ${basis}`)}">${esc(kind)}</span>`;
}

/** "approval never · collaboration plan · sandbox …" followed by one evidence chip (the weakest kind among the facts). */
export function modeHtml(s: AgentSessionSnapshot, o: { chip?: boolean } = {}): string {
  const fs = modeFacts(s);
  if (!fs.length) return '';
  const text = fs.map(x => `${x.label} ${x.value}`).join(' · ');
  if (o.chip === false) return esc(text);
  const order: EvidenceKind[] = ['UNKNOWN', 'INFERRED', 'DERIVED', 'OBSERVED'];
  const kind = order.find(k => fs.some(x => x.kind === k)) ?? 'OBSERVED';
  return `${esc(text)}${modeChip(kind, fs.map(x => `${x.label}: ${x.kind} · ${x.basis}`).join('; '))}`;
}

function toolHeat(ms: number): string {
  return ms >= 20 * MIN ? 'lv-hot' : ms >= 5 * MIN ? 'lv-warm' : '';
}

/** What the session is doing now: open tool call, else last action, else status. */
function doing(r: LiveRow, now: number): string {
  if (r.tool) {
    return `<span class="lv-tool ${toolHeat(r.tool.elapsedMs)}" title="${esc(T_TOOL)}${r.tool.elapsedMs >= 5 * MIN ? ' — long-running call' : ''}"><b>${esc(r.tool.name)}</b>${r.tool.detail ? ` <span class="lv-det">${esc(r.tool.detail)}</span>` : ''}<span class="lv-el">${esc(el(r.tool.elapsedMs))}</span></span>`;
  }
  const s = r.s;
  if (s.lastAction) return `<span class="lv-last" title="${esc(T_LAST)}">${r.live ? '' : 'last: '}${esc(s.lastAction)}<span class="lv-el">${esc(s.lastActionAt ? el(now - s.lastActionAt) : '')}</span></span>`;
  return `<span class="lv-last" title="${esc(s.statusReason)}">${esc(statusText(s))}</span>`;
}

function sparkline(r: LiveRow, c: Cfg, max: number): string {
  if (!r.s.facts?.calls) return '<span class="lv-sp lv-na" title="no per-call token record for this session (UNKNOWN)"></span>';
  const bars = r.spark.map((v, i) => {
    const h = max ? Math.max(v ? 8 : 0, Math.round((100 * v) / max)) : 0;
    return `<i style="height:${h}%" title="${esc(`${SPARK_MIN - i} min ago: ${compact(v)} tokens`)}"></i>`;
  }).join('');
  return `<span class="lv-sp" title="${esc(`tokens per minute, last ${SPARK_MIN} min (prompt + output, OBSERVED calls); bar heights relative to the busiest minute on screen`)}">${bars}</span>`;
}

function ctxCell(r: LiveRow): string {
  if (r.ctxTokens === undefined) return `<span class="muted" title="${esc(T_CTX)}">—</span>`;
  if (r.ctxPct === undefined) return `<span title="${esc(T_CTX)}">${esc(compact(r.ctxTokens))}</span>`;
  const p = Math.round(r.ctxPct);
  return `<span class="lv-ctx" title="${esc(`${T_CTX}: ${compact(r.ctxTokens)} of ${compact(r.s.usage?.contextWindow ?? 0)}`)}"><span class="lv-m ${p >= 80 ? 'hot' : p >= 50 ? 'warm' : ''}"><i style="width:${p}%"></i></span>${p}%</span>`;
}

function roleChip(s: AgentSessionSnapshot): string {
  if (!s.isWorker) return '';
  const role = (s.workerLabel ?? 'worker').split(' · ')[0] || 'worker';
  return `<span class="lv-role" style="--rc:${identityColor(role)}" title="worker type as recorded by the provider (OBSERVED)">${esc(role)}</span>`;
}

function workersCell(r: LiveRow): string {
  if (!r.workersTotal) return '';
  return `<span title="workers with this session as recorded parent: live / total (OBSERVED edges)">${r.workersLive ? `<b class="lv-ok">${r.workersLive}</b>` : '0'}/${r.workersTotal}</span>`;
}

function where(s: AgentSessionSnapshot): string {
  const br = s.branch ?? s.facts?.recordedBranch ?? (s.detachedHead ? 'detached' : '');
  return [repoOf(s), br].filter(Boolean).join(' · ');
}

function rowAttrs(r: LiveRow, st: WsState, cls: string): string {
  const s = r.s;
  const c = [cls, st.selected === s.key ? 'lv-sel' : '', r.live ? '' : 'lv-ended', s.status === 'NEEDS_INPUT' ? 'lv-need' : ''].filter(Boolean).join(' ');
  return `class="${c}" style="--pv:var(--${s.provider});--id:${identityColor(repoOf(s))}" data-select="${esc(s.key)}" tabindex="0" title="${esc(`${statusText(s)} — ${s.statusReason}`)}"`;
}

function dot(s: AgentSessionSnapshot): string {
  return `<span class="dot ${esc(s.status)}${s.status === 'RUNNING' ? ' lv-pulse' : ''}"></span>`;
}

function nameCell(r: LiveRow): string {
  const s = r.s;
  return `${dot(s)}<b class="lv-nm">${esc(titleOf(s))}</b>${roleChip(s)}${r.spawn ? `<span class="lv-spawn" title="INFERRED: parent's spawn call of the same type just before this worker started">“${esc(r.spawn)}”</span>` : ''}`;
}

// ---------------------------------------------------------------- layouts

function table(rows: LiveRow[], d: WsData, st: WsState, c: Cfg, max: number): string {
  const body = rows.map(r => {
    const s = r.s;
    const pad = 6 + r.depth * 16;
    return `<tr ${rowAttrs(r, st, 'lv-tr')}><td class="lv-n1" style="padding-left:${pad}px">${r.depth ? '<span class="lv-br">└</span>' : ''}${nameCell(r)}</td><td class="lv-st">${esc(statusText(s))}</td><td class="lv-who"><span class="lv-pv">${esc(PROV[s.provider] ?? s.provider)}</span> ${esc(who(s))}</td><td class="lv-mode" title="${esc(T_MODE)}">${modeHtml(s)}</td><td class="lv-do">${doing(r, d.now)}</td><td class="r lv-rate" title="${esc(T_RATE(c))}">${esc(rateText(rateOf(r, c)))}</td><td>${sparkline(r, c, max)}</td><td class="r">${ctxCell(r)}</td><td class="r" title="user prompts recorded (OBSERVED)">${r.prompts ?? ''}</td><td class="r" title="files the provider recorded editing (OBSERVED)">${r.files || ''}</td><td class="r">${workersCell(r)}</td><td class="r" title="total tokens recorded for the session (OBSERVED)">${s.usage ? esc(compact(s.usage.totalTokens)) : ''}</td><td class="lv-where">${esc(where(s))}</td><td class="r" title="since session start (DERIVED)">${esc(el(s.startedAt !== undefined ? d.now - s.startedAt : undefined))}</td></tr>`;
  }).join('');
  return `<div class="lv-tw"><table class="lv-tab"><thead><tr><th>Session</th><th>Status</th><th>Provider · model</th><th>Mode</th><th>Now doing</th><th class="r">Tok/min</th><th>Last ${SPARK_MIN} min</th><th class="r">Context</th><th class="r">Prompts</th><th class="r">Files</th><th class="r">Workers</th><th class="r">Tokens</th><th>Repo · branch</th><th class="r">Up</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

function cardOf(r: LiveRow, d: WsData, st: WsState, c: Cfg, max: number, mini = false): string {
  const s = r.s;
  const stats = [
    `<span title="${esc(T_RATE(c))}"><b>${esc(rateText(rateOf(r, c)))}</b> tok/min</span>`,
    r.ctxTokens !== undefined ? `<span>ctx ${ctxCell(r)}</span>` : '',
    r.prompts !== undefined ? `<span title="user prompts (OBSERVED)">${r.prompts} prompt${r.prompts === 1 ? '' : 's'}</span>` : '',
    r.files ? `<span title="files edited (OBSERVED)">${r.files} file${r.files === 1 ? '' : 's'}</span>` : '',
    r.workersTotal ? `<span>workers ${workersCell(r)}</span>` : '',
  ].filter(Boolean).join('');
  const m = modeHtml(s);
  return `<div ${rowAttrs(r, st, `lv-card${mini ? ' lv-mini' : ''}${r.depth ? ' lv-wk' : ''}`)}>
<div class="lv-c1">${nameCell(r)}<span class="lv-up" title="since session start (DERIVED)">${esc(el(s.startedAt !== undefined ? d.now - s.startedAt : undefined))}</span></div>
<div class="lv-c2"><span class="lv-pv">${esc(PROV[s.provider] ?? s.provider)}</span> ${esc(who(s))}${m ? ` · <span title="${esc(T_MODE)}">${m}</span>` : ''}</div>
${mini ? '' : `<div class="lv-c2 muted">${esc(where(s))}</div>`}
<div class="lv-c3">${doing(r, d.now)}</div>
<div class="lv-c4">${stats}</div>
${sparkline(r, c, max)}</div>`;
}

function cards(rows: LiveRow[], d: WsData, st: WsState, c: Cfg, max: number): string {
  return `<div class="lv-grid">${rows.map(r => cardOf(r, d, st, c, max)).join('')}</div>`;
}

function laneKey(c: Cfg, root: AgentSessionSnapshot): string {
  if (c.laneBy === 'provider') return PROV[root.provider] ?? root.provider;
  if (c.laneBy === 'model') return prettyModel(root.model) || 'model not recorded';
  if (c.laneBy === 'status') return statusText(root);
  return repoOf(root);
}

function swimlanes(rows: LiveRow[], d: WsData, st: WsState, c: Cfg, max: number): string {
  // Workers ride in their lead's lane (nested order keeps them right after it).
  let root: AgentSessionSnapshot | undefined;
  const keyed = new Map<LiveRow, string>();
  for (const r of rows) {
    if (r.depth === 0) root = r.s;
    keyed.set(r, laneKey(c, r.depth === 0 || !root ? r.s : root));
  }
  const ls = lanes(rows, r => keyed.get(r) ?? '');
  const body = ls.map(([k, list]) => {
    const t = liveTotals(list, repoOf);
    const rate = c.basis === 'output' ? t.outRate : t.rate;
    const head = `<div class="lv-lh" style="--id:${identityColor(k)}"><b>${esc(k)}</b><span class="muted">${t.agents} live${t.workers ? ` · ${t.workers} worker${t.workers === 1 ? '' : 's'}` : ''}${t.rateRows ? ` · ${esc(rateText(rate))} tok/min` : ''}${list.length > t.agents ? ` · ${list.length - t.agents} recent` : ''}</span></div>`;
    return `<div class="lv-lane">${head}<div class="lv-lb">${list.map(r => cardOf(r, d, st, c, max, true)).join('')}</div></div>`;
  }).join('');
  return `<div class="lv-lanes ${c.orient === 'vertical' ? 'lv-vt' : 'lv-hz'}">${body}</div>`;
}

// ---------------------------------------------------------------- page

function render(d: WsData, st: WsState): string {
  const c = cfg(st);
  const grp = (t: string, control: string) => `<span class="lv-tg"><span class="lv-lbl">${t}</span>${control}</span>`;
  const tb1 = toolbar(
    grp('layout', seg(st, 'live.layout', [['table', 'Table'], ['cards', 'Cards'], ['lanes', 'Swimlanes']], 'table', 'Dense table, one card per session, or swimlanes')),
    grp('show', seg(st, 'live.show', [['live', 'Live'], ['30m', '+ ended 30 min'], ['2h', '+ ended 2 h']], 'live', 'Live sessions only, or also sessions that ended recently')),
    grp('workers', seg(st, 'live.workers', [['nested', 'Nested'], ['flat', 'Flat'], ['hide', 'Hide']], 'nested', 'Workers under their lead, as their own rows, or hidden')),
    grp('sort', seg(st, 'live.sort', [['activity', 'Latest'], ['status', 'Status'], ['rate', 'Pace'], ['tokens', 'Tokens'], ['start', 'Newest']], 'activity')),
  );
  const tb2 = toolbar(
    grp('pace window', seg(st, 'live.win', [['1', '1 min'], ['5', '5 min'], ['15', '15 min']], '5', 'Window for tokens / min')),
    grp('pace', seg(st, 'live.basis', [['total', 'Prompt + output'], ['output', 'Output only']], 'total', 'Prompt tokens include cached context re-sent each call; output tokens show what is generated')),
    c.layout === 'lanes' ? grp('lanes by', seg(st, 'live.laneby', [['repo', 'Repo'], ['provider', 'Provider'], ['model', 'Model'], ['status', 'Status']], 'repo')) : '',
    c.layout === 'lanes' ? grp('direction', seg(st, 'live.orient', [['horizontal', 'Rows'], ['vertical', 'Columns']], 'horizontal', 'Lanes as rows (cards flow right) or as columns')) : '',
  );
  let rows = liveRows(d.sessions, { now: d.now, windowMs: c.win * MIN, recentMs: RECENT[c.show] ?? 0, sparkMinutes: SPARK_MIN, sort: c.sort }, c.workers === 'nested');
  if (c.workers === 'hide') rows = rows.filter(r => !r.s.isWorker);
  const t = liveTotals(rows, repoOf);
  const rate = c.basis === 'output' ? t.outRate : t.rate;
  const prov = Object.entries(t.byProvider).map(([p, n]) => `${PROV[p] ?? p} ${n}`).join(' · ');
  const kpis = `<div class="kpis big lv-k">${kpi(t.agents, 'agents live', t.agents ? 'k-run' : '', `every live session, leads and workers${prov ? ` (${prov})` : ''}; live = Running / Idle / Needs input (INFERRED from recency)`)}${kpi(t.conversations, 'conversations', '', 'live sessions that are not workers')}${kpi(t.workers, 'workers live', '', 'live sessions with a recorded parent (Claude subagents, Codex spawned agents)')}${kpi(t.running, 'running', 'k-run')}${kpi(t.needsInput, 'needs input', t.needsInput ? 'k-need' : '')}${kpi(t.toolsInFlight, 'tools in flight', '', T_TOOL)}${kpi(t.rateRows ? rateText(rate) : '—', `tok/min · ${c.win} min`, '', `${T_RATE(c)}; summed over ${t.rateRows} live session(s) with call records`)}${kpi(t.repos, 'repos', '', 'distinct repositories with a live session')}</div>`;
  let h = `<div class="lv">${tb1}${tb2}${kpis}`;
  if (!rows.length) {
    return `${h}<div class="empty">No live Claude Code or Codex session right now${c.show === 'live' ? '. Switch “show” to include sessions that ended recently' : ' and none ended in that window'}.</div>${legend()}</div>`;
  }
  const more = rows.length - MAX_ROWS;
  const shown = rows.slice(0, MAX_ROWS);
  const max = Math.max(1, ...shown.flatMap(r => r.spark));
  h += c.layout === 'cards' ? cards(shown, d, st, c, max) : c.layout === 'lanes' ? swimlanes(shown, d, st, c, max) : table(shown, d, st, c, max);
  if (more > 0) h += `<div class="muted">… ${more} more row(s) not shown.</div>`;
  return `${h}${legend()}</div>`;
}

function legend(): string {
  return `<div class="foot lv-leg">Live status is INFERRED from recency and provider state. Tool calls, actions, modes, prompts, files and tokens are OBSERVED in the transcript / rollout; elapsed times and tokens / min are DERIVED from them. Context % only where the provider records the window (else UNKNOWN). Spawn descriptions in quotes are INFERRED. Left border: provider (<span class="lv-sw" style="--pv:var(--claude)"></span>Claude <span class="lv-sw" style="--pv:var(--codex)"></span>Codex); tool time turns amber after 5 min, red after 20 min. Updates on every refresh.</div>`;
}

function badge(d: WsData): string {
  const n = d.sessions.filter(s => s.status === 'RUNNING' || s.status === 'NEEDS_INPUT' || s.status === 'IDLE').length;
  return n ? String(n) : '';
}

const CSS = `
.lv .tb { margin: 0 0 6px; }
.lv-tg { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.lv-lbl { color: var(--vscode-descriptionForeground); font-size: 10px; text-transform: uppercase; letter-spacing: .05em; margin-left: 4px; }
.lv-k { margin: 6px 0 10px; }
.lv .dot.lv-pulse { animation: lv-pulse 1.8s ease-out infinite; }
@keyframes lv-pulse { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--ok) 60%, transparent); } 70% { box-shadow: 0 0 0 5px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
.lv-nm { font-weight: 600; margin-left: 5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lv-role { font-size: 10px; padding: 0 5px; margin-left: 5px; border-radius: 8px; border: 1px solid color-mix(in srgb, var(--rc) 60%, transparent); background: color-mix(in srgb, var(--rc) 16%, transparent); color: var(--vscode-foreground); white-space: nowrap; }
.lv-spawn { color: var(--vscode-descriptionForeground); font-style: italic; font-size: 11px; margin-left: 5px; }
.lv-pv { font-size: 10px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--pv); }
.lv-tool { display: inline-flex; gap: 4px; align-items: baseline; max-width: 100%; min-width: 0; padding: 0 5px; border-radius: 3px; background: color-mix(in srgb, var(--accent) 12%, transparent); }
.lv-tool b { font-weight: 600; }
.lv-tool.lv-warm { background: color-mix(in srgb, var(--warn) 18%, transparent); }
.lv-tool.lv-hot { background: color-mix(in srgb, var(--bad) 18%, transparent); }
.lv-det { color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; font-family: var(--vscode-editor-font-family); font-size: 11px; }
.lv-last { color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block; max-width: 100%; }
.lv-el { margin-left: 6px; font-variant-numeric: tabular-nums; font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
.lv-tool.lv-warm .lv-el { color: var(--warn); } .lv-tool.lv-hot .lv-el { color: var(--bad); }
.lv-ok { color: var(--ok); }
.lv-sp { display: inline-flex; align-items: flex-end; gap: 1px; height: 16px; width: 76px; vertical-align: middle; border-bottom: 1px solid var(--line); }
.lv-sp i { flex: 1; background: var(--pv, var(--accent)); opacity: .85; border-radius: 1px 1px 0 0; min-width: 2px; }
.lv-sp.lv-na { border-bottom-style: dashed; }
.lv-ctx { display: inline-flex; gap: 4px; align-items: center; font-variant-numeric: tabular-nums; }
.lv-m { display: inline-block; width: 34px; height: 4px; border-radius: 2px; background: var(--line); overflow: hidden; }
.lv-m i { display: block; height: 100%; background: var(--ok); } .lv-m.warm i { background: var(--vscode-charts-yellow); } .lv-m.hot i { background: var(--bad); }
.lv-sel { outline: 1px solid var(--vscode-focusBorder); background: var(--vscode-list-activeSelectionBackground) !important; color: var(--vscode-list-activeSelectionForeground); }
.lv-ended { opacity: .62; }
.lv-sw { display: inline-block; width: 3px; height: 10px; background: var(--pv); margin: 0 3px 0 6px; vertical-align: middle; }
/* table */
.lv-tw { overflow-x: auto; }
.lv-tab { border-collapse: collapse; width: 100%; font-size: 12px; }
.lv-tab th { text-align: left; font-weight: 600; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--line); padding: 3px 6px; position: sticky; top: 0; background: var(--vscode-editor-background); white-space: nowrap; }
.lv-tab td { padding: 3px 6px; border-bottom: 1px solid color-mix(in srgb, var(--line) 50%, transparent); white-space: nowrap; vertical-align: middle; }
.lv-tab .r { text-align: right; font-variant-numeric: tabular-nums; }
.lv-tr { cursor: pointer; }
.lv-tr:hover { background: var(--vscode-list-hoverBackground); }
.lv-tr td:first-child { border-left: 3px solid var(--pv); }
.lv-tr.lv-need { background: color-mix(in srgb, var(--warn) 10%, transparent); }
.lv-n1 { max-width: 300px; overflow: hidden; text-overflow: ellipsis; }
.lv-br { color: var(--vscode-descriptionForeground); margin-right: 4px; }
.lv-st, .lv-mode, .lv-where { color: var(--vscode-descriptionForeground); font-size: 11px; }
.lv-who { font-size: 11px; }
.lv-do { max-width: 380px; overflow: hidden; }
.lv-rate { font-weight: 600; }
.lv-where { max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
/* cards */
.lv-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 8px; }
.lv-card { border: 1px solid var(--line); border-left: 3px solid var(--pv); border-top: 2px solid var(--id); border-radius: 6px; padding: 6px 8px; background: var(--raise); cursor: pointer; display: grid; gap: 3px; min-width: 0; font-size: 12px; }
.lv-card:hover { border-color: var(--vscode-focusBorder); }
.lv-card.lv-need { box-shadow: 0 0 0 1px color-mix(in srgb, var(--warn) 65%, transparent); }
.lv-card.lv-wk { margin-left: 14px; }
.lv-grid .lv-card.lv-wk { margin-left: 0; border-top-style: dashed; }
.lv-c1 { display: flex; align-items: center; min-width: 0; }
.lv-c1 .lv-nm { flex: 0 1 auto; }
.lv-up { margin-left: auto; padding-left: 8px; font-size: 11px; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
.lv-c2 { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lv-c3 { min-width: 0; overflow: hidden; white-space: nowrap; }
.lv-c4 { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 11px; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
.lv-c4 b { color: var(--vscode-foreground); }
.lv-card .lv-sp { width: 100%; height: 18px; }
/* swimlanes */
.lv-lanes { display: grid; gap: 8px; }
.lv-lane { border: 1px solid var(--line); border-radius: 6px; overflow: hidden; min-width: 0; }
.lv-lh { display: flex; gap: 8px; align-items: baseline; padding: 4px 8px; border-left: 4px solid var(--id); background: color-mix(in srgb, var(--id) 10%, transparent); font-size: 12px; }
.lv-lb { display: flex; gap: 6px; padding: 6px; }
.lv-hz .lv-lane { display: grid; grid-template-columns: 170px minmax(0, 1fr); }
.lv-hz .lv-lh { flex-direction: column; gap: 2px; border-bottom: none; }
.lv-hz .lv-lb { overflow-x: auto; flex-wrap: nowrap; }
.lv-hz .lv-mini { flex: 0 0 230px; }
.lv-vt { grid-auto-flow: column; grid-auto-columns: minmax(240px, 1fr); overflow-x: auto; align-items: start; }
.lv-vt .lv-lb { flex-direction: column; }
.lv-mini.lv-wk { margin-left: 0; border-top-style: dashed; }
.lv-hz .lv-mini.lv-wk { flex-basis: 210px; }
.lv-vt .lv-mini.lv-wk { margin-left: 12px; }
.lv-leg { line-height: 1.5; }
`;

export const liveView: ExtraView = {
  id: 'live',
  label: 'Live',
  group: 'Now',
  hint: 'Who does what right now: every live Claude / Codex session and worker, current tool, tokens and pace.',
  ready: true,
  render,
  css: CSS,
  badge,
};
