import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { cockpitFixture } from './cockpitFixture';
import { correlateResourceTime, observeResources, validateResources } from '../src/cockpit/resources';
import { ScopePolicy } from '../src/cockpit/policy';
import { CockpitFacade } from '../src/cockpit/facade';
import { IncrementalExporter } from '../src/export/incremental';
import type { SelectedProcessResource } from '../src/cockpit/resources';
import { readProcessMetadata, validPid } from '../src/cockpit/processMetadata';

test('selected PID metadata remains separate, bounds reads, detects identity reuse and drops revoked results',async()=>{
  const f=await cockpitFixture();
  try {
    const startedAt='2026-10-09T12:00:00.000Z';
    const selected:SelectedProcessResource={id:'process:17',kind:'PROCESS',pid:17,expectedStartedAt:startedAt};
    validateResources(f.grant,[selected]);
    const calls:number[]=[];
    const observed=await observeResources([selected],()=>true,async pid=>{calls.push(pid);return {state:'OBSERVED',process:{pid,alive:true,name:'synthetic.exe',parentPid:9,startedAt,source:'LOCAL_CIM_PID_QUERY'}};});
    assert.deepEqual(calls,[17]);assert.equal(observed[0].state,'OBSERVED');assert.equal(observed[0].process?.startedAt,startedAt);assert.equal(observed[0].causality,'UNKNOWN');assert.equal(observed[0].enabled,null);
    const reused=await observeResources([selected],()=>true,async pid=>({state:'OBSERVED',process:{pid,alive:true,name:'replacement.exe',parentPid:9,startedAt:'2026-10-09T13:00:00.000Z',source:'LOCAL_CIM_PID_QUERY'}}));
    assert.equal(reused[0].state,'BLOCKED');assert.equal(reused[0].reason,'PID_IDENTITY_DRIFT');
    const absent=await observeResources([selected],()=>true,async pid=>({state:'ABSENT',process:{pid,alive:false,name:null,parentPid:null,startedAt:null,source:'LOCAL_CIM_PID_QUERY'}}));assert.equal(absent[0].state,'ABSENT');
    let authorized=true;assert.deepEqual(await observeResources([selected],()=>authorized,async pid=>{authorized=false;return {state:'OBSERVED',process:{pid,alive:true,name:'synthetic.exe',parentPid:null,startedAt:null,source:'LOCAL_PID_EXISTENCE'}};}),[]);
    assert.throws(()=>validateResources(f.grant,[{...selected,pid:-1}]),/Invalid/);assert.throws(()=>validateResources(f.grant,Array.from({length:11},(_,i)=>({...selected,id:'process:'+i}))),/Invalid/);
    assert.equal(validPid('17; arbitrary command'),false);await assert.rejects(readProcessMetadata(-1),/Invalid selected/);
  }finally{await fs.rm(f.temp,{recursive:true,force:true});}
});

test('resource timestamps correlate only with enrolled recorded windows, remain bounded and never imply cause',async()=>{
  const f=await cockpitFixture();
  try {
    const file=f.files[0];const at=Date.now();await fs.utimes(file,new Date(at),new Date(at));
    f.snapshots[0].startedAt=at-1000;f.snapshots[0].lastActivityAt=at+1000;
    f.snapshots[1].startedAt=at-1000;f.snapshots[1].lastActivityAt=at+1000;
    const policy=new ScopePolicy();policy.set(f.grant);
    const facade=new CockpitFacade({all:()=>f.snapshots,opts:{historyDays:3},onDidChange:()=>({dispose(){}})},policy,{open(){},async openSource(){}},new IncrementalExporter([f.adapter]));
    facade.registerResources(f.grant,[{id:'resource:1',kind:'FILE',file,enabled:null,staleAfterMs:null}]);
    const reply=await facade.api.getResourceObservations({requestId:'resource:1',scope:f.grant.scope});
    assert.deepEqual(reply.data[0].timeRelations?.map(r=>[r.sessionId,r.relation]),[[f.snapshots[0].key,'WITHIN_RECORDED_WINDOW']]);assert.equal(reply.data[0].causality,'UNKNOWN');assert.doesNotMatch(JSON.stringify(reply.data),new RegExp(f.snapshots[1].key));
    const pending=facade.api.getResourceObservations({requestId:'resource:drift',scope:f.grant.scope});f.snapshots[0].repository=f.temp;
    assert.deepEqual((await pending).data[0].timeRelations,[]);f.snapshots[0].repository=f.repo;
    const more=Array.from({length:12},(_,i)=>({...f.snapshots[0],key:'codex:synthetic-'+i}));
    const capped=correlateResourceTime(reply.data[0],more);assert.equal(capped.timeRelations?.length,10);assert.equal(capped.timeRelationCoverage?.complete,false);
    assert.equal(correlateResourceTime({...reply.data[0],modifiedAt:new Date(at-2000).toISOString()},[f.snapshots[0]]).timeRelations?.[0].relation,'BEFORE_RECORDED_WINDOW');
    assert.equal(correlateResourceTime({...reply.data[0],modifiedAt:new Date(at+2000).toISOString()},[f.snapshots[0]]).timeRelations?.[0].relation,'AFTER_RECORDED_WINDOW');
    const missing=correlateResourceTime(reply.data[0],[{...f.snapshots[0],startedAt:undefined}]);assert.equal(missing.timeRelations?.length,0);assert.equal(missing.timeRelationCoverage?.unavailableRecordedWindows,1);assert.equal(missing.timeRelationCoverage?.complete,false);
    assert.equal(correlateResourceTime({...reply.data[0],state:'BLOCKED'},more).timeRelations?.length,0);facade.dispose();
  }finally{await fs.rm(f.temp,{recursive:true,force:true});}
});
