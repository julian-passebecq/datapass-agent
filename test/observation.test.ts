import {test} from 'node:test';
import assert from 'node:assert/strict';
import {observationExport,OBSERVATION_CONTRACT} from '../src/export/observation';
import {sessionKey,agentLensContext} from '../src/interop';
import type {AgentSessionSnapshot} from '../src/model';
const s:AgentSessionSnapshot={key:'codex:synthetic',provider:'codex',sessionId:'synthetic',status:'UNKNOWN',statusReason:'No recorded exit',isWorker:false,commits:[],changedFiles:[],tests:[],counts:{tools:0,commands:0,fileEdits:0,turns:0},evidence:[],artifactPath:'synthetic.jsonl',diagnostics:[]};
test('observation export preserves missing outcomes, serializes and redacts event secrets',()=>{
  const result=observationExport(s,[{at:1,type:'TOOL_ACTIVITY',label:'mongodb://name:password@localhost/db',provider:'codex',sessionKey:s.key,kind:'OBSERVED'}]) as Record<string,unknown>;
  assert.equal(result.schema,OBSERVATION_CONTRACT);assert.equal(result.evidenceKind,'UNKNOWN');assert.deepEqual(result.verification,[]);assert.equal(result.startedAt,null);
  const json=JSON.stringify(result);assert(!json.includes('password@'));assert(!json.includes('PASS'));assert.deepEqual(JSON.parse(json).events[0].kind,'OBSERVED');
});
test('Agent never invents missing repository, worktree, commit or changed file',()=>{assert.equal(agentLensContext(s,'worktree'),undefined);assert.equal(agentLensContext({...s,repository:'D:/synthetic/repo'},'commit'),undefined);assert.equal(agentLensContext({...s,repository:'D:/synthetic/repo'},'file'),undefined);const pointer=agentLensContext({...s,repository:'D:/synthetic/repo',worktree:'D:/synthetic/worktree',commits:[{sha:'a'.repeat(40),at:1,subject:'synthetic',attribution:'session-ran-git-commit'}]},'commit')!;assert.equal(pointer.version,'galaxy.dev-context/1');assert.equal(pointer.repository?.path,'D:/synthetic/repo');assert.equal(pointer.worktreePath,'D:/synthetic/worktree');assert.equal(pointer.revision,'a'.repeat(40));assert.equal(sessionKey(pointer),'codex:synthetic');});
test('observation export retains verification UNKNOWN and field provenance',()=>{
  const result=observationExport({...s,tests:[{command:'npm test',at:1,outcome:'UNKNOWN',source:'provider-tool-error-flag'}],evidence:[{field:'status',kind:'INFERRED',source:'recency'}]},[]) as {evidenceKind:string;verification:{outcome:string}[]};
  assert.equal(result.evidenceKind,'INFERRED');assert.equal(result.verification[0].outcome,'UNKNOWN');
});
test('plain provider/session command object resolves without inventing session identity',()=>{
  assert.equal(sessionKey({provider:'codex',sessionId:'native-123',repoPath:'synthetic'}),'codex:native-123');
  assert.equal(sessionKey({provider:'claude',sessionId:'worker-1'}),'claude:worker-1');
  assert.equal(sessionKey({provider:'t3',sessionId:'native-123'}),undefined);assert.equal(sessionKey({provider:'codex',sessionId:'bad\nvalue'}),undefined);
});
