import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { allViews } from '../src/render/workspace';
import { workspaceMetadata,restoreWorkspaceMetadata,WORKSPACE_STATE_SCHEMA } from '../src/cockpit/workspaceState';
import { revealContextInLens,LENS_CONTEXT_COMMAND } from '../src/cockpit/lensContext';
import { repoId } from '../src/cockpit/policy';
import { cockpitFixture } from './cockpitFixture';
import * as fs from 'node:fs/promises';

const context={organizationId:'local',privacyDomainId:'fixture',projectId:'fixture',repoId:'repo:fixture',hostId:'host:fixture',worktreeId:null,revision:null,selectedItemId:'codex:fixture',returnToken:'pm:work:fixture'};
test('safe workspace state preserves navigation and ContextRef; strips grants, content, arbitrary options and approval bindings',()=>{
  const original={view:'catalog',selected:'codex:fixture',opts:{'catalog.tab':'models','compact-project':'fixture','scope':'fixture',credential:'secret','transcript.open':'conversation','rail.now':'closed'},context,grant:{roots:['private']},binding:{epoch:1},conversations:['private']};
  const saved=workspaceMetadata(original,allViews(),true,context);
  assert.equal(saved.view,'catalog');assert.equal(saved.selected,'codex:fixture');assert.deepEqual(saved.context,context);
  assert.deepEqual(saved.opts,{'catalog.tab':'models','compact-project':'fixture',scope:'fixture','rail.now':'closed'});
  assert.equal(JSON.stringify(saved).includes('private'),false);assert.equal(JSON.stringify(saved).includes('secret'),false);
  const restored=restoreWorkspaceMetadata(saved,allViews());assert.deepEqual(restored.metadata,saved);assert.match(restored.reason!,/grant was not restored/);
  const unscoped=workspaceMetadata({view:'board'},allViews());assert.equal(restoreWorkspaceMetadata(unscoped,allViews()).reason,undefined);
  assert.match(restoreWorkspaceMetadata({...saved,scoped:false},allViews()).reason!,/grant was not restored/);
});
test('invalid, old and forged restoration metadata fail closed without a fallback to local sources',()=>{
  for(const input of [null,{},[],{schema:WORKSPACE_STATE_SCHEMA,scoped:false,view:'unknown'}, {schema:WORKSPACE_STATE_SCHEMA,scoped:false,view:'overview',context:{...context,revision:1234567}}, {schema:'legacy',view:'board',scoped:false}]) {
    const result=restoreWorkspaceMetadata(input,allViews());assert.equal(result.metadata.scoped,true);assert.ok(result.reason);
  }
});
test('Agent to Lens forwards scoped context and original PM return binding only under current reviewed authority',async()=>{
  const f=await cockpitFixture();
  try{
    const s=f.snapshots[0];const c={...context,repoId:repoId(f.repo),selectedItemId:s.key};
    const binding={returnToken:c.returnToken,requestId:'fixture:lens',generation:'generation:1',scopeHash:'a'.repeat(64),epoch:1};
    let authorized=true;const effects:unknown[]=[];
    const transport={async commands(){return [LENS_CONTEXT_COMMAND];},async execute(command:string,payload:unknown){effects.push({command,payload});return {opened:true};}};
    assert.equal(await revealContextInLens(c,binding,f.snapshots,()=>authorized,transport),'OPENED');
    const forwarded=(effects[0] as {payload:{context:unknown;binding:unknown;devContext:{repository:{path:string}}}}).payload;
    assert.deepEqual(forwarded.context,c);assert.deepEqual(forwarded.binding,binding);assert.equal(forwarded.devContext.repository.path,f.repo);
    effects.length=0;
    assert.equal(await revealContextInLens({...c,projectId:'other',repoId:'repo:other'},binding,f.snapshots,()=>authorized,transport),'DENIED');
    assert.equal(await revealContextInLens({...c,revision:'b'.repeat(40)},binding,f.snapshots,()=>authorized,transport),'DENIED');
    assert.equal(await revealContextInLens(c,binding,f.snapshots,()=>authorized,{...transport,async commands(){authorized=false;return [LENS_CONTEXT_COMMAND];}}),'DENIED');assert.deepEqual(effects,[]);
    authorized=true;
    assert.equal(await revealContextInLens(c,binding,f.snapshots,()=>authorized,{...transport,async commands(){return [];}}),'UNAVAILABLE');
    assert.equal(await revealContextInLens(c,binding,f.snapshots,()=>authorized,{...transport,async execute(){return {opened:false};}}),'UNAVAILABLE');
    assert.equal(await revealContextInLens(c,{...binding,returnToken:'forged'},f.snapshots,()=>authorized,transport),'DENIED');
  }finally{await fs.rm(f.temp,{recursive:true,force:true});}
});
