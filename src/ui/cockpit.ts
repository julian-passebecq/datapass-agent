import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { SessionStore } from '../sessions/store';
import { CockpitFacade, ScopedInputs } from '../cockpit/facade';
import { digest, idOk, LocalGrant, makeGrant, ScopePolicy, repoId } from '../cockpit/policy';
import { safeLocalSource } from '../cockpit/configuration';
import { IncrementalExporter } from '../export/incremental';
import { WorkspacePanel } from './workspace';
import type { WebviewMessage } from '../render/html';
import type { Scope } from '../cockpit/interfaces';
import type { ImageProducerReceipt } from '../cockpit/images';
import { contextSourceHash, returnToPm } from '../cockpit/contextReturn';

export function registerCockpit(ctx: vscode.ExtensionContext, store: SessionStore, ternAvailable: () => boolean, onMessage: (m: WebviewMessage) => void, installed: () => import('../extension').AgentApi['installed']): CockpitFacade {
  const policy = new ScopePolicy(), panels = new Set<WorkspacePanel>();
  const saved = ctx.globalState.get<LocalGrant[]>('cockpit.scopes.v1', []);
  for (const g of saved.slice(0, 100)) {
    if (g?.scope && Array.isArray(g.sessionKeys) && Array.isArray(g.roots) && g.sessionKeys.every(idOk)) {
      policy.set(g); if (!policy.authorize({ requestId: 'restore', scope: g.scope })) policy.clear();
    }
  }
  const facade = new CockpitFacade(store, policy, {
    installed,
    open: (view, grant, id, context, returnBinding) => {
      const epoch=policy.epoch;
      const valid=()=>!!policy.authorize({requestId:'panel',scope:grant.scope,epoch});
      const read = () => valid() ? policy.sessions(grant, store.all()).filter(s=>!context || repoId(s.repository ?? s.cwd ?? '')===context.repoId) : [];
      const sourceHash=context ? contextSourceHash(context,read()):null;
      const validReturn=()=>valid() && !!context && contextSourceHash(context,read())===sourceHash;
      let panel:WorkspacePanel;
      const scopedMessage=(m:WebviewMessage)=>{
        if(m.type==='cmd' && (m.cmd==='returnToPm' || m.cmd==='copyReturnToken')){
          if(!context || !returnBinding)return;
          void returnToPm(context,returnBinding,validReturn,{commands:()=>vscode.commands.getCommands(true),execute:(command,payload)=>vscode.commands.executeCommand(command,payload),copy:token=>vscode.env.clipboard.writeText(token)},m.cmd==='copyReturnToken').then(result=>{
            if(result==='COPIED')void vscode.window.showInformationMessage('Agent: return token copied. Restore the reviewed selection in PM.');
            if(result==='DENIED')void vscode.window.showWarningMessage('Agent: source or reviewed scope changed. Reopen the current project before returning.');
          }).catch(()=>{void vscode.window.showWarningMessage('Agent: PM refused the return. Reopen the current project and review its selection.');});
          return;
        }
        if(!valid())return;
        if(m.type==='open'){panel.open('transcript',m.key);return;}
        if(m.type==='cmd' && m.cmd==='openWorkspaceNewTab'){panel.open('compact');return;}
        if(m.type==='cmd' && ['readTranscript','openTimeline','timelineAll','openWorkspace','knowledge'].includes(m.cmd)){panel.open(m.cmd==='readTranscript'?'transcript':m.cmd==='knowledge'?'context-activity':m.cmd==='openWorkspace'?'compact':'activity',m.key || undefined);return;}
        onMessage(m);
      };
      panel = new WorkspacePanel(store, scopedMessage, ternAvailable, p => { panels.delete(p); p.dispose(); }, read, () => ({...(valid()?facade.scopedInputs(grant):{contexts:[],acceptedWork:[],assets:[]}),panelContext:{valid:valid(),context,projectId:grant.scope.projectIds.join(', ')}}));
      panels.add(panel); panel.open(view === 'settings' || view === 'catalog' ? view : 'compact', view === 'session' ? id : undefined, { 'compact-scope': view === 'session' ? 'session' : 'all', 'compact-view': view === 'project' ? 'factory' : 'live' });
    },
    openSource: async file => { await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true }); },
  }, new IncrementalExporter(store.adapters));
  const chooseScope = async (): Promise<LocalGrant | undefined> => {
    const scopes = policy.scopes();
    const pick = await vscode.window.showQuickPick(scopes.map(scope => ({ label: scope.projectIds.join(', '), description: scope.organizationIds.join(', '), scope })), { title: 'Agent: Select reviewed cockpit scope' });
    return pick && policy.authorize({ requestId: 'local-picker', scope: pick.scope });
  };
  ctx.subscriptions.push(facade, { dispose: () => { panels.forEach(p => p.dispose()); panels.clear(); } },
    vscode.commands.registerCommand('agent.inspectSelectedProcess',async()=>{
      const g=await chooseScope();if(!g)return;
      const epoch=policy.epoch;
      const input=await vscode.window.showInputBox({title:'Inspect one reviewed local process ID',placeHolder:'PID only; arguments and environment are excluded',validateInput:value=>/^[1-9][0-9]{0,9}$/.test(value) && Number(value)<=2147483647?undefined:'Enter one positive process ID.'});if(!input)return;
      if(!policy.authorize({requestId:'local-process-select',scope:g.scope,epoch}))return;
      const pid=Number(input),id='process:'+pid;
      facade.registerResources(g,[{id,kind:'PROCESS',pid,expectedStartedAt:null}]);
      const reply=await facade.api.getResourceObservations({requestId:'local-process-read',scope:g.scope,epoch});
      const observed=reply.data.find(item=>item.id===id);
      if(observed?.state==='OBSERVED' && observed.process?.startedAt)facade.registerResources(g,[{id,kind:'PROCESS',pid,expectedStartedAt:observed.process.startedAt}]);
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({language:'json',content:JSON.stringify(reply,null,2)}),{preview:true});
    }),
    vscode.commands.registerCommand('agent.inspectSelectedResources',async()=>{
      const g=await chooseScope();if(!g)return;
      const files=await vscode.window.showOpenDialog({title:'Select exact diagnostic files (metadata only; no execution)',canSelectMany:true});if(!files?.length)return;
      facade.registerResources(g,files.slice(0,50).map(f=>({id:'resource:'+digest(f.fsPath).slice(0,24),file:f.fsPath,kind:/\.lock$/i.test(f.fsPath)?'LOCK':/\.(py|ps1|js|mjs)$/i.test(f.fsPath)?'SCRIPT':'FILE',enabled:null,staleAfterMs:3600000})));
      const reply=await facade.api.getResourceObservations({requestId:'local-resource-read',scope:g.scope});
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({language:'json',content:JSON.stringify(reply,null,2)}),{preview:true});
    }),
    vscode.commands.registerCommand('agent.importImageReceipt',async()=>{
      const g=await chooseScope();if(!g)return;
      const receipts=await vscode.window.showOpenDialog({title:'Select reviewed image producer receipt',canSelectMany:false,filters:{JSON:['json']}});if(!receipts?.[0])return;
      const receiptFile=receipts[0].fsPath;if(!await safeLocalSource(receiptFile) || (await fs.stat(receiptFile)).size>16384)throw new Error('Unsafe or oversized image receipt.');
      const receipt=JSON.parse(await fs.readFile(receiptFile,'utf8')) as ImageProducerReceipt;
      const images=await vscode.window.showOpenDialog({title:'Select exact image to verify against this receipt',canSelectMany:false,filters:{Images:['png','jpg','jpeg','gif','webp']}});if(!images?.[0])return;
      const result=await facade.registerImageReceipt(g,images[0].fsPath,receipt);
      void vscode.window.showInformationMessage('Agent: image hash verified; producer '+(result.producer ?? 'UNKNOWN')+'; publication not approved.');
    }),
    vscode.commands.registerCommand('agent.reviewCockpitScope', async () => {
      const sessions = store.all();
      const selected = await vscode.window.showQuickPick(sessions.map(s => ({ label: s.title ?? s.sessionId, description: `${s.provider} · ${s.repository ?? s.cwd ?? 'unassigned'}`, key: s.key })), { title: 'Associate native sessions to a cockpit project', canPickMany: true, placeHolder: 'Select exact sessions; title matches are suggestions only.' });
      if (!selected?.length) return;
      const project = await vscode.window.showInputBox({ title: 'Reviewed project ID', validateInput: v => idOk(v) ? undefined : 'Use a stable ID: letters, numbers, dots, colon, slash or dash.' }); if (!project) return;
      const organization = await vscode.window.showInputBox({ title: 'Organization ID', value: 'local', validateInput: v => idOk(v) ? undefined : 'Enter a stable organization ID.' }); if (!organization) return;
      const privacy = await vscode.window.showInputBox({ title: 'Privacy domain ID', value: organization, validateInput: v => idOk(v) ? undefined : 'Enter a stable privacy domain ID.' }); if (!privacy) return;
      const permission = await vscode.window.showQuickPick([{ label: 'Observation only', configuration: false, exportConsent: false }, { label: 'Observation and sanitized provider configuration', configuration: true, exportConsent: false }, { label: 'Observation, sanitized configuration, and reviewed local export', configuration: true, exportConsent: true }], { title: 'Allowed cockpit scope', placeHolder: 'Export still requires a specific plan review and destination.' }); if (!permission) return;
      const grant = makeGrant({ id: organization + ':' + project, organization, project, privacy, sessions: sessions.filter(s => selected.some(p => p.key === s.key)), ...permission });
      policy.set(grant);
      const grants = policy.scopes().map(scope => policy.authorize({ requestId: 'persist', scope })!);
      await ctx.globalState.update('cockpit.scopes.v1', grants);
      void vscode.window.showInformationMessage(`Agent: reviewed ${grant.sessionKeys.length} sessions for ${project}.`);
    }),
    vscode.commands.registerCommand('agent.revokeCockpitScopes', async () => { policy.clear(); await ctx.globalState.update('cockpit.scopes.v1', []); }),
    vscode.commands.registerCommand('agent.importCockpitReceipts', async () => {
      const g = await chooseScope(); if (!g) return;
      const files = await vscode.window.showOpenDialog({ title: 'Import registered scoped receipts', canSelectMany: false, filters: { JSON: ['json'] } }); if (!files?.[0]) return;
      const file = files[0].fsPath; if (!await safeLocalSource(file) || (await fs.stat(file)).size > 256 * 1024) throw new Error('Unsafe or oversized receipt input.');
      const input = JSON.parse(await fs.readFile(file, 'utf8')) as { schema: string; scope: Scope; data: ScopedInputs };
      if (input.schema !== 'datapass.agent-scoped-inputs/1' || digest(input.scope) !== digest(g.scope)) throw new Error('Receipt scope differs from selected reviewed scope.');
      facade.registerInputs(g, input.data);
      void vscode.window.showInformationMessage('Agent: registered scoped observation receipts.');
    }),
    vscode.commands.registerCommand('agent.exportIncremental', async () => {
      const g = await chooseScope(); if (!g?.exportConsent) return void vscode.window.showInformationMessage('Review an export-enabled scope first.');
      const folder = await vscode.window.showOpenDialog({ title: 'Selected local export destination', canSelectFolders: true, canSelectFiles: false, canSelectMany: false }); if (!folder?.[0]) return;
      const destinationId = 'destination:' + randomUUID(); facade.setDestination(destinationId, folder[0].fsPath);
      const request = { requestId: 'local-export:' + randomUUID(), scope: g.scope };
      const plan = await facade.api.planExport({ ...request, sourceIds: g.sessionKeys, redactionProfileHash: digest('shared-dialogue/1') });
      if (plan.state !== 'OK') return void vscode.window.showWarningMessage(plan.omissions.join(' ') || 'Export plan unavailable.');
      const p = plan.data;
      const approved = await vscode.window.showWarningMessage(`Export selected ${g.scope.projectIds.join(', ')} sessions locally? ${p.newCount} new, ${p.appendedCount} appended, ${p.rewrittenCount} rewritten, ${p.unchangedCount} unchanged. Curated full-session resnapshots exclude hidden reasoning and tool payloads.`, { modal: true }, 'Export selected plan');
      if (approved !== 'Export selected plan') return;
      facade.approve(p.hash, g, destinationId);
      const receipt = await facade.api.executeApprovedLocalExport({ ...request, approval: { approvedPlanHash: p.hash, destinationId, scopePolicyHash: g.scope.policyHash } });
      if(receipt.state==='OK')await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({language:'json',content:JSON.stringify({schema:'datapass.committed-export-handoff/1',scope:g.scope,receipt:receipt.data,destinationId},null,2)}),{preview:true});
      void vscode.window.showInformationMessage(`Agent export: ${receipt.state}${receipt.state === 'OK' ? ' · ' + receipt.data.manifestHash : ''}`);
    }),
    vscode.commands.registerCommand('agent.selectAssetRoot', async () => {
      const folder = await vscode.window.showOpenDialog({ title: 'Select approved local image root', canSelectFolders: true, canSelectFiles: false, canSelectMany: false }); if (!folder?.[0]) return;
      const config = vscode.workspace.getConfiguration('agent');
      const roots = config.get<string[]>('cockpit.assetRoots', []);
      await config.update('cockpit.assetRoots', [...new Set([...roots, folder[0].fsPath])].slice(0, 20), vscode.ConfigurationTarget.Global);
    }),
  );
  return facade;
}
