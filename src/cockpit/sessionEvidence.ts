import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentSessionSnapshot } from '../model';
import { clean, readTranscript } from '../providers/transcript';
import { safeLocalSource } from './configuration';
import type { SessionEvidence, SessionRef } from './interfaces';
import { digest, idOk, repoId } from './policy';

const MAX_BYTES=5*1024*1024,MAX_ENTRIES=2000,MAX_PROMPT=6000,MAX_RESULT=12000;
const normalized=(p:string)=>{const value=path.resolve(p).replace(/\\/g,'/');return process.platform==='win32'?value.toLowerCase():value;};
/** Only identity-bearing facts bind a capture. Titles and activity timestamps never do. */
export const sessionEvidenceBinding=(s:AgentSessionSnapshot)=>digest([s.key,s.provider,s.sessionId,s.artifactPath,s.cwd,s.repository,s.model,s.effort,s.providerVersion]);
const statBinding=(s:Awaited<ReturnType<typeof fs.stat>>)=>digest([s.dev,s.ino,s.birthtimeMs,s.mtimeMs,s.ctimeMs,s.size]);

/** Read one reviewed source with the existing provider parser. No history/export/tool projection. */
export async function captureSessionEvidence(s:AgentSessionSnapshot,ref:SessionRef,exactPrompt:string,stillAuthorized:()=>boolean):Promise<SessionEvidence|null> {
  const capturedAt=new Date().toISOString(),omissions=[
    'Exact matching uses the existing redacted, normalized prompt projection; hashes use SHA256(JSON.stringify(text)).',
    'Only bounded reply text from this turn is projected; thinking, tools, other turns and raw history are omitted.',
    'Task and role association requires owner review; the provider does not attest a PM task or role. Turn completion is not asserted.'
  ];
  let data:SessionEvidence={schema:'datapass.session-evidence/1',session:ref,nativeId:s.sessionId,promptHash:null,promptMatch:'ABSENT',resultText:'',resultHash:null,sourceHash:digest([s.key,'source-unavailable']),capturedAt,state:'UNAVAILABLE',omissions};
  const unavailable=(reason:string)=>({...data,omissions:[...omissions,reason]});
  if(!stillAuthorized())return null;
  if(!idOk(s.sessionId) || s.key!==s.provider+':'+s.sessionId || !['codex','claude'].includes(s.provider))return null;
  if(!s.cwd || !path.isAbsolute(s.cwd) || !ref.repoId || ref.repoId!==repoId(s.repository ?? s.cwd))return unavailable('Recorded native project mapping is unavailable.');
  if(typeof exactPrompt!=='string' || !exactPrompt.trim() || exactPrompt.length>MAX_PROMPT)return unavailable('The exact prompt must be nonempty and within the 6000-character source-reader bound.');
  const prompt=clean(exactPrompt,Number.MAX_SAFE_INTEGER);
  if(prompt.length>MAX_PROMPT)return unavailable('The normalized prompt exceeds the 6000-character source-reader bound; a truncated projection cannot certify an exact match.');
  if(!await safeLocalSource(s.artifactPath) || !stillAuthorized())return stillAuthorized()?unavailable('The reviewed provider source is unavailable or unsafe.'):null;
  try{
    const before=await fs.stat(s.artifactPath);
    if(!stillAuthorized())return null;
    if(!before.isFile() || before.size>MAX_BYTES)return unavailable('The source exceeds the 5 MiB full-session evidence bound; uniqueness cannot be qualified from a tail.');
    const transcript=readTranscript(s.artifactPath,s.provider,{maxBytes:MAX_BYTES,maxEntries:MAX_ENTRIES,fresh:true});
    const after=await fs.stat(s.artifactPath);
    if(!await safeLocalSource(s.artifactPath) || !stillAuthorized())return null;
    if(statBinding(before)!==statBinding(after) || transcript.size!==before.size)return unavailable('The provider source changed during capture; retry after its native write settles.');
    data={...data,sourceHash:digest({sourceId:s.key,identity:sessionEvidenceBinding(s),stat:statBinding(after),window:{from:transcript.from,size:transcript.size,records:transcript.records,bad:transcript.bad,dropped:transcript.dropped}})};
    if(transcript.error || transcript.from!==0 || transcript.dropped>0 || transcript.bad>0 || (transcript.pendingBytes ?? 0)>0)return unavailable('The full bounded source is incomplete or malformed; exact prompt uniqueness is unavailable.');
    const identity=transcript.identity;
    if(!identity || identity.conflict || identity.nativeId!==s.sessionId || !identity.cwd || !path.isAbsolute(identity.cwd) || normalized(identity.cwd)!==normalized(s.cwd))return unavailable('Literal provider-record session ID/cwd does not match the reviewed native session. Filename, title and timing are insufficient.');
    const matches=transcript.entries.filter(e=>e.kind==='prompt' && e.text===prompt);
    if(matches.length!==1){data={...data,promptMatch:matches.length?'AMBIGUOUS':'ABSENT'};return unavailable(matches.length?'The prompt occurs more than once; owner-selected session alone cannot identify an exact turn.':'The exact prompt was not found in this provider session.');}
    const index=transcript.entries.indexOf(matches[0]),next=transcript.entries.findIndex((e,i)=>i>index && e.kind==='prompt');
    const replies=transcript.entries.slice(index+1,next<0?undefined:next).filter(e=>e.kind==='reply').map(e=>({text:e.text,phase:e.phase ?? null,model:e.model ?? null}));
    const resultText=clean(replies.map(e=>e.text).join('\n\n'),MAX_RESULT);
    data={...data,promptHash:digest(prompt),promptMatch:'EXACT',resultText,resultHash:resultText?digest(resultText):null,sourceHash:digest({sourceId:s.key,identity:sessionEvidenceBinding(s),stat:statBinding(after),prompt:matches[0].text,replies}),state:resultText?'PROVIDER_OBSERVED':'NATIVE_VISIBLE_ONLY'};
    if(!resultText)data.omissions=[...omissions,'No parsed provider reply is available for this exact turn; any result visible only in the native UI is not a PM response.'];
    else if(replies.map(e=>e.text).join('\n\n').length>MAX_RESULT)data.omissions=[...omissions,'Reply projection truncated at 12000 characters.'];
    return stillAuthorized()?data:null;
  }catch{return stillAuthorized()?unavailable('The reviewed provider source disappeared or could not be captured.'):null;}
}
