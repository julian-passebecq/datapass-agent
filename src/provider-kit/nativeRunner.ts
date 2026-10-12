import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { bounded } from '../util/redact';
import { hasLinkedAncestor, isPlausibleLocalPath } from '../util/paths';
import { NativeIdentity, NativeSelection, PreparedNativeTask, nativeEnvironment, nativeHash, nativeIdOk, nativeLaunchArguments, preflightNativeTransport, prepareNativeTask } from './nativeTransport';
import { readNativeRepositoryIdentity } from './nativeProjectScope';

export type NativeTaskState = 'SPAWN_INTENT' | 'RUNNING' | 'NEEDS_INPUT' | 'COMPLETED' | 'FAILED' | 'INTERRUPTED' | 'UNCERTAIN';
export interface NativeTaskObservation {
  schema:'datapass.native-task-observation/1'; taskId:string; preparedHash:string; selectionHash:string;
  targetHash:string; permissionHash:string; configHash:string; presetHash:string; promptHash:string; bindingHash:string; scopeHash:string; configScopeHash:string;
  state:NativeTaskState; sessionId:string|null; turnId:string|null; sequence:number;
  requestedIdentity:NativeIdentity; observedIdentity:{model:string|null;effort:string|null;accountId:string|null};
  resultText:string; resultHash:string|null; reason:string|null; updatedAt:string;
  /** Native completion is not independent acceptance or Git/CI verification. */
  evidence:'NATIVE_REPORTED' | 'NO_COMPLETION_EVIDENCE';
  quiescence:'NATIVE_TURN_SETTLED'|'UNKNOWN';
}
export interface NativeTaskEvent { type:'STATE'|'PROGRESS'|'MESSAGE'; observation:NativeTaskObservation; }
export interface NativeTaskHandle {
  taskId:string; observation():NativeTaskObservation; result:Promise<NativeTaskObservation>;
  subscribe(listener:(event:NativeTaskEvent)=>void):{dispose():void};
  cancel():Promise<NativeTaskObservation>;
}
interface LiveTask { handle:NativeTaskHandle; cancel:()=>Promise<NativeTaskObservation>; }
/** The standalone kit is a transport, never a scheduler/cognitive loop. The installed facade supplies authority. */
export class NativeTaskRunner {
  private live=new Map<string,LiveTask>();
  constructor(readonly ledgerDirectory:string, private spawnProcess:typeof spawn=spawn) {
    let ancestor=ledgerDirectory;while(!fsSync.existsSync(ancestor) && ancestor!==path.dirname(ancestor))ancestor=path.dirname(ancestor);
    if(!isPlausibleLocalPath(ledgerDirectory) || hasLinkedAncestor(ancestor))throw Error('A real owned ledger directory is required.');
  }
  private file(id:string):string {if(!nativeIdOk(id))throw Error('Invalid owned task identity.');return path.join(this.ledgerDirectory,nativeHash(id)+'.json');}
  async lookup(id:string):Promise<NativeTaskObservation|null> {
    if(this.live.has(id))return this.live.get(id)!.handle.observation();
    try {
      if(!fsSync.existsSync(this.ledgerDirectory))return null;
      if(hasLinkedAncestor(this.ledgerDirectory))throw Error('Linked ledger denied.');
      const file=this.file(id);if(!fsSync.existsSync(file))return null;if(hasLinkedAncestor(file))throw Error('Linked ledger file denied.');
      const raw=await fs.readFile(file,'utf8'); if(raw.length>128*1024)throw Error('Oversize ledger.');
      const o=JSON.parse(raw) as NativeTaskObservation;
      if(o.schema!=='datapass.native-task-observation/1' || o.taskId!==id)throw Error('Invalid task ledger.');
      if(['SPAWN_INTENT','RUNNING','NEEDS_INPUT'].includes(o.state))return {...o,state:'UNCERTAIN',reason:'Prior owned process outcome is unknown; no blind retry or automatic resume.'};
      return o;
    }catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}
  }
  async cancel(id:string):Promise<NativeTaskObservation> {
    const live=this.live.get(id);if(!live)throw Error('Cancel is limited to an active process owned by this host instance.');return live.cancel();
  }
  async dispose():Promise<void> { await Promise.allSettled([...this.live.values()].map(t=>t.cancel())); }
  async start(input:PreparedNativeTask, reviewedHash:string, stillAuthorized:()=>boolean=()=>true):Promise<NativeTaskHandle> {
    const task=structuredClone(input), {schema,preparedHash,...i}=task;
    if(schema!=='datapass.native-task/1' || prepareNativeTask(i).preparedHash!==preparedHash || reviewedHash!==preparedHash || !stillAuthorized())throw Error('Exact prepared task approval is required.');
    const preflight=await preflightNativeTransport(task.selection);if(preflight.state!=='READY')throw Error('Native startup blocked: '+preflight.reasons.join(' '));
    let resumeId:string|undefined;
    if(task.resumeFromTaskId){
      const prior=await this.lookup(task.resumeFromTaskId);
      if(!prior || !['COMPLETED','INTERRUPTED'].includes(prior.state) || prior.quiescence!=='NATIVE_TURN_SETTLED' || !prior.sessionId || prior.selectionHash!==nativeHash(task.selection) || prior.targetHash!==task.targetHash || prior.permissionHash!==task.permissionHash || prior.configHash!==task.configHash || prior.presetHash!==task.presetHash || prior.bindingHash!==task.bindingHash || prior.scopeHash!==task.scopeHash || prior.configScopeHash!==task.configScopeHash)throw Error('Resume requires an owned settled native session with unchanged reviewed target, configuration and permission.');
      resumeId=prior.sessionId;
    }
    await fs.mkdir(this.ledgerDirectory,{recursive:true});
    if(hasLinkedAncestor(this.ledgerDirectory) || !stillAuthorized())throw Error('Owned ledger/authority changed before launch.');
    const filename=this.file(task.taskId), selection=task.selection;
    let observation:NativeTaskObservation={schema:'datapass.native-task-observation/1',taskId:task.taskId,preparedHash,selectionHash:nativeHash(selection),targetHash:task.targetHash,permissionHash:task.permissionHash,configHash:task.configHash,presetHash:task.presetHash,promptHash:task.promptHash,bindingHash:task.bindingHash,scopeHash:task.scopeHash,configScopeHash:task.configScopeHash,state:'SPAWN_INTENT',sessionId:resumeId??null,turnId:null,sequence:0,requestedIdentity:selection.requestedIdentity,observedIdentity:{model:null,effort:null,accountId:null},resultText:'',resultHash:null,reason:null,updatedAt:new Date().toISOString(),evidence:'NO_COMPLETION_EVIDENCE',quiescence:'UNKNOWN'};
    // Exclusive durable intent is committed BEFORE spawn; a failed/uncertain start is never retried.
    const intent=await fs.open(filename,'wx',0o600);try{await intent.writeFile(JSON.stringify(observation));await intent.sync();}finally{await intent.close();}
    // A session lease prevents concurrent different task IDs from resuming the same thread.
    const lease=resumeId?path.join(this.ledgerDirectory,'session-'+nativeHash(resumeId)+'.lease'):undefined;
    if(lease){const fd=await fs.open(lease,'wx',0o600);try{await fd.writeFile(task.taskId);await fd.sync();}finally{await fd.close();}}
    const repoLeases:string[]=[];
    if(selection.permission==='workspace-write'){
      const identity=await readNativeRepositoryIdentity(selection.cwd);
      const keys=[nativeHash({host:identity.remoteHost,repo:identity.repoId.toLowerCase()}),nativeHash(process.platform==='win32'?identity.commonDirectory.toLowerCase():identity.commonDirectory)];
      try{for(const key of [...new Set(keys)].sort()){const file=path.join(this.ledgerDirectory,'repo-'+key+'.lease'),fd=await fs.open(file,'wx',0o600);try{await fd.writeFile(JSON.stringify({taskId:task.taskId,preparedHash,identityHash:nativeHash(identity)}));await fd.sync();}finally{await fd.close();}repoLeases.push(file);}}catch(e){for(const file of repoLeases)await fs.unlink(file);throw Error('Another owned native writer or uncertain write lease holds this canonical repository.');}
    }
    let child:ChildProcessWithoutNullStreams|undefined, finished=false, cancelRequested=false, cliCompleted=false, nativeTerminal=false, buffer='', resultText='', queued:Promise<void>=Promise.resolve();
    let complete!:(value:NativeTaskObservation)=>void;
    const result=new Promise<NativeTaskObservation>(resolve=>{complete=resolve;});
    const listeners=new Set<(event:NativeTaskEvent)=>void>();
    const snapshot=()=>structuredClone(observation);
    const persist=async(value:NativeTaskObservation)=>{const temporary=filename+'.'+randomUUID()+'.tmp',fd=await fs.open(temporary,'wx',0o600);try{await fd.writeFile(JSON.stringify(value));await fd.sync();}finally{await fd.close();}await fs.rename(temporary,filename);};
    const emit=(type:NativeTaskEvent['type'])=>{for(const fn of listeners)try{fn({type,observation:snapshot()});}catch{/* consumer cannot alter transport */}};
    const update=async(fields:Partial<NativeTaskObservation>,type:NativeTaskEvent['type']='STATE')=>{const next={...observation,...fields,sequence:observation.sequence+1,updatedAt:new Date().toISOString()};await persist(next);observation=next;emit(type);};
    const enqueue=(action:()=>Promise<void>)=>{queued=queued.then(action).catch(()=>{finished=true;observation={...observation,state:'UNCERTAIN',reason:'Durable native state commit failed; do not retry.'};child?.kill();clearTimeout(timeout);clearInterval(authorityWatch);this.live.delete(task.taskId);complete(snapshot());});};
    const finish=async(state:NativeTaskState,reason:string|null=null,settled=false)=>{
      if(finished)return;finished=true;clearTimeout(timeout);clearInterval(authorityWatch);
      await update({state,reason,resultText:bounded(resultText,32*1024),resultHash:resultText?nativeHash(bounded(resultText,32*1024)):null,evidence:state==='COMPLETED'?'NATIVE_REPORTED':'NO_COMPLETION_EVIDENCE',quiescence:settled?'NATIVE_TURN_SETTLED':'UNKNOWN'});
      if(lease && settled)await fs.unlink(lease);
      if(settled)for(const file of repoLeases)await fs.unlink(file);
      this.live.delete(task.taskId);complete(snapshot());
      // Only this child is owned; no process search, external session kill or tree-wide termination.
      child?.stdin.end();child?.kill();
    };
    const send=(value:unknown)=>{if(!child || !child.stdin.writable)throw Error('Owned native stdin closed.');child.stdin.write(JSON.stringify(value)+'\n');};
    const cancel=async()=>{
      if(finished)return snapshot();cancelRequested=true;
      if(selection.transport==='codex-app-server' && observation.sessionId && observation.turnId){send({id:4,method:'turn/interrupt',params:{threadId:observation.sessionId,turnId:observation.turnId}});}
      else child?.kill();
      // Acknowledgement/exit determines the state; merely requesting a kill is not completion.
      return snapshot();
    };
    const handle:NativeTaskHandle={taskId:task.taskId,observation:snapshot,result,subscribe:fn=>{if(listeners.size>=20)throw Error('Native subscription bound exceeded.');listeners.add(fn);return {dispose:()=>listeners.delete(fn)};},cancel};
    this.live.set(task.taskId,{handle,cancel});
    const timeout=setTimeout(()=>{enqueue(()=>finish('UNCERTAIN','Native completion deadline reached; owned process cancellation requested, no automatic retry.'));},10*60*1000);
    const authorityWatch=setInterval(()=>{if(!finished && !stillAuthorized())enqueue(()=>finish('UNCERTAIN','Reviewed authority was revoked; owned process stopped, native descendants require reconciliation.'));},250);
    const threadParams={cwd:selection.cwd,model:selection.requestedIdentity.model,approvalPolicy:'never',sandbox:selection.permission==='read-only'?'readOnly':'workspaceWrite',...(resumeId?{threadId:resumeId}:{})};
    const turnParams=()=>({threadId:observation.sessionId,input:[{type:'text',text:task.text}],cwd:selection.cwd,model:selection.requestedIdentity.model,...(selection.requestedIdentity.effort?{effort:selection.requestedIdentity.effort}:{}),approvalPolicy:'never',sandboxPolicy:selection.permission==='read-only'?{type:'readOnly'}:{type:'workspaceWrite',writableRoots:[selection.cwd],networkAccess:false}});
    const consume=async(message:any)=>{
      if(finished)return;if(!stillAuthorized()){await cancel();return;}
      if(selection.transport==='codex-app-server'){
        if(message.error){await finish('FAILED','Native protocol request failed.');return;}
        if(message.id===0 && message.result){send({method:'initialized',params:{}});send({id:1,method:resumeId?'thread/resume':'thread/start',params:threadParams});return;}
        if(message.id===1 && message.result?.thread){
          const thread=message.result.thread;if(!nativeIdOk(thread.id) || resumeId && thread.id!==resumeId){await finish('UNCERTAIN','Native thread identity mismatch.');return;}
          await update({sessionId:thread.id,observedIdentity:{model:typeof message.result.model==='string'?bounded(message.result.model,160):null,effort:null,accountId:null}});
          send({id:2,method:'turn/start',params:turnParams()});return;
        }
        if(message.id===2 && message.result?.turn){const t=message.result.turn;if(!nativeIdOk(t.id)){await finish('UNCERTAIN','Invalid native turn identity.');return;}await update({turnId:t.id});return;}
        if(message.method && message.id!==undefined){
          // Never synthesize security decisions from ordinary text or auto-accept permissions.
          send({id:message.id,error:{code:-32000,message:'Agent transport requires native/manual handling for server requests.'}});
          await finish('INTERRUPTED','Native input/security request requires the owned native interface; refused automatically.');return;
        }
        const p=message.params;
        if(!p || p.threadId!==observation.sessionId || observation.turnId && (p.turnId??p.turn?.id)!==observation.turnId)return;
        if(message.method==='item/agentMessage/delta'){await update({},'PROGRESS');return;}
        if(message.method==='item/completed' && p.item?.type==='agentMessage' && typeof p.item.text==='string'){resultText=bounded(p.item.text,32*1024);await update({resultText,resultHash:nativeHash(resultText)},'MESSAGE');}
        if(message.method==='turn/completed'){
          if(!observation.turnId && nativeIdOk(p.turn?.id))await update({turnId:p.turn.id});
          if(p.turn?.id!==observation.turnId){await finish('UNCERTAIN','Native completion identity mismatch.');return;}
          if(!['completed','failed','interrupted'].includes(p.turn.status)){await finish('UNCERTAIN','Unknown native terminal status; retain owned leases.');return;}
          await finish(p.turn.status==='completed'?'COMPLETED':p.turn.status==='interrupted'?'INTERRUPTED':'FAILED',p.turn.status==='completed'?null:'Native turn did not complete successfully.',true);
        }
      }else if(selection.transport==='codex-cli'){
        if(message.type==='thread.started' && nativeIdOk(message.thread_id)){
          if(resumeId && resumeId!==message.thread_id){await finish('UNCERTAIN','Resumed native session mismatch.');return;}
          await update({sessionId:message.thread_id});
        }else if(message.type==='item.completed' && message.item?.type==='agent_message' && typeof message.item.text==='string'){resultText=bounded(message.item.text,32*1024);await update({resultText,resultHash:nativeHash(resultText)},'MESSAGE');}
        else if(message.type==='turn.completed'){if(observation.sessionId){cliCompleted=true;nativeTerminal=true;}else await finish('UNCERTAIN','Native session identity missing.');}
        else if(message.type==='turn.failed'){nativeTerminal=true;await update({reason:'Native CLI reported failed turn.'});}
        else if(message.type==='error')await finish('FAILED','Native CLI reported failure.');
        else if(message.type==='item.started')await update({},'PROGRESS');
      }else {
        if(message.type==='system' && message.subtype==='init'){
          if(!nativeIdOk(message.session_id) || resumeId && resumeId!==message.session_id){await finish('UNCERTAIN','Native session identity mismatch.');return;}
          await update({sessionId:message.session_id,observedIdentity:{model:typeof message.model==='string'?bounded(message.model,160):null,effort:null,accountId:null}});
        }else if(message.type==='stream_event')await update({},'PROGRESS');
        else if(message.type==='assistant'){
          const text=Array.isArray(message.message?.content)?message.message.content.filter((b:any)=>b.type==='text'&&typeof b.text==='string').map((b:any)=>b.text).join('\n'):'';
          if(text){resultText=bounded(text,32*1024);await update({resultText,resultHash:nativeHash(resultText)},'MESSAGE');}
        }else if(message.type==='result'){
          if(message.session_id!==observation.sessionId){await finish('UNCERTAIN','Native result session mismatch.');return;}
          if(typeof message.result==='string')resultText=bounded(message.result,32*1024);
          nativeTerminal=true;if(!message.is_error && message.subtype==='success')cliCompleted=true;else await update({reason:'Native CLI reported failed result.'});
        }
      }
    };
    try {
      if(!stillAuthorized())throw Error('Native authority revoked before spawn.');
      child=this.spawnProcess(selection.executable,nativeLaunchArguments(task,resumeId),{cwd:selection.cwd,env:nativeEnvironment(selection),windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']}) as ChildProcessWithoutNullStreams;
      child.on('error',()=>enqueue(()=>finish('UNCERTAIN','Native process startup outcome uncertain; no blind retry.')));
      child.stdin.on('error',()=>enqueue(()=>finish('UNCERTAIN','Native stdin failed after launch; no blind retry.')));
      child.on('spawn',()=>enqueue(async()=>{await update({state:'RUNNING'});if(selection.transport==='codex-app-server')send({id:0,method:'initialize',params:{clientInfo:{name:'datapass_agent',title:'DataPass Agent',version:'1.0.0'}}});else child!.stdin.end(task.text+'\n');}));
      let totalBytes=0,totalRecords=0;
      child.stdout.setEncoding('utf8');child.stdout.on('data',(data:string)=>{
        if(finished)return;buffer+=data;
        totalBytes+=Buffer.byteLength(data);
        if(buffer.length>1024*1024 || totalBytes>8*1024*1024){enqueue(()=>finish('UNCERTAIN','Native output exceeded bounded parser limit.'));return;}
        let newline:number;while((newline=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);if(!line.trim())continue;if(++totalRecords>20000){enqueue(()=>finish('UNCERTAIN','Native event count exceeded bounded parser limit.'));return;}try{const message=JSON.parse(line);enqueue(()=>consume(message));}catch{enqueue(()=>finish('UNCERTAIN','Malformed native event; no retry.'));}}
      });
      // Stderr is never published: native diagnostics may carry paths, tokens or reasoning.
      child.stderr.on('data',()=>{});
      child.on('close',(code,signal)=>enqueue(async()=>{if(buffer.trim()){try{await consume(JSON.parse(buffer));}catch{await finish('UNCERTAIN','Incomplete native event on process close.');}}if(!finished)await finish(cancelRequested?'INTERRUPTED':code===0&&cliCompleted?'COMPLETED':nativeTerminal?'FAILED':code===0?'UNCERTAIN':'FAILED',cancelRequested?'Owned process cancellation observed.':code===0&&cliCompleted?null:'Native process exited without a matching successful completion event.',!cancelRequested&&nativeTerminal);}));
    }catch{await finish('UNCERTAIN','Native spawn attempt could not be confirmed; intent is retained, no blind retry.');}
    return handle;
  }
}
