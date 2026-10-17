import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { cockpitFixture } from './cockpitFixture';
import { IncrementalExporter } from '../src/export/incremental';
import { digest } from '../src/cockpit/policy';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const extraRecord = (text: string) => JSON.stringify({type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text}]}})+'\n';
async function files(out: string) {
  const rows = [];
  for (const folder of ['commits','objects']) {
    const names = await fs.readdir(path.join(out,folder)).catch(e => { if(e.code==='ENOENT')return [];throw e; });
    for (const name of names.sort()) { const file=path.join(out,folder,name),st=await fs.stat(file);rows.push({file:folder+'/'+name,sha256:hash(await fs.readFile(file)),bytes:st.size,mtimeMs:st.mtimeMs,ino:st.ino}); }
  }
  return rows;
}
async function clean(out: string) { const names=await fs.readdir(out);assert.ok(!names.includes('.export-lock'));assert.ok(!names.some(name=>name.startsWith('.stage-'))); }

test('fresh reviewed truncation commits full resnapshot; historical reappend advances while unchanged repeats stay idempotent',async()=>{
 const f=await cockpitFixture();try{
  const exporter=new IncrementalExporter([f.adapter]),out=path.join(f.temp,'out'),redaction=digest('shared/1'),source=f.files[0],initial=await fs.readFile(source,'utf8');
  const plan=()=>exporter.plan(f.grant,f.snapshots,f.grant.sessionKeys,redaction,out),execute=async()=>{const p=await plan();return{p,r:await exporter.execute(f.grant,p.hash,out)};},manifest=async(hash:string)=>JSON.parse(await fs.readFile(path.join(out,'commits',hash+'.json'),'utf8'));
  const base=await execute(),grown=initial+extraRecord('generated appended answer');await fs.writeFile(source,grown);const append=await execute();assert.equal(append.p.appendedCount,1);const beforeTruncate=await files(out);
  await fs.writeFile(source,initial);const truncate=await execute();assert.equal(truncate.p.rewrittenCount,1);const truncatedManifest=await manifest(truncate.r.manifestHash);assert.equal(truncatedManifest.cursors[0].bytes,Buffer.byteLength(initial));assert.ok(truncatedManifest.cursors[0].bytes<(await manifest(append.r.manifestHash)).cursors[0].bytes);assert.equal(truncatedManifest.artifacts[0].records,2);
  const body=await fs.readFile(path.join(out,truncatedManifest.artifacts[0].file),'utf8');assert.match(body,/hello|answer/);assert.doesNotMatch(body,/PRIVATE_HIDDEN_REASONING|fixture-secret-value/);assert.ok(!JSON.stringify(truncatedManifest).includes('expectedPrevious'));
  for(const old of beforeTruncate)assert.deepEqual((await files(out)).find(row=>row.file===old.file),old);
  const unchanged=await execute(),samePlan=await plan();assert.equal(unchanged.p.unchangedCount,1);assert.equal(samePlan.hash,unchanged.p.hash);const beforeRepeat=await files(out),repeat=await exporter.execute(f.grant,samePlan.hash,out);assert.equal(repeat.manifestHash,unchanged.r.manifestHash);assert.deepEqual(await files(out),beforeRepeat);
  await fs.writeFile(source,grown);const reappend=await execute();assert.equal(reappend.p.appendedCount,1);assert.notEqual(reappend.p.hash,append.p.hash,'Fresh predecessor generation must not reuse historical plan hash');assert.notEqual(reappend.r.manifestHash,append.r.manifestHash,'Reappend must advance latest cursor rather than recover old receipt only');assert.equal((await manifest(reappend.r.manifestHash)).cursors[0].bytes,Buffer.byteLength(grown));assert.equal((await plan()).unchangedCount,1);
  const recovered=new IncrementalExporter([f.adapter]);for(const receipt of [base.r,append.r,truncate.r,unchanged.r,reappend.r])assert.deepEqual(await recovered.recoverReceipt(f.grant,receipt.id,out),receipt);for(const old of beforeRepeat)assert.deepEqual((await files(out)).find(row=>row.file===old.file),old);await clean(out);
 }finally{await fs.rm(f.temp,{recursive:true,force:true});}
});

test('a reviewed shrink cannot overwrite a concurrent appended cursor and cleans its lock without writes',async()=>{
 const f=await cockpitFixture();try{
  const a=new IncrementalExporter([f.adapter]),b=new IncrementalExporter([f.adapter]),out=path.join(f.temp,'out'),redaction=digest('shared/1'),source=f.files[0],initial=await fs.readFile(source,'utf8'),grown=initial+extraRecord('first append');
  const plan=(e:IncrementalExporter)=>e.plan(f.grant,f.snapshots,f.grant.sessionKeys,redaction,out);await fs.writeFile(source,grown);const base=await plan(a);await a.execute(f.grant,base.hash,out);
  await fs.writeFile(source,initial);const shrink=await plan(a);assert.equal(shrink.rewrittenCount,1);await fs.writeFile(source,grown+extraRecord('concurrent append'));const winner=await plan(b);await b.execute(f.grant,winner.hash,out);await fs.writeFile(source,initial);const before=await files(out);await assert.rejects(a.execute(f.grant,shrink.hash,out),/A newer export committed/);assert.deepEqual(await files(out),before);await clean(out);
 }finally{await fs.rm(f.temp,{recursive:true,force:true});}
});

test('equal-length concurrent rewrite invalidates an older reviewed predecessor even after source bytes restored',async()=>{
 const f=await cockpitFixture();try{
  const a=new IncrementalExporter([f.adapter]),b=new IncrementalExporter([f.adapter]),out=path.join(f.temp,'out'),redaction=digest('shared/1'),source=f.files[0],initial=await fs.readFile(source,'utf8'),versionA=initial.replace('"answer"','"change"'),versionB=initial.replace('"answer"','"result"');assert.notEqual(versionA,initial);assert.notEqual(versionB,initial);assert.equal(Buffer.byteLength(versionA),Buffer.byteLength(versionB));
  const plan=(e:IncrementalExporter)=>e.plan(f.grant,f.snapshots,f.grant.sessionKeys,redaction,out),base=await plan(a);await a.execute(f.grant,base.hash,out);await fs.writeFile(source,versionA);const stale=await plan(a);await fs.writeFile(source,versionB);const winner=await plan(b);assert.equal(stale.rewrittenCount,1);assert.equal(winner.rewrittenCount,1);await b.execute(f.grant,winner.hash,out);await fs.writeFile(source,versionA);const before=await files(out);await assert.rejects(a.execute(f.grant,stale.hash,out),/A newer export committed/);assert.deepEqual(await files(out),before);await clean(out);
 }finally{await fs.rm(f.temp,{recursive:true,force:true});}
});

test('new-source plan bound to absent cursor cannot replace another first commit',async()=>{
 const f=await cockpitFixture();try{
  const a=new IncrementalExporter([f.adapter]),b=new IncrementalExporter([f.adapter]),out=path.join(f.temp,'out'),redaction=digest('shared/1'),source=f.files[0],initial=await fs.readFile(source,'utf8');const plan=(e:IncrementalExporter)=>e.plan(f.grant,f.snapshots,f.grant.sessionKeys,redaction,out),stale=await plan(a);await fs.writeFile(source,initial.replace('"answer"','"result"'));const winner=await plan(b);await b.execute(f.grant,winner.hash,out);await fs.writeFile(source,initial);const before=await files(out);await assert.rejects(a.execute(f.grant,stale.hash,out),/A newer export committed/);assert.deepEqual(await files(out),before);await clean(out);
 }finally{await fs.rm(f.temp,{recursive:true,force:true});}
});

test('changed capture binds prior manifest as well as equal cursor; fresh preview recovers without relaxing idempotence',async()=>{
 const f=await cockpitFixture();try{
  const a=new IncrementalExporter([f.adapter]),b=new IncrementalExporter([f.adapter]),out=path.join(f.temp,'out'),redaction=digest('shared/1'),source=f.files[0],initial=await fs.readFile(source,'utf8'),grown=initial+extraRecord('pending after current cursor');const plan=(e:IncrementalExporter)=>e.plan(f.grant,f.snapshots,f.grant.sessionKeys,redaction,out),base=await plan(a);await a.execute(f.grant,base.hash,out);await fs.writeFile(source,grown);const stale=await plan(a);await fs.writeFile(source,initial);const unchanged=await plan(b);assert.equal(unchanged.unchangedCount,1);const other=await b.execute(f.grant,unchanged.hash,out);await fs.writeFile(source,grown);const before=await files(out);await assert.rejects(a.execute(f.grant,stale.hash,out),/A newer export committed/);assert.deepEqual(await files(out),before);const fresh=await plan(a);assert.notEqual(fresh.hash,stale.hash);assert.equal(fresh.appendedCount,1);const committed=await a.execute(f.grant,fresh.hash,out);assert.notEqual(committed.manifestHash,other.manifestHash);assert.deepEqual(await a.execute(f.grant,fresh.hash,out),committed);assert.equal((await plan(a)).unchangedCount,1);await clean(out);
 }finally{await fs.rm(f.temp,{recursive:true,force:true});}
});
test('original 0.11.8 v1 manifest and object bytes recover as the identical receipt without rewriting legacy assets',async()=>{
 const f=await cockpitFixture();try{
  const old=JSON.parse(await fs.readFile(path.join(__dirname,'../../test/fixtures/incremental-v1-receipt.json'),'utf8'));assert.equal(old.sourceSha,'e72d0c4312746e1ff7012126bb9fd2c0fdd8f9fc');assert.equal(old.manifest.schema,'datapass.incremental-history/1');assert.equal(digest(old.manifest),old.manifestSha256);assert.ok(!JSON.stringify(old.manifest).includes('expectedPrevious'));
  const out=path.join(f.temp,'legacy');await fs.mkdir(path.join(out,'commits'),{recursive:true});await fs.mkdir(path.join(out,'objects'));await fs.writeFile(path.join(out,'commits',old.manifestSha256+'.json'),JSON.stringify(old.manifest));for(const object of old.objects){const bytes=Buffer.from(object.bytesBase64,'base64');assert.equal(hash(bytes),object.sha256);await fs.writeFile(path.join(out,object.file),bytes);}
  // Direct exporter-unit fixture uses the exact producing policy hash. Public facade grant review is separate.
  const grant={...f.grant,scope:{...f.grant.scope,policyHash:old.manifest.scopeHash}},exporter=new IncrementalExporter([f.adapter]),before=await files(out),expected={id:'receipt:'+old.manifestSha256,manifestHash:old.manifestSha256,state:'OK',committedCursorIds:old.manifest.cursors.map((c:{id:string})=>c.id),artifactRefs:['commits/'+old.manifestSha256+'.json',...old.manifest.artifacts.map((a:{file:string})=>a.file)]};assert.deepEqual(await exporter.recoverReceipt(grant,expected.id,out),expected);assert.deepEqual(exporter.getReceipt(grant,expected.id),expected);assert.deepEqual(await files(out),before);assert.equal(await exporter.recoverReceipt({...grant,scope:{...grant.scope,policyHash:'f'.repeat(64)}},expected.id,out),undefined);assert.deepEqual(await files(out),before);
 }finally{await fs.rm(f.temp,{recursive:true,force:true});}
});
test('job80 same-length rewritten source then fresh truncation produces the reviewed shorter full resnapshot',async()=>{
 const f=await cockpitFixture();try{
  const exporter=new IncrementalExporter([f.adapter]),out=path.join(f.temp,'out'),redaction=digest('shared/1'),source=f.files[0],initial=await fs.readFile(source,'utf8'),grown=initial+extraRecord('generated appended answer');const plan=()=>exporter.plan(f.grant,f.snapshots,f.grant.sessionKeys,redaction,out);let p=await plan();await exporter.execute(f.grant,p.hash,out);await fs.writeFile(source,grown);p=await plan();await exporter.execute(f.grant,p.hash,out);const rewritten=grown.replace('"answer"','"change"');assert.equal(Buffer.byteLength(rewritten),Buffer.byteLength(grown));await fs.writeFile(source,rewritten);p=await plan();assert.equal(p.rewrittenCount,1);const prior=await exporter.execute(f.grant,p.hash,out),before=await files(out);const truncated=rewritten.slice(0,rewritten.lastIndexOf('\n',rewritten.length-2)+1);await fs.writeFile(source,truncated);p=await plan();assert.equal(p.rewrittenCount,1);const receipt=await exporter.execute(f.grant,p.hash,out),manifest=JSON.parse(await fs.readFile(path.join(out,'commits',receipt.manifestHash+'.json'),'utf8'));assert.notEqual(receipt.manifestHash,prior.manifestHash);assert.equal(manifest.cursors[0].bytes,Buffer.byteLength(truncated));assert.equal(manifest.artifacts[0].records,2);const text=await fs.readFile(path.join(out,manifest.artifacts[0].file),'utf8');assert.match(text,/"text":"change"/);assert.doesNotMatch(text,/generated appended answer/);for(const old of before)assert.deepEqual((await files(out)).find(row=>row.file===old.file),old);await clean(out);
 }finally{await fs.rm(f.temp,{recursive:true,force:true});}
});