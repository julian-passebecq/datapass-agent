import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { HARDEN, resolveExe } from '../git/git';
import { hasLinkedAncestor, isPlausibleLocalPath } from '../util/paths';
import type { AHPBinding } from './agentHostTypes';
import { createHash } from 'node:crypto';
import { repoId } from '../cockpit/policy';
/** Inert exact Git root and HEAD check shared by production AHP reviews and recovery. No remote/auth read. */
export async function verifyAHPProject(binding:AHPBinding,approvedRepoIds?:string[]):Promise<boolean>{
  try{const root=binding.root;if(!isPlausibleLocalPath(root)||hasLinkedAncestor(root)||!(await fs.lstat(root)).isDirectory())return false;
    const git=resolveExe('git');if(!git)return false;const env:NodeJS.ProcessEnv={GIT_TERMINAL_PROMPT:'0'};for(const key of ['PATH','Path','SystemRoot'])if(process.env[key])env[key]=process.env[key];
    const read=(args:string[])=>new Promise<string>((resolve,reject)=>execFile(git,[...HARDEN,'-c','core.hooksPath=NUL',...args],{cwd:root,env,shell:false,windowsHide:true,timeout:10000,maxBuffer:16384},(e,out)=>e?reject(Error('Source unavailable')):resolve(out.toString().trim())));
    const [observed,revision,remoteNames]=await Promise.all([read(['rev-parse','--show-toplevel']),read(['rev-parse','HEAD']),read(['remote'])]);
    const canonical=(s:string)=>process.platform==='win32'?path.resolve(s).toLowerCase():path.resolve(s);
    const realRoot=await fs.realpath(observed);if(canonical(realRoot)!==canonical(root)||revision!==binding.revision)return false;
    if(!approvedRepoIds?.length)return false;
    const names=remoteNames.split('\n').filter(Boolean);if(names.length>32)return false;
    const identities:string[]=[];
    for(const name of names){if(!/^[a-zA-Z0-9._-]{1,160}$/.test(name))return false;const remote=await read(['remote','get-url',name]);const match=/^(?:https:\/\/|git@)(github\.com|gitlab\.com)(?:\/|:)([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+?)(?:\.git)?\/?$/.exec(remote);if(match)identities.push(match[2].toLowerCase());}
    const normalized=process.platform==='win32'?realRoot.replace(/\\/g,'/').toLowerCase():realRoot;
    const local='local:'+createHash('sha256').update(normalized).digest('hex');
    // The legacy observer ID is an exact root hash. PM aliases are checked
    // independently against observed Git metadata; local identity is allowed
    // only when no supported remote identity exists.
    return approvedRepoIds.some(id=>id===repoId(realRoot)||identities.includes(id.toLowerCase())||!identities.length&&id===local);
  }catch{return false;}
}
