import type { ContextRef } from './interfaces';
import { idOk } from './policy';
import type { WsState } from '../render/workspace';

export const WORKSPACE_STATE_SCHEMA = 'datapass.agent-workspace-state/1';
export interface WorkspaceMetadata {
  schema: typeof WORKSPACE_STATE_SCHEMA;
  view: string;
  selected?: string;
  opts: Record<string, string>;
  scoped: boolean;
  context?: ContextRef;
}
// Only navigation selections are durable. Search text, transcript content, paths,
// grants, return approval bindings and feed data never enter webview state.
const OPTIONS = new Set(['scope', 'compact-scope', 'compact-project', 'compact-view', 'compact-window', 'catalog.tab', 'settings.scope', 'settings.kind', 'panes.layout', 'panes.p0', 'panes.p1', 'panes.p2', 'panes.p3', 'rail.now', 'rail.agents', 'rail.work', 'rail.change', 'rail.verify', 'rail.time', 'rail.usage', 'rail.system']);
export function safeContext(value: unknown): ContextRef | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const c = value as ContextRef;
  if (![c.organizationId,c.privacyDomainId,c.projectId,c.repoId,c.hostId,c.returnToken].every(idOk) || c.worktreeId !== null && !idOk(c.worktreeId) || c.selectedItemId !== null && !idOk(c.selectedItemId) || c.revision !== null && (typeof c.revision!=='string' || !/^[a-f0-9]{7,40}$/.test(c.revision))) return;
  return { organizationId:c.organizationId,privacyDomainId:c.privacyDomainId,projectId:c.projectId,repoId:c.repoId,hostId:c.hostId,worktreeId:c.worktreeId,revision:c.revision,selectedItemId:c.selectedItemId,returnToken:c.returnToken };
}
export function workspaceMetadata(state: WsState, views: string[], scoped = false, context?: ContextRef): WorkspaceMetadata {
  const opts: Record<string,string> = {};
  for (const [name,value] of Object.entries(state.opts ?? {})) if (OPTIONS.has(name) && typeof value === 'string' && /^[a-zA-Z0-9._:/-]{0,160}$/.test(value)) opts[name] = value;
  return { schema:WORKSPACE_STATE_SCHEMA,view:views.includes(state.view)?state.view:'overview',...(idOk(state.selected)?{selected:state.selected}:{}),opts,scoped, ...(safeContext(context)?{context:safeContext(context)}:{}) };
}
export function restoreWorkspaceMetadata(value: unknown, views: string[]): { metadata:WorkspaceMetadata; reason?:string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {metadata:workspaceMetadata({view:'overview'},views,true),reason:'Saved panel metadata is missing. Review the project context before reconnecting.'};
  const v = value as WorkspaceMetadata;
  if (v.schema !== WORKSPACE_STATE_SCHEMA || typeof v.scoped !== 'boolean' || !views.includes(v.view) || v.context && !safeContext(v.context)) return {metadata:workspaceMetadata({view:'overview'},views,true),reason:'Saved panel metadata is invalid or from an unsupported version. Review the project context before reconnecting.'};
  const metadata = workspaceMetadata(v,views,v.scoped,v.context);
  // Context metadata cannot establish authority, even if a caller forges scoped:false.
  metadata.scoped = v.scoped || !!metadata.context;
  return {metadata,...(metadata.scoped?{reason:'The extension host restarted. The previous reviewed source grant was not restored. Review Cockpit Scope and reopen this project from PM.'}:{})};
}
