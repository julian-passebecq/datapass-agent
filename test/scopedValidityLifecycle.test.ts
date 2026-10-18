import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import * as ts from 'typescript';
import { CodexAdapter } from '../src/providers/codex/codex';
import { SessionStore } from '../src/sessions/store';
import { localSourceIdentity } from '../src/cockpit/configuration';

test('scoped workspace re-renders source validity transitions when the session projection stays unchanged',async t=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'agent-scoped-validity-'));
  const home=path.join(temp,'codex'),repo=path.join(temp,'repo'),now=Date.now(),at=new Date(now).toISOString();
  const directory=path.join(home,'sessions',...at.slice(0,10).split('-'));
  fs.mkdirSync(directory,{recursive:true});fs.mkdirSync(repo);
  const id='77777777-8888-4999-aaaa-bbbbbbbbbbbb';
  const artifact=path.join(directory,'rollout-'+at.slice(0,19).replace(/:/g,'-')+'-'+id+'.jsonl');
  fs.writeFileSync(artifact,[{timestamp:at,type:'session_meta',payload:{id,timestamp:at,cwd:repo,originator:'GENERATED_TEST_FIXTURE',cli_version:'GENERATED_NOT_NATIVE'}},{timestamp:at,type:'event_msg',payload:{type:'user_message',message:'Generated scoped lifecycle fixture.'}}].map(record=>JSON.stringify(record)).join('\n')+'\n',{flag:'wx'});
  const store=new SessionStore([new CodexAdapter(home)],{historyDays:30,maxSessions:10,idleMinutes:5,git:false},()=>now);
  const callbacks:{message?:(m:unknown)=>void;visibility?:(e:unknown)=>void}={};
  const received:{html?:string}[]=[];
  const nativePanel={visible:true,active:true,title:'Agent',iconPath:undefined as unknown,webview:{options:{},cspSource:'self',html:'',onDidReceiveMessage(fn:(m:unknown)=>void){callbacks.message=fn;},postMessage(m:{html?:string}){received.push(m);return Promise.resolve(true);}},onDidChangeViewState(fn:(e:unknown)=>void){callbacks.visibility=fn;},onDidDispose(){},reveal(){},dispose(){}};
  const vscode={ThemeIcon:class{},ViewColumn:{Active:1},window:{createWebviewPanel(){return nativePanel;}},workspace:{isTrusted:false,getConfiguration(){return {get(_key:string,fallback:unknown){return fallback;}};}}};
  // Same source-loading boundary as panelLifecycle.test.ts: stub the public VS Code
  // surface and provider feed pumping, while keeping the real panel and renderer.
  const source=fs.readFileSync(path.resolve(__dirname,'../../src/ui/workspace.ts'),'utf8');
  const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const localRequire=createRequire(path.resolve(__dirname,'../src/ui/workspace.js'));
  const module={exports:{} as {WorkspacePanel:new(...args:any[])=>any}};
  new Function('require','module','exports',compiled)((name:string)=>name==='vscode'?vscode:name==='../render/extra/feeds'?{...localRequire(name),pump(){}}:localRequire(name),module,module.exports);
  let panel:any;
  try{
    await store.refresh();assert.equal(store.all().length,1);
    const version=store.version,snapshot=store.all()[0],identity=localSourceIdentity(artifact);
    assert.ok(identity);
    const valid=()=>localSourceIdentity(artifact)===identity;
    let inputReads=0;
    const context={organizationId:'local',privacyDomainId:'fixture',projectId:'fixture',repoId:'repo:fixture',hostId:'host:fixture',worktreeId:null,revision:null,selectedItemId:snapshot.key,returnToken:'pm:fixture'};
    panel=new module.exports.WorkspacePanel(store,()=>{},()=>false,undefined,()=>valid()?store.all():[],()=>{inputReads++;return {contexts:[],acceptedWork:[],assets:[],panelContext:{valid:valid(),projectId:'fixture',context,reason:valid()?undefined:'The reviewed provider source disappeared or is unavailable. Activity is UNKNOWN.'}};},context,valid);
    panel.open('compact');callbacks.message!({type:'ready',key:''});
    assert.match(received.at(-1)!.html!,/data-cmd="returnToPm"/);
    t.mock.timers.enable({apis:['setTimeout']});
    let count=received.length,reads=inputReads;
    await store.refresh();t.mock.timers.tick(300);
    assert.equal(received.length,count,'unchanged valid projection skips page work');
    assert.equal(inputReads,reads,'validity check does not collect full scoped inputs');
    fs.renameSync(artifact,artifact+'.owned-offline');
    await store.refresh();
    assert.equal(store.version,version);assert.equal(store.all()[0],snapshot,'store retains historical session snapshot');assert.equal(valid(),false);
    assert.equal(inputReads,reads,'source invalidation schedules without collecting page inputs');
    t.mock.timers.tick(300);
    const invalid=received.at(-1)!.html!;
    assert.match(invalid,/class="context-bridge" role="alert"/);assert.match(invalid,/<h2>Reviewed scope is no longer valid<\/h2>/);assert.match(invalid,/Source coverage: UNKNOWN\. Observation and source collectors are suspended/);
    assert.doesNotMatch(invalid,/data-cmd="(?:returnToPm|copyReturnToken|openScopedLens)"/);
    count=received.length;reads=inputReads;
    await store.refresh();t.mock.timers.tick(300);
    assert.equal(received.length,count,'unchanged invalid projection skips page work');assert.equal(inputReads,reads);
    fs.renameSync(artifact+'.owned-offline',artifact);await store.refresh();t.mock.timers.tick(300);
    assert.equal(store.version,version);assert.equal(localSourceIdentity(artifact),identity);
    assert.match(received.at(-1)!.html!,/data-cmd="returnToPm"/);assert.match(received.at(-1)!.html!,/data-cmd="copyReturnToken"/);assert.match(received.at(-1)!.html!,/data-cmd="openScopedLens"/);assert.doesNotMatch(received.at(-1)!.html!,/class="context-bridge" role="alert"|<h2>Reviewed scope is no longer valid<\/h2>/);
    count=received.length;nativePanel.visible=false;fs.renameSync(artifact,artifact+'.owned-offline');await store.refresh();t.mock.timers.tick(300);
    assert.equal(received.length,count,'hidden panels schedule no render');
    nativePanel.visible=true;callbacks.visibility!({webviewPanel:nativePanel});
    assert.match(received.at(-1)!.html!,/class="context-bridge" role="alert"/,'existing visibility lifecycle rechecks source validity');
    assert.match(received.at(-1)!.html!,/<h2>Reviewed scope is no longer valid<\/h2>/);
  }finally{
    panel?.dispose();store.dispose();t.mock.timers.reset();fs.rmSync(temp,{recursive:true,force:true});
  }
});
