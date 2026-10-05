// Add-on screen "Workflows": every Claude Code workflow run and its agents, live, plus background
// subagents (Agent tool) and Codex worker sessions. Data: src/providers/claude/workflows.ts (feed: 3 s while a run is live, else 30 s).
import * as path from 'path';
import type { AgentSessionSnapshot } from '../../model';
import { claudeRoot } from '../../providers/claude/claude';
import { BgAgent, LIVE_SCAN_MS, LIVE_WINDOW_MS, scanIntervalMs, WfAgent, WfRun, WorkflowsSnapshot, workflowScanner } from '../../providers/claude/workflows';
import { compact, identityColor, isLive } from '../../activity/insights';
import { esc } from '../html';
import { hhmm } from '../views';
import { prettyModel, repoOf, titleOf, kpi, WsData, WsState } from '../workspace';
import { feedValue, Feed } from './feeds';
import { actBtn, ExtraView, opt, seg, toolbar } from './kit';

const FEED = 'workflows.scan';

export const workflowsFeed: Feed<WorkflowsSnapshot> = {
  id: FEED,
  // Polled every 3 s; the scanner returns its cached snapshot unless a run is live (3 s) or 30 s have passed.
  intervalMs: LIVE_SCAN_MS,
  load: ctx => workflowScanner(path.join(claudeRoot(), 'projects')).scanIfDue(ctx.now),
};

/** Token totals re-count the cached prompt on every call: they are a derived sum, not new tokens. */
const TOK_BASIS = 'DERIVED sum incl. cache reads: input + cache read + cache creation + output, per model call (message id)';
const partialNote = (a: WfAgent) => (a.tokensPartial ? ' · partial: only the transcript tail (last 2 MB) was read' : '');

const PERIOD: Record<string, number> ={ '1h': 3600_000, '24h': 86400_000, '7d': 7 * 86400_000 };

/** Option values allow [a-z0-9._:-]: run ids carry "_", so the key drops other characters. */
export const runKey = (runId: string) => runId.toLowerCase().replace(/[^a-z0-9.:-]/g, '').slice(0, 40);

function dur(ms: number | undefined): string {
  if (ms === undefined || !isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h${String(m % 60).padStart(2, '0')}` : `${Math.floor(h / 24)}d${h % 24}h`;
}

function when(now: number, t: number | undefined): string {
  if (!t) return '—';
  return now - t < 86400_000 ? hhmm(t) : `${new Date(t).toISOString().slice(5, 10)} ${hhmm(t)}`;
}

const STATUS_LABEL: Record<string, string> = { running: 'running', done: 'done', failed: 'failed', stale: 'no result' };

function badge(status: string, basis: string): string {
  return `<span class="wf-st wf-${esc(status)}" title="${esc(basis)}">${esc(STATUS_LABEL[status] ?? status)}</span>`;
}

function agentEnd(a: WfAgent, now: number): number | undefined {
  return a.status === 'running' ? now : a.lastAt;
}

function parentOf(d: WsData, key: string, slug: string): { title: string; repo: string; known: boolean } {
  const s = d.sessions.find(x => x.key === key);
  if (s) return { title: titleOf(s), repo: repoOf(s), known: true };
  const tail = slug.split(/-+/).filter(Boolean).pop() ?? slug;
  return { title: key.slice(7, 15), repo: tail, known: false };
}

function dots(agents: WfAgent[]): string {
  return `<span class="wf-dots">${agents.map(a => `<i class="wf-dot wf-${esc(a.status)}" title="${esc(`${a.label}: ${STATUS_LABEL[a.status]}`)}"></i>`).join('')}</span>`;
}

function phaseStrip(run: WfRun): string {
  const parts = run.phases.map(p => {
    const ag = run.agents.filter(a => a.phase === p.title);
    const done = ag.filter(a => a.status === 'done' || a.status === 'failed').length;
    const state = !ag.length ? 'pending' : ag.some(a => a.status === 'running') ? 'running' : done === ag.length ? (ag.some(a => a.status === 'failed') ? 'failed' : 'done') : 'stale';
    return `<div class="wf-ph wf-ph-${state}" title="${esc(p.detail ?? p.title)}"><b>${esc(p.title)}</b> <span class="muted">${done}/${ag.length}</span> ${ag.length ? dots(ag) : '<i class="wf-dot wf-pending" title="no agent started in this phase yet"></i>'}</div>`;
  });
  const loose = run.agents.filter(a => !a.phase);
  if (loose.length) parts.push(`<div class="wf-ph"><b>(no phase)</b> ${dots(loose)}</div>`);
  return `<div class="wf-phases">${parts.join('<span class="wf-arrow">→</span>')}</div>`;
}

function agentRow(a: WfAgent, run: WfRun | undefined, d: WsData, st: WsState, cols: { run: boolean }): string {
  const known = d.sessions.some(s => s.key === a.sessionKey);
  const sel = opt(st, 'workflows.agent', '') === a.agentId.toLowerCase();
  const attr = known ? `data-select="${esc(a.sessionKey)}"` : `data-opt="workflows.agent" data-val="${esc(sel ? '' : a.agentId.toLowerCase())}"`;
  const end = agentEnd(a, d.now);
  const tool = a.currentTool ? `▸ ${a.currentTool}` : a.lastTool ?? '';
  return `<tr class="wf-row${sel ? ' sel' : ''}" ${attr} tabindex="0" title="${esc(a.statusBasis)}">
<td>${badge(a.status, a.statusBasis)}</td>
<td><b>${esc(a.label)}</b>${a.toolErrors ? ` <span class="wf-err" title="tool results flagged is_error (OBSERVED)">${a.toolErrors} err</span>` : ''}</td>
${cols.run ? `<td class="muted">${esc(run?.name ?? run?.runId ?? '')}</td>` : ''}
<td class="muted">${esc(a.agentType ?? '')}</td>
<td title="assistant message .model (OBSERVED)">${esc(prettyModel(a.model))}</td>
<td>${esc(a.phase ?? '')}</td>
<td class="num" title="first transcript timestamp (OBSERVED)">${esc(when(d.now, a.firstAt))}</td>
<td class="num" title="last − first timestamp, or now for running (DERIVED)">${esc(dur(a.firstAt && end ? end - a.firstAt : undefined))}</td>
<td class="num" title="${esc(`${TOK_BASIS}: ${a.tokens.toLocaleString()} total · ${a.outputTokens.toLocaleString()} output (OBSERVED) · ${a.calls} calls${partialNote(a)}`)}">${esc(a.tokens ? `${compact(a.tokens)}${a.tokensPartial ? '+' : ''}` : '—')}${a.outputTokens ? ` <span class="muted">· ${esc(compact(a.outputTokens))} out</span>` : ''}</td>
<td class="wf-tool" title="${esc(a.currentTool ? 'tool_use without tool_result yet (OBSERVED)' : 'last tool_use (OBSERVED)')}">${esc(tool)}</td>
<td class="muted" title="${esc(a.worktree ?? '')}">${esc(a.worktree ? path.basename(a.worktree) : '')}</td>
<td><button class="link" data-opt="workflows.agent" data-val="${esc(sel ? '' : a.agentId.toLowerCase())}" title="details">${sel ? '▾' : '▸'}</button></td></tr>`;
}

function agentHead(cols: { run: boolean }): string {
  return `<tr><th>Status</th><th>Agent</th>${cols.run ? '<th>Run</th>' : ''}<th>Type</th><th>Model</th><th>Phase</th><th>Started</th><th>Time</th><th>Tokens</th><th>Tool</th><th>Worktree</th><th></th></tr>`;
}

function detail(a: WfAgent, run: WfRun | undefined, d: WsData): string {
  const rows: [string, string, string][] = [
    ['Agent id', a.agentId, 'journal / file name (OBSERVED)'],
    ['Label', a.label, 'journal started.label (OBSERVED)'],
    ['Description', a.description ?? '', 'meta.json description (OBSERVED)'],
    ['Type', a.agentType ?? '', 'meta.json agentType (OBSERVED)'],
    ['Run', run ? `${run.name ?? ''} ${run.runId}` : '', 'folder name + script meta (OBSERVED)'],
    ['Phase', a.phase ?? '', 'journal started.phase (OBSERVED)'],
    ['Model', a.model ?? '', 'assistant message .model (OBSERVED)'],
    ['Status', `${STATUS_LABEL[a.status]} — ${a.statusBasis}`, a.statusBasis.split(':')[0]],
    ['Started / last', `${when(d.now, a.firstAt)} → ${when(d.now, a.lastAt)}`, 'transcript timestamps (OBSERVED)'],
    ['Tokens', `${a.tokens.toLocaleString()} total incl. cache reads · ${a.outputTokens.toLocaleString()} output · ${a.calls} model calls${partialNote(a)}`, `${TOK_BASIS}; output: OBSERVED`],
    ['Tools', `${a.tools} calls · ${a.toolErrors} flagged error`, 'tool_use / tool_result is_error (OBSERVED)'],
    ['Now / last tool', a.currentTool ? `▸ ${a.currentTool}` : `${a.lastTool ?? '—'} ${a.lastToolAt ? `at ${hhmm(a.lastToolAt)}` : ''}`, 'tool_use records (OBSERVED)'],
    ['Result', a.result ?? '—', 'journal result, summarized and redacted (≤ 160 chars)'],
    ['Worktree', a.worktree ?? '', 'meta.json worktreePath (OBSERVED)'],
    ['Spawn depth', a.spawnDepth !== undefined ? String(a.spawnDepth) : '', 'meta.json spawnDepth (OBSERVED)'],
    ['Transcript', a.transcript ? `${path.basename(a.transcript)}${a.transcriptBytes ? ` · ${Math.round(a.transcriptBytes / 1024)} KB` : ''}` : '', 'file on disk'],
  ];
  const acts = [
    a.transcript ? actBtn('open', a.transcript, 'Open transcript', 'Opens the agent transcript (read-only)') : '',
    a.worktree ? actBtn('reveal', a.worktree, 'Reveal worktree', 'Shows the worktree folder in the OS') : '',
    run?.scriptPath ? actBtn('open', run.scriptPath, 'Open script', 'Opens the workflow script') : '',
  ].filter(Boolean).join(' ');
  return `<div class="wf-detail"><dl>${rows.filter(r => r[1]).map(([k, v, t]) => `<dt>${esc(k)}</dt><dd title="${esc(t)}">${esc(v)}</dd>`).join('')}</dl><div>${acts}</div></div>`;
}

function runBasis(run: WfRun): string {
  if (run.finalStatus) return `OBSERVED: workflows/<run>.json status "${run.finalStatus}"`;
  if (run.status === 'running') return 'INFERRED: an agent has no result and its transcript was written < 10 min ago';
  if (run.status === 'done') return 'OBSERVED: every started agent has a journal result';
  return 'INFERRED: agents without result, quiet ≥ 10 min, no final run state';
}

function runSummary(run: WfRun, d: WsData): { done: number; total: number; tokens: number; output: number; elapsed: number | undefined } {
  const done = run.agents.filter(a => a.status === 'done' || a.status === 'failed').length;
  const tokens = run.agents.reduce((n, a) => n + a.tokens, 0);
  const output = run.agents.reduce((n, a) => n + a.outputTokens, 0);
  const end = run.status === 'running' ? d.now : run.lastAt;
  return { done, total: run.agents.length, tokens, output, elapsed: run.startedAt && end ? end - run.startedAt : undefined };
}

function runsMode(runs: WfRun[], d: WsData, st: WsState): string {
  const open = opt(st, 'workflows.run', runs.find(r => r.status === 'running') ? runKey(runs.find(r => r.status === 'running')!.runId) : runs[0] ? runKey(runs[0].runId) : '');
  const selAgent = opt(st, 'workflows.agent', '');
  return runs.map(run => {
    const k = runKey(run.runId);
    const isOpen = k === open;
    const p = parentOf(d, run.parentKey, run.projectSlug);
    const sm = runSummary(run, d);
    const failed = run.agents.filter(a => a.status === 'failed').length;
    const head = `<div class="wf-rh" data-opt="workflows.run" data-val="${esc(isOpen ? 'none' : k)}" style="--id:${identityColor(p.repo)}" title="${esc(run.description ?? run.runId)}">
<span class="wf-st wf-${esc(run.status)}" title="${esc(runBasis(run))}">${esc(run.status)}</span>${run.error ? `<span class="wf-err" title="run error (OBSERVED, redacted)">${esc(run.error)}</span>` : ''}
<b>${esc(run.name ?? run.runId)}</b>${dots(run.agents)}
<span class="muted">${esc(p.repo)} · ${p.known ? `<span data-select="${esc(run.parentKey)}" class="wf-parent" title="parent session">${esc(p.title)}</span>` : esc(p.title)}</span>
<span class="right num"><span title="first agent timestamp (OBSERVED)">${esc(when(d.now, run.startedAt))}</span> · <span title="DERIVED">${esc(dur(sm.elapsed))}</span> · <span title="agents with a journal result / started (OBSERVED)">${sm.done}/${sm.total}${failed ? ` <span class="wf-err">${failed} failed</span>` : ''}</span> · <span title="${esc(`${TOK_BASIS}, summed over the run's agents`)}">${esc(compact(sm.tokens))} tok</span> · <span title="output tokens, summed over the run's agents (OBSERVED)">${esc(compact(sm.output))} out</span></span></div>`;
    if (!isOpen) return `<div class="wf-run">${head}</div>`;
    const cols = { run: false };
    const sel = run.agents.find(a => a.agentId.toLowerCase() === selAgent);
    return `<div class="wf-run open">${head}${run.description ? `<div class="muted wf-desc">${esc(run.description)}</div>` : ''}${phaseStrip(run)}
<table class="wf-t">${agentHead(cols)}${run.agents.map(a => agentRow(a, run, d, st, cols)).join('')}</table>${sel ? detail(sel, run, d) : ''}
<div class="wf-acts">${run.scriptPath ? actBtn('open', run.scriptPath, 'Open script') : ''} <span class="muted">${esc(run.runId)}</span></div></div>`;
  }).join('');
}

interface Flat {
  a: WfAgent;
  run: WfRun;
}

function groupKey(f: Flat, by: string, d: WsData): string {
  if (by === 'phase') return f.a.phase ?? '(no phase)';
  if (by === 'parent') {
    const p = parentOf(d, f.run.parentKey, f.run.projectSlug);
    return `${p.repo} · ${p.title}`;
  }
  return `${f.run.name ?? f.run.runId}`;
}

function grouped(flat: Flat[], by: string, d: WsData): [string, Flat[]][] {
  const m = new Map<string, Flat[]>();
  for (const f of flat) {
    const k = groupKey(f, by, d);
    (m.get(k) ?? m.set(k, []).get(k)!).push(f);
  }
  return [...m];
}

function agentsMode(flat: Flat[], d: WsData, st: WsState): string {
  const by = opt(st, 'workflows.group', 'run');
  const cols = { run: by !== 'run' };
  const selAgent = opt(st, 'workflows.agent', '');
  const sel = flat.find(f => f.a.agentId.toLowerCase() === selAgent);
  return grouped(flat, by, d).map(([k, fs]) => `<h2 class="wf-g">${esc(k)} <span class="muted">${fs.length} agents ${dots(fs.map(f => f.a))}</span></h2>
<table class="wf-t">${agentHead(cols)}${fs.map(f => agentRow(f.a, f.run, d, st, cols)).join('')}</table>`).join('') + (sel ? detail(sel.a, sel.run, d) : '');
}

function timelineMode(flat: Flat[], d: WsData, st: WsState): string {
  const items = flat.filter(f => f.a.firstAt).slice(0, 300);
  if (!items.length) return '<div class="empty">No agent has a timestamp yet.</div>';
  const t0 = Math.min(...items.map(f => f.a.firstAt!));
  const t1 = Math.max(...items.map(f => agentEnd(f.a, d.now) ?? f.a.firstAt!), t0 + 60_000);
  const span = t1 - t0;
  const ticks = Array.from({ length: 6 }, (_, i) => t0 + (span * i) / 5);
  const axis = `<div class="wf-gl"><span></span><div class="wf-axis">${ticks.map((t, i) => `<span style="left:${(i * 20).toFixed(1)}%">${esc(when(d.now, t))}</span>`).join('')}</div></div>`;
  const by = opt(st, 'workflows.group', 'run');
  const selAgent = opt(st, 'workflows.agent', '');
  const sel = items.find(f => f.a.agentId.toLowerCase() === selAgent);
  const body = grouped(items, by, d).map(([k, fs]) => `<div class="wf-gh">${esc(k)}</div>` + fs.map(f => {
    const a = f.a;
    const end = agentEnd(a, d.now) ?? a.firstAt!;
    const left = ((a.firstAt! - t0) / span) * 100;
    const width = Math.max(0.4, ((end - a.firstAt!) / span) * 100);
    const known = d.sessions.some(s => s.key === a.sessionKey);
    const attr = known ? `data-select="${esc(a.sessionKey)}"` : `data-opt="workflows.agent" data-val="${esc(a.agentId.toLowerCase())}"`;
    const tip = `${a.label} · ${STATUS_LABEL[a.status]} · ${when(d.now, a.firstAt)} → ${when(d.now, end)} (${dur(end - a.firstAt!)}) · ${compact(a.tokens)} tok incl. cache · ${compact(a.outputTokens)} out · ${prettyModel(a.model)}`;
    return `<div class="wf-gl${selAgent === a.agentId.toLowerCase() ? ' sel' : ''}" ${attr} tabindex="0"><span class="wf-gn" title="${esc(a.label)}">${esc(a.label)}</span><div class="wf-track"><i class="wf-bar wf-${esc(a.status)}" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%" title="${esc(tip)}"></i></div></div>`;
  }).join('')).join('');
  return `<div class="wf-gantt">${axis}${body}</div>${sel ? detail(sel.a, sel.run, d) : ''}`;
}

function bgSection(bg: BgAgent[], d: WsData): string {
  if (!bg.length) return '';
  const rows = bg.slice(0, 40).map(b => {
    const s = d.sessions.find(x => x.key === b.sessionKey);
    const p = parentOf(d, b.parentKey, '');
    const live = d.now - b.mtimeMs < LIVE_WINDOW_MS;
    const status = s ? (isLive(s) ? 'running' : 'done') : live ? 'running' : 'done';
    const basis = s ? `session status ${s.status}: ${s.statusReason}` : live ? 'INFERRED: transcript written < 10 min ago' : 'INFERRED: transcript quiet ≥ 10 min';
    const attr = s ? `data-select="${esc(s.key)}"` : '';
    const started = s?.startedAt ?? b.birthMs;
    return `<tr class="wf-row" ${attr} tabindex="0"><td>${badge(status, basis)}</td><td><b>${esc(b.description ?? b.agentId)}</b></td><td class="muted">${esc(b.agentType ?? '')}</td><td title="${esc(s?.model ?? '')}">${esc(prettyModel(s?.model))}</td><td>${esc(p.known ? `${p.repo} · ${p.title}` : b.sessionId.slice(0, 8))}</td><td class="num">${esc(when(d.now, started))}</td><td class="num" title="last write (OBSERVED file mtime)">${esc(when(d.now, b.mtimeMs))}</td><td class="num" title="${s?.usage ? 'provider-recorded usage (OBSERVED)' : 'not loaded by the session store'}">${esc(s?.usage ? compact(s.usage.totalTokens) : '—')}</td><td class="wf-tool">${esc(s?.facts?.currentTool ? `▸ ${s.facts.currentTool.name}` : s?.lastAction ?? '')}</td><td>${s ? '' : actBtn('open', b.transcript, 'transcript', 'Open the transcript (read-only)')}</td></tr>`;
  }).join('');
  return `<h2>Background subagents <span class="muted">${bg.length} in 7 days · Agent tool, subagents/agent-*.jsonl</span></h2><table class="wf-t"><tr><th>Status</th><th>Description</th><th>Type</th><th>Model</th><th>Parent</th><th>Started</th><th>Last write</th><th>Tokens</th><th>Last action</th><th></th></tr>${rows}</table>`;
}

function codexSection(d: WsData): string {
  const ws = d.sessions.filter(s => s.provider === 'codex' && s.isWorker).sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)).slice(0, 60);
  if (!ws.length) return '<h2>Codex workers</h2><div class="empty">No Codex worker session in the loaded history.</div>';
  const byKey = new Map(d.sessions.map(s => [s.key, s] as [string, AgentSessionSnapshot]));
  const rows = ws.map(s => {
    const parent = s.parentSessionId ? byKey.get(s.parentSessionId) : undefined;
    const st = isLive(s) ? 'running' : 'done';
    const end = isLive(s) ? d.now : s.endedAt ?? s.lastActivityAt;
    return `<tr class="wf-row" data-select="${esc(s.key)}" tabindex="0"><td>${badge(st, `session status ${s.status}: ${s.statusReason}`)}</td><td><b>${esc(s.workerLabel ?? titleOf(s))}</b></td><td>${esc(parent ? titleOf(parent) : s.parentSessionId?.slice(6, 14) ?? '')}</td><td>${esc([prettyModel(s.model), s.effort].filter(Boolean).join(' · '))}</td><td class="num">${esc(when(d.now, s.startedAt))}</td><td class="num">${esc(dur(s.startedAt && end ? end - s.startedAt : undefined))}</td><td class="num" title="provider-recorded usage (OBSERVED)">${esc(s.usage ? compact(s.usage.totalTokens) : '—')}</td><td class="wf-tool">${esc(s.facts?.currentTool ? `▸ ${s.facts.currentTool.name}` : s.lastAction ?? '')}</td></tr>`;
  }).join('');
  return `<h2>Codex workers <span class="muted">${ws.length} · spawned Codex sessions</span></h2><table class="wf-t"><tr><th>Status</th><th>Worker</th><th>Parent</th><th>Model</th><th>Started</th><th>Time</th><th>Tokens</th><th>Last action</th></tr>${rows}</table>`;
}

export function renderWorkflows(d: WsData, st: WsState, snap: WorkflowsSnapshot | undefined, error?: string): string {
  const mode = opt(st, 'workflows.mode', 'runs');
  const period = opt(st, 'workflows.period', '7d');
  const bar = toolbar(
    seg(st, 'workflows.mode', [['runs', 'Runs'], ['agents', 'All agents'], ['timeline', 'Timeline']], 'runs', 'View'),
    mode !== 'runs' ? seg(st, 'workflows.group', [['run', 'By run'], ['phase', 'By phase'], ['parent', 'By parent session']], 'run', 'Group by') : '',
    seg(st, 'workflows.period', [['1h', '1 h'], ['24h', '24 h'], ['7d', '7 d']], '7d', 'Runs active in'),
    seg(st, 'workflows.only', [['all', 'All'], ['live', 'Running only']], 'all', 'Filter'),
  );
  if (!snap) return `${bar}<div class="empty">${esc(error ? `Workflow scan failed: ${error}` : 'Scanning ~/.claude/projects for workflow runs…')}</div>${codexSection(d)}`;
  const since = d.now - (PERIOD[period] ?? PERIOD['7d']);
  const scope = st.opts?.scope;
  const keys = new Set(d.sessions.map(s => s.key));
  let runs = snap.runs.filter(r => (r.lastAt ?? r.startedAt ?? 0) >= since);
  if (scope) runs = runs.filter(r => keys.has(r.parentKey));
  if (opt(st, 'workflows.only', 'all') === 'live') runs = runs.filter(r => r.status === 'running');
  let bg = snap.background.filter(b => b.mtimeMs >= since);
  if (scope) bg = bg.filter(b => keys.has(b.parentKey));
  if (opt(st, 'workflows.only', 'all') === 'live') bg = bg.filter(b => d.now - b.mtimeMs < LIVE_WINDOW_MS);
  const flat: Flat[] = runs.flatMap(run => run.agents.map(a => ({ a, run })));
  const running = flat.filter(f => f.a.status === 'running').length;
  const done = flat.filter(f => f.a.status === 'done' || f.a.status === 'failed').length;
  const tokens = flat.reduce((n, f) => n + f.a.tokens, 0);
  const output = flat.reduce((n, f) => n + f.a.outputTokens, 0);
  const codexLive = d.sessions.filter(s => s.provider === 'codex' && s.isWorker && isLive(s)).length;
  const kpis = `<div class="kpis">${kpi(runs.filter(r => r.status === 'running').length, 'runs running', 'k-run', 'INFERRED from journal + transcript recency')}${kpi(runs.length, 'runs')}${kpi(running, 'agents running', 'k-run')}${kpi(`${done}/${flat.length}`, 'agents done', '', 'journal results / started (OBSERVED)')}${kpi(compact(tokens), 'tokens incl. cache', '', TOK_BASIS)}${kpi(compact(output), 'output tokens', '', 'output tokens per model call (OBSERVED)')}${kpi(bg.filter(b => d.now - b.mtimeMs < LIVE_WINDOW_MS).length, 'background live', '', 'INFERRED: transcript written < 10 min ago')}${kpi(codexLive, 'Codex workers live')}</div>`;
  const body = !runs.length
    ? '<div class="empty">No workflow run in this period.</div>'
    : mode === 'agents' ? agentsMode(flat, d, st) : mode === 'timeline' ? timelineMode(flat, d, st) : runsMode(runs, d, st);
  const legend = `<div class="legend muted wf-legend">${['running', 'done', 'failed', 'stale'].map(s => `<i class="wf-dot wf-${s}"></i> ${STATUS_LABEL[s]}`).join(' ')} · done / failed: OBSERVED journal result · running / no result: INFERRED (transcript written &lt; 10 min ago) · tokens: DERIVED sum incl. cache reads (re-counted every call), output tokens shown next to them · model, tools: OBSERVED · times: DERIVED · scan ${snap.scanMs} ms, every ${scanIntervalMs(snap) / 1000} s${snap.diagnostics.length ? ` · ${esc(snap.diagnostics.join('; '))}` : ''}</div>`;
  return `${bar}${kpis}${body}${bgSection(bg, d)}${codexSection(d)}${legend}`;
}

function knownPath(arg: string, kind: 'file' | 'dir'): string | undefined {
  const snap = feedValue<WorkflowsSnapshot>(FEED).value;
  if (!snap || typeof arg !== 'string' || arg.length > 1000) return undefined;
  for (const r of snap.runs) {
    if (kind === 'file' && r.scriptPath === arg) return arg;
    for (const a of r.agents) if ((kind === 'file' ? a.transcript : a.worktree) === arg) return arg;
  }
  if (kind === 'file') for (const b of snap.background) if (b.transcript === arg) return arg;
  return undefined;
}

export const workflowsView: ExtraView = {
  id: 'workflows',
  label: 'Workflows',
  group: 'Now',
  hint: 'Claude Code workflow runs and their agents live: phases, model, time, tokens, current tool; plus background subagents and Codex workers.',
  ready: true,
  feeds: [workflowsFeed as Feed],
  badge: () => {
    const v = feedValue<WorkflowsSnapshot>(FEED).value;
    const n = v ? v.runs.reduce((k, r) => k + r.agents.filter(a => a.status === 'running').length, 0) : 0;
    return n ? String(n) : '';
  },
  render: (d, st) => {
    const f = feedValue<WorkflowsSnapshot>(FEED);
    return `<div class="wf">${renderWorkflows(d, st, f.value, f.error)}</div>`;
  },
  actions: {
    open: async (arg, ctx) => {
      const p = knownPath(arg, 'file');
      if (!p) return ctx.info('Unknown file.');
      await ctx.openFile(p);
    },
    reveal: async (arg, ctx) => {
      const p = knownPath(arg, 'dir');
      if (!p) return ctx.info('Unknown folder.');
      await ctx.revealInOs(p);
    },
  },
  css: `
.wf .wf-run { border: 1px solid var(--line); border-radius: 6px; margin: 0 0 6px; background: var(--raise); }
.wf .wf-rh { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 6px 9px; cursor: pointer; border-left: 3px solid var(--id, var(--accent)); border-radius: 6px; }
.wf .wf-rh:hover { background: var(--vscode-list-hoverBackground); }
.wf .wf-rh .right { margin-left: auto; }
.wf .wf-parent { text-decoration: underline dotted; cursor: pointer; }
.wf .wf-desc { padding: 0 10px; font-size: 11px; }
.wf .wf-phases { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 6px 10px; }
.wf .wf-ph { border: 1px solid var(--line); border-radius: 4px; padding: 2px 7px; font-size: 11px; display: inline-flex; gap: 5px; align-items: center; }
.wf .wf-ph-running { border-color: var(--accent); } .wf .wf-ph-done { border-color: color-mix(in srgb, var(--ok) 60%, transparent); } .wf .wf-ph-failed { border-color: var(--bad); } .wf .wf-ph-pending { opacity: .6; }
.wf .wf-arrow { color: var(--quiet); }
.wf .wf-dots { display: inline-flex; gap: 2px; flex-wrap: wrap; max-width: 260px; vertical-align: middle; }
.wf .wf-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--quiet); vertical-align: middle; }
.wf .wf-dot.wf-done { background: var(--ok); } .wf .wf-dot.wf-failed { background: var(--bad); } .wf .wf-dot.wf-stale { background: var(--warn); }
.wf .wf-dot.wf-running { background: var(--accent); animation: wf-pulse 1.2s ease-in-out infinite; }
.wf .wf-dot.wf-pending { background: transparent; border: 1px solid var(--quiet); box-sizing: border-box; }
@keyframes wf-pulse { 50% { opacity: .35; } }
.wf .wf-st { font-size: 10px; padding: 0 6px; border-radius: 8px; border: 1px solid var(--line); white-space: nowrap; }
.wf .wf-st.wf-running { color: var(--accent); border-color: var(--accent); } .wf .wf-st.wf-done { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 60%, transparent); }
.wf .wf-st.wf-failed { color: var(--bad); border-color: var(--bad); } .wf .wf-st.wf-killed { color: var(--warn); border-color: var(--warn); } .wf .wf-st.wf-stale { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 60%, transparent); }
.wf .wf-err { color: var(--bad); font-size: 10px; }
.wf table.wf-t { width: 100%; margin: 2px 0 8px; }
.wf .wf-row { cursor: pointer; } .wf .wf-row:hover { background: var(--vscode-list-hoverBackground); }
.wf .wf-tool { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--vscode-editor-font-family); font-size: 11px; }
.wf .wf-detail { border: 1px solid var(--line); border-radius: 6px; padding: 6px 10px; margin: 4px 10px 8px; background: var(--vscode-editor-background); }
.wf .wf-detail dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 0 0 6px; font-size: 12px; }
.wf .wf-detail dt { color: var(--vscode-descriptionForeground); } .wf .wf-detail dd { margin: 0; overflow-wrap: anywhere; }
.wf .wf-acts { padding: 0 10px 6px; font-size: 11px; }
.wf h2.wf-g { font-size: 12px; margin: 10px 0 2px; }
.wf .wf-gantt { margin: 4px 0 10px; }
.wf .wf-gl { display: grid; grid-template-columns: 200px 1fr; gap: 6px; align-items: center; min-height: 16px; cursor: pointer; }
.wf .wf-gl:hover, .wf .wf-gl.sel { background: var(--vscode-list-hoverBackground); }
.wf .wf-gn { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
.wf .wf-gh { font-size: 11px; font-weight: 600; margin: 6px 0 2px; color: var(--vscode-descriptionForeground); }
.wf .wf-axis { position: relative; height: 14px; font-size: 10px; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--line); }
.wf .wf-axis span { position: absolute; transform: translateX(-50%); white-space: nowrap; } .wf .wf-axis span:first-child { transform: none; } .wf .wf-axis span:last-child { transform: translateX(-100%); }
.wf .wf-track { position: relative; height: 10px; background: color-mix(in srgb, var(--line) 35%, transparent); border-radius: 2px; }
.wf .wf-bar { position: absolute; top: 0; bottom: 0; border-radius: 2px; background: var(--quiet); }
.wf .wf-bar.wf-done { background: var(--ok); } .wf .wf-bar.wf-failed { background: var(--bad); } .wf .wf-bar.wf-stale { background: var(--warn); }
.wf .wf-bar.wf-running { background: var(--accent); animation: wf-pulse 1.2s ease-in-out infinite; }
.wf .wf-legend { margin-top: 10px; font-size: 11px; }
`,
};
