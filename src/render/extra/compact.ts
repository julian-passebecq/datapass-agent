import type { AgentSessionSnapshot } from '../../model';
import { attention } from '../../activity/insights';
import { scanBacklog } from '../../feeds/backlog';
import { scanAssets, LocalAsset } from '../../feeds/assets';
import type { BacklogReport } from '../../activity/backlog';
import { repoId } from '../../cockpit/policy';
import { usageWindows } from '../../cockpit/facade';
import { safeLocalSource } from '../../cockpit/configuration';
import { esc } from '../html';
import { renderGraph, statusText } from '../views';
import type { WsData, WsState } from '../workspace';
import { actBtn, ExtraView, seg, toolbar } from './kit';
import { Feed, feedValue } from './feeds';

const rootOf = (s: AgentSessionSnapshot) => s.repository ?? s.cwd ?? '';
const compactBacklog: Feed<BacklogReport> = { id: 'compact.backlog', intervalMs: 60000, load: ctx => scanBacklog({ roots: [...new Set(ctx.sessions.map(rootOf).filter(Boolean))].slice(0, 60), now: ctx.now }) };
const compactAssets: Feed<LocalAsset[]> = { id: 'compact.assets', intervalMs: 60000, load: ctx => scanAssets(ctx.config<string[]>('agent.cockpit.assetRoots', [])) };
function sessionRows(sessions: AgentSessionSnapshot[]): string {
  return sessions.slice(0, 100).map(s => `<div class="compact-session" tabindex="0" role="button" data-select="${esc(s.key)}"><span class="dot ${esc(s.status)}"></span> ${esc(s.title ?? s.sessionId)} <span class="muted">${esc(statusText(s))} · ${esc(s.model ?? 'model UNKNOWN')}</span><small>${esc(s.worktree ?? rootOf(s))}</small></div>`).join('') || '<div class="empty">No observed sessions in this selection.</div>';
}
export function compactSessions(d: WsData, st: WsState): AgentSessionSnapshot[] {
  let sessions = d.sessions;
  if (st.opts?.['compact-scope'] === 'project' && st.opts?.['compact-project']) sessions = sessions.filter(s => rootOf(s) && repoId(rootOf(s)).slice(5) === st.opts!['compact-project']);
  if (st.opts?.['compact-scope'] === 'session') sessions = sessions.filter(s => s.key === st.selected || s.parentSessionId === st.selected);
  return sessions;
}
export function renderCompact(d: WsData, st: WsState): string {
  const roots = [...new Map(d.sessions.filter(s => rootOf(s)).map(s => [repoId(rootOf(s)), rootOf(s)])).entries()];
  const scope = st.opts?.['compact-scope'] ?? 'all', view = st.opts?.['compact-view'] ?? 'live';
  const sessions = compactSessions(d, st), plan = feedValue<BacklogReport>('compact.backlog').value;
  const projects = `<label>Project <select data-opt="compact-project" aria-label="Compact project"><option value="">Choose project</option>${roots.map(([id, root]) => `<option value="${id.slice(5)}"${st.opts?.['compact-project'] === id.slice(5) ? ' selected' : ''}>${esc(root.split(/[\\/]/).pop() ?? root)}</option>`).join('')}</select></label>`;
  let h = `<section class="agent-compact">${toolbar('<span>Scope</span>', seg(st, 'compact-scope', [['all', 'All observed locally'], ['project', 'Project'], ['session', 'Session']], 'all'), projects)}${toolbar('<span>View</span>', seg(st, 'compact-view', [['live', 'Live'], ['factory', 'Factory'], ['backlog', 'Backlog'], ['metrics', 'Metrics'], ['attention', 'Attention']], 'live'))}<p class="muted">Observed local evidence · recent activity does not prove process liveness. Unassigned sessions cannot leave the cockpit facade.</p>`;
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
  } else if (view === 'attention') {
    const alerts = attention(sessions, d.now); h += alerts.map(a => `<button class="compact-session" data-open="${esc(a.key)}">${esc(a.reason)}<small>${esc(a.basis)}</small></button>`).join('') || '<p>No attention signal observed.</p>';
  } else h += sessionRows(sessions);
  const selectedKeys = new Set(sessions.map(s => s.key)), contexts = (d.cockpitInputs?.contexts ?? []).filter(c => c.sourceIds.some(id => selectedKeys.has(id)));
  h += `<details><summary>Context activity · ${contexts.length} registered receipts</summary>${contexts.map(c => `<p>${esc(c.backend)} · generation ${esc(c.generationId)} · query ${esc(c.queriedAt)} · ${esc(c.state)}</p>`).join('') || '<p>UNKNOWN — no registered query receipt. Returned does not mean read or understood.</p>'}<button class="link" data-nav="context-activity">Full context activity</button></details>`;
  const assets = feedValue<LocalAsset[]>('compact.assets').value ?? [];
  h += `<details><summary>Assets · ${assets.length} files in approved roots</summary>${assets.slice(0, 8).map(a => `<p>${esc(a.name)} · FILE_OBSERVED · producer UNKNOWN · ${esc(a.sha256.slice(0, 12))} ${actBtn('preview-asset', a.id, 'Preview')}</p>`).join('') || '<p>No files observed in selected asset roots.</p>'}<button class="link" data-nav="asset-gallery">Full asset gallery</button></details></section>`;
  return h;
}
const previewAsset = async (id: string, ctx: import('./kit').ActCtx) => {
  const asset = feedValue<LocalAsset[]>('compact.assets').value?.find(a => a.id === id);
  if (asset && await safeLocalSource(asset.file)) await ctx.openFile(asset.file);
};
export const compactView: ExtraView = { id: 'compact', label: 'Compact', group: 'Now', hint: 'Project/session observation with independent roots and scoped evidence.', render: renderCompact, feeds: [compactBacklog, compactAssets] as Feed[], actions: { 'preview-asset': previewAsset }, css: '.agent-compact{min-width:0;overflow-wrap:anywhere}.agent-compact *{box-sizing:border-box}.agent-compact select{max-width:100%}.agent-compact .compact-session{display:block;width:100%;text-align:left;padding:8px;background:var(--vscode-editor-background);color:var(--vscode-foreground);border:1px solid var(--vscode-widget-border);cursor:pointer}.agent-compact small{display:block;color:var(--vscode-descriptionForeground);overflow:hidden;text-overflow:ellipsis}.agent-compact button:focus-visible,.agent-compact [tabindex]:focus-visible{outline:2px solid var(--vscode-focusBorder)}.agent-compact details{margin:10px 0}@media(max-width:600px){.agent-compact .compact-workers:not([open]) .tree{display:none}}' };
export const contextView: ExtraView = { id: 'context-activity', label: 'Context activity', group: 'Agents', hint: 'Registered query receipts; no inferred consumption.', render: (d, st) => {
  const keys = new Set(compactSessions(d, st).map(s => s.key));
  const contexts = (d.cockpitInputs?.contexts ?? []).filter(c => c.sourceIds.some(id => keys.has(id)));
  return `<h2>Observed context queries</h2>${contexts.map(c => `<p>${esc(c.projectId)} · ${esc(c.backend)} · generation ${esc(c.generationId)} · ${esc(c.queriedAt)} · ${esc(c.state)}<br>Sources: ${c.sourceIds.map(esc).join(', ')}</p>`).join('') || '<p>UNKNOWN — no registered query receipts for this scope.</p>'}<p class="muted">Returned does not prove read, understood, verified or consumed. Query input is registered explicitly; unrelated source text is excluded.</p>`;
} };
export const assetsView: ExtraView = { id: 'asset-gallery', label: 'Asset gallery', group: 'Work', hint: 'Observed approved-root files and reviewed manifest provenance.', feeds: [compactAssets] as Feed[], actions: { 'preview-asset': previewAsset }, render: d => {
  const assets = feedValue<LocalAsset[]>('compact.assets').value ?? [];
  return `<h2>Approved local image files</h2>${assets.map(a => `<p>${esc(a.name)} · ${a.bytes} bytes · FILE_OBSERVED · producer UNKNOWN<br>${esc(a.sha256)} ${actBtn('preview-asset', a.id, 'Preview')}</p>`).join('') || '<p>Select image roots using Agent: Select Asset Root.</p>'}<h2>Registered manifest assets</h2>${(d.cockpitInputs?.assets ?? []).map(a => `<p>${esc(a.id)} · ${esc(a.state)} · producer ${esc(a.producer ?? 'UNKNOWN')} · ${esc(a.sha256)}</p>`).join('') || '<p>No approved manifest references registered.</p>'}`;
} };
