import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { cockpitFixture } from './cockpitFixture';
import { observeResources } from '../src/cockpit/resources';
import { intakeImage, ImageProducerReceipt } from '../src/cockpit/images';
import { IncrementalExporter } from '../src/export/incremental';
import { digest } from '../src/cockpit/policy';

test('selected resource metadata distinguishes absent, blocked, disabled and stale without claiming causes',async()=>{
  const f=await cockpitFixture();
  try {
    const script=path.join(f.temp,'watch.py');await fs.writeFile(script,'raise RuntimeError("THIS_MUST_NOT_RUN")');await fs.utimes(script,new Date(0),new Date(0));
    const auth=path.join(f.temp,'auth.json');await fs.writeFile(auth,'{"secret":"NEVER_READ"}');
    const selected=[{id:'disabled',file:script,kind:'SCRIPT' as const,enabled:false,staleAfterMs:1000},{id:'stale',file:script,kind:'SCRIPT' as const,enabled:null,staleAfterMs:1000},{id:'missing',file:path.join(f.temp,'missing.lock'),kind:'LOCK' as const,enabled:null,staleAfterMs:null},{id:'credential',file:auth,kind:'FILE' as const,enabled:null,staleAfterMs:null}];
    const observations=await observeResources(selected,()=>true);assert.deepEqual(observations.map(o=>o.state),['DISABLED','STALE','ABSENT','BLOCKED']);assert.ok(observations.every(o=>o.causality==='UNKNOWN'));assert.doesNotMatch(JSON.stringify(observations),/THIS_MUST_NOT_RUN|NEVER_READ|watch.py/);
    assert.deepEqual(await observeResources(selected,()=>false),[]);
  }finally{await fs.rm(f.temp,{recursive:true,force:true});}
});

test('image intake matches selected file bytes/hash and scoped source receipt; producer/publication stay separate',async()=>{
  const f=await cockpitFixture();
  try {
    const file=path.join(f.temp,'fixture.png'),bytes=Buffer.from([137,80,78,71]);await fs.writeFile(file,bytes);
    const receipt:ImageProducerReceipt={schema:'datapass.image-producer-receipt/1',id:'image:1',sourceSessionId:f.snapshots[0].key,nativeReceiptId:'native:1',producer:'image_gen',sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,capturedAt:new Date().toISOString()};
    const asset=await intakeImage(file,receipt,f.grant,()=>true);assert.equal(asset.state,'GENERATED_REPORTED');assert.equal(asset.fileHashVerified,true);assert.equal(asset.publication,'NOT_APPROVED');
    const unknown=await intakeImage(file,{...receipt,producer:null,sourceSessionId:null,nativeReceiptId:null},f.grant,()=>true);assert.equal(unknown.state,'FILE_OBSERVED');assert.equal(unknown.producer,null);
    await assert.rejects(intakeImage(file,{...receipt,sourceSessionId:f.snapshots[1].key},f.grant,()=>true),/producer scope/);
    await fs.writeFile(file,Buffer.from([1,2,3,4]));await assert.rejects(intakeImage(file,receipt,f.grant,()=>true),/hash drift/);
  }finally{await fs.rm(f.temp,{recursive:true,force:true});}
});

test('committed export receipts recover after restart and revocation never advances a cursor',async()=>{
  const f=await cockpitFixture();
  try {
    const destination=path.join(f.temp,'export');const exporter=new IncrementalExporter([f.adapter]);
    const plan=await exporter.plan(f.grant,f.snapshots,f.grant.sessionKeys,digest('test-redaction'),destination);
    await assert.rejects(exporter.execute(f.grant,plan.hash,destination,undefined,()=>false),/Scope revoked/);
    const commits=await fs.readdir(path.join(destination,'commits')).catch(()=>[]);assert.equal(commits.length,0);
    const receipt=await exporter.execute(f.grant,plan.hash,destination);
    const recovered=await new IncrementalExporter([f.adapter]).recoverReceipt(f.grant,receipt.id,destination);assert.deepEqual(recovered,receipt);
    await fs.appendFile(path.join(destination,receipt.artifactRefs[1]),'TAMPERED');
    await assert.rejects(new IncrementalExporter([f.adapter]).recoverReceipt(f.grant,receipt.id,destination),/artifact drift/);
  }finally{await fs.rm(f.temp,{recursive:true,force:true});}
});
