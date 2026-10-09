import type { AgentSessionSnapshot } from '../model';
import type { ContextRef } from './interfaces';
import { digest, idOk, repoId } from './policy';

export const PM_RETURN_COMMAND = 'datapassPm.returnFromAgent';
export interface ContextReturnBinding { returnToken:string;requestId:string;generation:string|null;scopeHash:string;epoch:number; }
/** Bind source identity and Git context, without invalidating on normal new provider events. */
export function contextSourceHash(context:ContextRef,sessions:AgentSessionSnapshot[]):string {
  return digest(sessions.filter(s=>(!context.selectedItemId || s.key===context.selectedItemId) && repoId(s.repository ?? s.cwd ?? '')===context.repoId)
    .map(s=>[s.key,s.artifactPath,repoId(s.repository ?? s.cwd ?? ''),s.worktree ?? null,s.headBefore ?? null,s.headAfter ?? null]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))));
}
export async function returnToPm(context:ContextRef,binding:ContextReturnBinding,valid:()=>boolean,transport:{commands():PromiseLike<string[]>;execute(command:string,payload:ContextReturnBinding):PromiseLike<unknown>;copy(token:string):PromiseLike<unknown>},copyOnly=false):Promise<'RETURNED'|'COPIED'|'DENIED'> {
  if(!valid() || binding.returnToken!==context.returnToken || !idOk(binding.returnToken) || !idOk(binding.requestId) || binding.generation!==null && !idOk(binding.generation) || !/^[a-f0-9]{64}$/.test(binding.scopeHash) || !Number.isSafeInteger(binding.epoch) || binding.epoch<0)return 'DENIED';
  const installed=!copyOnly && binding.generation!==null && (await transport.commands()).includes(PM_RETURN_COMMAND);
  if(!valid())return 'DENIED';
  if(installed){await transport.execute(PM_RETURN_COMMAND,structuredClone(binding));return 'RETURNED';}
  await transport.copy(context.returnToken);return 'COPIED';
}
