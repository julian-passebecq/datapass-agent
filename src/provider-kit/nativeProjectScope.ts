import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { HARDEN, resolveExe } from '../git/git';
import { hasLinkedAncestor, isPlausibleLocalPath } from '../util/paths';
import { hashOk, nativeIdOk } from './nativeTransport';

export interface NativeProjectScopeInput {organizationId:string;privacyDomainId:string;projectId:string;repoId:string;root:string;revision:string;sourceVectorHash:string;policyHash:string;}
export interface NativeRepositoryIdentity {root:string;revision:string;repoId:string;remoteHost:string;commonDirectory:string;}
/** Inert Git identity lookup with hardened executable and config; no network, hooks, history or task. */
export async function verifyNativeProjectScope(input:NativeProjectScopeInput):Promise<void>{
  if(!input || ![input.organizationId,input.privacyDomainId,input.projectId].every(nativeIdOk) || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(input.repoId) || !isPlausibleLocalPath(input.root) || hasLinkedAncestor(input.root) || !/^[a-f0-9]{40}$/.test(input.revision) || ![input.sourceVectorHash,input.policyHash].every(hashOk))throw Error('Invalid exact project execution scope.');
  const observed=await readNativeRepositoryIdentity(input.root);
  const canonical=(s:string)=>process.platform==='win32'?path.resolve(s).toLowerCase():path.resolve(s);
  if(canonical(observed.root)!==canonical(input.root) || observed.revision!==input.revision || observed.repoId.toLowerCase()!==input.repoId.toLowerCase())throw Error('Exact project root, canonical origin or revision changed.');
}
/** Reused for execution project grants and durable native write leases. No external-writer inference. */
export async function readNativeRepositoryIdentity(root:string):Promise<NativeRepositoryIdentity>{
  if(!isPlausibleLocalPath(root) || hasLinkedAncestor(root) || !(await fs.lstat(root)).isDirectory())throw Error('Reviewed project root is unavailable.');
  const git=resolveExe('git');if(!git)throw Error('Git identity verification unavailable.');
  const env:NodeJS.ProcessEnv={GIT_TERMINAL_PROMPT:'0'};
  for(const key of ['PATH','Path','SystemRoot'])if(process.env[key])env[key]=process.env[key];
  const read=(args:string[])=>new Promise<string>((resolve,reject)=>execFile(git,[...HARDEN,'-c','core.hooksPath=NUL',...args],{cwd:root,env,shell:false,windowsHide:true,timeout:10000,maxBuffer:64*1024},(error,out)=>error?reject(Error('Project Git identity unavailable.')):resolve(out.toString().trim())));
  const [worktree,head,remote,common]=await Promise.all([read(['rev-parse','--show-toplevel']),read(['rev-parse','HEAD']),read(['config','--get','remote.origin.url']),read(['rev-parse','--git-common-dir'])]);
  const match=/^(?:https:\/\/|git@)(github\.com|gitlab\.com)(?:\/|:)([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+?)(?:\.git)?$/.exec(remote);
  if(!match || !/^[a-f0-9]{40}$/.test(head))throw Error('Exact project canonical origin or revision unavailable.');
  const commonDirectory=await fs.realpath(path.resolve(root,common));if(hasLinkedAncestor(commonDirectory))throw Error('Linked Git metadata denied.');
  return {root:await fs.realpath(worktree),revision:head,repoId:match[2],remoteHost:match[1],commonDirectory};
}
