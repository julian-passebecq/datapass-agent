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
    const transport={async commands(){return commands;},async execute(command:string,payload:unknown){effects.push({command,payload});return {returned:true,...payload as typeof binding};},async copy(token:string){effects.push({copied:token});}};
    assert.equal(await returnToPm(context,binding,valid,transport),'RETURNED');assert.deepEqual(effects,[{command:'datapassPm.returnFromAgent',payload:binding}]);
    assert.equal(await returnToPm(context,binding,valid,{...transport,async execute(){return undefined;}}),'UNVERIFIED','legacy missing acknowledgement cannot imply restoration');
    assert.equal(await returnToPm(context,binding,valid,{...transport,async execute(){return {returned:true,...binding,epoch:binding.epoch+1};}}),'DENIED','wrong original binding cannot acknowledge this selection');
    await assert.rejects(()=>returnToPm(context,binding,valid,{...transport,async execute(){throw new Error('PM task authority changed');}}),/task authority changed/);
    commands=['arbitrary.command'];effects.length=0;assert.equal(await returnToPm(context,binding,valid,transport),'COPIED');assert.deepEqual(effects,[{copied:context.returnToken}]);
    commands=[PM_RETURN_COMMAND];effects.length=0;f.snapshots[0].headAfter='a'.repeat(40);assert.equal(await returnToPm(context,binding,valid,transport),'DENIED');assert.deepEqual(effects,[]);f.snapshots[0].headAfter=undefined;
    assert.equal(await returnToPm(context,{...binding,returnToken:'arbitrary.command'},valid,transport),'DENIED');
    assert.equal(await returnToPm(context,binding,valid,{...transport,async commands(){policy.clear();return commands;}}),'DENIED');assert.deepEqual(effects,[]);
    policy.set(f.grant);const fresh={...binding,epoch:policy.epoch};
    assert.equal(await returnToPm(context,fresh,()=>!!policy.authorize({requestId:'copy:late',scope:f.grant.scope,epoch:fresh.epoch}),{...transport,async copy(){policy.clear();}},true),'DENIED','late clipboard acknowledgement cannot report a current return after revocation');
    policy.set(f.grant);assert.equal(await returnToPm(context,binding,valid,transport,true),'DENIED');
    assert.ok(validateMessage({type:'cmd',cmd:'returnToPm',key:''},()=>false));assert.equal(validateMessage({type:'cmd',cmd:'datapassPm.returnFromAgent',key:''},()=>false),undefined);
    const html=renderContextBridge({sessions:[],providers:[],events:[],now:Date.now(),ternAvailable:false,cockpitInputs:{contexts:[],acceptedWork:[],assets:[],panelContext:{valid:true,context,projectId:'fixture'}}});assert.match(html,/data-cmd="returnToPm"/);assert.match(html,/Copy return token/);
  }finally{await fs.rm(f.temp,{recursive:true,force:true});}
});

test('PM task origin is inert selection metadata, separately validated from observed native session identity',async()=>{
  const f=await cockpitFixture();try{
    const policy=new ScopePolicy();policy.set(f.grant);let opened:any;
    const facade=new CockpitFacade({all:()=>f.snapshots,opts:{historyDays:3},onDidChange:()=>({dispose(){}})},policy,{open(_v,_g,_id,c){opened=c;},async openSource(){}},new IncrementalExporter([f.adapter]));
    const context={organizationId:'local',privacyDomainId:'fixture',projectId:'fixture',repoId:repoId(f.repo),hostId:localHost().hostId,worktreeId:null,revision:null,selectedItemId:f.snapshots[0].key,returnToken:'pm:task:7',origin:{schema:'datapass.pm-origin/1' as const,projectId:'fixture',taskId:'task:7',taskRevision:4,taskAuthorityHash:'a'.repeat(64)}};
    const r={requestId:'open:origin',scope:f.grant.scope};assert.equal((await facade.api.revealContext({...r,context})).state,'OK');assert.deepEqual(opened.origin,context.origin);
    const html=renderContextBridge({sessions:[],providers:[],events:[],now:Date.now(),ternAvailable:false,cockpitInputs:{contexts:[],acceptedWork:[],assets:[],panelContext:{valid:true,context,projectId:'fixture'}}});assert.match(html,/Selected PM task: <b>task:7/);assert.match(html,/Session assignment is UNKNOWN/);assert.match(html,/Observed native session:/);
    for(const origin of [{...context.origin,projectId:'other'},{...context.origin,taskRevision:null},{...context.origin,taskAuthorityHash:'wrong'},{...context.origin,taskRevision:-1}])assert.equal((await facade.api.revealContext({...r,context:{...context,origin}})).state,'DENIED');
    facade.dispose();
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

test('return scope hash matches the actual reply for a valid reordered caller scope',async()=>{
  const f=await cockpitFixture();
  try {
    const policy=new ScopePolicy();policy.set(f.grant);
    const scope=Object.fromEntries(Object.entries(f.grant.scope).reverse()) as typeof f.grant.scope;
    const r={requestId:'open:reordered',scope,generation:'generation:1'};
    const context={organizationId:'local',privacyDomainId:'fixture',projectId:'fixture',repoId:repoId(f.repo),hostId:localHost().hostId,worktreeId:null,revision:null,selectedItemId:f.snapshots[0].key,returnToken:'pm:work:7'};
    let hash:string|undefined;const facade=new CockpitFacade({all:()=>f.snapshots,opts:{historyDays:3},onDidChange:()=>({dispose(){}})},policy,{open(_v,_g,_id,_context,returned){hash=returned?.scopeHash;},async openSource(){}},new IncrementalExporter([f.adapter]));
    const reply=await facade.api.revealContext({...r,context});assert.equal(reply.state,'OK');assert.equal(hash,reply.scopeHash);assert.equal(hash,digest(scope));facade.dispose();
  }finally{await fs.rm(f.temp,{recursive:true,force:true});}
});

test('context open refuses source identity drift during an asynchronous host open',async()=>{
  const f=await cockpitFixture();
  try {
    const policy=new ScopePolicy();policy.set(f.grant);
    const context={organizationId:'local',privacyDomainId:'fixture',projectId:'fixture',repoId:repoId(f.repo),hostId:localHost().hostId,worktreeId:null,revision:null,selectedItemId:f.snapshots[0].key,returnToken:'pm:work:7'};
    const facade=new CockpitFacade({all:()=>f.snapshots,opts:{historyDays:3},onDidChange:()=>({dispose(){}})},policy,{async open(){f.snapshots[0].repository=f.temp;},async openSource(){}},new IncrementalExporter([f.adapter]));
    assert.equal((await facade.api.revealContext({requestId:'open:drift',scope:f.grant.scope,context})).state,'DENIED');facade.dispose();
  }finally{await fs.rm(f.temp,{recursive:true,force:true});}
});
