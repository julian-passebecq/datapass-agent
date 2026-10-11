import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { cockpitFixture } from './cockpitFixture';
import { CockpitFacade,localHost } from '../src/cockpit/facade';
import { ScopePolicy,repoId,digest } from '../src/cockpit/policy';
import { IncrementalExporter } from '../src/export/incremental';

test('context mappings expose only reviewed local metadata, preserve reply bindings and omit disappeared sources',async()=>{
  const f=await cockpitFixture();
  try{
    const policy=new ScopePolicy();let opened=0;
    const facade=new CockpitFacade({all:()=>f.snapshots,opts:{historyDays:3},onDidChange:()=>({dispose(){}})},policy,{open(){opened++;},async openSource(){}},new IncrementalExporter([f.adapter]));
    const r={requestId:'fixture:mappings',scope:f.grant.scope,generation:'generation:fixture'};
    assert.equal((await facade.api.getContextMappings(r)).state,'DENIED');
    policy.set(f.grant);f.snapshots[0].headAfter='a'.repeat(40);f.snapshots[0].worktree=f.repo;
    const reply=await facade.api.getContextMappings({...r,epoch:policy.epoch});
    assert.equal(reply.state,'OK');assert.equal(reply.generation,r.generation);assert.equal(reply.epoch,policy.epoch);assert.equal(reply.scopeHash,digest(r.scope));
    assert.deepEqual(reply.data,[{repoId:repoId(f.repo),path:f.repo,worktreeId:repoId(f.repo),worktreePath:f.repo,revision:'a'.repeat(40),sessionId:f.snapshots[0].key}]);
    assert.doesNotMatch(JSON.stringify(reply),/fixture-secret-value|PRIVATE_HIDDEN_REASONING|22222222/);
    reply.data[0].path='mutated';assert.equal((await facade.api.getContextMappings(r)).data[0].path,f.repo);
    assert.equal((await facade.api.getContextMappings({...r,scope:{...r.scope,repoIds:['repo:other']}})).state,'DENIED');
    await fs.unlink(f.files[0]);
    const missing=await facade.api.getContextMappings(r);assert.equal(missing.state,'PARTIAL');assert.deepEqual(missing.data,[]);assert.match(missing.omissions.join(' '),/UNKNOWN/);
    const context={organizationId:'local',privacyDomainId:'fixture',projectId:'fixture',repoId:repoId(f.repo),hostId:localHost().hostId,worktreeId:repoId(f.repo),revision:'a'.repeat(40),selectedItemId:f.snapshots[0].key,returnToken:'pm:fixture'};
    assert.equal((await facade.api.revealContext({...r,context})).state,'DENIED');assert.equal(opened,0);
    policy.clear();assert.equal((await facade.api.getContextMappings(r)).state,'DENIED');facade.dispose();
  }finally{await fs.rm(f.temp,{recursive:true,force:true});}
});
test('asynchronous mapping discards source drift and grant revocation',async()=>{
  const f=await cockpitFixture();
  try{
    const policy=new ScopePolicy();policy.set(f.grant);let calls=0,mode='drift';
    const facade=new CockpitFacade({all(){calls++;if(calls===2){if(mode==='drift')f.snapshots[0].headAfter='b'.repeat(40);else policy.clear();}return f.snapshots;},opts:{historyDays:3},onDidChange:()=>({dispose(){}})},policy,{open(){},async openSource(){}},new IncrementalExporter([f.adapter]));
    const r={requestId:'fixture:mappings',scope:f.grant.scope};
    assert.equal((await facade.api.getContextMappings(r)).state,'DENIED');
    calls=0;mode='revoke';assert.equal((await facade.api.getContextMappings(r)).state,'DENIED');facade.dispose();
  }finally{await fs.rm(f.temp,{recursive:true,force:true});}
});
