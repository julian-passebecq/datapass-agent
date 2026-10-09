import * as fs from 'node:fs/promises';
import type { LocalGrant } from './policy';
import { idOk } from './policy';
import { safeLocalSource } from './configuration';
import { isPlausibleLocalPath } from '../util/paths';
import { readProcessMetadata, validPid } from './processMetadata';
import type { ProcessLookup, ProcessMetadata } from './processMetadata';
export interface SelectedFileResource { id:string;file:string;kind:'SCRIPT'|'LOCK'|'TASK_METADATA'|'FILE';enabled:boolean|null;staleAfterMs:number|null; }
export interface SelectedProcessResource { id:string;pid:number;kind:'PROCESS';expectedStartedAt:string|null; }
export type SelectedResource=SelectedFileResource|SelectedProcessResource;
export interface ResourceObservation { id:string;kind:SelectedResource['kind'];state:'OBSERVED'|'DISABLED'|'STALE'|'ABSENT'|'BLOCKED';bytes:number|null;modifiedAt:string|null;enabled:boolean|null;enabledBasis:'HOST_REVIEWED_ASSERTION'|'UNKNOWN';capturedAt:string;causality:'UNKNOWN';process?:ProcessMetadata;reason?:string; }
/** Metadata-only read of exact host-reviewed resources. No task/script execution, watcher repair, or process kill. */
export async function observeResources(selection:SelectedResource[],stillAuthorized:()=>boolean,processReader:(pid:number)=>Promise<ProcessLookup>=readProcessMetadata):Promise<ResourceObservation[]> {
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
  return stillAuthorized()?out:[];
}
export function validateResources(grant:LocalGrant,items:SelectedResource[]):void {
  if(!grant || !Array.isArray(items) || items.length>50 || items.filter(i=>i.kind==='PROCESS').length>10 || items.some(i=>!idOk(i.id) || (i.kind==='PROCESS' ? !validPid(i.pid) || i.expectedStartedAt!==null && (typeof i.expectedStartedAt!=='string' || !Number.isFinite(Date.parse(i.expectedStartedAt))):!isPlausibleLocalPath(i.file) || !['SCRIPT','LOCK','TASK_METADATA','FILE'].includes(i.kind) || ![true,false,null].includes(i.enabled) || i.staleAfterMs!==null && (!Number.isSafeInteger(i.staleAfterMs) || i.staleAfterMs<0))))throw new Error('Invalid selected resource metadata.');
}
