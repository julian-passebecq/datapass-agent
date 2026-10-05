// Add-on screen "Lifecycle": two state-machine diagrams (SVG, deterministic layout, no library) rebuilt from
// snapshots + the event timeline on every render (src/activity/lifecycle.ts): session status machine and work
// loop machine, aggregated over the sessions in scope or for one session. Clicking a state lists the sessions
// currently in it (data-select rows). Pure rendering; all text escaped; no I/O.
import type { AgentSessionSnapshot, EvidenceKind, TimelineEvent } from '../../model';
import { identityColor } from '../../activity/insights';
import {
  dwell, loopStats, LoopStats, Machine, machine, STATUS_STATES, StatusState, statusPath, sumLoops, toolState, Visit, WORK_STATES, WorkState, workPath,
} from '../../activity/lifecycle';
import { esc } from '../html';
import { ago, kpi, repoOf, titleOf, WsData, WsState } from '../workspace';
import { ExtraView, opt, seg, toolbar } from './kit';

const DAY = 86_400_000;
const PERIOD: Record<string, number> = { '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY, all: Infinity };
const MAX_SESSIONS = 400;
const MAX_LIST = 80;
const MAX_PICK = 14;
const MAX_STORY = 160;

interface Spec {
  id: string;
  label: string;
  col: number;
  row: number;
  color: string;
  hint: string;
}

const STATUS_SPEC: Record<StatusState, Spec> = {
  STARTED: { id: 'STARTED', label: 'Started', col: 0, row: 1, color: 'var(--accent)', hint: 'first record of the session (OBSERVED first record, else DERIVED earliest timestamp)' },
  RUNNING: { id: 'RUNNING', label: 'Running', col: 1, row: 1, color: 'var(--ok)', hint: 'records keep coming (DERIVED from record timestamps)' },
  IDLE: { id: 'IDLE', label: 'Idle', col: 2, row: 0, color: 'var(--vscode-charts-yellow, #cca700)', hint: 'between records: no record for ≥ 5 min (INFERRED); as current status: turn completed, thread open' },
  NEEDS_INPUT: { id: 'NEEDS_INPUT', label: 'Needs input', col: 2, row: 2, color: 'var(--warn)', hint: 'waiting for you (status evidence of the provider)' },
  ENDED: { id: 'ENDED', label: 'Ended', col: 3, row: 1, color: 'var(--quiet)', hint: 'session ended (status evidence of the provider)' },
  UNKNOWN: { id: 'UNKNOWN', label: 'Unknown', col: 3, row: 3, color: 'var(--line)', hint: 'status not determinable (INFERRED)' },
};

const WORK_SPEC: Record<WorkState, Spec> = {
  prompt: { id: 'prompt', label: 'Prompt', col: 0, row: 1, color: 'var(--accent)', hint: 'user turn / turn started (OBSERVED)' },
  read: { id: 'read', label: 'Read / Search', col: 1, row: 0, color: 'var(--vscode-charts-blue, #3794ff)', hint: 'Read / Grep / Glob / web tools, read-only shell commands (OBSERVED call, classification DERIVED)' },
  edit: { id: 'edit', label: 'Edit', col: 2, row: 1, color: 'var(--vscode-charts-purple, #b180d7)', hint: 'file edit / write / patch (OBSERVED)' },
  test: { id: 'test', label: 'Test', col: 3, row: 0, color: 'var(--ok)', hint: 'test / build command that passed or has no outcome (OBSERVED)' },
  fail: { id: 'fail', label: 'Fail', col: 3, row: 2, color: 'var(--bad)', hint: 'test / build command that failed (OBSERVED exit code or tool error flag)' },
  commit: { id: 'commit', label: 'Commit', col: 4, row: 1, color: 'var(--vscode-charts-orange, #d18616)', hint: 'git commit run (OBSERVED) or commit in the session window (DERIVED)' },
  reply: { id: 'reply', label: 'Reply', col: 5, row: 1, color: 'var(--quiet)', hint: 'turn completed (OBSERVED for Codex), else INFERRED before the next prompt / at the end' },
};

const EV_SHORT: Record<EvidenceKind, string> = { OBSERVED: 'obs', DERIVED: 'der', INFERRED: 'inf', UNKNOWN: 'unk' };

/** Option-safe token for a session ([a-z0-9._:-], ≤ 40). */
export function sessTok(s: AgentSessionSnapshot): string {
  return `${s.provider[0]}${s.sessionId}`.toLowerCase().replace(/[^a-z0-9._:-]/g, '').slice(0, 40);
}

// ---- data ---------------------------------------------------------------------------------------------------

interface Built {
  sessions: AgentSessionSnapshot[];
  status: Map<string, Visit<StatusState>[]>;
  work: Map<string, Visit<WorkState>[]>;
  loops: Map<string, LoopStats>;
  noEvents: number;
}

function build(d: WsData, sessions: AgentSessionSnapshot[], one: AgentSessionSnapshot | undefined): Built {
  const events: TimelineEvent[] = d.timeline ? d.timeline(one?.key, one ? 20_000 : 200_000) : d.events;
  const by = new Map<string, TimelineEvent[]>();
  for (const e of events) {
    const l = by.get(e.sessionKey);
    if (l) l.push(e);
    else by.set(e.sessionKey, [e]);
  }
  const status = new Map<string, Visit<StatusState>[]>();
  const work = new Map<string, Visit<WorkState>[]>();
  const loops = new Map<string, LoopStats>();
  let noEvents = 0;
  for (const s of sessions) {
    const ev = by.get(s.key) ?? [];
    if (!ev.length) noEvents++;
    status.set(s.key, statusPath(s, ev, { now: d.now }));
    const w = workPath(s, ev);
    work.set(s.key, w);
    loops.set(s.key, loopStats(w));
  }
  return { sessions, status, work, loops, noEvents };
}

// ---- SVG ----------------------------------------------------------------------------------------------------

const NW = 132, NH = 46, CW = 190, RH = 74, PAD = 14;

function center(sp: Spec): { x: number; y: number } {
  return { x: PAD + sp.col * CW + NW / 2, y: PAD + sp.row * RH + NH / 2 };
}

/** Point on the node rectangle border from its center toward (tx, ty). */
function clip(c: { x: number; y: number }, tx: number, ty: number): { x: number; y: number } {
  const dx = tx - c.x, dy = ty - c.y;
  if (!dx && !dy) return c;
  const k = Math.min(dx ? NW / 2 / Math.abs(dx) : Infinity, dy ? NH / 2 / Math.abs(dy) : Infinity);
  return { x: c.x + dx * k, y: c.y + dy * k };
}

function evTip(e: Partial<Record<EvidenceKind, number>>): string {
  return (Object.keys(e) as EvidenceKind[]).map(k => `${e[k]} ${k}`).join(', ');
}

function diagram(m: Machine, specs: Record<string, Spec>, order: string[], current: Map<string, number>, pickName: string, pick: string, aria: string, prefix: string): string {
  const cols = Math.max(...order.map(id => specs[id].col)) + 1;
  const rows = Math.max(...order.map(id => specs[id].row)) + 1;
  const W = PAD * 2 + (cols - 1) * CW + NW;
  const H = PAD * 2 + (rows - 1) * RH + NH + 10;
  const maxC = Math.max(1, ...m.edges.map(e => e.count));
  const paths = m.edges
    .filter(e => specs[e.from] && specs[e.to] && e.from !== e.to)
    .map(e => {
      const a = center(specs[e.from]), b = center(specs[e.to]);
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const off = 18 + 0.1 * len;
      const cx = (a.x + b.x) / 2 - (dy / len) * off, cy = (a.y + b.y) / 2 + (dx / len) * off;
      const p0 = clip(a, cx, cy), p2 = clip(b, cx, cy);
      const w = 1 + (5 * e.count) / maxC;
      const lx = 0.25 * p0.x + 0.5 * cx + 0.25 * p2.x, ly = 0.25 * p0.y + 0.5 * cy + 0.25 * p2.y;
      const tip = esc(`${specs[e.from].label} → ${specs[e.to].label}: ${e.count} transition(s) · median ${dwell(e.medianMs)} in ${specs[e.from].label} before it (DERIVED) · evidence: ${evTip(e.evidence)}`);
      return `<g class="${prefix}-e"><title>${tip}</title><path d="M${p0.x.toFixed(1)},${p0.y.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}" stroke-width="${w.toFixed(1)}" marker-end="url(#${prefix}-ar)"/><text x="${lx.toFixed(0)}" y="${(ly + 3).toFixed(0)}">${e.count} · ${esc(dwell(e.medianMs))}</text></g>`;
    })
    .join('');
  const boxes = order
    .map(id => {
      const sp = specs[id];
      const n = m.nodes.get(id);
      const cur = current.get(id) ?? 0;
      const x = PAD + sp.col * CW, y = PAD + sp.row * RH;
      const on = pick === id;
      const tip = esc(`${sp.label}: ${sp.hint}. ${cur} session(s) in it now · ${n?.visits ?? 0} visit(s) by ${n?.sessions ?? 0} session(s) · median dwell ${dwell(n?.medianMs)} (DERIVED, ${n?.dwellSamples ?? 0} sample(s)). Click to list the sessions in it now.`);
      return `<g class="${prefix}-n${on ? ' on' : ''}${n || cur ? '' : ' zero'}" data-opt="${esc(pickName)}" data-val="${esc(on ? '' : id)}" style="--sc:${sp.color}"><title>${tip}</title><rect x="${x}" y="${y}" width="${NW}" height="${NH}" rx="8"/><text class="t" x="${x + NW / 2}" y="${y + 18}">${esc(sp.label)}</text><text class="s" x="${x + NW / 2}" y="${y + 35}">now ${cur} · ${esc(dwell(n?.medianMs))}</text></g>`;
    })
    .join('');
  return `<div class="${prefix}-gw"><svg class="${prefix}-g" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(aria)}"><defs><marker id="${prefix}-ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z"/></marker></defs>${paths}${boxes}</svg></div>`;
}

function edgeTable(m: Machine, specs: Record<string, Spec>): string {
  if (!m.edges.length) return '';
  const rows = m.edges
    .slice(0, 30)
    .map(e => `<tr><td><i class="lc-dot" style="--c:${specs[e.from]?.color ?? 'var(--line)'}"></i>${esc(specs[e.from]?.label ?? e.from)}</td><td><i class="lc-dot" style="--c:${specs[e.to]?.color ?? 'var(--line)'}"></i>${esc(specs[e.to]?.label ?? e.to)}</td><td class="r">${e.count}</td><td class="r" title="DERIVED: median time in the source state before this transition">${esc(dwell(e.medianMs))}</td><td class="muted">${esc(evTip(e.evidence))}</td></tr>`)
    .join('');
  return `<details class="lc-det"><summary>Transitions table (${m.edges.length})</summary><table class="lc-t"><tr><th>From</th><th>To</th><th class="r">Count</th><th class="r">Median before</th><th>Evidence</th></tr>${rows}</table></details>`;
}

// ---- session lists ------------------------------------------------------------------------------------------

function list(title: string, ss: AgentSessionSnapshot[], b: Built, d: WsData, st: WsState, pickName: string): string {
  const shown = [...ss].sort((a, b2) => (b2.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)).slice(0, MAX_LIST);
  const rows = shown
    .map(s => {
      const l = b.loops.get(s.key);
      const sp = b.status.get(s.key) ?? [];
      return `<tr data-select="${esc(s.key)}" tabindex="0"${st.selected === s.key ? ' class="sel"' : ''}><td class="lc-nm" title="${esc(s.key)}"><span class="lc-pv" style="--pv:var(--${esc(s.provider)})"></span>${s.isWorker ? '<span class="muted">↳</span> ' : ''}${esc(titleOf(s))}</td><td><span class="lc-repo" style="--rc:${identityColor(repoOf(s))}">${esc(repoOf(s))}</span></td><td>${esc(s.status)}</td><td class="r" title="DERIVED: time since entering the current status">${esc(dwell(sp.length ? d.now - sp[sp.length - 1].at : undefined))}</td><td class="r" title="Prompts seen in the timeline">${l?.turns ?? 0}</td><td class="r" title="INFERRED: edit → fail → edit cycles">${l?.cycles || ''}</td><td class="muted">${esc(ago(d.now, s.lastActivityAt))}</td></tr>`;
    })
    .join('');
  const empty = ss.length ? '' : '<div class="muted lc-empty">No session in this state now.</div>';
  return `<h2>${esc(title)} · ${ss.length} session(s) <button class="link" data-opt="${esc(pickName)}" data-val="" title="Close">✕</button></h2>${empty}${ss.length ? `<table class="lc-t lc-l"><tr><th>Session</th><th>Repo</th><th>Status</th><th class="r">In state</th><th class="r">Turns</th><th class="r">Cycles</th><th>Last activity</th></tr>${rows}</table>` : ''}${ss.length > shown.length ? `<div class="muted">… ${ss.length - shown.length} more</div>` : ''}`;
}

function story(path: Visit[], specs: Record<string, Spec>, now: number): string {
  if (!path.length) return '<div class="muted lc-empty">No state recorded for this session.</div>';
  const shown = path.slice(-MAX_STORY);
  const chips = shown
    .map((v, i) => {
      const next = shown[i + 1];
      const dur = next ? next.at - v.at : v.until !== undefined ? v.until - v.at : undefined;
      const sp = specs[v.state];
      const t = new Date(v.at);
      return `<span class="lc-st" style="--sc:${sp?.color ?? 'var(--line)'}" title="${esc(`${sp?.label ?? v.state} at ${t.toLocaleString()} · ${dur !== undefined ? dwell(dur) : 'open'} · ${v.n} record(s) · ${v.evidence}`)}">${esc(sp?.label ?? v.state)}${v.n > 1 ? ` ×${v.n}` : ''} <span class="muted">${esc(dwell(dur))}</span> <sup>${EV_SHORT[v.evidence]}</sup></span>`;
    })
    .join('<span class="lc-arr">→</span>');
  return `<div class="lc-story">${path.length > shown.length ? `<span class="muted">… ${path.length - shown.length} earlier · </span>` : ''}${chips}</div><div class="legend">Path oldest → newest (last ${MAX_STORY} states), each state with its time in state and evidence (obs / der / inf). Updated ${esc(new Date(now).toLocaleTimeString())}.</div>`;
}

// ---- screen -------------------------------------------------------------------------------------------------

export function renderLifecycle(d: WsData, st: WsState): string {
  const period = opt(st, 'lifecycle.period', '7d');
  const mode = opt(st, 'lifecycle.mode', 'agg');
  const which = opt(st, 'lifecycle.machine', 'both');
  const span = PERIOD[period] ?? PERIOD['7d'];
  const since = Number.isFinite(span) ? d.now - span : -Infinity;
  const inScope = d.sessions
    .filter(s => (s.lastActivityAt ?? s.startedAt ?? 0) >= since)
    .sort((a, b) => (b.lastActivityAt ?? b.startedAt ?? 0) - (a.lastActivityAt ?? a.startedAt ?? 0));
  const bar = toolbar(
    seg(st, 'lifecycle.mode', [['agg', 'Aggregate'], ['one', 'One session']], 'agg', 'All sessions in scope, or one session'),
    seg(st, 'lifecycle.machine', [['both', 'Both'], ['status', 'Status'], ['work', 'Work loop']], 'both', 'Which state machine'),
    seg(st, 'lifecycle.period', [['24h', '24 h'], ['7d', '7 d'], ['30d', '30 d'], ['all', 'All loaded']], '7d', 'Period (sessions active in it)'),
  );
  if (!inScope.length) return `${bar}<div class="muted lc-empty">No session in this period.</div>`;

  let one: AgentSessionSnapshot | undefined;
  let picker = '';
  if (mode === 'one') {
    const tok = opt(st, 'lifecycle.sess', '');
    one = (tok && inScope.find(s => sessTok(s) === tok)) || inScope.find(s => s.key === st.selected) || inScope[0];
    const cands = inScope.slice(0, MAX_PICK);
    if (!cands.includes(one)) cands.unshift(one);
    picker = `<div class="lc-pick"><span class="muted">Session:</span> ${cands
      .map(s => `<button class="lc-pb${s === one ? ' on' : ''}" data-opt="lifecycle.sess" data-val="${esc(sessTok(s))}" title="${esc(`${titleOf(s)} · ${repoOf(s)} · ${s.status} · ${s.key}`)}"><span class="lc-pv" style="--pv:var(--${esc(s.provider)})"></span>${esc(titleOf(s).slice(0, 28))}</button>`)
      .join('')}${inScope.length > cands.length ? `<span class="muted"> · ${inScope.length - cands.length} more: select one in another screen (inspector selection is used when nothing is picked here)</span>` : ''}</div>`;
  }
  const sessions = one ? [one] : inScope.slice(0, MAX_SESSIONS);
  const b = build(d, sessions, one);
  const statusM = machine(sessions.map(s => b.status.get(s.key) ?? []));
  const workM = machine(sessions.map(s => b.work.get(s.key) ?? []));
  const loops = sumLoops(sessions.map(s => b.loops.get(s.key)!).filter(Boolean));
  const withLoop = sessions.filter(s => (b.loops.get(s.key)?.cycles ?? 0) > 0).length;

  const curStatus = new Map<string, number>();
  for (const s of inScope) curStatus.set(s.status, (curStatus.get(s.status) ?? 0) + 1);
  const lastWork = (s: AgentSessionSnapshot): WorkState | undefined => {
    const p = b.work.get(s.key);
    return p?.length ? p[p.length - 1].state : undefined;
  };
  const curWork = new Map<string, number>();
  for (const s of sessions) {
    const w = lastWork(s);
    if (w) curWork.set(w, (curWork.get(w) ?? 0) + 1);
  }
  // In one-session mode the status counts are that session's.
  const statusNow = one ? new Map([[one.status as string, 1]]) : curStatus;

  const tools: Partial<Record<WorkState, number>> = {};
  let toolOther = 0;
  for (const s of sessions)
    for (const [name, n] of Object.entries(s.facts?.toolCounts ?? {})) {
      const w = toolState(name);
      if (w) tools[w] = (tools[w] ?? 0) + n;
      else toolOther += n;
    }

  const k = `<div class="kpis">${kpi(sessions.length, one ? 'Session' : 'Sessions', '', `sessions active in the period${inScope.length > sessions.length ? ` (newest ${MAX_SESSIONS} of ${inScope.length})` : ''}`)}${kpi(statusM.transitions, 'Status moves', '', 'DERIVED / INFERRED status transitions (see legend)')}${kpi(workM.transitions, 'Work moves', '', 'transitions between work-loop states')}${kpi(loops.cycles, 'Edit→fail→edit', loops.cycles ? 'warn' : '', 'INFERRED: a failing test between two edits')}${kpi(loops.fixed, 'Fixed after fail', '', 'INFERRED: a failing test later followed by a passing one in the same turn')}${one ? kpi(loops.maxFailStreak, 'Longest fail run', '', 'INFERRED: fails in a row with only edits / reads between them') : kpi(withLoop, 'Sessions w/ loops', '', 'sessions with at least one edit → fail → edit cycle (INFERRED)')}</div>`;

  const pickS = opt(st, 'lifecycle.state', '');
  const pickW = opt(st, 'lifecycle.work', '');
  let body = '';
  if (which !== 'work') {
    body += `<h2>Session status machine</h2>${diagram(statusM, STATUS_SPEC, STATUS_STATES, statusNow, 'lifecycle.state', pickS, 'Session status state machine', 'lcs')}`;
    if (pickS && STATUS_SPEC[pickS as StatusState]) body += list(`Now ${STATUS_SPEC[pickS as StatusState].label}`, (one ? [one] : inScope).filter(s => s.status === pickS), b, d, st, 'lifecycle.state');
    if (one) body += story(b.status.get(one.key) ?? [], STATUS_SPEC, d.now);
    body += edgeTable(statusM, STATUS_SPEC);
  }
  if (which !== 'status') {
    body += `<h2>Work loop machine</h2>${diagram(workM, WORK_SPEC, WORK_STATES, curWork, 'lifecycle.work', pickW, 'Work loop state machine', 'lcw')}`;
    if (pickW && WORK_SPEC[pickW as WorkState]) body += list(`Last in ${WORK_SPEC[pickW as WorkState].label}`, sessions.filter(s => lastWork(s) === pickW), b, d, st, 'lifecycle.work');
    if (one) body += story(b.work.get(one.key) ?? [], WORK_SPEC, d.now);
    body += edgeTable(workM, WORK_SPEC);
    const tl = (Object.keys(tools) as WorkState[]).map(w => `${WORK_SPEC[w].label} ${tools[w]}`).join(' · ');
    if (tl || toolOther) body += `<div class="legend">Recorded tool calls (OBSERVED, provider tool counts): ${esc(tl || '—')}${toolOther ? ` · other tools ${toolOther}` : ''}.</div>`;
  }
  const gaps = b.noEvents ? `<div class="muted lc-note">${b.noEvents} session(s) have no event history loaded: status shows start and current status only, work loop empty.</div>` : '';
  const foot = `<div class="legend lc-foot">
<b>Evidence.</b> OBSERVED = read from a provider record (first record, tool call, file edit, test exit code / error flag, git commit command, Codex “turn completed”). DERIVED = computed from records (Running from record timestamps, commits found by git log in the session window, every median dwell / edge time). INFERRED = assumed: Idle between records when no record for ≥ 5 min, Reply before the next prompt for Claude, edit → fail → edit cycles and fixes. UNKNOWN = not exposed. Providers do not record status history, so only start and the current status are evidence-backed; the moves in between are reconstructed.
<br>Node: “now N” = sessions in that state now (status machine) or whose last work state it is (work loop) · median dwell. Edge: count · median time in the source state; width ∝ count. Shell commands that are neither read-only nor tests are not loop states. No prompt text is read.</div>`;
  return `${bar}${picker}${k}${gaps}${body}${foot}`;
}

export const lifecycleView: ExtraView = {
  id: 'lifecycle',
  label: 'Lifecycle',
  group: 'Quality',
  hint: 'State machines: session status and the prompt → read → edit → test → commit loop, with counts and median times.',
  ready: true,
  render: (d, st) => `<div class="lc">${renderLifecycle(d, st)}</div>`,
  css: `
.lc .r { text-align: right; }
.lc .lc-empty, .lc .lc-note { font-size: 11px; margin: 4px 0 8px; }
.lc .lcs-g, .lc .lcw-g { display: block; font-size: 11px; }
.lc .lcs-gw, .lc .lcw-gw { overflow: auto; border: 1px solid var(--line); border-radius: 6px; background: var(--raise); padding: 4px; margin-bottom: 6px; }
.lc .lcs-n, .lc .lcw-n { cursor: pointer; }
.lc .lcs-n rect, .lc .lcw-n rect { fill: color-mix(in srgb, var(--sc) 20%, var(--vscode-editor-background)); stroke: var(--sc); stroke-width: 1.5; }
.lc .lcs-n.on rect, .lc .lcw-n.on rect { stroke-width: 3; fill: color-mix(in srgb, var(--sc) 38%, var(--vscode-editor-background)); }
.lc .lcs-n.zero, .lc .lcw-n.zero { opacity: .45; }
.lc .lcs-n:hover rect, .lc .lcw-n:hover rect { stroke-width: 2.5; }
.lc .lcs-n text, .lc .lcw-n text { fill: var(--vscode-foreground); text-anchor: middle; pointer-events: none; }
.lc .lcs-n text.t, .lc .lcw-n text.t { font-weight: 600; }
.lc .lcs-n text.s, .lc .lcw-n text.s { fill: var(--vscode-descriptionForeground); font-size: 10px; }
.lc .lcs-e path, .lc .lcw-e path { fill: none; stroke: var(--vscode-descriptionForeground); opacity: .65; }
.lc .lcs-e:hover path, .lc .lcw-e:hover path { opacity: 1; stroke: var(--accent); }
.lc .lcs-e text, .lc .lcw-e text { fill: var(--vscode-foreground); font-size: 10px; text-anchor: middle; paint-order: stroke; stroke: var(--raise); stroke-width: 3px; }
.lc .lcs-g marker path, .lc .lcw-g marker path { fill: var(--vscode-descriptionForeground); }
.lc .lc-t { font-size: 11px; margin-bottom: 8px; }
.lc .lc-t tr[data-select] { cursor: pointer; }
.lc .lc-t tr[data-select]:hover, .lc .lc-t tr.sel { background: var(--vscode-list-hoverBackground); }
.lc .lc-nm { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lc .lc-pv { display: inline-block; width: 3px; height: 10px; margin-right: 4px; background: var(--pv); vertical-align: middle; }
.lc .lc-repo { border-left: 3px solid var(--rc); padding-left: 4px; white-space: nowrap; }
.lc .lc-dot { display: inline-block; width: 8px; height: 8px; border-radius: 2px; background: var(--c); margin-right: 4px; vertical-align: middle; }
.lc .lc-det { font-size: 11px; margin: 0 0 10px; }
.lc .lc-det summary { cursor: pointer; color: var(--vscode-descriptionForeground); }
.lc .lc-pick { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; font-size: 11px; margin: 0 0 8px; }
.lc .lc-pb { background: none; border: 1px solid var(--line); border-radius: 4px; color: var(--vscode-foreground); padding: 1px 6px; cursor: pointer; font: inherit; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lc .lc-pb.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.lc .lc-story { display: flex; flex-wrap: wrap; gap: 3px; align-items: center; font-size: 11px; margin: 2px 0 4px; }
.lc .lc-st { border-left: 3px solid var(--sc); background: color-mix(in srgb, var(--sc) 14%, transparent); padding: 0 5px; border-radius: 3px; white-space: nowrap; }
.lc .lc-st sup { font-size: 8px; color: var(--vscode-descriptionForeground); }
.lc .lc-arr { color: var(--vscode-descriptionForeground); font-size: 10px; }
.lc .lc-foot { margin-top: 10px; line-height: 1.5; }
`,
};
