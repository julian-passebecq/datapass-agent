import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJson, sha256 } from '../galaxy';
import { hasLinkedAncestor, isPlausibleLocalPath } from '../util/paths';

/** Registered by the Agent host, never accepted as executable paths from a task. */
export interface MafRuntime {
  schema:'datapass.maf-runtime/1';
  python:string; pythonSha256:string;
  worker:string; workerSha256:string;
  sitePackages:string;
  files:{path:string;sha256:string}[];
}
export interface MafAction { tool:'write_artifact'; filename:string; content:string; }
export const mafRuntimeHash=(runtime:MafRuntime)=>sha256(canonicalJson(runtime));
export const mafActionHash=(action:MafAction)=>sha256(canonicalJson(action));
const hashOk=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export function validateMafAction(action:MafAction):boolean {
  return !!action && Object.keys(action).sort().join(',')==='content,filename,tool' && action.tool==='write_artifact' &&
    typeof action.filename==='string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}\.txt$/.test(action.filename) &&
    !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])\./i.test(action.filename) &&
    typeof action.content==='string' && Buffer.byteLength(action.content)>0 && Buffer.byteLength(action.content)<=16384 && !action.content.includes('\0');
}
/** Verify the host-reviewed import tree, including unexpected added files. No Python execution. */
export async function verifyMafRuntime(runtime:MafRuntime|undefined, expectedHash:string, python:string, pythonHash:string):Promise<void> {
  if(!runtime || runtime.schema!=='datapass.maf-runtime/1' || mafRuntimeHash(runtime)!==expectedHash || runtime.python!==python || runtime.pythonSha256!==pythonHash ||
    ![runtime.python,runtime.worker,runtime.sitePackages].every(p=>isPlausibleLocalPath(p)&&!hasLinkedAncestor(p)) ||
    !hashOk(runtime.workerSha256) || !Array.isArray(runtime.files) || !runtime.files.length || runtime.files.length>10000)throw Error('Exact host-registered MAF runtime is required.');
  const workerStat=await fs.lstat(runtime.worker);
  if(!workerStat.isFile()||workerStat.size>256*1024)throw Error('Invalid bounded MAF worker.');
  const worker=await fs.readFile(runtime.worker);
  if(worker.length>256*1024 || createHash('sha256').update(worker).digest('hex')!==runtime.workerSha256)throw Error('MAF worker bytes changed.');
  const expected=new Map<string,string>();
  for(const f of runtime.files){
    if(!f || typeof f.path!=='string' || f.path.length>300 || f.path.includes('\\') || f.path.split('/').some(p=>!p||p==='.'||p==='..') || path.isAbsolute(f.path) || !hashOk(f.sha256) || expected.has(f.path))throw Error('Invalid MAF import inventory.');
    expected.set(f.path,f.sha256);
  }
  let count=0,bytes=0;
  const walk=async(directory:string,relative=''):Promise<void>=>{
    for(const entry of await fs.readdir(directory,{withFileTypes:true})){
      const name=relative+entry.name,full=path.join(directory,entry.name);
      if(entry.isSymbolicLink() || hasLinkedAncestor(full))throw Error('Linked MAF runtime file denied.');
      // Existing bytecode belongs to the seal too; -B prevents changing it during execution.
      if(entry.isDirectory()){await walk(full,name+'/');continue;}
      if(!entry.isFile() || ++count>10000 || !expected.has(name))throw Error('MAF import tree changed.');
      const stat=await fs.lstat(full);if(!stat.isFile()||bytes+stat.size>256*1024*1024)throw Error('Oversized MAF runtime.');
      const content=await fs.readFile(full);bytes+=content.length;
      if(bytes>256*1024*1024 || createHash('sha256').update(content).digest('hex')!==expected.get(name))throw Error('MAF import bytes changed.');
    }
  };
  await walk(runtime.sitePackages);
  if(count!==expected.size)throw Error('MAF import file missing.');
}
