// Shared bits for showing Claude workflow runs next to their lead (Topology, Team, Live, Overview, HUD).
// Data: the "workflows.scan" feed of the Workflows screen (one cached scanner, no extra file reads).
import type { AgentSessionSnapshot } from '../../model';
import type { WfAgent, WfRun, WorkflowsSnapshot } from '../../providers/claude/workflows';
import { compact } from '../../activity/insights';
import { agentLabel, agentWallMs, modelEffortText, runCounts, runsByLead, runStrip, WF_COUNT_BASIS, WF_LINK_BASIS } from '../../activity/wfLinks';
import { esc } from '../html';
import type { WsData } from '../workspace';
import { feedValue } from './feeds';

/** Same id as workflowsFeed in ./workflows (kept literal here so core screens avoid an import cycle). */
export const WF_FEED_ID = 'workflows.scan';

export function wfSnapshot(): WorkflowsSnapshot | undefined {
  return feedValue<WorkflowsSnapshot>(WF_FEED_ID).value;
}

/** Runs per lead key for the loaded sessions; agents already loaded as sessions are left out. */
export function leadRuns(d: WsData): Map<string, WfRun[]> {
  const snap = wfSnapshot();
  if (!snap?.runs.length) return new Map();
  return runsByLead(snap, new Set(d.sessions.map(s => s.key)));
}

export function wfDur(ms: number | undefined): string {
  if (ms === undefined || !isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, '0')}`;
}

export function wfDot(status: string, basis: string): string {
  return `<span class="wk-dot wk-${esc(status)}" title="${esc(`${status} — ${basis}`)}"></span>`;
}

export const WF_TOK_BASIS = 'workflow agent tokens: DERIVED sum incl. cache reads (input + cache read + cache creation + output) per model call';

/** Compact strip under a lead: "workflow <name> · phase · n/m done". */
export function runStripHtml(r: WfRun, cls = 'wk-strip'): string {
  const c = runCounts(r);
  return `<div class="${cls}" title="${esc(`${WF_LINK_BASIS}. ${WF_COUNT_BASIS}`)}">${wfDot(r.status, `run ${r.status}`)}<span>${esc(runStrip(r))}</span>${c.running ? ` <span class="wk-run">${c.running} running</span>` : ''}${c.failed ? ` <span class="wk-fail">${c.failed} failed</span>` : ''}</div>`;
}

/** One row per workflow agent: label, model, current tool, tokens, time. */
export function agentRowHtml(a: WfAgent, now: number, prettyModel: (m: string | undefined) => string, lead?: AgentSessionSnapshot): string {
  const me = modelEffortText(a, lead, prettyModel);
  const tool = a.currentTool ? `▸ ${a.currentTool}` : a.lastTool ? `last: ${a.lastTool}` : '';
  return `<div class="wk-a" title="${esc(`${agentLabel(a)} · ${a.statusBasis}`)}">${wfDot(a.status, a.statusBasis)}<span class="wk-al">${esc(agentLabel(a).slice(0, 60))}</span><span class="wk-am" title="${esc(me.title)}">${esc(me.text)}</span><span class="wk-at" title="${esc(a.currentTool ? 'OBSERVED: tool call with no recorded result yet' : 'OBSERVED: latest recorded tool call')}">${esc(tool)}</span><span class="wk-ak" title="${esc(WF_TOK_BASIS)}">${esc(compact(a.tokens))}${a.tokensPartial ? '+' : ''}</span><span class="wk-ad" title="DERIVED: first record → now while running, else → last record">${esc(wfDur(agentWallMs(a, now)))}</span></div>`;
}

export const WFK_CSS = `
.wk-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex: none; background: var(--vscode-disabledForeground, #888); }
.wk-dot.wk-done { background: var(--ok); } .wk-dot.wk-failed { background: var(--bad); } .wk-dot.wk-stale, .wk-dot.wk-killed { background: var(--warn); }
.wk-dot.wk-running { background: var(--accent); }
.wk-strip { display: flex; gap: 6px; align-items: center; font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 3px; min-width: 0; flex-wrap: wrap; }
.wk-strip > span:nth-child(2) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.wk-run { color: var(--accent); } .wk-fail { color: var(--bad); }
.wk-a { display: grid; grid-template-columns: 10px minmax(0, 1fr) auto minmax(0, 1fr) auto auto; gap: 6px; align-items: center; font-size: 11px; padding: 1px 0 1px 12px; min-width: 0; }
.wk-a > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wk-am, .wk-at, .wk-ad { color: var(--vscode-descriptionForeground); }
.wk-ak, .wk-ad { font-variant-numeric: tabular-nums; text-align: right; }
.wk-badge { font-size: 10px; padding: 0 6px; border-radius: 8px; border: 1px solid var(--accent); color: var(--accent); white-space: nowrap; }
`;
