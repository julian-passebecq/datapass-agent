import { parseDevContext, DEV_CONTEXT_VERSION } from '@galaxy/dev-context';
import type { AgentSessionSnapshot } from '../model';
import type { ContextRef } from './interfaces';
import type { ContextReturnBinding } from './contextReturn';
import { idOk, repoId } from './policy';
import { safeContext } from './workspaceState';

export const LENS_CONTEXT_COMMAND = 'tern.openCockpitContext';
export async function revealContextInLens(context:ContextRef,binding:ContextReturnBinding,sessions:AgentSessionSnapshot[],valid:()=>boolean,transport:{commands():PromiseLike<string[]>;execute(command:string,payload:unknown):PromiseLike<unknown>}):Promise<'OPENED'|'UNAVAILABLE'|'DENIED'> {
  if (!valid() || !safeContext(context) || binding.returnToken!==context.returnToken || !idOk(binding.requestId) || binding.generation!==null && !idOk(binding.generation) || !/^[a-f0-9]{64}$/.test(binding.scopeHash) || !Number.isSafeInteger(binding.epoch) || binding.epoch<0) return 'DENIED';
  const session=sessions.find(s=>(!context.selectedItemId || s.key===context.selectedItemId) && repoId(s.repository ?? s.cwd ?? '')===context.repoId && (!context.worktreeId || !!s.worktree && repoId(s.worktree)===context.worktreeId) && (!context.revision || s.headAfter===context.revision || s.headBefore===context.revision));
  if (!session) return 'DENIED';
  let devContext;
  try { devContext=parseDevContext({version:DEV_CONTEXT_VERSION,repository:{path:session.repository ?? session.cwd},worktreePath:session.worktree,revision:context.revision ?? undefined,thread:{provider:session.provider,id:session.sessionId}}); } catch { return 'DENIED'; }
  if (!(await transport.commands()).includes(LENS_CONTEXT_COMMAND)) return valid()?'UNAVAILABLE':'DENIED';
  if (!valid()) return 'DENIED';
  const reply=await transport.execute(LENS_CONTEXT_COMMAND,{schema:'datapass.cockpit-lens-context/1',context:structuredClone(context),binding:structuredClone(binding),devContext});
  if (!valid()) return 'DENIED';
  return reply && typeof reply==='object' && (reply as {opened?:boolean}).opened===true?'OPENED':'UNAVAILABLE';
}
