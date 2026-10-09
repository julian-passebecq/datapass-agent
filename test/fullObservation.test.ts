import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { cockpitFixture } from './cockpitFixture';
import { CockpitFacade, localHost } from '../src/cockpit/facade';
import { ScopePolicy, repoId } from '../src/cockpit/policy';
import { IncrementalExporter } from '../src/export/incremental';
import { SessionAccumulator } from '../src/sessions/accumulator';
import { observeSession } from '../src/cockpit/observation';
import { sessionRef } from '../src/cockpit/facade';
import { compactSessions, renderCompact } from '../src/render/extra/compact';

test('Codex reader observes ordinary request/result and requested child metadata without inventing observed model', async()=>{
  const f=await cockpitFixture();
  try {
    const at=new Date().toISOString();
    const lines=[{type:'response_item',timestamp:at,payload:{type:'function_call',call_id:'question:1',name:'request_user_input',arguments:JSON.stringify({questions:[{id:'choice:1',question:'Choose output language',options:[{label:'English'}]}]})}},
      {type:'response_item',timestamp:at,payload:{type:'function_call',call_id:'spawn:1',name:'spawn_agent',arguments:JSON.stringify({model:'requested-child-model',task_name:'worker'})}},
      {type:'response_item',timestamp:at,payload:{type:'function_call_output',call_id:'question:1',output:JSON.stringify({answers:{'choice:1':'English api_key=fixture-private'}})}}];
    await fs.appendFile(f.files[0],lines.map(o=>JSON.stringify(o)).join('\n')+'\n');
    const st=await fs.stat(f.files[0]);const snapshot=f.adapter.ingest({path:f.files[0],size:st.size,mtimeMs:st.mtimeMs})!.toSnapshot();
    assert.equal(snapshot.facts?.nativeInputs?.[0].requestClass,'ORDINARY_INPUT');assert.equal(snapshot.facts?.nativeInputs?.[0].state,'ANSWER_RECEIVED');
    assert.doesNotMatch(snapshot.facts!.nativeInputs![0].answer!,/fixture-private/);
    assert.equal(snapshot.facts?.requestedTrace?.[0].model,'requested-child-model');assert.equal(snapshot.model,'gpt-6');
    const acc=new SessionAccumulator('claude','native-unknown','fixture.jsonl');acc.nativeRequest('permission:1',{questions:[{question:'Permit write'}]},'permission_request',1);acc.nativeAnswer('permission:1','SECURITY_RESULT_PRIVATE',2);
    acc.nativeRequest('question:2',{questions:[{question:'Language?'}]},'AskUserQuestion',3);
    const unknown=acc.toSnapshot(),ref=sessionRef(unknown,new Set([unknown.key]));assert.equal(ref.model.value,null);
    const observation=observeSession(unknown,ref);assert.equal(observation.process.alive,null);assert.equal(observation.nativeInputs[0].answer,null);
    assert.equal(observation.nativeInputs[1].requestClass,'ORDINARY_INPUT');assert.equal(observation.metrics.usage,null);
    assert.equal(observation.nativeInputs[1].questions[0].id,null);
    assert.equal(observation.goal.observed,null);
    acc.nativeGoalRequest('goal:1','create_goal',undefined,4);assert.equal(acc.toSnapshot().facts?.nativeGoal?.observed,null);
    acc.nativeGoalResult('goal:1',{goal:{status:'active',threadId:'thread:fixture'}},5);assert.equal(acc.toSnapshot().facts?.nativeGoal?.observed,'active');
  }finally{await fs.rm(f.temp,{recursive:true,force:true});}
});

test('scoped event pages deduplicate, isolate other sessions, recover gaps and reject stale epochs',async()=>{
  const f=await cockpitFixture();
  try {
    const policy=new ScopePolicy();policy.set(f.grant);let changed=()=>{};
    const facade=new CockpitFacade({all:()=>f.snapshots,opts:{historyDays:3},onDidChange:fn=>{changed=fn;return{dispose(){}};}},policy,{open(){},async openSource(){}},new IncrementalExporter([f.adapter]));
    const r={requestId:'event:fixture',scope:f.grant.scope,epoch:policy.epoch,generation:'generation:1'};
    assert.equal((await facade.api.getEventPage(r)).data.nextSequence,0);
    changed();f.snapshots[1].title='unrelated changed';changed();assert.equal((await facade.api.getEventPage(r)).data.nextSequence,0);
    for(let i=0;i<270;i++){f.snapshots[0].diagnostics=['distinct-error-'+i];changed();}
    const page=await facade.api.getEventPage({...r,afterSequence:0,limit:3});assert.equal(page.state,'STALE');assert.equal(page.data.gap,true);assert.equal(page.data.events.length,3);assert.equal(page.data.oldestSequence,15);
    assert.equal(page.generation,'generation:1');assert.ok(page.data.events.every(e=>e.scopeHash===page.scopeHash));
    const continued=await facade.api.getEventPage({...r,afterSequence:page.data.nextSequence,limit:500});assert.equal(continued.data.events.length,253);
    policy.clear();policy.set(f.grant);assert.equal((await facade.api.getObservation(r)).state,'DENIED');assert.equal((await facade.api.getEventPage(r)).state,'DENIED');
    facade.dispose();
  }finally{await fs.rm(f.temp,{recursive:true,force:true});}
});

test('ContextRef preserves exact scope/return target; ordinary drafts cannot answer security prompts',async()=>{
  const f=await cockpitFixture();
  try {
    const policy=new ScopePolicy();policy.set(f.grant);const opened:unknown[]=[];
    const acc=new SessionAccumulator('codex',f.snapshots[0].sessionId,f.files[0]);
    acc.nativeRequest('q:ordinary',{questions:[{id:'language',question:'Choose language'}]},'request_user_input',1);
    acc.nativeRequest('q:security',{questions:[{id:'permit',question:'Approve access'}]},'permission_request',2);
    f.snapshots[0].facts=acc.toSnapshot().facts;
    const facade=new CockpitFacade({all:()=>f.snapshots,opts:{historyDays:3},onDidChange:()=>({dispose(){}})},policy,{open:(_v,_g,_id,c)=>{opened.push(c);},async openSource(){}},new IncrementalExporter([f.adapter]));
    const r={requestId:'context:1',scope:f.grant.scope};
    const context={organizationId:'local',privacyDomainId:'fixture',projectId:'fixture',repoId:repoId(f.repo),hostId:localHost().hostId,worktreeId:null,revision:null,selectedItemId:f.snapshots[0].key,returnToken:'pm:task:7'};
    assert.equal((await facade.api.revealContext({...r,context})).data.returnToken,'pm:task:7');assert.deepEqual(opened,[context]);
    assert.equal((await facade.api.revealContext({...r,context:{...context,projectId:'other-client'}})).state,'DENIED');
    assert.equal((await facade.api.revealContext({...r,context:{...context,revision:'badbeef'}})).state,'DENIED');
    const draft=await facade.api.prepareReply({...r,sessionId:f.snapshots[0].key,questionId:'q:ordinary',text:'English'});assert.equal(draft.data.transport,'MANUAL_COPY');assert.equal(draft.data.sent,false);
    assert.equal((await facade.api.prepareReply({...r,sessionId:f.snapshots[0].key,questionId:'q:security',text:'approve'})).state,'DENIED');
    const data={sessions:f.snapshots,providers:[],events:[],now:Date.now(),ternAvailable:false};assert.deepEqual(compactSessions(data,{view:'compact',opts:{'compact-scope':'project'}}),[]);
    assert.match(renderCompact({...data,cockpitInputs:{contexts:[],acceptedWork:[],assets:[],panelContext:{valid:false,projectId:'fixture'}}},{view:'compact'}),/No fallback to All/);
    facade.dispose();
  }finally{await fs.rm(f.temp,{recursive:true,force:true});}
});
