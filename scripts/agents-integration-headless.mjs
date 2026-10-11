// Synthetic, headless Chromium only. No Electron, owner profile, physical input,
// provider home, native conversations or external network is used.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url);
const {renderWorkspace,allViews}=require('../out-test/src/render/workspace.js');
const {page,DIGIT_VIEWS}=require('../out-test/src/render/html.js');
const {workspaceMetadata,restoreWorkspaceMetadata}=require('../out-test/src/cockpit/workspaceState.js');
const {extraCss}=require('../out-test/src/render/extra/index.js');
const output=path.resolve(process.argv[2] ?? path.join(root,'.smoke','agents-integration-headless'));
fs.mkdirSync(output,{recursive:true});
const executablePath=process.env.AGENT_HEADLESS_CHROMIUM ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const browser=await chromium.launch({executablePath,headless:true,args:['--disable-background-networking','--disable-component-update']});
const checks=[];const check=(name,ok,detail='')=>{checks.push({name,state:ok?'PASS':'FAIL',detail});console.log(`${ok?'PASS':'FAIL'} ${name} ${detail}`);};
const contextRef={organizationId:'local',privacyDomainId:'synthetic',projectId:'fixture',repoId:'repo:fixture',hostId:'host:fixture',worktreeId:null,revision:null,selectedItemId:'codex:fixture',returnToken:'pm:fixture'};
const session={key:'codex:fixture',provider:'codex',sessionId:'fixture',status:'UNKNOWN',statusReason:'Synthetic fixture; no process evidence',title:'Synthetic controlled project',commits:[],changedFiles:[],tests:[],isWorker:false,counts:{tools:0,commands:0,fileEdits:0,turns:0},evidence:[],artifactPath:'fixture-only',diagnostics:[],repository:'D:/fixture/controlled-project',cwd:'D:/fixture/controlled-project'};
let data={sessions:[session],providers:[],events:[],now:Date.parse('2026-10-11T18:00:00Z'),ternAvailable:false,cockpitInputs:{contexts:[],acceptedWork:[],assets:[],panelContext:{valid:true,context:contextRef,projectId:'fixture'}}};
let state={view:'compact',selected:session.key,opts:{'compact-scope':'session'}};
const style=':root{--vscode-font-family:Arial;--vscode-font-size:13px;--vscode-foreground:#ddd;--vscode-descriptionForeground:#bbb;--vscode-editor-background:#1e1e1e;--vscode-widget-border:#555;--vscode-list-activeSelectionBackground:#174b79;--vscode-list-activeSelectionForeground:#fff}body{background:#1e1e1e}';
let documentHtml=()=>page('https://agent-fixture.invalid',renderWorkspace(data,state),{filter:true,css:extraCss()+style,state:workspaceMetadata(state,allViews(),true,contextRef)});
const context=await browser.newContext({viewport:{width:420,height:900}});
await context.addInitScript(()=>{
  window.__messages=[];
  window.acquireVsCodeApi=()=>({postMessage(m){window.__messages.push(m);window.__fixtureHost?.(m);},setState(s){window.__state=s;},getState(){return window.__state;}});
});
const tab=await context.newPage();
await context.route('**/*',route=>route.fulfill({status:200,contentType:'text/html',body:documentHtml()}));
await tab.exposeFunction('__fixtureHost',async m=>{
  if(m.type==='nav')state.view=m.view;
  else if(m.type==='opt')state.opts[m.name]=m.value;
  else if(m.type==='select')state.selected=m.key;
  else if(m.type==='clear')state.selected=undefined;
  else return;
  await tab.evaluate(({html,state})=>window.postMessage({type:'render',html,state},'*'),{html:renderWorkspace(data,state),state:workspaceMetadata(state,allViews(),true,contextRef)});
});
try {
  await tab.goto('https://agent-fixture.invalid/fixture');
  for(const width of [420,600,700,1000,1500]){
    await tab.setViewportSize({width,height:900});
    const overflow=[];
    for(const view of allViews()){
      state.view=view;
      await tab.evaluate(({html,state})=>window.postMessage({type:'render',html,state},'*'),{html:renderWorkspace(data,state),state:workspaceMetadata(state,allViews(),true,contextRef)});
      await tab.waitForFunction(v=>window.__state?.view===v,view);
      const dims=await tab.evaluate(()=>({client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));
      if(dims.scroll>dims.client+1)overflow.push(`${view} +${dims.scroll-dims.client}px`);
    }
    check(`All ${allViews().length} screens at ${width}px: bounded page width`,overflow.length===0,overflow.join(', '));
  }
  state.view='settings';
  await tab.setViewportSize({width:420,height:900});
  await tab.evaluate(({html,state})=>window.postMessage({type:'render',html,state},'*'),{html:renderWorkspace(data,state),state:workspaceMetadata(state,allViews(),true,contextRef)});
  await tab.waitForFunction(()=>window.__state?.view==='settings');
  const activeVisible=await tab.locator('.rail .nav.on').evaluate(el=>{const a=el.getBoundingClientRect(),r=el.closest('.rail').getBoundingClientRect();return a.left>=r.left-1 && a.right<=r.right+1;});
  check('Offscreen active rail control is brought into the narrow viewport',activeVisible);
  await tab.screenshot({path:path.join(output,'synthetic-narrow-settings.png')});
  await tab.locator('.nav.on').focus();
  for(let i=0;i<10;i++){
    const digit=i===9?'0':String(i+1);
    await tab.keyboard.press(digit);
    await tab.waitForFunction(view=>window.__state?.view===view,DIGIT_VIEWS[i]);
  }
  check('Focused webview numbered shortcuts retain fixed mapping across all ten screens',true);
  await tab.locator('#q').evaluate(el=>{el.classList.remove('q-off');el.focus();});
  const before=await tab.evaluate(()=>window.__messages.filter(m=>m.type==='nav').length);
  await tab.keyboard.type('123');
  check('Search input typing never navigates screens',await tab.evaluate(()=>window.__messages.filter(m=>m.type==='nav').length)===before);
  await tab.evaluate(()=>{const edit=document.createElement('div');edit.contentEditable='true';edit.id='fixture-edit';document.body.append(edit);edit.focus();});
  await tab.keyboard.type('456');
  check('Contenteditable typing never navigates screens',await tab.evaluate(()=>window.__messages.filter(m=>m.type==='nav').length)===before);
  const saved=await tab.evaluate(()=>window.__state);
  const restored=restoreWorkspaceMetadata(saved,allViews());
  state={view:restored.metadata.view,selected:restored.metadata.selected,opts:restored.metadata.opts};
  data={...data,sessions:[],cockpitInputs:{contexts:[],acceptedWork:[],assets:[],panelContext:{valid:false,context:restored.metadata.context,projectId:'fixture',reason:restored.reason}}};
  await tab.reload();
  check('Synthetic host restart preserves selected page and context metadata',await tab.evaluate(()=>window.__state.view)===saved.view && (await tab.evaluate(()=>window.__state.context.projectId))==='fixture');
  check('Synthetic host restart requires reviewed reconnect and hides provider data',(await tab.locator('[role=alert]').textContent()).includes('grant was not restored') && await tab.locator('[data-select]').count()===0);
  await tab.screenshot({path:path.join(output,'synthetic-reload-reconnect.png')});
}finally{
  await browser.close();
  fs.writeFileSync(path.join(output,'receipt.json'),JSON.stringify({schema:'datapass.agent-headless-qualification/1',fixture:'SYNTHETIC',nativeUiState:'UNTESTED',physicalInput:false,providerHomeRead:false,checks},null,2)+'\n');
}
if(checks.some(c=>c.state==='FAIL'))process.exitCode=1;
