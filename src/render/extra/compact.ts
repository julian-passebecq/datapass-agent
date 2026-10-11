import type { AgentSessionSnapshot } from '../../model';
import { attention } from '../../activity/insights';
import { scanBacklog } from '../../feeds/backlog';
import { scanAssets, LocalAsset } from '../../feeds/assets';
import type { BacklogReport } from '../../activity/backlog';
import { repoId, digest } from '../../cockpit/policy';
import { usageWindows } from '../../cockpit/facade';
import { safeLocalSource } from '../../cockpit/configuration';
import { esc } from '../html';
import { renderGraph, statusText } from '../views';
import type { WsData, WsState } from '../workspace';
import { actBtn, ExtraView, seg, toolbar } from './kit';
import { Feed, feedValue } from './feeds';

const rootOf = (s: AgentSessionSnapshot) => s.repository ?? s.cwd ?? '';
export function renderContextBridge(d:WsData):string {
  const panel=d.cockpitInputs?.panelContext;if(!panel)return '';
  if(!panel.valid)return `<div class="context-bridge" role="alert" style="overflow-wrap:anywhere"><b>Saved project: ${esc(panel.projectId)}</b>${panel.context?.origin?.taskId?` · saved PM task ${esc(panel.context.origin.taskId)} · revision ${panel.context.origin.taskRevision}`:''}${panel.context?.selectedItemId?` · native session reference ${esc(panel.context.selectedItemId)}`:''}<p>${esc(panel.reason ?? 'Scope changed or revoked. Review Cockpit Scope and reopen this project.')} No sources are granted by navigation. <button class="link" data-cmd="reviewCockpitScope">Review Cockpit Scope</button></p></div>`;
  const c=panel.context;
  const origin=c?.origin;
  const task=origin?.taskId?`<p>Selected PM task: <b>${esc(origin.taskId)}</b> · revision ${origin.taskRevision} · authority <code title="${esc(origin.taskAuthorityHash)}">${esc(origin.taskAuthorityHash?.slice(0,12))}</code>. Session assignment is UNKNOWN; this is the selection to restore in PM.</p>`:origin?'<p>PM project selection; no task selected. Session task assignment is UNKNOWN.</p>':'';
  const session=c?.selectedItemId?`<p>Observed native session: ${esc(c.selectedItemId)} <button class="link" data-cmd="readTranscript" data-key="${esc(c.selectedItemId)}">Read selected session</button>${panel.exportAllowed?` <button class="link" data-cmd="exportConversations" data-key="${esc(c.selectedItemId)}">Export reviewed session</button>`:' <span class="muted">Export requires an export-enabled reviewed scope</span>'}</p>`:'';
  return `<div class="context-bridge" style="overflow-wrap:anywhere"><b>Reviewed project: ${esc(panel.projectId)}</b>${c?` · organization ${esc(c.organizationId)} · repo ${esc(c.repoId)} · revision ${esc(c.revision ?? 'UNKNOWN')} · return ${esc(c.returnToken)} <button class="link" data-cmd="returnToPm">Return to PM</button> <button class="link" data-cmd="copyReturnToken">Copy return token</button> <button class="link" data-cmd="openScopedLens">Inspect context in Lens</button>`:''}${task}${session} <button class="link" data-nav="compact"${c?.selectedItemId?` data-key="${esc(c.selectedItemId)}"`:''}>Back to Compact</button></div>`;
}
const questionId=(s:AgentSessionSnapshot,id:string)=>digest([s.key,id]).slice(0,32);
export function nativeAttention(sessions:AgentSessionSnapshot[]):string {
  const content=sessions.flatMap(s=>(s.facts?.nativeInputs ?? []).map(q=>`<div class="compact-session"><b>${esc(q.requestClass)} · ${esc(q.state)}</b> · ${esc(s.provider)} · ${esc(q.id)}${q.questions.map(question=>`<p>${esc(question.text)}${question.options.length?' · '+question.options.map(esc).join(' / '):''}</p>`).join('')}${q.answer?`<p>Answer received: ${esc(q.answer)}</p>`:''}${q.requestClass==='ORDINARY_INPUT' && q.state==='REQUESTED'?actBtn('copy-native-question',questionId(s,q.id),'Copy question for native reply'):'<p>Approval remains in the native provider.</p>'}<small>Source ${esc(q.source)} · ${q.at===null?'time UNKNOWN':esc(new Date(q.at).toISOString())} · native send unavailable; manual fallback</small></div>`)).join('');
  return '<h2>Native input requests</h2>'+(content || '<p>No observed input requests.</p>');
}
const compactBacklog: Feed<BacklogReport> = { id: 'compact.backlog', intervalMs: 60000, load: ctx => scanBacklog({ roots: [...new Set(ctx.sessions.map(rootOf).filter(Boolean))].slice(0, 60), now: ctx.now }) };
const compactAssets: Feed<LocalAsset[]> = { id: 'compact.assets', intervalMs: 60000, load: ctx => scanAssets(ctx.config<string[]>('agent.cockpit.assetRoots', [])) };
function sessionRows(sessions: AgentSessionSnapshot[]): string {
  return sessions.slice(0, 100).map(s => `<div class="compact-session" tabindex="0" role="button" data-select="${esc(s.key)}"><span class="dot ${esc(s.status)}"></span> ${esc(s.title ?? s.sessionId)} <span class="muted">${esc(statusText(s))} · ${esc(s.model ?? 'model UNKNOWN')}</span><small>${esc(s.worktree ?? rootOf(s))}</small></div>`).join('') || '<div class="empty">No observed sessions in this selection.</div>';
}
export function compactSessions(d: WsData, st: WsState): AgentSessionSnapshot[] {
  let sessions = d.sessions;
  if (st.opts?.['compact-scope'] === 'project' && !st.opts?.['compact-project']) return [];
  if (st.opts?.['compact-scope'] === 'project' && st.opts?.['compact-project']) sessions = sessions.filter(s => rootOf(s) && repoId(rootOf(s)).slice(5) === st.opts!['compact-project']);
  if (st.opts?.['compact-scope'] === 'session') sessions = sessions.filter(s => s.key === st.selected || s.parentSessionId === st.selected);
  return sessions;
}
export function renderCompact(d: WsData, st: WsState): string {
  if(d.cockpitInputs?.panelContext?.valid===false)return '<section class="agent-compact"><h2>Reviewed scope is no longer valid</h2><p>The grant was changed or revoked. Reconnect using Agent: Review Cockpit Scope, then open this project again. No fallback to All.</p></section>';
  const roots = [...new Map(d.sessions.filter(s => rootOf(s)).map(s => [repoId(rootOf(s)), rootOf(s)])).entries()];
  const scope = st.opts?.['compact-scope'] ?? 'all', view = st.opts?.['compact-view'] ?? 'live';
  const sessions = compactSessions(d, st), plan = feedValue<BacklogReport>('compact.backlog').value;
  const projects = `<label>Project <select data-opt="compact-project" aria-label="Compact project"><option value="">Choose project</option>${roots.map(([id, root]) => `<option value="${id.slice(5)}"${st.opts?.['compact-project'] === id.slice(5) ? ' selected' : ''}>${esc(root.split(/[\\/]/).pop() ?? root)}</option>`).join('')}</select></label>`;
  let h = `<section class="agent-compact">${toolbar('<span>Scope</span>', seg(st, 'compact-scope', [['all', d.cockpitInputs?.panelContext?'All reviewed sessions':'All observed locally'], ['project', 'Project'], ['session', 'Session']], 'all'), projects)}${toolbar('<span>View</span>', seg(st, 'compact-view', [['live', 'Live'], ['factory', 'Factory'], ['backlog', 'Backlog'], ['metrics', 'Metrics'], ['attention', 'Attention']], 'live'))}<p class="muted">Observed local evidence · recent activity does not prove process liveness. Unassigned sessions cannot leave the cockpit facade.</p>`;
  if (scope === 'project' && !st.opts?.['compact-project']) return h + '<p>Choose a project to see its evidence.</p></section>';
  if (scope === 'session' && !st.selected) return h + '<p>Select a session in Live or Factory, then choose Session scope.</p></section>';
  if (view === 'factory') h += `<p>Recorded roots and worker links; independent leads remain independent.</p><details class="compact-workers"><summary>Factory graph · ${sessions.length} sessions</summary>${renderGraph(sessions)}</details>${sessionRows(sessions.filter(s => !s.parentSessionId || !sessions.some(p => p.key === s.parentSessionId)))}`;
  else if (view === 'backlog') {
    const refs = d.cockpitInputs?.acceptedWork ?? [];
    h += `<h2>PM accepted work</h2>${refs.length ? refs.map(w => `<p>${esc(w.projectId)} · ${w.counts.open} open · ${w.counts.active} active · ${w.counts.done} done · revision ${esc(w.revision)}</p>`).join('') : '<p class="muted">UNKNOWN — no registered accepted-work summary for this selection.</p>'}<h2>Observed repository plans</h2>`;
    const selectedRoots = new Set(sessions.map(rootOf));
    h += plan ? plan.files.filter(f => selectedRoots.has(f.root)).map(f => `<p>${esc(f.repo)} / ${esc(f.rel)} · ${f.items.length} items · observed ${esc(new Date(f.mtime).toISOString())}${f.skipped ? ' · PARTIAL' : ''}</p>`).join('') || '<p>No plan observed in this selection.</p>' : '<p>Plan evidence pending.</p>';
  } else if (view === 'metrics') {
    h += toolbar(seg(st, 'compact-window', [['24h', '24h'], ['7d', '7d'], ['30d', '30d']], '24h'));
    const usage = (usageWindows(sessions, d.now, d.config?.('historyDays', 3) ?? 3) as { window: string; sessions: number; repositories: number; inputTokens: number; outputTokens: number; sampledSessions: number; calls: number }[]).find(w => w.window === (st.opts?.['compact-window'] ?? '24h'))!;
    h += `<p>${usage.sessions} observed sessions · ${usage.repositories} canonical repositories · ${usage.calls} recorded root/standalone model-call samples</p><p>${usage.inputTokens} input / ${usage.outputTokens} output tokens · ${usage.sampledSessions} sampled sessions</p><p class="muted">Linked worker samples remain separate; parent/child totals are not added together. PARTIAL coverage: bounded loaded history and per-call samples. Worktree identity remains in session detail. Tokens are not productivity; API-equivalent estimates are not subscription bills.</p>`;
    const value=(v:number|undefined)=>v===undefined?'UNKNOWN':String(v);
    h+=`<details><summary>Recorded per-session counters and time coverage</summary>${sessions.map(s=>`<p>${esc(s.sessionId)} · model ${esc(s.model ?? 'UNKNOWN')} · input ${value(s.usage?.inputTokens)} · cached ${value(s.usage?.cachedInputTokens)} · output ${value(s.usage?.outputTokens)} · reasoning ${value(s.usage?.reasoningOutputTokens)} · provider-recorded USD ${value(s.usage?.costUSD)}<br>Derived active ms ${value(s.facts?.activeMs)} · wait ms ${value(s.facts?.waitTotalMs)} · provider quota ${s.facts?.rateLimits?esc(JSON.stringify(s.facts.rateLimits)):'UNKNOWN'} · parent/child disjointness UNKNOWN</p>`).join('')}<p>These are per-session provider counters and derived time heuristics, separate from the selected period samples above. No subscription-cost or quota conversion.</p></details>`;
  } else if (view === 'attention') {
    const alerts = attention(sessions, d.now); h += alerts.map(a => `<button class="compact-session" data-open="${esc(a.key)}">${esc(a.reason)}<small>${esc(a.basis)}</small></button>`).join('') || '<p>No attention signal observed.</p>';
    h+=nativeAttention(sessions);
  } else h += sessionRows(sessions);
  const selectedKeys = new Set(sessions.map(s => s.key)), contexts = (d.cockpitInputs?.contexts ?? []).filter(c => c.sourceIds.some(id => selectedKeys.has(id)));
  const evidenceRefs=(d.cockpitInputs?.evidenceRefs ?? []).filter(ref=>selectedKeys.has(ref.sessionId));
  h+=`<details><summary>Config, preset and evidence links · ${evidenceRefs.length}</summary>${evidenceRefs.map(ref=>`<p>${esc(ref.sessionId)} · task ${esc(ref.taskId ?? 'UNKNOWN')} · source ${esc(ref.sourceSha ?? 'UNKNOWN')} · QA receipt ${esc(ref.qaReceiptId ?? 'UNKNOWN')}<br>Config ${esc(ref.configHash ?? 'UNKNOWN')} · preset ${esc(ref.presetHash ?? 'UNKNOWN')} · prompt ${esc(ref.promptHash ?? 'UNKNOWN')}</p>`).join('') || '<p>No registered immutable snapshot references for this scope.</p>'}</details>`;
  h += `<details><summary>Context activity · ${contexts.length} registered receipts</summary>${contexts.map(c => `<p>${esc(c.backend)} · generation ${esc(c.generationId)} · query ${esc(c.queriedAt)} · ${esc(c.state)}</p>`).join('') || '<p>UNKNOWN — no registered query receipt. Returned does not mean read or understood.</p>'}<button class="link" data-nav="context-activity">Full context activity</button></details>`;
  const assets = feedValue<LocalAsset[]>('compact.assets').value ?? [];
  h += `<details><summary>Assets · ${assets.length} files in approved roots</summary>${assets.slice(0, 8).map(a => `<p>${esc(a.name)} · FILE_OBSERVED · producer UNKNOWN · ${esc(a.sha256.slice(0, 12))} ${actBtn('preview-asset', a.id, 'Preview')}</p>`).join('') || '<p>No files observed in selected asset roots.</p>'}<button class="link" data-nav="asset-gallery">Full asset gallery</button></details></section>`;
  return h;
}
const previewAsset = async (id: string, ctx: import('./kit').ActCtx) => {
  const asset = feedValue<LocalAsset[]>('compact.assets').value?.find(a => a.id === id);
  if (asset && await safeLocalSource(asset.file)) await ctx.openFile(asset.file);
};
const copyNativeQuestion=async(id:string,ctx:import('./kit').ActCtx)=>{
  for(const s of ctx.sessions())for(const q of s.facts?.nativeInputs ?? [])if(questionId(s,q.id)===id && q.requestClass==='ORDINARY_INPUT' && q.state==='REQUESTED'){
    await ctx.copy(q.questions.map(question=>question.text).join('\n'));ctx.info('Question copied. Reply in the owned native conversation; Agent has not sent an answer.');return;
  }
};
export const compactView: ExtraView = { id: 'compact', label: 'Compact', group: 'Now', hint: 'Project/session observation with independent roots and scoped evidence.', render: renderCompact, feeds: [compactBacklog, compactAssets] as Feed[], actions: { 'preview-asset': previewAsset, 'copy-native-question':copyNativeQuestion }, css: '.agent-compact{min-width:0;overflow-wrap:anywhere}.agent-compact *{box-sizing:border-box}.agent-compact select{max-width:100%}.agent-compact .compact-session{display:block;width:100%;text-align:left;padding:8px;background:var(--vscode-editor-background);color:var(--vscode-foreground);border:1px solid var(--vscode-widget-border);cursor:pointer}.agent-compact small{display:block;color:var(--vscode-descriptionForeground);overflow:hidden;text-overflow:ellipsis}.agent-compact button:focus-visible,.agent-compact [tabindex]:focus-visible{outline:2px solid var(--vscode-focusBorder)}.agent-compact details{margin:10px 0}@media(max-width:600px){.agent-compact .compact-workers:not([open]) .tree{display:none}}' };
export const contextView: ExtraView = { id: 'context-activity', label: 'Context activity', group: 'Agents', hint: 'Registered query receipts; no inferred consumption.', render: (d, st) => {
  const keys = new Set(compactSessions(d, st).map(s => s.key));
  const contexts = (d.cockpitInputs?.contexts ?? []).filter(c => c.sourceIds.some(id => keys.has(id)));
  return `<h2>Observed context queries</h2>${contexts.map(c => `<p>${esc(c.projectId)} · ${esc(c.backend)} · generation ${esc(c.generationId)} · ${esc(c.queriedAt)} · ${esc(c.state)}<br>Sources: ${c.sourceIds.map(esc).join(', ')}</p>`).join('') || '<p>UNKNOWN — no registered query receipts for this scope.</p>'}<p class="muted">Returned does not prove read, understood, verified or consumed. Query input is registered explicitly; unrelated source text is excluded.</p>`;
} };
export const assetsView: ExtraView = { id: 'asset-gallery', label: 'Asset gallery', group: 'Work', hint: 'Observed approved-root files and reviewed manifest provenance.', feeds: [compactAssets] as Feed[], actions: { 'preview-asset': previewAsset }, render: d => {
  const assets = feedValue<LocalAsset[]>('compact.assets').value ?? [];
  return `<h2>Approved local image files</h2>${assets.map(a => `<p>${esc(a.name)} · ${a.bytes} bytes · FILE_OBSERVED · producer UNKNOWN<br>${esc(a.sha256)} ${actBtn('preview-asset', a.id, 'Preview')}</p>`).join('') || '<p>Select image roots using Agent: Select Asset Root.</p>'}<h2>Registered manifest assets</h2>${(d.cockpitInputs?.assets ?? []).map(a => `<p>${esc(a.id)} · ${esc(a.state)} · producer ${esc(a.producer ?? 'UNKNOWN')} · ${esc(a.sha256)}</p>`).join('') || '<p>No approved manifest references registered.</p>'}`;
} };
