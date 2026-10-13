import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { CockpitFacade } from '../src/cockpit/facade';
import { digest, makeGrant, ScopePolicy } from '../src/cockpit/policy';
import { IncrementalExporter } from '../src/export/incremental';
import { clean, readTranscript } from '../src/providers/transcript';
import { ClaudeAdapter } from '../src/providers/claude/claude';
import { cockpitFixture } from './cockpitFixture';

const row=(value:unknown)=>JSON.stringify(value)+'\n';
const prompt=(text:string)=>({type:'event_msg',payload:{type:'user_message',message:text}});
const reply=(text:string)=>({type:'event_msg',payload:{type:'agent_message',message:text}});
function host(f:Awaited<ReturnType<typeof cockpitFixture>>) {
  const policy=new ScopePolicy();policy.set(f.grant);
  const facade=new CockpitFacade({all:()=>f.snapshots,opts:{historyDays:3},onDidChange:()=>({dispose(){}})},policy,{open:()=>{},openSource:async()=>{}},new IncrementalExporter([f.adapter]));
  const request={requestId:'reviewed-turn',scope:f.grant.scope,sessionId:f.snapshots[0].key,exactPrompt:'Read the synthetic README.'};
  return {policy,facade,request};
}

test('Codex evidence captures a genuine exact turn with redacted replies, excludes tools/reasoning/other turns',async()=>{
  const f=await cockpitFixture();const h=host(f);
  try{
    await fs.appendFile(f.files[0],row(prompt(h.request.exactPrompt))+row({type:'response_item',payload:{type:'reasoning',summary:[{type:'summary_text',text:'PRIVATE_REASONING'}]}})+row({type:'response_item',payload:{type:'function_call',name:'exec_command',arguments:JSON.stringify({command:'PRIVATE_TOOL'})}})+row(reply('Summary api_key=PRIVATE_SECRET_VALUE'))+row(prompt('Unrelated next task'))+row(reply('PRIVATE_OTHER_TASK')));
    const result=await h.facade.api.getSessionEvidence(h.request);
    assert.equal(result.state,'OK');assert.equal(result.data?.state,'PROVIDER_OBSERVED');assert.equal(result.data?.promptMatch,'EXACT');
    assert.equal(result.data?.nativeId,f.snapshots[0].sessionId);assert.equal(result.data?.session.id,h.request.sessionId);assert.equal(result.data?.session.model.value,'gpt-6');
    assert.equal(result.data?.promptHash,digest(clean(h.request.exactPrompt)));assert.equal(result.data?.resultHash,digest(result.data?.resultText));assert.match(result.data?.resultText ?? '',/Summary/);
    assert.doesNotMatch(JSON.stringify(result),/PRIVATE_SECRET_VALUE|PRIVATE_REASONING|PRIVATE_TOOL|PRIVATE_OTHER_TASK|artifactPath|rollout-/);
    assert.match(result.data?.sourceHash ?? '',/^[a-f0-9]{64}$/);
    const capability=await h.facade.api.capabilities();assert.ok(capability.data.some(c=>c.name==='getSessionEvidence'));
    result.data!.resultText='consumer-mutated';assert.notEqual((await h.facade.api.getSessionEvidence(h.request)).data?.resultText,'consumer-mutated');
  }finally{h.facade.dispose();await fs.rm(f.temp,{recursive:true,force:true});}
});

test('selected source without exact prompt or with repeated prompt has no result; exact pending turn is native-visible-only',async()=>{
  const f=await cockpitFixture();const h=host(f);
  try{
    let result=await h.facade.api.getSessionEvidence(h.request);
    assert.equal(result.state,'PARTIAL');assert.equal(result.data?.promptMatch,'ABSENT');assert.equal(result.data?.state,'UNAVAILABLE');assert.equal(result.data?.resultHash,null);
    await fs.appendFile(f.files[0],row(prompt(h.request.exactPrompt)));
    result=await h.facade.api.getSessionEvidence(h.request);assert.equal(result.data?.promptMatch,'EXACT');assert.equal(result.data?.state,'NATIVE_VISIBLE_ONLY');assert.equal(result.data?.resultText,'');
    await fs.appendFile(f.files[0],row(reply('First response'))+row(prompt(h.request.exactPrompt))+row(reply('Second response')));
    result=await h.facade.api.getSessionEvidence(h.request);assert.equal(result.data?.promptMatch,'AMBIGUOUS');assert.equal(result.data?.state,'UNAVAILABLE');assert.equal(result.data?.resultText,'');assert.equal(result.data?.promptHash,null);
  }finally{h.facade.dispose();await fs.rm(f.temp,{recursive:true,force:true});}
});

test('oversized or normalized-expansion prompts cannot certify an exact truncated prefix',async()=>{
  const f=await cockpitFixture();const h=host(f);
  try{
    const long='README '.repeat(900),expanded=('api_key=x ').repeat(500);
    for(const exactPrompt of [long,expanded]){
      await fs.appendFile(f.files[0],row(prompt(exactPrompt))+row(reply('BOUNDED_PREFIX_MUST_NOT_CERTIFY')));
      const result=await h.facade.api.getSessionEvidence({...h.request,exactPrompt});assert.equal(result.state,'PARTIAL');assert.equal(result.data?.state,'UNAVAILABLE');assert.equal(result.data?.promptHash,null);assert.equal(result.data?.resultText,'');assert.match(result.data?.omissions.join(' ') ?? '',/6000-character/);
    }
  }finally{h.facade.dispose();await fs.rm(f.temp,{recursive:true,force:true});}
});

test('scope revocation and nonexistent/unreviewed sessions cannot expose evidence',async()=>{
  const f=await cockpitFixture();const h=host(f);
  try{
    await fs.appendFile(f.files[0],row(prompt(h.request.exactPrompt))+row(reply('Scoped response')));
    for(const sessionId of ['codex:missing',f.snapshots[1].key]){const result=await h.facade.api.getSessionEvidence({...h.request,sessionId});assert.equal(result.state,'DENIED');assert.equal(result.data,null);}
    const pending=h.facade.api.getSessionEvidence(h.request);h.policy.clear();
    const denied=await pending;assert.equal(denied.state,'DENIED');assert.equal(denied.data,null);assert.doesNotMatch(JSON.stringify(denied),/Scoped response/);
    h.policy.set(f.grant);assert.equal((await h.facade.api.getSessionEvidence({...h.request,epoch:0})).state,'DENIED');
    f.snapshots[0].sessionId='PRIVATE_INVALID_NATIVE_ID\n';const invalid=await h.facade.api.getSessionEvidence(h.request);assert.equal(invalid.state,'DENIED');assert.equal(invalid.data,null);assert.doesNotMatch(JSON.stringify(invalid),/PRIVATE_INVALID_NATIVE_ID/);
  }finally{h.facade.dispose();await fs.rm(f.temp,{recursive:true,force:true});}
});

test('literal provider identity and cwd must match; malformed, oversized and linked sources stay unavailable',async()=>{
  const f=await cockpitFixture();const h=host(f);
  try{
    const original=await fs.readFile(f.files[0],'utf8');
    await fs.writeFile(f.files[0],original.replace(f.snapshots[0].sessionId,f.snapshots[1].sessionId)+row(prompt(h.request.exactPrompt))+row(reply('MISMATCHED_PRIVATE')));
    let result=await h.facade.api.getSessionEvidence(h.request);assert.equal(result.data?.state,'UNAVAILABLE');assert.equal(result.data?.resultText,'');
    await fs.writeFile(f.files[0],original.replace(JSON.stringify(f.repo),JSON.stringify(path.join(f.temp,'other')))+row(prompt(h.request.exactPrompt))+row(reply('MISMATCHED_PRIVATE')));
    result=await h.facade.api.getSessionEvidence(h.request);assert.equal(result.data?.state,'UNAVAILABLE');assert.equal(result.data?.resultText,'');
    await fs.writeFile(f.files[0],original+row(prompt(h.request.exactPrompt))+row(reply('MALFORMED_PRIVATE'))+'{bad\n');
    result=await h.facade.api.getSessionEvidence(h.request);assert.equal(result.data?.state,'UNAVAILABLE');assert.equal(result.data?.resultText,'');
    await fs.writeFile(f.files[0],original+row(prompt(h.request.exactPrompt))+row(reply('INCOMPLETE_PRIVATE'))+JSON.stringify(prompt(h.request.exactPrompt)));
    result=await h.facade.api.getSessionEvidence(h.request);assert.equal(result.data?.state,'UNAVAILABLE');assert.equal(result.data?.resultText,'');
    await fs.writeFile(f.files[0],' '.repeat(5*1024*1024+1));result=await h.facade.api.getSessionEvidence(h.request);assert.equal(result.data?.state,'UNAVAILABLE');
    const linked=path.join(f.temp,'linked');await fs.symlink(path.dirname(f.files[0]),linked,process.platform==='win32'?'junction':'dir');f.snapshots[0].artifactPath=path.join(linked,path.basename(f.files[0]));
    result=await h.facade.api.getSessionEvidence(h.request);assert.equal(result.data?.state,'UNAVAILABLE');assert.match(result.data?.omissions.join(' ') ?? '',/unsafe/);
  }finally{h.facade.dispose();await fs.rm(f.temp,{recursive:true,force:true});}
});

test('fresh evidence reparses same-size rewritten sources and fails closed on concurrent store remapping',async()=>{
  const f=await cockpitFixture();const h=host(f);
  try{
    const original=await fs.readFile(f.files[0],'utf8'),text=original+row(prompt(h.request.exactPrompt))+row(reply('Old reply'));
    await fs.writeFile(f.files[0],text);const first=await h.facade.api.getSessionEvidence(h.request);assert.equal(first.data?.resultText,'Old reply');
    await fs.writeFile(f.files[0],text.replace('Old reply','New reply'));const second=await h.facade.api.getSessionEvidence(h.request);assert.equal(second.data?.resultText,'New reply');assert.notEqual(first.data?.sourceHash,second.data?.sourceHash);
    const cached=readTranscript(f.files[0],'codex');const isolated=readTranscript(f.files[0],'codex',{fresh:true});
    assert.notEqual(isolated.entries,cached.entries,'fresh capture has independent state');assert.equal(readTranscript(f.files[0],'codex').entries,cached.entries,'fresh capture preserves the normal transcript cache');
    const pending=h.facade.api.getSessionEvidence(h.request);f.snapshots[0].artifactPath=f.files[1];const denied=await pending;assert.equal(denied.state,'DENIED');assert.equal(denied.data,null);
  }finally{h.facade.dispose();await fs.rm(f.temp,{recursive:true,force:true});}
});

test('existing Claude reader returns only redacted reply blocks for a genuine recorded session and prompt',async()=>{
  const f=await cockpitFixture();let facade:CockpitFacade|undefined;
  try{
    const id='33333333-3333-4333-8333-333333333333',dir=path.join(f.claudeHome,'projects','fixture-repo'),file=path.join(dir,id+'.jsonl'),exactPrompt='Read README api_key=PRIVATE_PROMPT_SECRET';
    await fs.mkdir(dir,{recursive:true});
    const common={sessionId:id,cwd:f.repo,timestamp:'2026-10-13T10:00:00Z'};
    await fs.writeFile(file,[{...common,type:'user',message:{role:'user',content:exactPrompt}},{...common,type:'assistant',uuid:'reply-one',message:{role:'assistant',model:'claude-fixture',content:[{type:'thinking',thinking:'PRIVATE_CLAUDE_REASONING'},{type:'tool_use',id:'tool-one',name:'Bash',input:{command:'PRIVATE_CLAUDE_TOOL'}},{type:'text',text:'Claude README summary api_key=PRIVATE_CLAUDE_SECRET'}]}}].map(row).join(''));
    const adapter=new ClaudeAdapter(f.claudeHome),stat=await fs.stat(file),snapshot=adapter.ingest({path:file,size:stat.size,mtimeMs:stat.mtimeMs})!.toSnapshot();
    const grant=makeGrant({id:'claude:test',organization:'local',project:'fixture',privacy:'fixture',sessions:[snapshot],configuration:false,exportConsent:false}),policy=new ScopePolicy();policy.set(grant);
    facade=new CockpitFacade({all:()=>[snapshot],opts:{historyDays:3},onDidChange:()=>({dispose(){}})},policy,{open:()=>{},openSource:async()=>{}},new IncrementalExporter([adapter]));
    const result=await facade.api.getSessionEvidence({requestId:'claude-review',scope:grant.scope,sessionId:snapshot.key,exactPrompt});
    assert.equal(result.state,'OK');assert.equal(result.data?.nativeId,id);assert.equal(result.data?.session.provider,'claude');assert.equal(result.data?.promptHash,digest(clean(exactPrompt)));assert.match(result.data?.resultText ?? '',/Claude README summary/);
    assert.doesNotMatch(JSON.stringify(result),/PRIVATE_PROMPT_SECRET|PRIVATE_CLAUDE_SECRET|PRIVATE_CLAUDE_TOOL|PRIVATE_CLAUDE_REASONING/);
  }finally{facade?.dispose();await fs.rm(f.temp,{recursive:true,force:true});}
});
