import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { cockpitFixture } from './cockpitFixture';
import { observeResources, validateResources } from '../src/cockpit/resources';
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
