import {parseDevContext,DEV_CONTEXT_VERSION,type DevContext} from '@galaxy/dev-context';
import type {AgentSessionSnapshot} from './model';
export function agentLensContext(s:AgentSessionSnapshot,action:'worktree'|'change'|'commit'|'file'):DevContext|undefined {
  const repo=s.repository??s.worktree;if(!repo)return;
  if(action==='worktree'&&!s.worktree||action==='commit'&&!s.commits.length||action==='file'&&!s.changedFiles.length||action==='change'&&!s.changedFiles.length&&!s.commits.length&&!s.dirty)return;
  try{return parseDevContext({version:DEV_CONTEXT_VERSION,repository:{path:repo},worktreePath:s.worktree,branch:s.branch,
    revision:action==='commit'?s.commits[0].sha:undefined,file:action==='file'?{path:s.changedFiles[0]}:undefined,thread:{provider:s.provider,id:s.sessionId}});}catch{return;}
}
export function sessionKey(argument:unknown):string|undefined {
  if(typeof argument==='string')return argument;
  if(!argument||typeof argument!=='object')return;
  const value=argument as Record<string,unknown>;
  if(value.version===DEV_CONTEXT_VERSION){try{const pointer=parseDevContext(value);return pointer.thread?sessionKey({provider:pointer.thread.provider,sessionId:pointer.thread.id}):undefined;}catch{return;}}
  if((value.provider==='claude'||value.provider==='codex')&&typeof value.sessionId==='string'&&/^[a-zA-Z0-9._:-]{1,160}$/.test(value.sessionId))return `${value.provider}:${value.sessionId}`;
}
