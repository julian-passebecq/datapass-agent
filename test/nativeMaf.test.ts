import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {spawn,execFileSync} from 'node:child_process';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {NativeTaskRunner,NativeSelection,prepareNativeTask,captureNativeStartupManifest,nativeStartupReviewHash,nativeEnvironment,nativeToolPolicy,nativeHash,MafRuntime,mafRuntimeHash,mafActionHash,verifyMafRuntime} from '../src/provider-kit';
import {canonicalJson} from '../src/galaxy';

class Child extends EventEmitter {
  stdin=new PassThrough();stdout=new PassThrough();stderr=new PassThrough();
  kill(){setImmediate(()=>this.emit('close',null,'SIGTERM'));return true;}
  emitRecord(value:unknown){this.stdout.write(JSON.stringify(value)+'\n');}
}
async function fixture(){
  const base=path.resolve('.smoke/maf');await fs.mkdir(base,{recursive:true});const root=await fs.mkdtemp(path.join(base,'fixture-'));
  const cwd=path.join(root,'repo'),home=path.join(root,'home'),site=path.join(root,'site'),ledger=path.join(root,'ledger'),worker=path.join(root,'worker.py');
  for(const p of [cwd,home,site])await fs.mkdir(p);
  const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
  await fs.writeFile(worker,'# Synthetic protocol only; never executed.\n');await fs.writeFile(path.join(site,'module.py'),'# Sealed fixture module.\n');
  const git=(args:string[])=>execFileSync('git',['-c','core.hooksPath=NUL',...args],{cwd,windowsHide:true,stdio:'ignore'});
  git(['init']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-m','Fixture']);git(['remote','add','origin','https://github.com/fixture/'+path.basename(root)+'.git']);
  const runtime:MafRuntime={schema:'datapass.maf-runtime/1',python:process.execPath,pythonSha256:sha(await fs.readFile(process.execPath)),worker,workerSha256:sha(await fs.readFile(worker)),sitePackages:site,files:[{path:'module.py',sha256:sha(await fs.readFile(path.join(site,'module.py')))}]};
  const selection:NativeSelection={transport:'maf-harness',mafRuntimeHash:mafRuntimeHash(runtime),executable:runtime.python,executableSha256:runtime.pythonSha256,nativeVersion:'agent-framework-core:1.23.0',cwd,home,hostId:'fixture:maf',permission:'workspace-write',requestedIdentity:{model:'offline-replay-v1',effort:null,accountId:null},startup:{reviewHash:nativeHash('placeholder'),configurationHash:nativeHash('placeholder'),hooks:'NONE',mcp:'NONE',managed:'NONE',isolated:true,supported:['maf/1','exact-tool-approval','offline-replay','owned-process']}};
  const key=generateKeyPairSync('ed25519'),fingerprint=sha(key.publicKey.export({type:'spki',format:'der'}));
  const keys=[{issuerId:'fixture-only',fingerprint,publicKeyPem:key.publicKey.export({type:'spki',format:'pem'}).toString()}];
  const manifest=await captureNativeStartupManifest(selection);selection.startup.manifest=manifest;selection.startup.configurationHash=manifest.manifestHash;
  const payload={hostId:selection.hostId,transport:selection.transport,cwd,home,permission:selection.permission,executableSha256:selection.executableSha256,nativeVersion:selection.nativeVersion,startupManifestHash:manifest.manifestHash,environmentHash:nativeHash(nativeEnvironment(selection)),toolPolicyHash:nativeHash(nativeToolPolicy(selection)),supportedCapabilities:selection.startup.supported,managed:{state:'COMPLETE_NO_STARTUP_EFFECTS' as const,sourceHash:nativeHash('synthetic'),sourceRef:'fixture:managed'},ambient:{state:'DISABLED_OR_SEALED' as const,sourceHash:nativeHash('synthetic'),sourceRef:'fixture:ambient'},isolation:{state:'ENFORCED' as const,descendants:'ENFORCED' as const,boundaryId:'fixture:fake-child',policyHash:nativeHash('synthetic')},issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()};
  selection.startup.platformProof={schema:'datapass.native-platform-proof/1',issuerId:keys[0].issuerId,keyFingerprint:fingerprint,payload,signature:sign(null,Buffer.from(canonicalJson(payload)),key.privateKey).toString('base64')};selection.startup.reviewHash=nativeStartupReviewHash(selection,manifest);
  const input={selection,taskId:'maf-task',text:'Exact action',mafAction:{tool:'write_artifact' as const,filename:'result.txt',content:'Synthetic'},targetHash:nativeHash(cwd),permissionHash:nativeHash('workspace-write'),configHash:nativeHash('config'),presetHash:nativeHash('preset'),promptHash:nativeHash('prompt'),bindingHash:nativeHash('binding'),scopeHash:nativeHash('scope'),configScopeHash:nativeHash('config-scope')};
  return {root,ledger,site,runtime,keys,input};
}

for(const mode of ['foreign-session','stale-preparation','foreign-action','duplicate-approval','eof'])test('MAF '+mode+' cannot create a completed receipt or authorize another effect',async()=>{
  const f=await fixture(),child=new Child(),sent:any[]=[];let runner:NativeTaskRunner|undefined;
  try{
    const fake=((exe:string,args:string[],options:any)=>{
      assert.equal(exe,f.runtime.python);assert.deepEqual(args,['-I','-S','-B',f.runtime.worker,'--site-packages',f.site]);assert.equal(options.shell,false);assert.equal(options.env.PATH,undefined);
      child.stdin.on('data',chunk=>{for(const line of chunk.toString().trim().split('\n')){
        const m=JSON.parse(line);sent.push(m);
        if(m.type==='start'){
          const {schema,taskId,preparedHash,scopeHash,sessionId}=m,binding={schema,taskId,preparedHash,scopeHash,sessionId};
          child.emitRecord({...binding,type:'started'});
          if(mode==='eof'){setImmediate(()=>child.emit('close',0,null));continue;}
          const approval={...binding,type:'approval',approvalId:'approval:1',actionHash:mafActionHash(f.input.mafAction)};
          if(mode==='foreign-session')approval.sessionId='foreign';if(mode==='stale-preparation')approval.preparedHash='0'.repeat(64);if(mode==='foreign-action')approval.actionHash='0'.repeat(64);
          child.emitRecord(approval);if(mode==='duplicate-approval')child.emitRecord(approval);
        }
      }});
      setImmediate(()=>child.emit('spawn'));return child;
    }) as unknown as typeof spawn;
    runner=new NativeTaskRunner(f.ledger,fake,()=>f.keys,f.runtime);const task=prepareNativeTask(f.input),result=await(await runner.start(task,task.preparedHash)).result;
    assert.equal(result.state,'UNCERTAIN');assert.equal(result.evidence,'NO_COMPLETION_EVIDENCE');assert.equal(result.quiescence,'UNKNOWN');
    assert.equal(sent.filter(m=>m.type==='approval-response').length,mode==='duplicate-approval'?1:0);
    assert.ok((await fs.readdir(f.ledger)).some(n=>n.endsWith('.lease')));
    assert.equal((await new NativeTaskRunner(f.ledger).lookup(task.taskId))?.state,'UNCERTAIN');
  }finally{await runner?.dispose();await new Promise(r=>setTimeout(r,25));await fs.rm(f.root,{recursive:true,force:true});}
});
test('MAF runtime seal rejects added, changed and missing import files',async()=>{
  const f=await fixture();try{
    await verifyMafRuntime(f.runtime,mafRuntimeHash(f.runtime),f.runtime.python,f.runtime.pythonSha256);
    await fs.writeFile(path.join(f.site,'extra.py'),'unexpected');await assert.rejects(verifyMafRuntime(f.runtime,mafRuntimeHash(f.runtime),f.runtime.python,f.runtime.pythonSha256),/changed/);await fs.unlink(path.join(f.site,'extra.py'));
    await fs.writeFile(path.join(f.site,'module.py'),'changed');await assert.rejects(verifyMafRuntime(f.runtime,mafRuntimeHash(f.runtime),f.runtime.python,f.runtime.pythonSha256),/changed/);await fs.unlink(path.join(f.site,'module.py'));
    await assert.rejects(verifyMafRuntime(f.runtime,mafRuntimeHash(f.runtime),f.runtime.python,f.runtime.pythonSha256),/missing/);
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
