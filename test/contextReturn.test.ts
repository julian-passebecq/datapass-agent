import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { cockpitFixture } from './cockpitFixture';
import { contextSourceHash, PM_RETURN_COMMAND, returnToPm } from '../src/cockpit/contextReturn';
import { digest, repoId, ScopePolicy } from '../src/cockpit/policy';
import { CockpitFacade, localHost } from '../src/cockpit/facade';
import { IncrementalExporter } from '../src/export/incremental';
import { renderContextBridge } from '../src/render/extra/compact';
import { validateMessage } from '../src/render/html';

test('owner return executes only fixed PM command; absence copies token; drift denies both effects',async()=>{
  const f=await cockpitFixture();
  try {
    const policy=new ScopePolicy();policy.set(f.grant);
    const context={organizationId:'local',privacyDomainId:'fixture',projectId:'fixture',repoId:repoId(f.repo),hostId:localHost().hostId,worktreeId:null,revision:null,selectedItemId:f.snapshots[0].key,returnToken:'pm:work:7'};
    const binding={returnToken:context.returnToken,requestId:'open:1',generation:'generation:1',scopeHash:digest(f.grant.scope),epoch:policy.epoch};
    const source=contextSourceHash(context,policy.sessions(f.grant,f.snapshots));
    const valid=()=>!!policy.authorize({requestId:'return:1',scope:f.grant.scope,epoch:binding.epoch}) && contextSourceHash(context,policy.sessions(f.grant,f.snapshots))===source;
    const effects:unknown[]=[];let commands=[PM_RETURN_COMMAND];
    const transport={async commands(){return commands;},async execute(command:string,payload:unknown){effects.push({command,payload});},async copy(token:string){effects.push({copied:token});}};
    assert.equal(await returnToPm(context,binding,valid,transport),'RETURNED');assert.deepEqual(effects,[{command:'datapassPm.returnFromAgent',payload:binding}]);
    commands=['arbitrary.command'];effects.length=0;assert.equal(await returnToPm(context,binding,valid,transport),'COPIED');assert.deepEqual(effects,[{copied:context.returnToken}]);
    commands=[PM_RETURN_COMMAND];effects.length=0;f.snapshots[0].headAfter='a'.repeat(40);assert.equal(await returnToPm(context,binding,valid,transport),'DENIED');assert.deepEqual(effects,[]);f.snapshots[0].headAfter=undefined;
    assert.equal(await returnToPm(context,{...binding,returnToken:'arbitrary.command'},valid,transport),'DENIED');
    assert.equal(await returnToPm(context,binding,valid,{...transport,async commands(){policy.clear();return commands;}}),'DENIED');assert.deepEqual(effects,[]);
    policy.set(f.grant);assert.equal(await returnToPm(context,binding,valid,transport,true),'DENIED');
    assert.ok(validateMessage({type:'cmd',cmd:'returnToPm',key:''},()=>false));assert.equal(validateMessage({type:'cmd',cmd:'datapassPm.returnFromAgent',key:''},()=>false),undefined);
    const html=renderContextBridge({sessions:[],providers:[],events:[],now:Date.now(),ternAvailable:false,cockpitInputs:{contexts:[],acceptedWork:[],assets:[],panelContext:{valid:true,context,projectId:'fixture'}}});assert.match(html,/data-cmd="returnToPm"/);assert.match(html,/Copy return token/);
  }finally{await fs.rm(f.temp,{recursive:true,force:true});}
});

test('facade passes exact return binding and denies revocation during host opening',async()=>{
  const f=await cockpitFixture();
  try {
    const policy=new ScopePolicy();policy.set(f.grant);const r={requestId:'open:1',scope:f.grant.scope,generation:'generation:1'};
    const context={organizationId:'local',privacyDomainId:'fixture',projectId:'fixture',repoId:repoId(f.repo),hostId:localHost().hostId,worktreeId:null,revision:null,selectedItemId:f.snapshots[0].key,returnToken:'pm:work:7'};
    let binding:unknown;const epoch=policy.epoch;
    const facade=new CockpitFacade({all:()=>f.snapshots,opts:{historyDays:3},onDidChange:()=>({dispose(){}})},policy,{open(_v,_g,_id,_context,returned){binding=returned;policy.clear();},async openSource(){}},new IncrementalExporter([f.adapter]));
    assert.equal((await facade.api.revealContext({...r,context})).state,'DENIED');assert.deepEqual(binding,{returnToken:context.returnToken,requestId:r.requestId,generation:r.generation,scopeHash:digest(r.scope),epoch});facade.dispose();
  }finally{await fs.rm(f.temp,{recursive:true,force:true});}
});
