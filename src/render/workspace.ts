import {controlMap} from './controlMap';
import { compactSessions } from './extra/compact';
// Agent Workspace: one editor panel with a navigation rail, a main surface and a selection pane.
// Pure string rendering from snapshots; every value is escaped here.
import { AgentSessionSnapshot, ProviderState, SourceState, TimelineEvent } from '../model';
import { duration, weekly } from '../activity/activity';
import { attention, AttentionItem, base, compact, dayStart, flow, hourly, identityColor, isLive, outcome, Outcome, OUTCOME_LABEL, stages, usageSince, verification, Verification, VERIFY_LABEL, workerRole } from '../activity/insights';
import { digitOf, esc } from './html';
import { extraViews } from './extra';
import { hhmm, statusText } from './views';
import { endInferred } from '../sessions/classify';
import { endObserved } from '../activity/audit';
import type { WfRun } from '../providers/claude/workflows';
import { agentLabel, agentWallMs, liveRunsOf, modelEffortText, runCounts, runName, runningWfAgents, WF_COUNT_BASIS, WF_LINK_BASIS } from '../activity/wfLinks';
import { agentRowHtml, leadRuns, runStripHtml, wfDur } from './extra/wfkit';
import type { Feed } from './extra/feeds';
import { workflowsFeed } from './extra/workflows';

/** Async feeds core screens read (pumped by the panel like an add-on screen's feeds). */
export function coreFeeds(view: string): Feed[] {
  return view === 'overview' || view === 'team' ? [workflowsFeed as Feed] : [];
}

export const WS_VIEWS = ['overview', 'attention', 'board', 'team', 'flow', 'worktrees', 'gantt', 'verify', 'activity', 'providers', 'control-map'] as const;
export type CoreView = (typeof WS_VIEWS)[number];
/** Core view id or an add-on screen id from render/extra. */
export type WsView = string;

/** Every screen id, core first then add-ons. */
export function allViews(): string[] {
  return [...WS_VIEWS, ...extraViews().map(v => v.id)];
}

export interface WsState {
  view: WsView;
  selected?: string;
  /** Per-screen options set by toolbar toggles (granularity, orientation, chart type …). */
  opts?: Record<string, string>;
}

export interface WsData {
  cockpitInputs?: import('../cockpit/facade').ScopedInputs;
  sessions: AgentSessionSnapshot[];
  providers: ProviderState[];
  events: TimelineEvent[];
  now: number;
  ternAvailable: boolean;
  idleAlertMinutes?: number;
  /** Git correlation collector state (from the store). */
  git?: { enabled: boolean; lastMs?: number; at?: number; progress?: { done: number; total: number } };
  /** Lazy access to the store's event history for screens that need more than `events`. */
  timeline?: (key?: string, limit?: number) => TimelineEvent[];
  /** Reads an `agent.*` setting at render time ("agent.x" or "x"). */
  config?: <T>(key: string, fallback: T) => T;
  /** Last refresh pass, for the status strip (host-measured). */
  stats?: { refreshMs: number; gitMs: number; bytesRead: number; artifacts: number; heapMB: number; at: number };
}

/** All collectors, providers first, then git. */
export function sources(d: WsData): SourceState[] {
  const out = d.providers.flatMap(p => p.sources ?? []);
  if (d.git) out.push({ id: 'git', label: 'Git correlation', status: d.git.enabled ? 'ready' : 'off', detail: d.git.enabled ? `read-only, hardened${d.git.lastMs !== undefined ? ` · last pass ${d.git.lastMs} ms` : ''}` : 'off in untrusted workspaces', at: d.git.at ?? d.now });
  return out;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

const PROV: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };
const VIEW_LABEL: Record<CoreView, string> = {
  'control-map': 'Agent map', overview: 'Overview', attention: 'Attention', board: 'Board', team: 'Team', flow: 'Flow', worktrees: 'Worktrees', gantt: 'Last 24 h', verify: 'Verification', activity: 'Activity', providers: 'Sources',
};
const VIEW_HINT: Record<CoreView, string> = {
  'control-map': 'Optional map of recorded model, session, checkout and evidence, with existing Agent navigation.',
  overview: 'What is running now, what needs you, and today at a glance.',
  attention: 'Sessions that need a human look, with the observation behind each item.',
  board: 'Every session by live status.',
  team: 'Lead session and its workers, grouped by the role the provider recorded.',
  flow: 'Provider → repository → observed outcome, for sessions in the loaded history.',
  worktrees: 'Which agent works where: repository → branch / worktree → sessions.',
  gantt: 'When each session was active in the last 24 hours, with commits and test runs.',
  verify: 'Test and build commands observed in sessions, with exit-code provenance.',
  activity: 'Factual daily and hourly rollups. Not a productivity score.',
  providers: 'Collectors, provider log storage, and what Agent can observe. Missing access is shown, not hidden.',
};

export function prettyModel(m: string | undefined): string {
  if (!m) return '';
  const c = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(m);
  return c ? `${c[1][0].toUpperCase()}${c[1].slice(1)} ${c[2]}.${c[3]}` : m;
}

export const repoOf = (s: AgentSessionSnapshot) => base(s.repository) || base(s.cwd) || '(no repo)';
export const titleOf = (s: AgentSessionSnapshot) => s.title ?? s.workerLabel ?? s.sessionId.slice(0, 8);
export const ago = (now: number, t?: number) => (t ? `${duration(now - t)} ago` : '');

export function stageStrip(s: AgentSessionSnapshot): string {
  return `<span class="stages">${stages(s).map(g => `<span class="stg ${g.state}" title="${esc(`${g.label}: ${g.detail}`)}">${esc(g.label)}</span>`).join('')}</span>`;
}

export function usageLine(s: AgentSessionSnapshot): string {
  const u = s.usage;
  if (!u) return '';
  const parts: string[] = [];
  if (u.contextTokens) parts.push(u.contextWindow ? `ctx ${Math.round((100 * u.contextTokens) / u.contextWindow)}% · ${compact(u.contextTokens)}` : `ctx ${compact(u.contextTokens)}`);
  if (u.totalTokens) parts.push(`${compact(u.totalTokens)} tok`);
  if (u.costUSD !== undefined) parts.push(`$${u.costUSD.toFixed(2)}`);
  return parts.join(' · ');
}

export function ctxBar(s: AgentSessionSnapshot): string {
  const u = s.usage;
  if (!u?.contextTokens || !u.contextWindow) return '';
  const pct = Math.min(100, Math.round((100 * u.contextTokens) / u.contextWindow));
  return `<div class="meter ${pct >= 80 ? 'hot' : pct >= 50 ? 'warm' : ''}" title="context ${pct}% of ${compact(u.contextWindow)} (provider token_count)"><i style="width:${pct}%"></i></div>`;
}

export function card(s: AgentSessionSnapshot, d: WsData, sel?: string, extra = ''): string {
  const live = isLive(s);
  const dur = live ? duration(d.now - (s.startedAt ?? d.now)) : endTime(s);
  const who = [PROV[s.provider], prettyModel(s.model), s.effort].filter(Boolean).join(' · ');
  const where = [repoOf(s), s.branch ?? (s.detachedHead ? 'detached' : ''), s.isLinkedWorktree ? `wt ${base(s.worktree)}` : ''].filter(Boolean).join(' · ');
  const u = usageLine(s);
  const act = live && s.lastAction ? `<div class="cl act">▸ ${esc(s.lastAction)} <span class="muted">${esc(ago(d.now, s.lastActionAt))}</span></div>` : '';
  return `<div class="card${sel === s.key ? ' sel' : ''}" style="--id:${identityColor(repoOf(s))}" data-select="${esc(s.key)}" tabindex="0" title="${esc(statusText(s) + ' — ' + s.statusReason)}">
<div class="ct"><span class="dot ${s.status}"></span><b title="${esc(titleOf(s))}">${esc(titleOf(s))}</b><span class="right" title="${esc(durTip(s, live))}">${esc(dur)}</span></div>
<div class="cl"><span class="who">${esc(who)}</span></div><div class="cl muted">${esc(where)}</div>${u ? `<div class="cl num">${esc(u)}</div>` : ''}${ctxBar(s)}${act}${extra}<div>${stageStrip(s)}</div></div>`;
}

/** Evidence title of a card's duration / end cell. */
export function durTip(s: AgentSessionSnapshot, live = isLive(s)): string {
  if (live) return 'DERIVED: time since the first record; the session is still live';
  if (endObserved(s)) return 'OBSERVED: end recorded by the provider';
  if (endInferred(s) || s.endedAt === undefined) return END_INFERRED_TIP;
  return 'DERIVED: end time from the session status (no provider end record)';
}

export function kpi(value: string | number, label: string, cls = '', title = ''): string {
  return `<div class="kpi ${cls}"${title ? ` title="${esc(title)}"` : ''}><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
}

// ---------------------------------------------------------------- views

const DAY = 86400_000;

function overview(d: WsData, st: WsState): string {
  const top = d.sessions.filter(s => !s.isWorker);
  const today = d.now - DAY;
  const live = top.filter(isLive).sort((a, b) => order(a) - order(b) || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
  const att = attention(d.sessions, d.now, d);
  const todays = top.filter(s => (s.lastActivityAt ?? 0) >= today);
  const tests = d.sessions.flatMap(s => s.tests).filter(t => t.at >= today);
  const commits = new Set(d.sessions.flatMap(s => s.commits).filter(c => c.at >= today).map(c => c.sha));
  const u = usageSince(d.sessions, today);
  const runs = leadRuns(d);
  const wfLive = runningWfAgents(runs);
  const workers = d.sessions.filter(s => s.isWorker && isLive(s)).length + wfLive;
  const passN = tests.filter(t => t.outcome === 'PASS').length;
  const status = (k: string) => `DERIVED: lead sessions whose current status is ${k} (each status carries its own evidence: live registry, open turn, recent activity)`;
  let h = `<div class="kpis big">${[
    kpi(live.filter(s => s.status === 'RUNNING').length, 'Running', 'k-run', status('running')),
    kpi(live.filter(s => s.status === 'NEEDS_INPUT').length, 'Needs input', 'k-need', status('needs input')),
    kpi(live.filter(s => s.status === 'IDLE').length, 'Idle', 'k-idle', status('idle')),
    kpi(workers, 'Live workers', '', `DERIVED: worker sessions (subagents) whose current status is running, idle or needs input, plus ${wfLive} running Claude workflow agent(s) (${WF_COUNT_BASIS})`),
    kpi(att.filter(a => a.severity !== 'low').length, 'Attention', att.some(a => a.severity === 'high') ? 'k-need' : '', 'DERIVED: medium and high attention items; each item shows the observation behind it'),
    kpi(todays.length, 'Sessions 24 h', '', 'DERIVED: lead sessions with recorded activity in the last 24 hours'),
    kpi(commits.size, 'Commits 24 h', '', 'DERIVED: distinct commits from git log in the last 24 hours, in the window of a loaded session. Not proof a session made them (only a recorded `git commit` by the session is).'),
    kpi(`${passN}/${tests.length}`, 'Tests pass 24 h', tests.some(t => t.outcome === 'FAIL') ? 'k-fail' : '', `DERIVED: ${passN} passing of ${tests.length} test / build commands OBSERVED in the last 24 hours (outcome from exit code or provider error flag)`),
    kpi(compact(u.tokens), 'Tokens 24 h', '', `DERIVED: sum of provider-recorded (OBSERVED) token totals of ${u.sessions} session(s) active in the last 24 hours (whole-session totals)`),
    u.costSessions ? kpi(`$${u.costUSD.toFixed(2)}`, 'Cost recorded', '', `DERIVED: sum of Claude Code cost-state (OBSERVED) over ${u.costSessions} session(s) active in the last 24 hours (whole-session totals); Codex records no cost`) : '',
  ].join('')}</div>`;
  h += overviewCols(d, st, live, att, runs, wfLive);
  h += `<h2>Last 24 hours</h2>${gantt(d, st, 14)}`;
  return h;
}

/** "workflow <name> n/m" badges for a lead's running runs (n = agents with a result). */
export function wfBadges(runs: WfRun[] | undefined): string {
  return liveRunsOf(runs)
    .map(r => {
      const c = runCounts(r);
      return `<span class="wk-badge" title="${esc(`${WF_LINK_BASIS}. ${c.done + c.failed} of ${c.total} agents have a result, ${c.running} running. ${WF_COUNT_BASIS}`)}">workflow ${esc(runName(r))} ${c.done + c.failed}/${c.total}</span>`;
    })
    .join(' ');
}

/** Max running workers / workflow agents listed on a lead card before "+n more". */
export const OV_WORKER_ROWS = 5;
const OV_PROVS = ['claude', 'codex'] as const;

/** Collapsible section header: a button posting `name` = 'closed' | '' (WsState opts); the count stays visible. */
function ovHead(st: WsState, name: string, label: string, count: number, tag = 'h2'): { html: string; closed: boolean } {
  const closed = st.opts?.[name] === 'closed';
  const html = `<${tag} class="ovh"><button class="ovt" data-opt="${esc(name)}" data-val="${closed ? '' : 'closed'}" aria-expanded="${closed ? 'false' : 'true'}" title="${esc(`${closed ? 'Expand' : 'Collapse'} ${label}`)}"><span class="chev" aria-hidden="true">${closed ? '▸' : '▾'}</span>${esc(label)} <span class="ovn">${count}</span></button></${tag}>`;
  return { html, closed };
}

/** Live agents and Needs attention, each grouped by provider and collapsible ('ov.live.*', 'ov.attn', 'ov.attn.*'). */
function overviewCols(d: WsData, st: WsState, live: AgentSessionSnapshot[], att: AttentionItem[], runs: Map<string, WfRun[]>, wfLive: number): string {
  const by = new Map(d.sessions.map(s => [s.key, s]));
  const wfNote = wfLive ? ` <span class="muted" title="${esc(`running workflow agents under these leads; ${WF_COUNT_BASIS}`)}">+ ${wfLive} workflow agent(s)</span>` : '';
  let lv = `<div class="ov-live"><h2>Live agents · ${live.length}${wfNote}</h2>`;
  if (!live.length) lv += '<div class="empty">No live session. Ended sessions are on the Board.</div>';
  for (const p of OV_PROVS) {
    const list = live.filter(s => s.provider === p);
    if (!list.length) continue;
    const hd = ovHead(st, `ov.live.${p}`, PROV[p], list.length, 'h3');
    lv += `<section class="ovg" data-ovg="live.${p}">${hd.html}${hd.closed ? '' : `<div class="grid">${list.map(s => card(s, d, st.selected, workersLine(s, d, runs.get(s.key)))).join('')}</div>`}</section>`;
  }
  lv += '</div>';
  const top = ovHead(st, 'ov.attn', 'Needs attention', att.length);
  let at = `<div class="ov-attn${top.closed ? ' closed' : ''}">${top.html}`;
  if (!top.closed) {
    if (!att.length) at += '<div class="empty">Nothing needs you.</div>';
    for (const p of OV_PROVS) {
      const items = att.filter(a => by.get(a.key)?.provider === p);
      if (!items.length) continue;
      const hd = ovHead(st, `ov.attn.${p}`, PROV[p], items.length, 'h3');
      at += `<section class="ovg" data-ovg="attn.${p}">${hd.html}${hd.closed ? '' : attList(items.slice(0, 6), d, st)}</section>`;
    }
    if (att.length > 6) at += `<button class="link" data-nav="attention">all ${att.length} items →</button>`;
  }
  at += '</div>';
  return `<div class="cols ov-cols${top.closed ? ' ov-wide' : ''}">${lv}${at}</div>`;
}

export interface WorkerRow { key?: string; status: string; dotTitle: string; label: string; me: string; meTitle: string; tool: string; toolTitle: string; elapsed: string; start: number }

/** Running workers (sessions) and running workflow agents of a lead, newest first. Idle and ended ones are only counted. */
export function runningWorkerRows(s: AgentSessionSnapshot, d: WsData, runs?: WfRun[]): WorkerRow[] {
  const rows: WorkerRow[] = [];
  for (const k of d.sessions.filter(c => c.parentSessionId === s.key && c.status === 'RUNNING')) {
    const ct = k.facts?.currentTool;
    rows.push({
      key: k.key,
      status: k.status,
      dotTitle: `${statusText(k)} — ${k.statusReason}`,
      label: k.workerLabel && k.title && k.title !== k.workerLabel ? `${k.workerLabel} · ${k.title}` : titleOf(k),
      me: [prettyModel(k.model), k.effort].filter(Boolean).join(' · ') || '—',
      meTitle: 'model and effort as recorded by the provider (OBSERVED); — when not recorded (UNKNOWN)',
      tool: ct ? `▸ ${ct.name}${ct.detail ? ` ${ct.detail}` : ''}` : '',
      toolTitle: ct ? 'OBSERVED: tool call with no recorded result yet' : 'UNKNOWN: no open tool call recorded',
      elapsed: k.startedAt !== undefined ? duration(d.now - k.startedAt) : '—',
      start: k.startedAt ?? 0,
    });
  }
  for (const r of liveRunsOf(runs))
    for (const a of r.agents.filter(x => x.status === 'running')) {
      const me = modelEffortText(a, s, prettyModel);
      rows.push({
        status: 'RUNNING',
        dotTitle: `running — ${a.statusBasis}`,
        label: `${agentLabel(a)} · workflow ${runName(r)}`,
        me: me.text,
        meTitle: me.title,
        tool: a.currentTool ? `▸ ${a.currentTool}` : '',
        toolTitle: a.currentTool ? 'OBSERVED: tool call with no recorded result yet' : 'UNKNOWN: no open tool call recorded',
        elapsed: wfDur(agentWallMs(a, d.now)),
        start: a.firstAt ?? 0,
      });
    }
  return rows.sort((x, y) => y.start - x.start);
}

function workerRowHtml(w: WorkerRow): string {
  const sel = w.key ? ` data-select="${esc(w.key)}" tabindex="0"` : '';
  return `<div class="ovw"${sel} title="${esc(w.label)}"><span class="dot ${esc(w.status)}" title="${esc(w.dotTitle)}"></span><span class="ovw-l">${esc(w.label.slice(0, 80))}</span><span class="ovw-m" title="${esc(w.meTitle)}">${esc(w.me)}</span><span class="ovw-t" title="${esc(w.toolTitle)}">${esc(w.tool)}</span><span class="ovw-e" title="DERIVED: time since the first record">${esc(w.elapsed)}</span></div>`;
}

function workersLine(s: AgentSessionSnapshot, d: WsData, runs?: WfRun[]): string {
  const kids = d.sessions.filter(c => c.parentSessionId === s.key);
  const badges = wfBadges(runs);
  if (!kids.length && !badges) return '';
  const rows = runningWorkerRows(s, d, runs);
  const runK = kids.filter(k => k.status === 'RUNNING').length;
  const rest = kids.length - runK;
  const w = kids.length ? `<span title="DERIVED: worker sessions whose recorded parent is this lead; running ones are listed, idle and ended ones only counted">${kids.length} worker${kids.length > 1 ? 's' : ''}${runK ? ` · <span class="pass">${runK} running</span>` : ''}${rest ? ` · ${rest} idle/ended` : ''}</span>` : '';
  const more = rows.length > OV_WORKER_ROWS ? `<button class="link ovmore" data-nav="topology" data-key="${esc(s.key)}" title="Open Topology on this lead">+${rows.length - OV_WORKER_ROWS} more</button>` : '';
  const list = rows.length ? `<div class="ovws">${rows.slice(0, OV_WORKER_ROWS).map(workerRowHtml).join('')}${more}</div>` : '';
  return `<div class="cl muted">${[w, badges].filter(Boolean).join(' ')}</div>${list}`;
}

function order(s: AgentSessionSnapshot): number {
  return s.status === 'NEEDS_INPUT' ? 0 : s.status === 'RUNNING' ? 1 : s.status === 'IDLE' ? 2 : 3;
}

function attList(items: AttentionItem[], d: WsData, st: WsState): string {
  const by = new Map(d.sessions.map(s => [s.key, s]));
  return items
    .map(a => {
      const s = by.get(a.key);
      if (!s) return '';
      return `<div class="att ${a.severity}${st.selected === s.key ? ' sel' : ''}" data-select="${esc(s.key)}" tabindex="0"><span class="sev">${esc(a.severity)}</span><div><b>${esc(a.reason)}</b><div class="muted">${esc(PROV[s.provider])} · ${esc(titleOf(s))} · ${esc(repoOf(s))}${s.branch ? ` · ${esc(s.branch)}` : ''}</div><div class="basis">${esc(a.basis)} · ${esc(ago(d.now, a.at))}</div></div><button class="link" data-open="${esc(s.key)}">Inspect</button></div>`;
    })
    .join('');
}

function attentionView(d: WsData, st: WsState): string {
  const att = attention(d.sessions, d.now, d);
  if (!att.length) return `<div class="empty">Nothing needs you. Items appear for: input requested, last test failed in a live session, context ≥ 80 %, open turn without activity, long idle, ended with edits but no commit.</div>`;
  return attList(att, d, st);
}

const BOARD_TIP = (k: string) => `DERIVED: lead sessions whose current status is ${k} (each card shows its own status evidence)`;

function board(d: WsData, st: WsState): string {
  const today = d.now - DAY;
  const top = d.sessions.filter(s => !s.isWorker);
  const cols: [string, string, AgentSessionSnapshot[], string][] = [
    ['NEEDS_INPUT', 'Needs input', top.filter(s => s.status === 'NEEDS_INPUT'), BOARD_TIP('needs input')],
    ['RUNNING', 'Running', top.filter(s => s.status === 'RUNNING'), BOARD_TIP('running')],
    ['IDLE', 'Idle', top.filter(s => s.status === 'IDLE'), BOARD_TIP('idle')],
    ['UNKNOWN', 'Unknown', top.filter(s => s.status === 'UNKNOWN'), 'UNKNOWN: lead sessions whose status cannot be decided from the records'],
    ['ENDED', 'Ended · 24 h', top.filter(s => s.status === 'ENDED' && (s.endedAt ?? s.lastActivityAt ?? 0) >= today), 'DERIVED: lead sessions ended in the last 24 hours (recorded end, else last record)'],
  ];
  return `<div class="board">${cols
    .map(([k, label, list, tip]) => `<div class="col"><div class="colh"><span class="dot ${k}"></span>${esc(label)}<span class="n" title="${esc(tip)}">${list.length}</span></div>${list.length ? list.slice(0, 40).map(s => card(s, d, st.selected)).join('') + (list.length > 40 ? `<div class="muted">… ${list.length - 40} more</div>` : '') : '<div class="empty">No session in this column.</div>'}</div>`)
    .join('')}</div>`;
}

/** Root for the Team view: the selection (or its parent), else the lead with the most live workers. */
export function teamRoot(d: WsData, selected?: string, runs?: Map<string, WfRun[]>): AgentSessionSnapshot | undefined {
  const by = new Map(d.sessions.map(s => [s.key, s]));
  let s = selected ? by.get(selected) : undefined;
  while (s?.parentSessionId && by.has(s.parentSessionId)) s = by.get(s.parentSessionId);
  const hasWf = (k: string) => !!runs?.get(k)?.length;
  if (s && (d.sessions.some(c => c.parentSessionId === s!.key) || hasWf(s.key))) return s;
  const leads = d.sessions.filter(x => !x.isWorker && (d.sessions.some(c => c.parentSessionId === x.key) || hasWf(x.key)));
  const liveWf = (k: string) => (runs?.get(k) ?? []).reduce((n, r) => n + runCounts(r).running, 0);
  const score = (x: AgentSessionSnapshot) => (d.sessions.filter(c => c.parentSessionId === x.key && isLive(c)).length + liveWf(x.key)) * 1000 + (isLive(x) ? 500 : 0) + (x.lastActivityAt ?? 0) / 1e10;
  return leads.sort((a, b) => score(b) - score(a))[0] ?? s;
}

function team(d: WsData, st: WsState): string {
  const runs = leadRuns(d);
  const root = teamRoot(d, st.selected, runs);
  const leads = d.sessions.filter(x => !x.isWorker && (d.sessions.some(c => c.parentSessionId === x.key) || !!runs.get(x.key)?.length)).sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
  let h = `<div class="pick">${leads.slice(0, 12).map(l => `<button class="pill${root?.key === l.key ? ' on' : ''}" data-select="${esc(l.key)}" style="--id:${identityColor(repoOf(l))}"><span class="dot ${l.status}"></span>${esc(titleOf(l).slice(0, 32))} <span class="muted">${d.sessions.filter(c => c.parentSessionId === l.key).length + (runs.get(l.key) ?? []).reduce((n, r) => n + r.agents.length, 0)}</span></button>`).join('')}</div>`;
  if (!root) return h + `<div class="empty">No session with observed workers in the loaded history. Claude exposes subagents as subagents/ transcripts; Codex exposes them via parent_thread_id.</div>`;
  const kids = d.sessions.filter(c => c.parentSessionId === root.key).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  const lanes = new Map<string, AgentSessionSnapshot[]>();
  for (const k of kids) lanes.set(workerRole(k), [...(lanes.get(workerRole(k)) ?? []), k]);
  const rootRuns = runs.get(root.key) ?? [];
  h += `<div class="org"><div class="lead">${card(root, d, st.selected, `<div class="cl muted">${kids.length} worker(s) · ${kids.filter(isLive).length} live · ${kids.reduce((n, k) => n + k.changedFiles.length, 0)} files by workers${rootRuns.length ? ` · ${rootRuns.length} workflow run(s)` : ''}</div>${wfBadges(rootRuns) ? `<div class="cl">${wfBadges(rootRuns)}</div>` : ''}`)}</div><div class="lanes">`;
  for (const [role, list] of lanes) {
    const shown = list.slice(-12);
    h += `<div class="lane" style="--id:${identityColor(role)}"><div class="laneh"><b>${esc(role)}</b> <span class="muted">${list.length} · ${list.filter(isLive).length} live</span></div><div class="grid">${shown.map(k => card(k, d, st.selected, nested(k, d))).join('')}</div>${list.length > shown.length ? `<div class="muted">… ${list.length - shown.length} earlier ${esc(role)} worker(s)</div>` : ''}</div>`;
  }
  for (const r of [...rootRuns].reverse()) {
    const shown = r.agents.slice(-12);
    h += `<div class="lane wk-lane" style="--id:var(--accent)"><div class="laneh">${runStripHtml(r, 'wk-strip wk-lh')}</div>${shown.map(a => agentRowHtml(a, d.now, prettyModel, root)).join('')}${r.agents.length > shown.length ? `<div class="muted">… ${r.agents.length - shown.length} earlier agent(s) on the Workflows screen</div>` : ''}</div>`;
  }
  return h + `</div></div><div class="foot">Roles are the worker type the provider recorded (Claude subagent type, Codex agent nickname). Edges exist only where the provider recorded the parent. Workflow lanes: Claude Workflow-tool runs stored under this session's directory (OBSERVED link); agent status from the run journal and transcript recency, tokens include cache reads (DERIVED).</div>`;
}

function nested(k: AgentSessionSnapshot, d: WsData): string {
  const n = d.sessions.filter(c => c.parentSessionId === k.key).length;
  return n ? `<div class="cl muted">${n} nested worker(s)</div>` : '';
}

/** Minimum vertical distance (svg units, ≈ one 12 px text line) between two node labels of a Sankey column. */
const LABEL_GAP = 14;

const OUT_COLOR: Record<Outcome, string> = { live: 'var(--ok)', committed: 'var(--accent)', changed: 'var(--warn)', nochange: 'var(--quiet)' };

const VER_COLOR: Record<Verification, string> = { pass: 'var(--ok)', fail: 'var(--bad)', none: 'var(--quiet)' };

/** Sankey provider → repo → outcome → verification. Clicking a node or band filters the table below (flow.pick = "c<col>-<i>" or "l<stage>-<i>-<j>"). */
function flowView(d: WsData, st: WsState): string {
  const f = flow(d.sessions);
  const top = d.sessions.filter(s => !s.isWorker);
  const total = top.length;
  if (!total) return `<div class="empty">No sessions in the loaded history.</div>`;
  const cols: string[][] = [f.providers, f.repos, f.outcomes, f.verifs];
  const W = 1000, H = Math.max(260, Math.min(560, 40 + f.repos.length * 46)), nodeW = 12, gap = 10;
  const xs = [120, 390, 650, 880];
  const keyOf = (ci: number, s: AgentSessionSnapshot) => (ci === 0 ? s.provider : ci === 1 ? f.repoOf(s) : ci === 2 ? outcome(s) : verification(s));
  const val = (col: number, n: string) => top.filter(s => keyOf(col, s) === n).length;
  const scale = (H - 20 - gap * Math.max(...cols.map(c => c.length))) / total;
  const pos = new Map<string, { x: number; y: number; h: number; out: number; in: number }>();
  cols.forEach((c, ci) => {
    let y = 10;
    for (const n of c) {
      const h = Math.max(3, val(ci, n) * scale);
      pos.set(`${ci}:${n}`, { x: xs[ci], y, h, out: 0, in: 0 });
      y += h + gap;
    }
  });
  const pick = st.opts?.['flow.pick'] ?? '';
  let match: (s: AgentSessionSnapshot) => boolean = () => true;
  let pickLabel = '';
  const lab = (ci: number, n: string) => (ci === 0 ? PROV[n] : ci === 2 ? OUTCOME_LABEL[n as Outcome] : ci === 3 ? VERIFY_LABEL[n as Verification] : n);
  const mc = /^c(\d)-(\d+)$/.exec(pick), ml = /^l(\d)-(\d+)-(\d+)$/.exec(pick);
  if (mc && cols[+mc[1]]?.[+mc[2]] !== undefined) {
    const ci = +mc[1], n = cols[ci][+mc[2]];
    match = s => keyOf(ci, s) === n;
    pickLabel = lab(ci, n);
  } else if (ml && cols[+ml[1]]?.[+ml[2]] !== undefined && cols[+ml[1] + 1]?.[+ml[3]] !== undefined) {
    const ci = +ml[1], n1 = cols[ci][+ml[2]], n2 = cols[ci + 1][+ml[3]];
    match = s => keyOf(ci, s) === n1 && keyOf(ci + 1, s) === n2;
    pickLabel = `${lab(ci, n1)} → ${lab(ci + 1, n2)}`;
  }
  const colorOf = (ci: number, n: string) => (ci === 0 ? (n === 'claude' ? 'var(--claude)' : 'var(--codex)') : ci === 1 ? identityColor(n) : ci === 2 ? OUT_COLOR[n as Outcome] : VER_COLOR[n as Verification]);
  let paths = '', nodes = '';
  for (const l of f.links) {
    const ci = l.stage;
    const a = pos.get(`${ci}:${l.from}`), b = pos.get(`${ci + 1}:${l.to}`);
    if (!a || !b) continue;
    const w = Math.max(1, l.value * scale);
    const y1 = a.y + a.out + w / 2, y2 = b.y + b.in + w / 2;
    a.out += w;
    b.in += w;
    const x1 = a.x + nodeW, x2 = b.x, mx = (x1 + x2) / 2;
    const id = `l${ci}-${cols[ci].indexOf(l.from)}-${cols[ci + 1].indexOf(l.to)}`;
    paths += `<path class="fl${pick === id ? ' on' : ''}" data-opt="flow.pick" data-val="${pick === id ? '' : id}" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" stroke="${colorOf(ci + 1, l.to)}" stroke-width="${w.toFixed(1)}" fill="none"><title>${esc(`${lab(ci, l.from)} → ${lab(ci + 1, l.to)}: ${l.value} · click to list`)}</title></path>`;
  }
  cols.forEach((c, ci) => {
    let lastY = -Infinity;
    c.forEach((n, i) => {
      const p = pos.get(`${ci}:${n}`)!;
      const id = `c${ci}-${i}`;
      const tx = ci === 0 ? p.x - 6 : p.x + nodeW + 6;
      const ty = p.y + p.h / 2 + 4;
      // Labels closer than one text line to the previous one are left to the tooltip (small repo nodes).
      const text = ty - lastY >= LABEL_GAP ? `<text class="halo" x="${tx}" y="${ty}" text-anchor="${ci === 0 ? 'end' : 'start'}">${esc(lab(ci, n))} <tspan class="muted">${val(ci, n)}</tspan></text>` : '';
      if (text) lastY = ty;
      nodes += `<g class="fn${pick === id ? ' on' : ''}" data-opt="flow.pick" data-val="${pick === id ? '' : id}"><rect x="${p.x}" y="${p.y}" width="${nodeW}" height="${p.h}" rx="3" fill="${colorOf(ci, n)}"/>${text}<title>${esc(`${lab(ci, n)}: ${val(ci, n)} · click to list`)}</title></g>`;
    });
  });
  const heads = ['Provider', 'Repository', 'Outcome', 'Verification'].map((h, i) => `<text class="fh" x="${xs[i] + (i === 0 ? nodeW : 0)}" y="8" text-anchor="${i === 0 ? 'end' : 'start'}">${h}</text>`).join('');
  const rows = top.filter(match).sort((x, y) => (y.lastActivityAt ?? 0) - (x.lastActivityAt ?? 0)).slice(0, 200);
  const table = `<h2>${pick ? `${esc(pickLabel)} · ${top.filter(match).length} sessions <button class="link" data-opt="flow.pick" data-val="">clear</button>` : `All sessions · click a node or band to filter`}</h2><table class="ft"><thead><tr><th>Session</th><th>Provider</th><th>Repository</th><th>Outcome</th><th>Verification</th><th>Last activity</th></tr></thead><tbody>${rows.map(s => `<tr data-select="${esc(s.key)}" class="${s.key === st.selected ? 'sel' : ''}"><td>${esc(titleOf(s))}</td><td>${esc(PROV[s.provider])}</td><td>${esc(f.repoOf(s))}</td><td>${esc(OUTCOME_LABEL[outcome(s)])}</td><td><span class="sd" style="background:${VER_COLOR[verification(s)]}"></span> ${esc(VERIFY_LABEL[verification(s)])}</td><td>${esc(ago(d.now, s.lastActivityAt))}</td></tr>`).join('')}</tbody></table>`;
  return `<svg class="flow" viewBox="0 -6 ${W} ${H + 6}" preserveAspectRatio="xMidYMin meet">${heads}${paths}${nodes}</svg><div class="foot">${total} top-level sessions. Outcome is factual: live, commit observed in the session window, files edited without a commit, or no file change observed. Verification is the session's last observed test command. "No commit" is not a failure.</div>${table}`;
}

function worktrees(d: WsData, st: WsState): string {
  const top = d.sessions.filter(s => !s.isWorker);
  const repos = new Map<string, Map<string, AgentSessionSnapshot[]>>();
  for (const s of top) {
    const r = repoOf(s);
    const wt = `${s.branch ?? (s.detachedHead ? 'detached HEAD' : 'branch not exposed')}${s.isLinkedWorktree ? `\u0000${base(s.worktree)}` : ''}`;
    const m = repos.get(r) ?? new Map();
    m.set(wt, [...(m.get(wt) ?? []), s]);
    repos.set(r, m);
  }
  const liveIn = (m: Map<string, AgentSessionSnapshot[]>) => [...m.values()].flat().filter(isLive).length;
  const last = (m: Map<string, AgentSessionSnapshot[]>) => Math.max(...[...m.values()].flat().map(s => s.lastActivityAt ?? 0));
  const sorted = [...repos].sort((a, b) => liveIn(b[1]) - liveIn(a[1]) || last(b[1]) - last(a[1]));
  if (!sorted.length) return `<div class="empty">No sessions in the loaded history.</div>`;
  return sorted
    .map(([repo, m]) => {
      const rows = [...m].sort((a, b) => b[1].filter(isLive).length - a[1].filter(isLive).length || Math.max(...b[1].map(s => s.lastActivityAt ?? 0)) - Math.max(...a[1].map(s => s.lastActivityAt ?? 0)));
      return `<div class="repo" style="--id:${identityColor(repo)}"><div class="repoh"><span class="sw"></span><b>${esc(repo)}</b><span class="muted">${m.size} branch/worktree · ${[...m.values()].flat().length} sessions${liveIn(m) ? ` · <span class="pass">${liveIn(m)} live</span>` : ''}</span></div>${rows
        .map(([k, list]) => {
          const [br, wt] = k.split('\u0000');
          const sessions = list.sort((a, b) => order(a) - order(b) || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
          const ternBtn = d.ternAvailable ? ` <button class="link" data-cmd="openInTern" data-key="${esc(sessions[0].key)}">Open in Tern</button>` : '';
          return `<div class="wt"><div class="wtn"><span class="br">⎇ ${esc(br)}</span>${wt ? ` <span class="chip">wt ${esc(wt)}</span>` : ''}${ternBtn}</div><div class="who">${sessions
            .slice(0, 12)
            .map(s => `<span class="agent${st.selected === s.key ? ' sel' : ''}" data-select="${esc(s.key)}" title="${esc(`${titleOf(s)} — ${statusText(s)}`)}"><span class="dot ${s.status}"></span>${esc(s.provider === 'claude' ? 'Claude' : 'Codex')} <span class="muted">${esc(titleOf(s).slice(0, 26))}</span></span>`)
            .join('')}${sessions.length > 12 ? `<span class="muted">+${sessions.length - 12}</span>` : ''}</div></div>`;
        })
        .join('')}</div>`;
    })
    .join('');
}

/** Swimlanes for sessions active in the last 24 hours. */
export function gantt(d: WsData, st: WsState, limit = 60): string {
  const t0 = d.now - DAY;
  const recent = d.sessions.filter(s => !s.isWorker && (s.lastActivityAt ?? 0) >= t0);
  // Probe-like sessions (ended, < 3 min, no edit, no commit) fold into one line so real work stays readable.
  const brief = (s: AgentSessionSnapshot) => !isLive(s) && (s.lastActivityAt ?? 0) - (s.startedAt ?? 0) < 180_000 && !s.changedFiles.length && !s.commits.length;
  const folded = recent.filter(brief);
  const list = recent.filter(s => !brief(s)).sort((a, b) => order(a) - order(b) || (a.startedAt ?? 0) - (b.startedAt ?? 0));
  if (!recent.length) return `<div class="empty">No session active in the last 24 hours.</div>`;
  if (!list.length) list.push(...folded.splice(0));
  const from = Math.max(t0, Math.min(...list.map(s => s.startedAt ?? d.now)));
  const lo = Math.floor(from / 3600_000) * 3600_000, hi = Math.max(lo + 3600_000, d.now);
  const pct = (t: number) => ((Math.min(Math.max(t, lo), hi) - lo) / (hi - lo)) * 100;
  const hours: number[] = [];
  for (let t = lo; t <= hi; t += 3600_000) hours.push(t);
  const step = hours.length > 16 ? 3 : hours.length > 8 ? 2 : 1;
  let h = `<div class="gantt"><div class="gh"><span></span><div class="track">${hours.filter((_, i) => i % step === 0).map(t => `<span class="tick" style="left:${pct(t)}%">${String(new Date(t).getHours()).padStart(2, '0')}</span>`).join('')}<span class="now" style="left:${pct(d.now)}%"></span></div></div>`;
  for (const s of list.slice(0, limit)) {
    const a = pct(s.startedAt ?? lo), b = pct(isLive(s) ? d.now : (s.lastActivityAt ?? lo));
    const marks = [...s.commits.filter(c => c.at >= lo).map(c => `<i class="mk commit" style="left:${pct(c.at)}%" title="${esc(`commit ${c.sha.slice(0, 7)} ${c.subject}`)}"></i>`), ...s.tests.filter(t => t.at >= lo).map(t => `<i class="mk test ${t.outcome}" style="left:${pct(t.at)}%" title="${esc(`${t.outcome} ${t.command}`)}"></i>`)].join('');
    h += `<div class="gr${st.selected === s.key ? ' sel' : ''}" data-select="${esc(s.key)}"><span class="gl"><span class="dot ${s.status}"></span>${esc(titleOf(s).slice(0, 34))}</span><div class="track"><span class="bar2 ${s.provider}${isLive(s) ? ' live' : ''}" style="left:${a}%;width:${Math.max(0.6, b - a)}%;--id:${identityColor(repoOf(s))}"></span>${marks}</div></div>`;
  }
  if (list.length > limit) h += `<div class="muted">… ${list.length - limit} more sessions in the last 24 hours</div>`;
  if (folded.length) h += `<div class="gr"><span class="gl muted">+ ${folded.length} short sessions (&lt; 3 min, no edit)</span><div class="track">${folded.map(s => `<i class="mk test UNKNOWN" style="left:${pct(s.startedAt ?? lo)}%" title="${esc(titleOf(s))}"></i>`).join('')}</div></div>`;
  return h + `<div class="legend"><span class="bar2 claude sample"></span> Claude <span class="bar2 codex sample"></span> Codex <i class="mk commit sample"></i> commit <i class="mk test PASS sample"></i> test pass <i class="mk test FAIL sample"></i> test fail · bars span first→last observed activity</div></div>`;
}

function verify(d: WsData, st: WsState): string {
  const rows = d.sessions.flatMap(s => s.tests.map(t => ({ s, t }))).sort((a, b) => b.t.at - a.t.at);
  const today = d.now - DAY;
  const td = rows.filter(r => r.t.at >= today);
  const failingNow = d.sessions.filter(s => isLive(s) && s.tests[s.tests.length - 1]?.outcome === 'FAIL');
  let h = `<div class="kpis">${kpi(td.length, 'Runs 24 h')}${kpi(td.filter(r => r.t.outcome === 'PASS').length, 'Pass', 'k-run')}${kpi(td.filter(r => r.t.outcome === 'FAIL').length, 'Fail', td.some(r => r.t.outcome === 'FAIL') ? 'k-fail' : '')}${kpi(failingNow.length, 'Live, last failed', failingNow.length ? 'k-fail' : '')}${kpi(rows.filter(r => r.t.source === 'provider-exit-code').length, 'With exit code', '', 'outcome from the recorded process exit code (Codex); the rest come from the provider tool error flag (Claude)')}</div>`;
  if (!rows.length) return h + `<div class="empty">No test or build command observed. Agent never parses phrases like "tests passed" as proof.</div>`;
  h += `<table class="vt"><tr><th>When</th><th>Session</th><th>Repo</th><th>Command</th><th>Result</th><th>Source</th></tr>${rows
    .slice(0, 150)
    .map(({ s, t }) => `<tr class="${st.selected === s.key ? 'sel' : ''}" data-select="${esc(s.key)}"><td>${t.at >= dayStart(d.now) ? hhmm(t.at) : esc(new Date(t.at).toLocaleDateString(undefined, { weekday: 'short' }) + ' ' + hhmm(t.at))}</td><td>${esc(titleOf(s).slice(0, 30))}</td><td><span class="sw" style="--id:${identityColor(repoOf(s))}"></span>${esc(repoOf(s))}</td><td><code>${esc(t.command)}</code></td><td class="${t.outcome === 'PASS' ? 'pass' : t.outcome === 'FAIL' ? 'fail' : 'muted'}">${t.outcome}${t.exitCode !== undefined ? ` · exit ${t.exitCode}` : ''}</td><td class="muted">${t.source === 'provider-exit-code' ? 'exit code' : 'tool status'}</td></tr>`)
    .join('')}</table>`;
  return h;
}

function activity(d: WsData): string {
  const days = weekly(d.sessions, d.now);
  const max = Math.max(1, ...days.map(x => x.sessions));
  let h = `<div class="week">${days
    .map(x => `<div class="wd"><div class="stack" title="${esc(`Claude ${x.byProvider.claude} · Codex ${x.byProvider.codex}`)}"><i class="codex" style="height:${(x.byProvider.codex / max) * 100}%"></i><i class="claude" style="height:${(x.byProvider.claude / max) * 100}%"></i></div><b>${x.sessions}</b><span>${esc(x.label)}</span><span class="muted">${x.commits}c · ${x.tests}t</span></div>`)
    .join('')}</div>`;
  const grid = hourly(d.events, d.now);
  const hmax = Math.max(1, ...grid.flatMap(r => r.counts));
  h += `<h2>Observed events per hour</h2><div class="heat"><span></span>${Array.from({ length: 24 }, (_, i) => `<span class="hx">${i % 3 === 0 ? String(i).padStart(2, '0') : ''}</span>`).join('')}${grid
    .map(r => `<span class="hy">${esc(new Date(r.day).toLocaleDateString(undefined, { weekday: 'short' }))}</span>${r.counts.map((c, i) => `<i style="opacity:${c ? 0.18 + 0.82 * (c / hmax) : 0.06}" title="${esc(`${new Date(r.day).toDateString()} ${i}:00 — ${c} events`)}"></i>`).join('')}`)
    .join('')}</div><div class="foot">Commands, file edits, tests, commits and worker starts. Turn and tool chatter are excluded.</div>`;
  h += `<h2>Per day</h2><table><tr><th>Day</th><th>Sessions</th><th>Workers</th><th>Observed</th><th>Commits</th><th>Files</th><th>Tests</th><th>Repos</th></tr>${days
    .map(x => `<tr><td>${esc(x.label)} <span class="muted">${esc(x.day.slice(5))}</span></td><td>${x.sessions}</td><td>${x.workers}</td><td>${duration(x.durationMin * 60_000)}</td><td>${x.commits}</td><td>${x.filesChanged}</td><td>${x.tests}</td><td title="${esc(x.repos.join(', '))}">${x.repos.length}</td></tr>`)
    .join('')}</table>`;
  return h;
}

const MATRIX: [string, string, string][] = [
  ['Session id, start, last activity', 'transcript records', 'rollout records'],
  ['cwd / branch', 'record .cwd, .gitBranch, worktree-state', 'session_meta / turn_context .cwd'],
  ['Model / effort', 'assistant .model, record .effort', 'turn_context .model, .effort'],
  ['Live status', '~/.claude/sessions registry busy/idle', 'open turn + recency (INFERRED)'],
  ['Tests', 'command + tool error flag', 'command + exit code'],
  ['File edits', 'Edit/Write tool inputs', 'FileChange items'],
  ['Workers', 'subagents/ transcripts + meta', 'parent_thread_id, agent nickname'],
  ['Tokens', 'assistant .usage per message', 'token_count (cumulative)'],
  ['Context window', 'not recorded', 'token_count .model_context_window'],
  ['Cost', 'cost-state .totalCostUSD', 'not recorded'],
  ['HEAD before', 'git log before start (DERIVED)', 'session_meta git.commit_hash'],
];

function providersView(d: WsData, st: WsState): string {
  const src = sources(d);
  let h = `<h2>Collectors</h2><table class="src"><tr><th></th><th>Source</th><th>Status</th><th>Items</th><th>Detail</th><th>Collected</th></tr>${src
    .map(x => `<tr><td><span class="sd ${x.status}"></span></td><td>${esc(x.label)}</td><td class="st-${x.status}">${esc(x.status)}</td><td class="num">${x.count ?? ''}</td><td class="muted">${esc(x.detail)}</td><td class="muted">${hhmm(x.at)}</td></tr>`)
    .join('')}</table>`;
  // Storage: provider artifacts in the loaded window.
  const withSize = d.sessions.filter(s => s.artifactBytes);
  const per = (p: string) => withSize.filter(s => s.provider === p).reduce((n, s) => n + (s.artifactBytes ?? 0), 0);
  const total = per('claude') + per('codex');
  h += `<h2>Storage · provider logs in the loaded history</h2><div class="kpis">${kpi(bytes(total), 'Total')}${kpi(bytes(per('claude')), 'Claude Code')}${kpi(bytes(per('codex')), 'Codex')}${kpi(withSize.length, 'Artifacts')}</div>`;
  if (total) h += `<div class="split"><i class="claude" style="width:${(100 * per('claude')) / total}%"></i><i class="codex" style="width:${(100 * per('codex')) / total}%"></i></div>`;
  const largest = [...withSize].sort((x, y) => (y.artifactBytes ?? 0) - (x.artifactBytes ?? 0)).slice(0, 10);
  const max = largest[0]?.artifactBytes ?? 1;
  if (largest.length) h += `<table class="vt">${largest.map(s => `<tr class="${st.selected === s.key ? 'sel' : ''}" data-select="${esc(s.key)}"><td class="num">${bytes(s.artifactBytes ?? 0)}</td><td style="width:30%"><span class="szbar ${s.provider}" style="width:${Math.max(2, (100 * (s.artifactBytes ?? 0)) / max)}%"></span></td><td>${esc(titleOf(s).slice(0, 48))}${s.isWorker ? ' <span class="muted">worker</span>' : ''}</td><td class="muted">${esc(repoOf(s))}</td><td><button class="link" data-cmd="openArtifactFolder" data-key="${esc(s.key)}">Reveal</button></td></tr>`).join('')}</table>`;
  h += `<div class="foot">Sizes are the provider's own log files for sessions in the loaded window (\`agent.historyDays\`). Agent reads them incrementally and never copies, compacts or deletes them.</div>`;
  h += `<h2>Providers</h2><div class="grid">${d.providers
    .map(p => {
      const ss = d.sessions.filter(s => s.provider === p.provider);
      return `<div class="card" style="--id:${p.provider === 'claude' ? 'var(--claude)' : 'var(--codex)'}"><div class="ct"><span class="dot ${p.detected ? 'RUNNING' : 'UNKNOWN'}"></span><b>${esc(PROV[p.provider])}</b><span class="right">${p.version ? esc(p.version) : ''}</span></div><div class="cl muted">${esc(p.detected ? 'detected' : 'not detected')}${p.versionSource ? ` · version from ${esc(p.versionSource)}` : ''}</div><div class="cl">${ss.filter(s => !s.isWorker).length} sessions · ${ss.filter(s => s.isWorker).length} workers · ${ss.filter(isLive).length} live</div>${p.diagnostics.slice(0, 5).map(x => `<div class="cl basis">${esc(x)}</div>`).join('')}</div>`;
    })
    .join('')}</div>`;
  h += `<h2>Observability matrix</h2><table><tr><th>Fact</th><th>Claude Code</th><th>Codex</th></tr>${MATRIX.map(r => `<tr><td>${esc(r[0])}</td><td class="muted">${esc(r[1])}</td><td class="muted">${esc(r[2])}</td></tr>`).join('')}</table><div class="foot">Agent reads provider files only. It never uploads transcripts, never edits provider files and never controls sessions.</div>`;
  return h;
}

// ---------------------------------------------------------------- selection pane

export function side(d: WsData, key: string | undefined): string {
  const s = key ? d.sessions.find(x => x.key === key) : undefined;
  if (!s) return `<div class="empty">Select a session to see its result card.</div>`;
  const kids = d.sessions.filter(c => c.parentSessionId === s.key);
  const parent = s.parentSessionId ? d.sessions.find(x => x.key === s.parentSessionId) : undefined;
  let h = `<div class="sideh" style="--id:${identityColor(repoOf(s))}"><div class="muted">${esc(PROV[s.provider])}${s.isWorker ? ` · worker ${esc(workerRole(s))}` : ''}</div><h3>${esc(titleOf(s))}</h3><div><span class="dot ${s.status}"></span> ${esc(statusText(s))} <span class="muted">· ${esc(s.statusReason)}</span></div></div>`;
  return h + resultCard(s, d.now) + sideRest(d, s, kids, parent);
}

/** Tooltip of an end time that is only inferred (no end event recorded; the registry entry is gone). */
export const END_INFERRED_TIP = 'INFERRED: no end recorded by the provider; this is the time of the last record';

/** End time of a non-live session; an inferred end is shown as "inactive HH:MM", never as an observed end. */
export function endTime(s: AgentSessionSnapshot): string {
  return endInferred(s) ? `inactive ${hhmm(s.lastActivityAt)}` : hhmm(s.endedAt ?? s.lastActivityAt);
}

/** Caveat on commit counts: commits in a session's time window are not proof the session made them. */
export const COMMIT_CAVEAT = 'DERIVED from git: commits made in the repository during the session window. Not proof the session made them (only a recorded `git commit` by the session is).';

/** Commit count with its caveat: how many the session itself ran, the rest only fall in its time window. */
export function commitCount(s: AgentSessionSnapshot): string {
  const n = s.commits.length;
  if (!n) return '0';
  const own = s.commits.filter(c => c.attribution === 'session-ran-git-commit').length;
  return `<span title="${esc(COMMIT_CAVEAT)}">${n}${own < n ? '<sup>*</sup>' : ''}</span>${own < n ? `<span class="caveat muted" style="display:block;font-size:10px;font-weight:400">${own ? `${own} ran by session; ` : ''}${n - own} in window, not proof</span>` : ''}`;
}

/** Inspector jump bar: opens the workspace on a per-session screen with this session selected. */
export function inspectorJumps(key: string): string {
  return `<div class="jumps" data-key="${esc(key)}">Workspace: <button class="link" data-nav="replay" title="Open the Replay screen for this session">Replay</button> · <button class="link" data-nav="hud" title="Open the HUD screen with this session selected">HUD</button></div>`;
}

/** Session result: duration, model, HEAD before→after, commits, files, lines, tests, tokens, cost, context, stages. */
export function resultCard(s: AgentSessionSnapshot, now: number): string {
  const pass = s.tests.filter(t => t.outcome === 'PASS').length, fail = s.tests.filter(t => t.outcome === 'FAIL').length;
  const live = isLive(s);
  // No recorded end: the duration stops at the last recorded activity, so it is a lower bound (audit A3 P2-15).
  const open = !live && (endInferred(s) || !endObserved(s));
  const cell = (label: string, v: string, cls = '') => `<div class="rc ${cls}"><span>${esc(label)}</span><b>${v}</b></div>`;
  const u = s.usage;
  let h = '';
  h += `<div class="rcard">${cell(open ? 'Duration (to last record)' : 'Duration', `<span title="${esc(open ? 'DERIVED: first record to last record; no end recorded, so a lower bound' : live ? 'DERIVED: first record to now; the session is still live' : 'DERIVED: first record to the recorded end')}">${open ? '≥ ' : ''}${esc(duration((live ? now : (s.lastActivityAt ?? now)) - (s.startedAt ?? now)))}</span>`)}${cell('Model', esc([prettyModel(s.model), s.effort].filter(Boolean).join(' · ') || '—'))}${cell('HEAD', `<code>${esc(s.headBefore?.slice(0, 7) ?? '?')}</code> → <code>${esc(s.headAfter?.slice(0, 7) ?? '?')}</code>`)}${cell('Commits', commitCount(s), s.commits.length ? 'ok' : '')}${cell('Files', String(s.changedFiles.length))}${cell('Lines', s.linesAdded !== undefined ? `<span class="pass">+${s.linesAdded}</span> <span class="fail">−${s.linesRemoved ?? 0}</span>` : '—')}${cell('Tests', s.tests.length ? `<span class="pass">${pass}✓</span> <span class="fail">${fail}✗</span>` : '—', fail && s.tests[s.tests.length - 1].outcome === 'FAIL' ? 'bad' : '')}${cell('Tokens', u ? esc(compact(u.totalTokens)) : '—')}${u?.costUSD !== undefined ? cell('Cost (recorded)', `$${u.costUSD.toFixed(2)}`) : ''}${u?.contextTokens ? cell('Context', esc(u.contextWindow ? `${Math.round((100 * u.contextTokens) / u.contextWindow)}%` : compact(u.contextTokens))) : ''}</div>${ctxBar(s)}`;
  h += `<div class="sidestages">${stageStrip(s)}</div>`;
  return h;
}

function sideRest(d: WsData, s: AgentSessionSnapshot, kids: AgentSessionSnapshot[], parent: AgentSessionSnapshot | undefined): string {
  let h = `<div class="sloc"><div><span class="muted">repo</span> ${esc(repoOf(s))}</div><div><span class="muted">branch</span> ${esc(s.branch ?? (s.detachedHead ? 'detached HEAD' : 'not exposed'))}</div>${s.isLinkedWorktree ? `<div><span class="muted">worktree</span> ${esc(base(s.worktree))}</div>` : ''}${s.lastAction ? `<div><span class="muted">last</span> ${esc(s.lastAction)} <span class="muted">${esc(ago(d.now, s.lastActionAt))}</span></div>` : ''}</div>`;
  h += `<div class="acts"><button class="btn" data-open="${esc(s.key)}">Open inspector</button><button class="link" data-cmd="openTimeline" data-key="${esc(s.key)}">Timeline</button><button class="link" data-cmd="revealWorktree" data-key="${esc(s.key)}">Reveal</button><button class="link" data-cmd="copySessionId" data-key="${esc(s.key)}">Copy id</button>${d.ternAvailable ? `<button class="link" data-cmd="openInTern" data-key="${esc(s.key)}">Tern</button>` : ''}</div>`;
  if (parent) h += `<h2>Parent</h2><div class="mini" data-select="${esc(parent.key)}"><span class="dot ${parent.status}"></span>${esc(titleOf(parent))}</div>`;
  if (kids.length) h += `<h2>Workers · ${kids.length}</h2>${kids.slice(-10).map(k => `<div class="mini" data-select="${esc(k.key)}"><span class="dot ${k.status}"></span>${esc(titleOf(k).slice(0, 40))}</div>`).join('')}${kids.length > 10 ? `<button class="link" data-nav="team">all in Team →</button>` : ''}`;
  if (s.commits.length) h += `<h2>Commits</h2>${s.commits.slice(-6).map(c => `<div class="mini"><code>${esc(c.sha.slice(0, 7))}</code> ${esc(c.subject)}<div class="basis">${c.attribution === 'session-ran-git-commit' ? 'session ran git commit' : 'commit observed during session'}</div></div>`).join('')}`;
  const ev = d.events.filter(e => e.sessionKey === s.key && e.type !== 'TOOL_ACTIVITY' && e.type !== 'SESSION_ACTIVITY').slice(-10).reverse();
  if (ev.length) h += `<h2>Recent</h2>${ev.map(e => `<div class="tl2"><span class="muted">${hhmm(e.at)}</span> ${esc(e.label)}</div>`).join('')}`;
  return h;
}

// ---------------------------------------------------------------- shell

/** Scope key of a session: lowercase repository (or cwd) folder name. Toolbar values are lowercase. */
export const scopeKey = (s: AgentSessionSnapshot) => repoOf(s).toLowerCase();

/** Applies the `scope` option (a scopeKey from the Projects screen) to every screen. */
export function scoped(d: WsData, scope: string | undefined): WsData {
  if (!scope) return d;
  const keep = new Set(d.sessions.filter(s => scopeKey(s) === scope).map(s => s.key));
  return { ...d, sessions: d.sessions.filter(s => keep.has(s.key)), events: d.events.filter(e => keep.has(e.sessionKey)) };
}

export function attentionCount(d: WsData): number {
  return attention(d.sessions, d.now, d).filter(a => a.severity !== 'low').length;
}

function collectorSummary(d: WsData): string {
  const src = sources(d);
  if (!src.length) return '';
  const n = (k: string) => src.filter(s => s.status === k).length;
  const parts = [['ready', n('ready')], ['partial', n('partial')], ['missing', n('missing')], ['off', n('off')]].filter(([, c]) => c) as [string, number][];
  return `<button class="link cs" data-nav="providers" title="Collectors">${parts.map(([k, c]) => `<span class="sd ${k}"></span>${c} ${k}`).join(' · ')}</button>`;
}

/** Bottom strip: refresh cost and a ticker of repositories with live sessions (status dot per session). */
export function statusStrip(d: WsData): string {
  const live = d.sessions.filter(s => isLive(s));
  const byRepo = new Map<string, AgentSessionSnapshot[]>();
  for (const s of live) byRepo.set(repoOf(s), [...(byRepo.get(repoOf(s)) ?? []), s]);
  const repos = [...byRepo].sort((a, b) => b[1].length - a[1].length);
  const ticker = repos.slice(0, FOOT_REPOS).map(([r, ss]) => `<span class="tk" title="${esc(`${r}: ${ss.length} live (${ss.filter(x => x.isWorker).length} workers)`)}"><span class="sw" style="background:${identityColor(r)}"></span>${esc(r)} ${ss.map(x => `<span class="sd ${x.status}" title="${esc(`${titleOf(x)} · ${statusText(x)}`)}"></span>`).join('')}</span>`).join('') + (repos.length > FOOT_REPOS ? `<span class="muted" title="${esc(repos.slice(FOOT_REPOS).map(([r, ss]) => `${r}: ${ss.length} live`).join('\n'))}">+${repos.length - FOOT_REPOS}</span>` : '');
  const st = d.stats;
  const costText = st ? `refresh ${st.refreshMs} ms · git ${st.gitMs} ms · read ${bytes(st.bytesRead)} of ${st.artifacts} artifacts · heap ${st.heapMB} MB · ${hhmm(st.at)}` : '';
  const cost = st ? `<span title="${esc(`Last refresh pass (DERIVED, host-measured): ${costText}`)}">${esc(costText)}</span>` : '';
  // Git correlation progress while a pass runs (OBSERVED: counted by the store); nothing when idle.
  const gp = d.git?.progress;
  const prog = gp && gp.total > 0 && gp.done < gp.total ? `<span class="gitp" title="${esc(`Git correlation in progress (OBSERVED, counted while it runs): ${gp.done} of ${gp.total} sessions`)}">git ${gp.done}/${gp.total}</span> · ` : '';
  return `<footer class="strip"><span class="tkr" title="${esc(repos.map(([r, ss]) => `${r}: ${ss.length} live`).join('\n'))}">${live.length ? `<b>${live.length} live</b> ${ticker}` : '<span class="muted">nothing live</span>'}</span><span class="muted">${prog}${cost}</span></footer>`;
}

/** Repository chips shown in the footer strip before "+k". */
const FOOT_REPOS = 8;

export const RAIL_GROUPS = ['Now', 'Agents', 'Work', 'Change', 'Verify', 'Time', 'Usage', 'System'];
const CORE_GROUP: Record<string, string> = { 'control-map':'Agents', overview: 'Now', attention: 'Now', board: 'Work', team: 'Agents', gantt: 'Time', worktrees: 'Change', activity: 'Time', flow: 'Work', verify: 'Verify', providers: 'System' };
/** Reading order inside groups; screens not listed go last in their group. Ids that are not registered screens are
 *  ignored (rank only sorts screens that exist), so a planned id such as 'benchmarks' is harmless. */
export const RAIL_ORDER = ['compact', 'context-activity', 'asset-gallery', 'overview', 'attention', 'live', 'hud', 'panes', 'codex', 'control-map', 'team', 'topology', 'roles', 'dispatch', 'transcript', 'projects', 'workflows', 'board', 'flow', 'backlog', 'scope', 'worktrees', 'repos', 'changes', 'review', 'pipelines', 'verify', 'signals', 'health', 'gantt', 'replay', 'lifecycle', 'week', 'runs', 'activity', 'forecast', 'history', 'tokens', 'ctxcost', 'limits', 'explore', 'benchmarks', 'providers', 'settings', 'catalog', 'audit', 'launcher'];
/** The question each rail group answers (group header tooltip). */
export const RAIL_GROUP_HINT: Record<string, string> = {
  Now: 'What is going on right now, and what needs me?',
  Agents: 'Who worked under whom, what did each worker cost, and what did one session say?',
  Work: 'Which projects, runs and planned items are agents working on?',
  Change: 'What changed, where, and what is the PR / CI state?',
  Verify: 'Do tests pass, and what looks wrong?',
  Time: 'When, how often and in what order did agents run?',
  Usage: 'How much budget did agents use, and what did it buy?',
  System: 'Configuration, collectors, and the screens that run a process (Catalog CLI probe, Launcher).',
};

/** One entry of the jump-to-screen picker (webview "g" / Ctrl+K and the "Agent: Go to screen…" command). */
export interface ScreenEntry { id: string; label: string; group: string; hint: string }

/** Every registered screen exactly once, in rail order (group by group), with its label, group and hint. */
export function screenIndex(): ScreenEntry[] {
  const ext = new Map(extraViews().map(x => [x.id, x]));
  const groupOf = (v: string) => CORE_GROUP[v] ?? ext.get(v)?.group ?? 'System';
  const rank = (v: string) => (RAIL_ORDER.indexOf(v) < 0 ? 999 : RAIL_ORDER.indexOf(v));
  const gi = (g: string) => (RAIL_GROUPS.indexOf(g) < 0 ? RAIL_GROUPS.length : RAIL_GROUPS.indexOf(g));
  return [...new Set(allViews())]
    .map(id => ({ id, label: viewLabel(id), group: groupOf(id), hint: viewHint(id) }))
    .sort((a, b) => gi(a.group) - gi(b.group) || rank(a.id) - rank(b.id));
}

/** Hidden source list the webview picker reads when it opens (outside the rail; never a [data-nav] element). */
export function screenPickerSource(): string {
  return `<ul class="gp-src" hidden aria-hidden="true">${screenIndex().map(s => `<li data-gp="${esc(s.id)}" data-group="${esc(s.group)}" data-hint="${esc(s.hint)}">${esc(s.label)}</li>`).join('')}</ul>`;
}

function bodies(d: WsData, st: WsState): Record<string, () => string> {
  const body: Record<string, () => string> = {
    'control-map': () => controlMap(d, st), overview: () => overview(d, st), attention: () => attentionView(d, st), board: () => board(d, st), team: () => team(d, st), flow: () => flowView(d, st), worktrees: () => worktrees(d, st), gantt: () => gantt(d, st), verify: () => verify(d, st), activity: () => activity(d), providers: () => providersView(d, st),
  };
  for (const x of extraViews()) body[x.id] = () => x.render(d, st);
  return body;
}

/** Body of one screen (core or add-on) from already-scoped data, as if it were the visible screen. '' if unknown. */
export function renderView(d: WsData, st: WsState, view: string): string {
  const f = bodies(d, { ...st, view })[view];
  return f ? f() : '';
}

/** Rail label and hint of any screen id. */
export function viewLabel(v: string): string {
  return (VIEW_LABEL as Record<string, string>)[v] ?? extraViews().find(x => x.id === v)?.label ?? v;
}
export function viewHint(v: string): string {
  return (VIEW_HINT as Record<string, string>)[v] ?? extraViews().find(x => x.id === v)?.hint ?? '';
}

export function renderWorkspace(d0: WsData, st0: WsState): string {
  let st = st0;
  const d = scoped(d0, st0.opts?.scope);
  const top = d.sessions.filter(s => !s.isWorker);
  const badge: Record<string, string> = {
    attention: String(attentionCount(d) || ''),
    board: String(top.filter(isLive).length || ''),
    team: String(d.sessions.filter(s => s.isWorker && isLive(s)).length || ''),
    verify: String(d.sessions.filter(s => isLive(s) && s.tests[s.tests.length - 1]?.outcome === 'FAIL').length || ''),
  };
  for (const x of extraViews()) if (x.badge) badge[x.id] = x.badge(d);
  const ext = new Map(extraViews().map(x => [x.id, x]));
  const label = (v: string) => (VIEW_LABEL as Record<string, string>)[v] ?? ext.get(v)?.label ?? v;
  const hint = (v: string) => (VIEW_HINT as Record<string, string>)[v] ?? ext.get(v)?.hint ?? '';
  const navBtn = (v: string) => {
    const dk = digitOf(v);
    return `<button class="nav${st.view === v ? ' on' : ''}" data-nav="${esc(v)}"${dk ? ` title="Shortcut: ${dk}" aria-keyshortcuts="${dk}"` : ''}>${esc(label(v))}${badge[v] ? `<span class="nb${v === 'attention' || v === 'verify' ? ' hot' : ''}">${esc(badge[v])}</span>` : ''}${dk ? `<kbd class="dk">${dk}</kbd>` : ''}</button>`;
  };
  // Rail: every screen (core + add-on) in one of the groups, in a fixed reading order; groups collapse.
  const groupOf = (v: string) => CORE_GROUP[v] ?? ext.get(v)?.group ?? 'System';
  const all = [...WS_VIEWS, ...extraViews().map(x => x.id)];
  const rank = (v: string) => (RAIL_ORDER.indexOf(v) < 0 ? 999 : RAIL_ORDER.indexOf(v));
  const groups = RAIL_GROUPS.map(g => [g, all.filter(v => groupOf(v) === g).sort((a, b) => rank(a) - rank(b))] as const).filter(([, vs]) => vs.length);
  const railGroup = ([g, vs]: readonly [string, string[]]) => {
    const name = `rail.${g.toLowerCase()}`;
    const closed = st.opts?.[name] === 'closed' && !vs.includes(st.view);
    const hot = vs.reduce((n, v) => n + (Number(badge[v]) || 0), 0);
    return `<div class="rg${closed ? ' closed' : ''}"><button class="railg" data-opt="${name}" data-val="${closed ? '' : 'closed'}" title="${esc(`${closed ? 'Expand' : 'Collapse'} ${g}${RAIL_GROUP_HINT[g] ? ` · ${RAIL_GROUP_HINT[g]}` : ''}`)}"><span class="chev">${closed ? '▸' : '▾'}</span>${esc(g)}<span class="rgc">${closed && hot ? esc(String(hot)) : vs.length}</span></button>${closed ? '' : vs.map(navBtn).join('')}</div>`;
  };
  const rail = `<nav class="rail"><div class="brand">Agent <button class="link" data-cmd="openWorkspaceNewTab" title="Open another Agent tab (own screen and scope)">+ tab</button></div>${groups.map(railGroup).join('')}<div class="railfoot">${d.providers.map(p => `<div><span class="dot ${p.detected ? 'RUNNING' : 'UNKNOWN'}"></span> ${esc(PROV[p.provider])} ${esc(p.version ?? '')}</div>`).join('')}${collectorSummary(d)}<div class="muted">local · read-only</div></div></nav>`;
  const body = bodies(d, st);
  if (!body[st.view]) st = { ...st, view: 'overview' };
  const keys = `<div class="keys"><b>1–0</b> screens with a number in the rail <b>Tab</b> / <b>j/k</b> move <b>Space</b> select <b>Enter</b> inspect <b>/</b> filter <b>g</b> go to screen <b>Esc</b> clear <b>r</b> refresh <b>?</b> keys</div>`;
  const main = `<main class="mainw"><header class="mh"><h1>${esc(label(st.view))}</h1>${st.opts?.scope ? `<button class="link scope" data-opt="scope" data-val="" title="Clear scope">scope: ${esc(st.opts.scope)} ✕</button>` : ""}<span class="muted hint" title="${esc(hint(st.view))}">${esc(hint(st.view))}</span><span class="right"><span class="muted">updated ${hhmm(d.now)}</span> <button class="link" data-cmd="refresh">Refresh</button></span></header>${body[st.view]()}${keys}${statusStrip(d)}</main>`;
  const detailData = st.view === 'compact' ? { ...d, sessions: compactSessions(d, st) } : d;
  return `<div class="ws">${rail}${main}<aside class="side">${side(detailData, st.selected)}</aside>${screenPickerSource()}</div>`;
}
