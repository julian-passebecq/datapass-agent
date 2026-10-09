import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { bounded } from '../util/redact';

export interface ProcessMetadata { pid:number;alive:boolean|null;name:string|null;parentPid:number|null;startedAt:string|null;source:'LOCAL_CIM_PID_QUERY'|'LOCAL_PID_EXISTENCE'; }
export type ProcessLookup = {state:'OBSERVED'|'ABSENT'|'BLOCKED';process:ProcessMetadata;reason?:'PID_LOOKUP_DENIED'|'PID_METADATA_INVALID'};
export const validPid=(pid:unknown):pid is number=>Number.isSafeInteger(pid) && (pid as number)>0 && (pid as number)<=2147483647;
/** One reviewed PID only. Never reads arguments, environment, executable path, or unrelated processes. */
export async function readProcessMetadata(pid:number):Promise<ProcessLookup> {
  if(!validPid(pid))throw new Error('Invalid selected process ID.');
  const empty:ProcessMetadata={pid,alive:null,name:null,parentPid:null,startedAt:null,source:process.platform==='win32'?'LOCAL_CIM_PID_QUERY':'LOCAL_PID_EXISTENCE'};
  if(process.platform!=='win32') {
    try {process.kill(pid,0);return {state:'OBSERVED',process:{...empty,alive:true}};}
    catch(e){return (e as NodeJS.ErrnoException).code==='ESRCH'?{state:'ABSENT',process:{...empty,alive:false}}:{state:'BLOCKED',process:empty,reason:'PID_LOOKUP_DENIED'};}
  }
  const script='$ErrorActionPreference="Stop"; $p=Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = '+String(pid)+'"; if($null -eq $p){"null"}else{[pscustomobject]@{pid=[int]$p.ProcessId;name=[string]$p.Name;parentPid=[int]$p.ParentProcessId;startedAt=$(if($p.CreationDate){$p.CreationDate.ToUniversalTime().ToString("o")}else{$null})}|ConvertTo-Json -Compress}';
  try {
    const exe=path.join(process.env.SystemRoot ?? 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    const {stdout}=await promisify(execFile)(exe,['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:3000,maxBuffer:16384});
    const value=JSON.parse(stdout.trim());
    if(value===null)return {state:'ABSENT',process:{...empty,alive:false}};
    if(value.pid!==pid || typeof value.name!=='string' || value.name.length>256 || !(value.parentPid===0 || validPid(value.parentPid)) || value.startedAt!==null && (typeof value.startedAt!=='string' || !Number.isFinite(Date.parse(value.startedAt))))return {state:'BLOCKED',process:empty,reason:'PID_METADATA_INVALID'};
    return {state:'OBSERVED',process:{...empty,alive:true,name:bounded(value.name,100),parentPid:value.parentPid,startedAt:value.startedAt===null?null:new Date(value.startedAt).toISOString()}};
  }catch{return {state:'BLOCKED',process:empty,reason:'PID_LOOKUP_DENIED'};}
}
