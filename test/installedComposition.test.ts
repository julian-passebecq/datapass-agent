import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {createHash} from 'node:crypto';

const directory=path.resolve('test/fixtures/installed-pm');
const json=(file:string)=>JSON.parse(fs.readFileSync(path.join(directory,file),'utf8').replace(/^\uFEFF/,''));
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
test('Installed composition binds the PM artifact to its exact successful qualification and retains the previous fixture',()=>{
  const receipt=json('receipt.json'),qualification=json('qualification-'+receipt.version+'.json');
  assert.equal(receipt.version,'0.5.1');assert.equal(receipt.sourceSha,qualification.sourceSha);
  assert.ok(qualification.gates.every((gate:{exitCode:number})=>gate.exitCode===0));
  assert.equal(qualification.tests.passed,qualification.tests.total);assert.ok(qualification.tests.total>0);
  const bytes=fs.readFileSync(path.join(directory,receipt.filename));assert.equal(hash(bytes),receipt.sha256);assert.equal(bytes.length,receipt.bytes);
  const artifact=qualification.artifact??qualification.artifacts?.[0];assert.equal(artifact.sha256,receipt.sha256);
  assert.ok(fs.existsSync(path.join(directory,'datapass-pm-0.5.0.vsix')));assert.ok(fs.existsSync(path.join(directory,receipt.historicalReceipt)));
  assert.equal(receipt.provenance.installedJourney,'BLOCKED_NOT_EXECUTED');
});
test('Installed composition uses the qualified Config role-binding candidate without implying native execution',()=>{
  const receipt=json('config-dependency.json'),bytes=fs.readFileSync(path.join(directory,receipt.filename));
  assert.equal(receipt.version,'0.8.1');assert.equal(receipt.sourceSha,'7d080980a0c679b6106a7e655450340dc8862edf');assert.equal(receipt.sha256,'a7aab6434d54d1253820c214241174f5407dd1175001cd1566ba8f0b3a6ee7a0');assert.equal(hash(bytes),receipt.sha256);assert.equal(bytes.length,receipt.bytes);
  assert.equal(receipt.role,'DEPENDENCY_ONLY');assert.equal(receipt.providerExecution,false);assert.equal(receipt.authentication,false);assert.ok(fs.existsSync(path.join(directory,receipt.historicalReceipt)));
});
