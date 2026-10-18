import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import * as ts from 'typescript';
import { workspaceMetadata } from '../src/cockpit/workspaceState';
import { allViews } from '../src/render/workspace';
import { cockpitFixture } from './cockpitFixture';
import { localHost } from '../src/cockpit/facade';
import { repoId } from '../src/cockpit/policy';

test('serializer adopts existing public panel, restores selected screen, persists metadata and denies stale source actions',async()=>{
  const callbacks:{message?:(m:unknown)=>void;dispose?:()=>void}={};
  const received:unknown[]=[];let created=0;
  const panel={visible:true,active:true,title:'Agent',iconPath:undefined as unknown,webview:{options:{},cspSource:'self',html:'',onDidReceiveMessage(fn:(m:unknown)=>void){callbacks.message=fn;},postMessage(m:unknown){received.push(m);return Promise.resolve(true);}},onDidChangeViewState(){},onDidDispose(fn:()=>void){callbacks.dispose=fn;},reveal(){},dispose(){}};
  let saveDialogs=0,beforeSave=()=>{};const writes:unknown[]=[];
  const vscode={ThemeIcon:class{},ViewColumn:{Active:1},Uri:{file:(fsPath:string)=>({fsPath})},window:{createWebviewPanel(){created++;return panel;},showInformationMessage(){},async showSaveDialog(){saveDialogs++;beforeSave();return {fsPath:'fixture-export.md'};}},workspace:{isTrusted:false,fs:{async writeFile(...args:unknown[]){writes.push(args);}},getConfiguration(){return {get(_k:string,f:unknown){return f;}};}}};
  const source=fs.readFileSync(path.resolve(__dirname,'../../src/ui/workspace.ts'),'utf8');
  const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const localRequire=createRequire(path.resolve(__dirname,'../src/ui/workspace.js'));
  const module={exports:{} as {WorkspacePanel:new(...args:any[])=>any}};
  const pumped:string[]=[];
  new Function('require','module','exports',compiled)((id:string)=>id==='vscode'?vscode:id==='../render/extra/feeds'?{...localRequire(id),pump(feeds:{id:string}[]){pumped.push(...feeds.map(f=>f.id));}}:localRequire(id),module,module.exports);
  const store={all:()=>[],onDidChange:()=>({dispose(){}}),version:1,opts:{git:false},providerStates:[],timeline:()=>[],gitProgress:{done:0,total:0}};
  const calls:unknown[]=[];
  const p=new module.exports.WorkspacePanel(store,(m:unknown)=>calls.push(m),()=>false);
  const context={organizationId:'local',privacyDomainId:'fixture',projectId:'fixture',repoId:'repo:fixture',hostId:'host:fixture',worktreeId:null,revision:null,selectedItemId:null,returnToken:'pm:fixture'};
  p.restore(panel,workspaceMetadata({view:'providers',opts:{scope:'fixture'}},allViews(),true,context));
  assert.equal(created,0,'adopts serializer panel');assert.match(panel.webview.html,/The extension host restarted/);assert.match(panel.webview.html,/>Sources<\/h1>/);
  callbacks.message!({type:'cmd',cmd:'openWorkspaceNewTab',key:''});callbacks.message!({type:'cmd',cmd:'returnToPm',key:''});assert.deepEqual(calls,[],'blocked state never escapes into unrestricted panels or uses stale approval');
  callbacks.message!({type:'cmd',cmd:'reviewCockpitScope',key:''});assert.equal(calls.length,1);
  callbacks.message!({type:'nav',view:'board',key:''});
  const update=received.at(-1) as {state:{view:string;context:unknown;scoped:boolean}};assert.equal(update.state.view,'board');assert.deepEqual(update.state.context,context);assert.equal(update.state.scoped,true);
  p.dispose();
  const independent=new module.exports.WorkspacePanel(store,()=>{},()=>false);
  independent.open('providers',undefined,{'catalog.tab':'models','settings.scope':'project'});
  callbacks.dispose!(); // setState was destroyed by close; the main panel owner retains its safe navigation.
  independent.open();
  assert.match(panel.webview.html,/>Sources<\/h1>/);assert.match(panel.webview.html,/"catalog.tab":"models"/);assert.match(panel.webview.html,/"settings.scope":"project"/);
  assert.equal(created,2,'close/reopen creates only the explicitly requested replacement');
  const initialHtml=panel.webview.html;
  independent.numberedNavigation('live');
  assert.deepEqual(received.at(-1),{type:'numberedNav',view:'live'},'public numbered command asks the active client to verify actual input focus');
  assert.equal(panel.webview.html,initialHtml,'host command does not directly navigate before client approval');
  const delivered=received.length;panel.active=false;independent.numberedNavigation('overview');assert.equal(received.length,delivered,'inactive editors receive no numbered request');
  panel.active=true;independent.numberedNavigation('settings');assert.equal(received.length,delivered,'only fixed numbered screens are accepted');independent.dispose();
  const suspended=new module.exports.WorkspacePanel(store,()=>{},()=>false);
  suspended.restore(panel,workspaceMetadata({view:'workflows'},allViews(),true,context));
  assert.match(panel.webview.html,/collectors are suspended/);assert.doesNotMatch(panel.webview.html,/Scanning ~\/\.claude|data-loading=/);
  suspended.dispose();
  pumped.length=0;
  const scoped=new module.exports.WorkspacePanel(store,()=>{},()=>false,undefined,()=>[],()=>({contexts:[],acceptedWork:[],assets:[],panelContext:{valid:true,context,projectId:'fixture'}}),context);
  scoped.open('workflows');assert.deepEqual(pumped,[],'provider-wide scanner is not pumped by reviewed scoped navigation');assert.match(panel.webview.html,/no scoped provider-wide scan was performed/);assert.doesNotMatch(panel.webview.html,/Scanning ~\/\.claude/);scoped.dispose();
  let valid=true,exportAllowed=false;
  const exporting=new module.exports.WorkspacePanel(store,()=>{},()=>false,undefined,()=>[],()=>({contexts:[],acceptedWork:[],assets:[],panelContext:{valid,exportAllowed,context,projectId:'fixture'}}),context);
  const ctx=exporting.ctx();assert.equal(await ctx.saveText('fixture.md','redacted fixture'),undefined);assert.equal(saveDialogs,0,'observation-only scope cannot ask for an export destination');
  exportAllowed=true;assert.equal(await ctx.saveText('fixture.md','redacted fixture'),'fixture-export.md');assert.equal(writes.length,1);
  beforeSave=()=>{valid=false;};assert.equal(await ctx.saveText('fixture.md','redacted fixture'),undefined);assert.equal(writes.length,1,'source/grant drift during destination dialog prevents the write');exporting.dispose();
});

test('scoped UI binds exports to reviewed sources and suspends missing, replaced or linked provider paths',async()=>{
  const f=await cockpitFixture();const handlers=new Map<string,Function>();let exportPermission=false,dialogs=0;const forwarded:unknown[]=[],panels:any[]=[],warnings:string[]=[];
  class Panel {constructor(...args:any[]){panels.push(this);Object.assign(this,{message:args[1],read:args[4],inputs:args[5]});}open(){}validityChanged(){}dispose(){}}
  const vscode={commands:{registerCommand(id:string,fn:Function){handlers.set(id,fn);return {dispose(){}};}},window:{async showQuickPick(items:any[],opts:any){return opts.canPickMany?[items[0]]:items.find(x=>x.exportConsent===exportPermission);},async showInputBox(opts:any){return opts.title==='Organization ID'?'local':'fixture';},showInformationMessage(){},showWarningMessage(message:string){warnings.push(message);},async showOpenDialog(){dialogs++;return [{fsPath:path.join(f.temp,'export')}];}},env:{clipboard:{async writeText(){}}}};
  const source=fs.readFileSync(path.resolve(__dirname,'../../src/ui/cockpit.ts'),'utf8'),compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const localRequire=createRequire(path.resolve(__dirname,'../src/ui/cockpit.js')),module={exports:{} as {registerCockpit:Function}};
  new Function('require','module','exports',compiled)((id:string)=>id==='vscode'?vscode:id==='./workspace'?{WorkspacePanel:Panel}:localRequire(id),module,module.exports);
  const store={all:()=>f.snapshots,adapters:[f.adapter],opts:{historyDays:3},onDidChange:()=>({dispose(){}})};
  const facade=module.exports.registerCockpit({subscriptions:[],globalState:{async update(){}}},store,()=>false,(m:unknown)=>forwarded.push(m),()=>({}));
  try{
    await handlers.get('agent.reviewCockpitScope')!();let scope=(await facade.api.getScopes()).data[0];
    const context={organizationId:'local',privacyDomainId:'fixture',projectId:'fixture',repoId:repoId(f.repo),hostId:localHost().hostId,worktreeId:null,revision:null,selectedItemId:f.snapshots[0].key,returnToken:'pm:fixture'};
    assert.equal((await facade.api.revealContext({requestId:'panel:fixture',scope,context})).state,'OK');let panel=panels.at(-1);
    panel.message({type:'cmd',cmd:'exportConversations',key:''});await new Promise(resolve=>setImmediate(resolve));assert.equal(dialogs,0);assert.deepEqual(forwarded,[],'scoped exports never enter the provider-wide command');
    exportPermission=true;await handlers.get('agent.reviewCockpitScope')!();scope=(await facade.api.getScopes()).data[0];assert.equal((await facade.api.revealContext({requestId:'panel:export',scope,context})).state,'OK');panel=panels.at(-1);
    panel.message({type:'cmd',cmd:'exportConversations',key:''});
    for(let i=0;i<40 && !warnings.some(m=>m.startsWith('Export selected fixture sessions locally?'));i++)await new Promise(resolve=>setTimeout(resolve,25));
    assert.ok(warnings.some(m=>m.startsWith('Export selected fixture sessions locally? 1 new, 0 appended, 0 rewritten, 0 unchanged.')),'actual export plan includes only the reviewed session');assert.equal(dialogs,1);assert.deepEqual(forwarded,[]);assert.equal(fs.existsSync(path.join(f.temp,'export')),false,'cancelled review writes no export');
    const original=f.snapshots[0].artifactPath,backup=original+'.approved';fs.appendFileSync(original,'\n');assert.equal(panel.read().length,1,'normal provider append retains the reviewed source identity');fs.renameSync(original,backup);assert.equal(panel.read().length,0);assert.equal(panel.inputs().panelContext.valid,false);
    fs.writeFileSync(original,fs.readFileSync(backup));assert.equal(panel.read().length,0,'same-path replacement requires fresh reviewed reconnect');assert.equal(panel.inputs().panelContext.valid,false);
    const linked=path.join(f.temp,'linked-provider');fs.symlinkSync(path.dirname(original),linked,'junction');f.snapshots[0].artifactPath=path.join(linked,path.basename(original));assert.equal(panel.read().length,0,'linked source cannot retain the panel authority');
  }finally{facade.dispose();fs.rmSync(f.temp,{recursive:true,force:true});}
});
