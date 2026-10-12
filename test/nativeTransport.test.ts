import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { NativeTaskRunner, NativeTransportFacade, NativeSelection, NativeTaskInput, nativeHash, nativeLaunchArguments, nativeEnvironment, preflightNativeTransport, prepareNativeTask, captureNativeStartupManifest, nativeStartupReviewHash, nativeToolPolicy, NativePlatformVerifier, NativePlatformProof } from '../src/provider-kit';
import { canonicalJson } from '../src/galaxy';
import { ScopePolicy, digest, repoId } from '../src/cockpit/policy';
import { LocalGrant } from '../src/cockpit/policy';
import { Request } from '../src/cockpit/interfaces';
import { resolveExe } from '../src/git/git';

class FakeProcess extends EventEmitter {
  stdin=new PassThrough();stdout=new PassThrough();stderr=new PassThrough();kills=0;
  kill(){this.kills++;setImmediate(()=>this.emit('close',null,'SIGTERM'));return true;}
  record(value:unknown){this.stdout.write(JSON.stringify(value)+'\n');}
}
async function fixture(transport:NativeSelection['transport']='codex-app-server'){
  const fixtureRoot=path.join(process.cwd(),'.smoke','native-startup');await fs.mkdir(fixtureRoot,{recursive:true});const temp=await fs.mkdtemp(path.join(fixtureRoot,'fixture-'));
  const cwd=path.join(temp,'repo'),home=path.join(temp,'synthetic-home'),ledger=path.join(temp,'ledger');await fs.mkdir(cwd);await fs.mkdir(home);
  const selection:NativeSelection={transport,executable:process.execPath,executableSha256:createHash('sha256').update(await fs.readFile(process.execPath)).digest('hex'),nativeVersion:'fixture-only',cwd,home,hostId:'host:fixture',permission:'read-only',requestedIdentity:{model:'requested-model',effort:'high',accountId:null},startup:{reviewHash:nativeHash('fixture-startup'),configurationHash:nativeHash('empty-fixture'),hooks:'NONE',mcp:'NONE',managed:'NONE',isolated:true,supported:['initialize','thread/start','thread/resume','turn/start','turn/interrupt','exec','json','resume','sandbox','print','stream-json','restricted','tools','strict-mcp-config','mcp-config','permission-mode','input-format','include-partial-messages','verbose','disallowedTools','effort']}};
  const git=resolveExe('git');assert.ok(git);execFileSync(git,['-c','core.hooksPath=NUL','init'],{cwd,windowsHide:true,stdio:'ignore'});
  const key=generateKeyPairSync('ed25519'),publicKeyPem=key.publicKey.export({type:'spki',format:'pem'}).toString();
  const keys:NativePlatformVerifier[]=[{issuerId:'synthetic-verifier',publicKeyPem,fingerprint:createHash('sha256').update(key.publicKey.export({type:'spki',format:'der'})).digest('hex')}];
  const seal=async(s:NativeSelection)=>{const value=structuredClone(s),manifest=await captureNativeStartupManifest(value);value.startup.manifest=manifest;value.startup.configurationHash=manifest.manifestHash;
    const payload:NativePlatformProof['payload']={hostId:value.hostId,transport:value.transport,cwd:value.cwd,home:value.home,permission:value.permission,executableSha256:value.executableSha256,nativeVersion:value.nativeVersion,startupManifestHash:manifest.manifestHash,environmentHash:nativeHash(nativeEnvironment(value)),toolPolicyHash:nativeHash(nativeToolPolicy(value)),supportedCapabilities:value.startup.supported,managed:{state:'COMPLETE_NO_STARTUP_EFFECTS',sourceHash:nativeHash('synthetic-managed'),sourceRef:'fixture:managed'},ambient:{state:'DISABLED_OR_SEALED',sourceHash:nativeHash('synthetic-ambient'),sourceRef:'fixture:ambient'},isolation:{state:'ENFORCED',descendants:'ENFORCED',boundaryId:'fixture:fake-process-only',policyHash:nativeHash('synthetic-boundary')},issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()};
    value.startup.platformProof={schema:'datapass.native-platform-proof/1',issuerId:keys[0].issuerId,keyFingerprint:keys[0].fingerprint,payload,signature:sign(null,Buffer.from(canonicalJson(payload)),key.privateKey).toString('base64')};value.startup.reviewHash=nativeStartupReviewHash(value,manifest);return value;};
  Object.assign(selection,await seal(selection));
  const grant:LocalGrant={scope:{scopeId:'fixture',organizationIds:['org'],privacyDomainIds:['private'],projectIds:['project'],repoIds:[repoId(cwd)],sourceVectorHash:nativeHash('source'),policyHash:nativeHash('policy')},roots:[cwd],sessionKeys:[],configuration:true,exportConsent:false};
  const policy=new ScopePolicy();policy.set(grant);const request:Request={requestId:'fixture-request',scope:grant.scope,epoch:policy.epoch};
  const input:NativeTaskInput={selection,taskId:'fixture-task',text:'Synthetic bounded task',targetHash:nativeHash(cwd),permissionHash:nativeHash('read-only'),configHash:nativeHash('config'),presetHash:nativeHash('preset'),promptHash:nativeHash('prompt'),bindingHash:nativeHash('role-binding'),scopeHash:digest(grant.scope),configScopeHash:nativeHash('config-independent-scope')};
  return {temp,ledger,selection,input,policy,request,keys,seal,cleanup:()=>fs.rm(temp,{recursive:true,force:true})};
}
function fakeSpawn(process:FakeProcess,onInput?:(chunk:string)=>void){
  const launches:{executable:string;argv:string[];options:any}[]=[];
  const fn=((executable:string,argv:string[],options:any)=>{launches.push({executable,argv,options});if(onInput)process.stdin.on('data',b=>onInput(b.toString()));setImmediate(()=>process.emit('spawn'));return process;}) as unknown as typeof spawn;
  return {fn,launches};
}
function appProtocol(process:FakeProcess,options:{fail?:boolean;security?:boolean;resume?:string}={}){
  const messages:any[]=[];
  const fake=fakeSpawn(process,chunk=>{for(const line of chunk.trim().split('\n')){const m=JSON.parse(line);messages.push(m);
    if(m.id===0)process.record({id:0,result:{userAgent:'fixture'}});
    if(m.id===1)process.record({id:1,result:{thread:{id:options.resume??'owned-session'},model:'native-reported-model'}});
    if(m.id===2){process.record({id:2,result:{turn:{id:'owned-turn',status:'inProgress'}}});
      if(options.security){process.record({id:99,method:'item/permissions/requestApproval',params:{threadId:'owned-session',turnId:'owned-turn'}});continue;}
      process.record({method:'item/agentMessage/delta',params:{threadId:'owned-session',turnId:'owned-turn',delta:'sk-proj-PARTIAL_SECRET_FRAGMENT'}});
      process.record({method:'item/completed',params:{threadId:'outside-session',turnId:'owned-turn',item:{type:'agentMessage',text:'EXCLUDED_OUTSIDE_SESSION'}}});
      process.record({method:'item/completed',params:{threadId:'owned-session',turnId:'owned-turn',item:{type:'reasoning',text:'HIDDEN_REASONING'}}});
      process.record({method:'item/completed',params:{threadId:options.resume??'owned-session',turnId:'owned-turn',item:{type:'agentMessage',text:'Fixture result api_key=PRIVATE_CREDENTIAL_VALUE'}}});
      process.record({method:'turn/completed',params:{threadId:options.resume??'owned-session',turn:{id:'owned-turn',status:options.fail?'failed':'completed'}}});
    }
  }});
  return {...fake,messages};
}

test('native preflight is inert and exact binary/startup/capability mismatches block',async()=>{
  const f=await fixture();try{
    assert.equal((await preflightNativeTransport(f.selection,f.keys)).state,'READY');
    for(const change of [{executableSha256:'0'.repeat(64)},{startup:{...f.selection.startup,isolated:false}},{startup:{...f.selection.startup,supported:[]}}])assert.equal((await preflightNativeTransport({...f.selection,...change},f.keys)).state,'BLOCKED');
    await assert.rejects(preflightNativeTransport({...f.selection,cwd:'relative'}),/Invalid/);
    const a=prepareNativeTask(f.input),b=prepareNativeTask({...f.input,text:'changed exact input'});assert.notEqual(a.preparedHash,b.preparedHash);
    for(const key of ['targetHash','permissionHash','configHash','presetHash','promptHash','bindingHash','scopeHash','configScopeHash'] as const)assert.notEqual(a.preparedHash,prepareNativeTask({...f.input,[key]:nativeHash('changed')}).preparedHash);
  }finally{await f.cleanup();}
});
test('native commands have no caller shell/argv/env or credential inheritance',async()=>{
  const f=await fixture();try{for(const transport of ['codex-app-server','codex-cli','claude-cli'] as const){const task=prepareNativeTask({...f.input,text:'$(write unsafe) `danger` ; &',selection:{...f.selection,transport}}),args=nativeLaunchArguments(task);assert.ok(!args.some(a=>a.includes('danger')||a.includes('write unsafe')));assert.doesNotMatch(args.join(' '),/dangerously|full-auto|bypassPermissions|--last(?:\s|$)|--all(?:\s|$)/);assert.equal(nativeEnvironment(task.selection).PATH,undefined);assert.equal(nativeEnvironment(task.selection).OPENAI_API_KEY,undefined);} }finally{await f.cleanup();}
});
test('owned app-server handshake, exact task, sanitized streams, completed ledger and duplicate refusal',async()=>{
  const f=await fixture();try{
    const process=new FakeProcess(),fake=appProtocol(process),runner=new NativeTaskRunner(f.ledger,fake.fn,()=>f.keys),task=prepareNativeTask(f.input);
    await assert.rejects(runner.start(task,'0'.repeat(64)),/approval/);assert.equal(fake.launches.length,0);
    const handle=await runner.start(task,task.preparedHash),events:unknown[]=[];handle.subscribe(e=>events.push(e));const result=await handle.result;
    assert.equal(result.state,'COMPLETED');assert.equal(result.sessionId,'owned-session');assert.equal(result.turnId,'owned-turn');assert.equal(result.evidence,'NATIVE_REPORTED');
    assert.equal(result.requestedIdentity.model,'requested-model');assert.equal(result.observedIdentity.model,'native-reported-model');assert.equal(result.observedIdentity.accountId,null);
    assert.match(result.resultText,/\[REDACTED\]/);assert.doesNotMatch(JSON.stringify(events),/PRIVATE_|PARTIAL_SECRET|HIDDEN_REASONING|EXCLUDED_OUTSIDE/);
    assert.equal(fake.messages.find(m=>m.method==='turn/start').params.input[0].text,f.input.text);
    assert.deepEqual(fake.messages.slice(0,3).map(m=>m.method),['initialize','initialized','thread/start']);
    assert.equal(fake.launches[0].options.shell,false);assert.equal(fake.launches[0].options.windowsHide,true);
    assert.deepEqual(await runner.lookup(task.taskId),result);await assert.rejects(runner.start(task,task.preparedHash),/EEXIST/);assert.equal(fake.launches.length,1);
  }finally{await f.cleanup();}
});
test('native failure/security refusal cannot become success or approval',async()=>{
  for(const options of [{fail:true},{security:true}]){const f=await fixture();try{const process=new FakeProcess(),fake=appProtocol(process,options),task=prepareNativeTask(f.input),runner=new NativeTaskRunner(f.ledger,fake.fn,()=>f.keys),result=await (await runner.start(task,task.preparedHash)).result;assert.equal(result.state,options.security?'INTERRUPTED':'FAILED');assert.equal(result.evidence,'NO_COMPLETION_EVIDENCE');if(options.security)assert.ok(fake.messages.some(m=>m.id===99&&m.error));}finally{await f.cleanup();}}
});
test('uncertain durable intent blocks blind retries and reload does not claim stopped',async()=>{
  const f=await fixture();try{const process=new FakeProcess(),fake=fakeSpawn(process),runner=new NativeTaskRunner(f.ledger,fake.fn,()=>f.keys),task=prepareNativeTask(f.input),h=await runner.start(task,task.preparedHash);await new Promise(r=>setTimeout(r,30));const recovered=await new NativeTaskRunner(f.ledger,fake.fn,()=>f.keys).lookup(task.taskId);assert.equal(recovered?.state,'UNCERTAIN');await assert.rejects(new NativeTaskRunner(f.ledger,fake.fn,()=>f.keys).start(task,task.preparedHash),/EEXIST/);await h.cancel();assert.equal((await h.result).state,'INTERRUPTED');}finally{await f.cleanup();}
});
test('owned completed session can resume; changed target/permission/Config binding cannot',async()=>{
  const f=await fixture();try{const first=new FakeProcess(),fake1=appProtocol(first),runner=new NativeTaskRunner(f.ledger,fake1.fn,()=>f.keys),task=prepareNativeTask(f.input);await (await runner.start(task,task.preparedHash)).result;
    const next=prepareNativeTask({...f.input,taskId:'resume-task',resumeFromTaskId:task.taskId,text:'Reviewed ordinary follow-up',promptHash:nativeHash('new exact reviewed follow-up prompt')});
    const second=new FakeProcess(),fake2=appProtocol(second,{resume:'owned-session'}),resumer=new NativeTaskRunner(f.ledger,fake2.fn,()=>f.keys),r=await (await resumer.start(next,next.preparedHash)).result;assert.equal(r.state,'COMPLETED');assert.equal(fake2.messages.find(m=>m.id===1).method,'thread/resume');assert.equal(fake2.messages.find(m=>m.id===1).params.threadId,'owned-session');
    const changed=prepareNativeTask({...f.input,taskId:'changed-resume',resumeFromTaskId:task.taskId,permissionHash:nativeHash('wider')});await assert.rejects(resumer.start(changed,changed.preparedHash),/unchanged reviewed/);
    await assert.rejects(resumer.cancel('unowned-task'),/owned/);
  }finally{await f.cleanup();}
});
for(const transport of ['codex-cli','claude-cli'] as const)test(`${transport} requires native completion AND zero exit; requested identity never inferred`,async()=>{
  for(const exit of [0,1]){const f=await fixture(transport);try{const process=new FakeProcess(),fake=fakeSpawn(process,()=>{
    if(transport==='codex-cli'){process.record({type:'thread.started',thread_id:'cli-session'});process.record({type:'item.completed',item:{type:'agent_message',text:'safe result'}});process.record({type:'turn.completed',usage:{input_tokens:12}});}
    else{process.record({type:'system',subtype:'init',session_id:'cli-session',model:'actual-model'});process.record({type:'result',subtype:'success',is_error:false,session_id:'cli-session',result:'safe result'});}
    setImmediate(()=>process.emit('close',exit,null));
  }),runner=new NativeTaskRunner(f.ledger,fake.fn,()=>f.keys),task=prepareNativeTask(f.input),result=await(await runner.start(task,task.preparedHash)).result;assert.equal(result.state,exit===0?'COMPLETED':'FAILED');assert.equal(result.observedIdentity.effort,null);assert.equal(result.observedIdentity.accountId,null);if(transport==='codex-cli')assert.equal(result.observedIdentity.model,null);
  }finally{await f.cleanup();}}
});
test('host facade requires independent exact approval, scope/epoch guards and own Config role association',async()=>{
  const f=await fixture();try{const process=new FakeProcess(),fake=appProtocol(process),runner=new NativeTaskRunner(f.ledger,fake.fn,()=>f.keys);let approvals=0;const facade=new NativeTransportFacade(runner,f.policy,f.selection.hostId,async()=>{approvals++;return true;}),api=facade.api;
    const task=await api.prepare(f.request,f.input);await assert.rejects(api.start(f.request,{taskId:task.taskId,preparedHash:task.preparedHash}),/approval/);assert.equal(fake.launches.length,0);
    assert.equal((await api.getRoleRuntime({bindingHash:f.input.bindingHash,scopeHash:f.input.configScopeHash})).state,'UNKNOWN');
    await api.review(f.request,task.preparedHash);await api.start(f.request,{taskId:task.taskId,preparedHash:task.preparedHash});
    let done!:()=>void;const completed=new Promise<void>(resolve=>{done=resolve;});const subscription=await api.subscribe(f.request,{taskId:task.taskId},event=>{if(event.observation.state==='COMPLETED')done();});if((await api.lookup(f.request,{taskId:task.taskId}))?.state==='COMPLETED')done();await completed;subscription.dispose();
    const runtime=await api.getRoleRuntime({bindingHash:f.input.bindingHash,scopeHash:f.input.configScopeHash});assert.equal(runtime.state,'STOPPED');assert.equal(runtime.nativeSessionId,'owned-session');assert.ok(runtime.nativeReceiptRef);assert.equal(approvals,1);
    assert.equal((await api.getRoleRuntime({bindingHash:f.input.bindingHash,scopeHash:f.input.scopeHash})).state,'UNKNOWN','independent producer hashes must not be inferred equal');
    await assert.rejects(api.lookup({...f.request,scope:{...f.request.scope,projectIds:['excluded']}},{taskId:task.taskId}),/scope/);
    f.policy.clear();assert.equal((await api.getRoleRuntime({bindingHash:f.input.bindingHash,scopeHash:f.input.configScopeHash})).state,'UNKNOWN');await assert.rejects(api.lookup(f.request,{taskId:task.taskId}),/scope/);
  }finally{await f.cleanup();}
});

test('empty owned project receives a separate reviewed execution scope; Git/root/revision and trust are verified',async()=>{
  const f=await fixture();try{
    const git=resolveExe('git');assert.ok(git,'Mandatory Git scope test requires installed Git.');
    const run=(...args:string[])=>execFileSync(git,['-c','core.hooksPath=NUL','-c','core.fsmonitor=false','-c','user.name=Native Fixture','-c','user.email=fixture@example.invalid',...args],{cwd:f.selection.cwd,windowsHide:true,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
    run('init');await fs.writeFile(path.join(f.selection.cwd,'README.md'),'Synthetic native scope fixture\n');run('add','README.md');run('commit','-m','Synthetic scope baseline');run('remote','add','origin','https://github.com/fixture/native-empty-repo.git');
    const input={organizationId:'org',privacyDomainId:'private',projectId:'empty-project',repoId:'fixture/native-empty-repo',root:f.selection.cwd,revision:run('rev-parse','HEAD'),sourceVectorHash:nativeHash('source'),policyHash:nativeHash('policy')};
    f.policy.clear();let reviews=0;
    const api=new NativeTransportFacade(new NativeTaskRunner(f.ledger),f.policy,f.selection.hostId,async()=>false,()=>true,async()=>{reviews++;return true;}).api;
    await assert.rejects(api.reviewProjectScope({...input,revision:'0'.repeat(40)}),/revision changed/);
    await assert.rejects(api.reviewProjectScope({...input,repoId:'fixture/another-repo'}),/origin/);assert.equal(reviews,0);
    const approved=await api.reviewProjectScope(input);assert.equal(approved.approved,true);assert.ok(approved.scope);assert.ok(approved.scopeHash);assert.equal(f.policy.scopes().length,0,'No observer grant/session is manufactured');
    const request={requestId:'first-native-task',scope:approved.scope,epoch:approved.epoch};const task=await api.prepare(request,{...f.input,scopeHash:approved.scopeHash});
    await assert.rejects(api.start(request,{taskId:task.taskId,preparedHash:task.preparedHash}),/approval/);
    const untrusted=new NativeTransportFacade(new NativeTaskRunner(f.ledger),f.policy,f.selection.hostId,async()=>true,()=>false,async()=>true);
    await assert.rejects(untrusted.api.reviewProjectScope(input),/Trusted/);
    run('commit','--allow-empty','-m','Synthetic target change');await assert.rejects(api.prepare(request,{...f.input,scopeHash:approved.scopeHash}),/revision changed/);
    const renewed=await api.reviewProjectScope({...input,revision:run('rev-parse','HEAD')});assert.equal(renewed.scopeHash,approved.scopeHash,'Reviewed revision update retains canonical native scope');assert.notEqual(renewed.epoch,approved.epoch);
    assert.ok(renewed.scope);await api.prepare({requestId:'renewed-task',scope:renewed.scope,epoch:renewed.epoch},{...f.input,taskId:'renewed-task',scopeHash:renewed.scopeHash!});
    const other=await api.reviewProjectScope({...input,projectId:'second-view',revision:run('rev-parse','HEAD')});assert.ok(other.approved);await api.prepare({requestId:'original-still-valid',scope:renewed.scope,epoch:renewed.epoch},{...f.input,taskId:'original-still-valid',scopeHash:renewed.scopeHash!});
  }finally{await f.cleanup();}
});

test('durable native writer lease excludes same repo, linked worktrees and proven same-origin clones; uncertainty retains lease',async()=>{
  const f=await fixture();try{
    const git=resolveExe('git');assert.ok(git);const run=(cwd:string,...args:string[])=>execFileSync(git,['-c','core.hooksPath=NUL','-c','core.fsmonitor=false','-c','user.name=Native Fixture','-c','user.email=fixture@example.invalid',...args],{cwd,windowsHide:true,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
    run(f.selection.cwd,'init');await fs.writeFile(path.join(f.selection.cwd,'README.md'),'Synthetic writer fixture\n');run(f.selection.cwd,'add','README.md');run(f.selection.cwd,'commit','-m','Synthetic writer baseline');run(f.selection.cwd,'remote','add','origin','https://github.com/fixture/native-writer.git');
    const linked=path.join(f.temp,'linked-worktree'),clone=path.join(f.temp,'clone');run(f.selection.cwd,'worktree','add','-b','fixture-linked',linked);run(f.temp,'clone',f.selection.cwd,clone);run(clone,'remote','set-url','origin','https://github.com/fixture/native-writer.git');
    const process=new FakeProcess(),fake=fakeSpawn(process),runner=new NativeTaskRunner(f.ledger,fake.fn,()=>f.keys),task=prepareNativeTask({...f.input,selection:await f.seal({...f.selection,permission:'workspace-write'})}),live=await runner.start(task,task.preparedHash);
    for(const [i,cwd] of [f.selection.cwd,linked,clone].entries()){
      const other=prepareNativeTask({...f.input,taskId:'conflicting-writer-'+i,selection:await f.seal({...f.selection,cwd,permission:'workspace-write'})});
      await assert.rejects(new NativeTaskRunner(f.ledger,fake.fn,()=>f.keys).start(other,other.preparedHash),/canonical repository/);
    }
    assert.equal(fake.launches.length,1);await live.cancel();const cancelled=await live.result;assert.equal(cancelled.quiescence,'UNKNOWN');
    const after=prepareNativeTask({...f.input,taskId:'uncertain-writer-retry',selection:await f.seal({...f.selection,permission:'workspace-write'})});await assert.rejects(new NativeTaskRunner(f.ledger,fake.fn,()=>f.keys).start(after,after.preparedHash),/canonical repository/);
  }finally{await f.cleanup();}
});
test('proven native completed write releases lease for a newly reviewed owned task',async()=>{
  const f=await fixture();try{
    const git=resolveExe('git');assert.ok(git);const run=(...args:string[])=>execFileSync(git,['-c','core.hooksPath=NUL','-c','user.name=Fixture','-c','user.email=fixture@example.invalid',...args],{cwd:f.selection.cwd,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();run('init');await fs.writeFile(path.join(f.selection.cwd,'README.md'),'Synthetic settled writer\n');run('add','README.md');run('commit','-m','Synthetic baseline');run('remote','add','origin','https://github.com/fixture/native-settled-writer.git');
    for(const id of ['first-write','second-write']){const process=new FakeProcess(),fake=appProtocol(process),task=prepareNativeTask({...f.input,taskId:id,selection:await f.seal({...f.selection,permission:'workspace-write'})}),runner=new NativeTaskRunner(f.ledger,fake.fn,()=>f.keys),result=await(await runner.start(task,task.preparedHash)).result;assert.equal(result.state,'COMPLETED');assert.equal(result.quiescence,'NATIVE_TURN_SETTLED');}
  }finally{await f.cleanup();}
});

test('startup manifest missing/drifted config and untrusted/expired platform proof cannot create native process',async()=>{
  const f=await fixture();try{
    const valid=await preflightNativeTransport(f.selection,f.keys);assert.equal(valid.state,'READY');assert.equal(valid.verification.installed,'EXACT_BINARY_VERIFIED');assert.equal(valid.verification.configured,'LOCAL_MANIFEST_VERIFIED');assert.equal(valid.verification.authenticated,'UNKNOWN');assert.equal(valid.verification.working,'UNKNOWN');
    const missing=structuredClone(f.selection);delete missing.startup.manifest;assert.equal((await preflightNativeTransport(missing,f.keys)).state,'BLOCKED');
    assert.equal((await preflightNativeTransport(f.selection)).state,'BLOCKED','Caller cannot create trusted verifier authority');
    const expired=structuredClone(f.selection);expired.startup.platformProof!.payload.expiresAt=new Date(Date.now()-1).toISOString();assert.equal((await preflightNativeTransport(expired,f.keys)).state,'BLOCKED');
    await fs.writeFile(path.join(f.selection.home,'config.toml'),'model="changed-after-review"\n');const current=await captureNativeStartupManifest(f.selection);assert.notEqual(current.manifestHash,f.selection.startup.manifest!.manifestHash);
    assert.equal((await preflightNativeTransport(f.selection,f.keys)).state,'BLOCKED');
    const forged=structuredClone(f.selection);forged.startup.manifest=current;forged.startup.configurationHash=current.manifestHash;forged.startup.reviewHash=nativeStartupReviewHash(forged,current);assert.equal((await preflightNativeTransport(forged,f.keys)).state,'BLOCKED','Rehashing caller JSON cannot forge independent platform proof');
    const process=new FakeProcess(),fake=fakeSpawn(process),runner=new NativeTaskRunner(f.ledger,fake.fn,()=>f.keys),task=prepareNativeTask(f.input);await assert.rejects(runner.start(task,task.preparedHash),/startup blocked/);assert.equal(fake.launches.length,0);
  }finally{await f.cleanup();}
});
test('current hook/MCP/plugin/inherited coverage blocks; auth/history bytes are never part of the startup manifest',async()=>{
  const f=await fixture();try{
    const before=await captureNativeStartupManifest(f.selection);await fs.writeFile(path.join(f.selection.home,'auth.json'),'SECRET_AUTH_STORE_NEVER_READ');await fs.mkdir(path.join(f.selection.home,'sessions'));await fs.writeFile(path.join(f.selection.home,'sessions','private.jsonl'),'PRIVATE_HISTORY_NEVER_READ');
    const after=await captureNativeStartupManifest(f.selection);assert.equal(after.manifestHash,before.manifestHash);assert.doesNotMatch(JSON.stringify(after),/SECRET_AUTH|PRIVATE_HISTORY|auth\.json|private\.jsonl/);
    await fs.writeFile(path.join(f.selection.home,'config.toml'),'model="fixture"\n[hooks]\ncommand="unsafe-unreviewed"\n');const hook=await f.seal(f.selection);assert.equal((await preflightNativeTransport(hook,f.keys)).state,'BLOCKED');
    await fs.unlink(path.join(f.selection.home,'config.toml'));await fs.mkdir(path.join(f.selection.cwd,'.codex','plugins'),{recursive:true});await fs.writeFile(path.join(f.selection.cwd,'.codex','plugins','plugin.json'),'{}');const plugin=await f.seal(f.selection);assert.equal((await preflightNativeTransport(plugin,f.keys)).state,'BLOCKED');
    await fs.rm(path.join(f.selection.cwd,'.codex'),{recursive:true,force:true});await fs.mkdir(path.join(f.temp,'.codex'));await fs.writeFile(path.join(f.temp,'.codex','config.toml'),'model="inherited"');const inherited=await f.seal(f.selection);assert.equal(inherited.startup.manifest!.localState,'PARTIAL');assert.equal((await preflightNativeTransport(inherited,f.keys)).state,'BLOCKED');
  }finally{await f.cleanup();}
});
test('proof drift after intent/lease work is checked again immediately before process creation',async()=>{
  const f=await fixture();try{const process=new FakeProcess(),fake=fakeSpawn(process),runner=new NativeTaskRunner(f.ledger,fake.fn,()=>f.keys),original=runner.preflight.bind(runner);let checks=0;
    runner.preflight=async selection=>{const result=await original(selection);if(++checks===1)await fs.writeFile(path.join(selection.home,'hooks.json'),'{}');return result;};
    const task=prepareNativeTask(f.input),handle=await runner.start(task,task.preparedHash);assert.equal((await handle.result).state,'UNCERTAIN');assert.equal(fake.launches.length,0,'No native process on changed startup proof');assert.equal(checks,2);
  }finally{await f.cleanup();}
});

test('explicit Config mapped native tools are signed and never auto-approved; usability remains unknown',async()=>{
  const f=await fixture('claude-cli');try{
    const selected=await f.seal({...f.selection,permission:'workspace-write',nativeTools:{configToolRefs:['config:read','config:bash','config:agent'],toolNames:['Read','Bash','Agent']}});
    const check=await preflightNativeTransport(selected,f.keys);assert.equal(check.state,'READY');assert.equal(check.tools.policy,'MAPPED_REPORTED_UNPROBED');assert.deepEqual(check.tools.toolNames,['Read','Bash','Agent']);assert.equal(check.tools.working,'UNKNOWN');assert.equal(check.tools.humanApprovalRoundTrip,'UNSUPPORTED_CLI_MANUAL');
    const args=nativeLaunchArguments(prepareNativeTask({...f.input,selection:selected}));assert.equal(args[args.indexOf('--tools')+1],'Read,Bash,Agent');assert.ok(!args.includes('--allowedTools'));assert.equal(args[args.indexOf('--permission-mode')+1],'default');assert.doesNotMatch(args.join(' '),/bypassPermissions|dangerously-skip/);
    const drift=structuredClone(selected);drift.nativeTools!.toolNames.push('Write');assert.equal((await preflightNativeTransport(drift,f.keys)).state,'BLOCKED','Tool mapping must retain independently signed policy');
    const defaultCheck=await preflightNativeTransport(f.selection,f.keys);assert.equal(defaultCheck.tools.policy,'RESTRICTED_DEFAULT_UNPROBED');assert.ok(defaultCheck.limitations.some(s=>s.includes('no verified human')));
  }finally{await f.cleanup();}
});
