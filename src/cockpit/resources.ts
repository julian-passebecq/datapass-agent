import * as fs from 'node:fs/promises';
import type { LocalGrant } from './policy';
import { idOk } from './policy';
import { safeLocalSource } from './configuration';
import { isPlausibleLocalPath } from '../util/paths';
import { readProcessMetadata, validPid } from './processMetadata';
import type { ProcessLookup, ProcessMetadata } from './processMetadata';
import type { AgentSessionSnapshot } from '../model';
export interface SelectedFileResource { id:string;file:string;kind:'SCRIPT'|'LOCK'|'TASK_METADATA'|'FILE';enabled:boolean|null;staleAfterMs:number|null; }
export interface SelectedProcessResource { id:string;pid:number;kind:'PROCESS';expectedStartedAt:string|null; }
export type SelectedResource=SelectedFileResource|SelectedProcessResource;
export interface ResourceTimeRelation { sessionId:string;timestampKind:'FILE_MODIFICATION'|'PROCESS_CREATION';relation:'BEFORE_RECORDED_WINDOW'|'WITHIN_RECORDED_WINDOW'|'AFTER_RECORDED_WINDOW';recordedStartAt:string;recordedEndAt:string; }
export interface ResourceObservation { id:string;kind:SelectedResource['kind'];state:'OBSERVED'|'DISABLED'|'STALE'|'ABSENT'|'BLOCKED';bytes:number|null;modifiedAt:string|null;enabled:boolean|null;enabledBasis:'HOST_REVIEWED_ASSERTION'|'UNKNOWN';capturedAt:string;causality:'UNKNOWN';process?:ProcessMetadata;reason?:string;timeRelations?:ResourceTimeRelation[];timeRelationCoverage?:{eligibleRecordedWindows:number;unavailableRecordedWindows:number;returned:number;complete:boolean;basis:string}; }
/** Timestamp comparison only: a file modification or process birth is not proof of execution or causality. */
export function correlateResourceTime(observation:ResourceObservation,sessions:AgentSessionSnapshot[]):ResourceObservation {
  const timestampKind=observation.kind==='PROCESS'?'PROCESS_CREATION':'FILE_MODIFICATION';
  const timestamp=observation.kind==='PROCESS'?observation.process?.startedAt:observation.modifiedAt;
  const at=timestamp?Date.parse(timestamp):NaN;
  const windows=sessions.filter(s=>idOk(s.key) && s.startedAt!==undefined && Number.isFinite(s.startedAt) && s.lastActivityAt!==undefined && Number.isFinite(s.lastActivityAt) && s.startedAt<=s.lastActivityAt);
  const relations=Number.isFinite(at) && observation.state!=='BLOCKED' && observation.state!=='ABSENT'?windows.map(s=>({sessionId:s.key,timestampKind,relation:at<s.startedAt!?'BEFORE_RECORDED_WINDOW':at>s.lastActivityAt!?'AFTER_RECORDED_WINDOW':'WITHIN_RECORDED_WINDOW',recordedStartAt:new Date(s.startedAt!).toISOString(),recordedEndAt:new Date(s.lastActivityAt!).toISOString()} as ResourceTimeRelation)).sort((a,b)=>Number(b.relation==='WITHIN_RECORDED_WINDOW')-Number(a.relation==='WITHIN_RECORDED_WINDOW') || a.sessionId.localeCompare(b.sessionId)).slice(0,10):[];
  return {...observation,timeRelations:relations,timeRelationCoverage:{eligibleRecordedWindows:windows.length,unavailableRecordedWindows:sessions.length-windows.length,returned:relations.length,complete:Number.isFinite(at) && observation.state!=='BLOCKED' && observation.state!=='ABSENT' && windows.length===sessions.length && relations.length===windows.length,basis:'DERIVED comparison to recorded provider event endpoints; not execution, work duration, interference, or cause; maximum 10 enrolled session windows'}};
}
/** Metadata-only read of exact host-reviewed resources. No task/script execution, watcher repair, or process kill. */
export async function observeResources(selection:SelectedResource[],stillAuthorized:()=>boolean,processReader:(pid:number)=>Promise<ProcessLookup>=readProcessMetadata,sessions:AgentSessionSnapshot[]=[]):Promise<ResourceObservation[]> {
  const capturedAt=new Date().toISOString(),out:ResourceObservation[]=[];
  for(const item of selection) {
    if(!stillAuthorized())return [];
    if(item.kind==='PROCESS') {
      const lookup=await processReader(item.pid);if(!stillAuthorized())return [];
      const drift=lookup.state==='OBSERVED' && item.expectedStartedAt!==null && lookup.process.startedAt!==item.expectedStartedAt;
      out.push({id:item.id,kind:'PROCESS',state:drift?'BLOCKED':lookup.state,bytes:null,modifiedAt:null,enabled:null,enabledBasis:'UNKNOWN',capturedAt:new Date().toISOString(),causality:'UNKNOWN',process:lookup.process,...(drift?{reason:'PID_IDENTITY_DRIFT'}:lookup.reason?{reason:lookup.reason}:{})});
      continue;
    }
    let state:ResourceObservation['state']='BLOCKED',bytes:number|null=null,modifiedAt:string|null=null;
    try {
      const st=await fs.lstat(item.file);
      if(!st.isSymbolicLink() && await safeLocalSource(item.file)) {
        bytes=st.size;modifiedAt=st.mtime.toISOString();state=item.enabled===false?'DISABLED':item.staleAfterMs!==null && Date.now()-st.mtimeMs>item.staleAfterMs?'STALE':'OBSERVED';
      }
    }catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')state='ABSENT';}
    out.push({id:item.id,kind:item.kind,state,bytes,modifiedAt,enabled:item.enabled,enabledBasis:item.enabled===null?'UNKNOWN':'HOST_REVIEWED_ASSERTION',capturedAt,causality:'UNKNOWN'});
  }
  return stillAuthorized()?out.map(item=>correlateResourceTime(item,sessions)):[];
}
export function validateResources(grant:LocalGrant,items:SelectedResource[]):void {
  if(!grant || !Array.isArray(items) || items.length>50 || items.filter(i=>i.kind==='PROCESS').length>10 || items.some(i=>!idOk(i.id) || (i.kind==='PROCESS' ? !validPid(i.pid) || i.expectedStartedAt!==null && (typeof i.expectedStartedAt!=='string' || !Number.isFinite(Date.parse(i.expectedStartedAt))):!isPlausibleLocalPath(i.file) || !['SCRIPT','LOCK','TASK_METADATA','FILE'].includes(i.kind) || ![true,false,null].includes(i.enabled) || i.staleAfterMs!==null && (!Number.isSafeInteger(i.staleAfterMs) || i.staleAfterMs<0))))throw new Error('Invalid selected resource metadata.');
}
