import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Request, Scope } from '../cockpit/interfaces';
import { ScopePolicy, digest, repoId } from '../cockpit/policy';
import { NativeSelection, NativeTaskInput, PreparedNativeTask, hashOk, nativeHash, nativeTransportVersion, preflightNativeTransport, prepareNativeTask } from './nativeTransport';
import { NativeTaskRunner, NativeTaskObservation, NativeTaskEvent, NativeTaskHandle } from './nativeRunner';
import { NativeProjectScopeInput, verifyNativeProjectScope } from './nativeProjectScope';
import { NativeStartupManifest, captureNativeStartupManifest, nativeStartupReviewHash } from './nativeStartup';
import type { NativePreflight } from './nativeTransport';

export interface NativeRoleRuntime { bindingHash:string;scopeHash:string;state:'RUNNING'|'STOPPED'|'UNKNOWN';nativeSessionId:string|null;nativeReceiptRef:string|null;observedAt:string|null; }
export interface NativeTransportApi {
  readonly major:1;readonly version:typeof nativeTransportVersion;
  reviewProjectScope(input:NativeProjectScopeInput):Promise<{approved:boolean;scope:Scope|null;epoch:number;scopeHash:string|null}>;
  captureStartup(request:Request,selection:NativeSelection):Promise<{manifest:NativeStartupManifest;configurationHash:string;reviewHash:string;verification:NativePreflight['verification']}>;
  preflight(request:Request,selection:NativeSelection):ReturnType<typeof preflightNativeTransport>;
  prepare(request:Request,input:NativeTaskInput):Promise<PreparedNativeTask>;
  review(request:Request,preparedHash:string):Promise<{approved:boolean;preparedHash:string}>;
  start(request:Request,input:{taskId:string;preparedHash:string}):Promise<NativeTaskObservation>;
  lookup(request:Request,input:{taskId:string}):Promise<NativeTaskObservation|null>;
  cancel(request:Request,input:{taskId:string}):Promise<NativeTaskObservation>;
  subscribe(request:Request,input:{taskId:string},listener:(event:NativeTaskEvent)=>void):Promise<{dispose():void}>;
  getRoleRuntime(input:{bindingHash:string;scopeHash:string}):Promise<NativeRoleRuntime>;
}
/** Only this host-owned facade is exported by the installed Agent; observer scope does not grant execution. */
export class NativeTransportFacade {
  readonly api:NativeTransportApi;
  private preparations=new Map<string,{task:PreparedNativeTask;request:Request;epoch:number;approved:boolean}>();
  private handles=new Map<string,NativeTaskHandle>();
  private executionPolicies=new Map<string,ScopePolicy>();
  private projectScopes=new Map<string,NativeProjectScopeInput>();
  constructor(private runner:NativeTaskRunner,private policy:ScopePolicy,private hostId:string,private review:(task:PreparedNativeTask)=>Promise<boolean>,private trusted:()=>boolean=()=>true,private reviewProject:(input:NativeProjectScopeInput)=>Promise<boolean>=async()=>false){
    this.api=Object.freeze({major:1 as const,version:nativeTransportVersion,
      reviewProjectScope:async(i:NativeProjectScopeInput)=>this.projectScope(i),
      captureStartup:async(r:Request,s:NativeSelection)=>{this.selection(r,s);const selection=structuredClone(s),manifest=await captureNativeStartupManifest(selection);selection.startup.manifest=manifest;selection.startup.configurationHash=manifest.manifestHash;selection.startup.reviewHash=nativeStartupReviewHash(selection,manifest);const check=await this.runner.preflight(selection);return {manifest,configurationHash:manifest.manifestHash,reviewHash:selection.startup.reviewHash,verification:check.verification};},
      preflight:async(r:Request,s:NativeSelection)=>{this.selection(r,s);return this.runner.preflight(s);},
      prepare:async(r:Request,i:NativeTaskInput)=>this.prepare(r,i),
      review:async(r:Request,h:string)=>this.approve(r,h),
      start:async(r:Request,i:{taskId:string;preparedHash:string})=>this.start(r,i),
      lookup:async(r:Request,i:{taskId:string})=>this.lookup(r,i.taskId),
      cancel:async(r:Request,i:{taskId:string})=>{await this.lookupRequired(r,i.taskId);return this.runner.cancel(i.taskId);},
      subscribe:async(r:Request,i:{taskId:string},listener:(event:NativeTaskEvent)=>void)=>{await this.lookupRequired(r,i.taskId);const handle=this.handles.get(i.taskId);if(!handle)throw Error('Owned live stream unavailable; poll the durable ledger.');return handle.subscribe(event=>{if(this.allowed(r,event.observation))listener(event);});},
      getRoleRuntime:async(i:{bindingHash:string;scopeHash:string})=>this.roleRuntime(i)});
  }
  private activePolicy(r:Request):ScopePolicy|undefined {const execution=this.executionPolicies.get(r?.scope?.scopeId);return execution?.authorize(r)?execution:this.policy.authorize(r)?this.policy:undefined;}
  private async projectScope(input:NativeProjectScopeInput){
    const i=structuredClone(input);if(!this.trusted())throw Error('Trusted owned workspace is required.');await verifyNativeProjectScope(i);
    const {revision,...stable}=i,scopeId='native-project:'+nativeHash(stable).slice(0,32),existing=this.executionPolicies.get(scopeId);
    if(existing && nativeHash(this.projectScopes.get(scopeId))===nativeHash(i)){const scope=existing.scopes()[0];return {approved:true,scope,epoch:existing.epoch,scopeHash:digest(scope)};}
    const approved=await this.reviewProject(i);if(!approved)return {approved:false,scope:null,epoch:existing?.epoch??0,scopeHash:null};
    if(!this.trusted())throw Error('Workspace trust changed during local review.');await verifyNativeProjectScope(i);
    const scope:Scope={scopeId,organizationIds:[i.organizationId],privacyDomainIds:[i.privacyDomainId],projectIds:[i.projectId],repoIds:[repoId(i.root)],sourceVectorHash:i.sourceVectorHash,policyHash:i.policyHash};
    if(!existing && this.executionPolicies.size>=100)throw Error('Native project scope bound exceeded.');const policy=existing??new ScopePolicy();
    policy.set({scope,roots:[i.root],sessionKeys:[],configuration:false,exportConsent:false});this.executionPolicies.set(scopeId,policy);this.projectScopes.set(scope.scopeId,i);
    return {approved:true,scope:structuredClone(scope),epoch:policy.epoch,scopeHash:digest(scope)};
  }
  private selection(r:Request,s:NativeSelection):void {
    const p=this.activePolicy(r),g=p?.authorize(r);
    if(!this.trusted() || !g || s.hostId!==this.hostId || !g.roots.includes(s.cwd) || !g.scope.repoIds.includes(repoId(s.cwd)))throw Error('Reviewed Agent target and current trusted host scope are required.');
  }
  private allowed(r:Request,o:NativeTaskObservation):boolean{return !!this.activePolicy(r) && this.trusted() && digest(r.scope)===o.scopeHash;}
  private async prepare(r:Request,i:NativeTaskInput):Promise<PreparedNativeTask>{
    const request=structuredClone(r),task=prepareNativeTask(i);this.selection(request,task.selection);
    const project=this.projectScopes.get(request.scope.scopeId);if(project)await verifyNativeProjectScope(project);
    if(task.scopeHash!==digest(request.scope))throw Error('Exact reviewed scope hash mismatch.');
    if(this.preparations.size>=100)throw Error('Prepared native task bound exceeded.');
    if(await this.runner.lookup(task.taskId))throw Error('Task already has a durable spawn intent; do not retry.');
    this.preparations.set(task.preparedHash,{task,request,epoch:this.activePolicy(request)!.epoch,approved:false});return structuredClone(task);
  }
  private prepared(r:Request,hash:string){
    const p=this.preparations.get(hash);
    if(!p || p.epoch!==this.activePolicy(r)?.epoch || digest(r.scope)!==p.task.scopeHash || !this.trusted())throw Error('Prepared native task scope/epoch is stale or unavailable.');
    this.selection(r,p.task.selection);return p;
  }
  private async approve(r:Request,hash:string):Promise<{approved:boolean;preparedHash:string}>{
    const p=this.prepared(r,hash),check=await this.runner.preflight(p.task.selection);
    if(check.state!=='READY')throw Error('Native startup effects or capabilities are blocked: '+check.reasons.join(' '));
    const accepted=await this.review(structuredClone(p.task));
    this.prepared(r,hash);p.approved=accepted;return {approved:accepted,preparedHash:hash};
  }
  private async start(r:Request,i:{taskId:string;preparedHash:string}):Promise<NativeTaskObservation>{
    const p=this.prepared(r,i.preparedHash);if(!p.approved || p.task.taskId!==i.taskId)throw Error('Independent exact host-owned execution approval is required.');
    const project=this.projectScopes.get(r.scope.scopeId);if(project)await verifyNativeProjectScope(project);
    // Consume approval before asynchronous spawn to block duplicate callers.
    p.approved=false;
    const handle=await this.runner.start(p.task,i.preparedHash,()=>this.trusted() && p.epoch===this.activePolicy(p.request)?.epoch);
    this.handles.set(i.taskId,handle);void handle.result.finally(()=>this.handles.delete(i.taskId));return handle.observation();
  }
  private async lookup(r:Request,id:string):Promise<NativeTaskObservation|null>{
    if(!this.activePolicy(r) || !this.trusted())throw Error('Reviewed Agent scope is required.');
    const o=await this.runner.lookup(id);if(o && !this.allowed(r,o))throw Error('Owned native task is outside this reviewed scope.');return o;
  }
  private async lookupRequired(r:Request,id:string):Promise<NativeTaskObservation>{const o=await this.lookup(r,id);if(!o)throw Error('Owned native task unavailable.');return o;}
  private async roleRuntime(i:{bindingHash:string;scopeHash:string}):Promise<NativeRoleRuntime>{
    const unknown:NativeRoleRuntime={...i,state:'UNKNOWN',nativeSessionId:null,nativeReceiptRef:null,observedAt:null};
    if(!hashOk(i.bindingHash) || !hashOk(i.scopeHash) || !this.trusted())return unknown;
    let files:string[];try{files=await fs.readdir(this.runner.ledgerDirectory);}catch{return unknown;}
    const names=files.filter(f=>/^[a-f0-9]{64}\.json$/.test(f));if(names.length>1000)return unknown;
    const matches:NativeTaskObservation[]=[];
    for(const f of names){try{const raw=await fs.readFile(path.join(this.runner.ledgerDirectory,f),'utf8');if(raw.length>128*1024)continue;const o=JSON.parse(raw);if(o.bindingHash===i.bindingHash && o.configScopeHash===i.scopeHash && [...this.policy.scopes(),...[...this.executionPolicies.values()].flatMap(p=>p.scopes())].some(s=>digest(s)===o.scopeHash)){const current=await this.runner.lookup(o.taskId);if(current)matches.push(current);}}catch{/* unavailable/corrupt native receipt stays unknown */}}
    const o=matches.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0];if(!o || !o.sessionId || !['RUNNING','NEEDS_INPUT','COMPLETED','INTERRUPTED','FAILED'].includes(o.state) || ['COMPLETED','INTERRUPTED','FAILED'].includes(o.state) && o.quiescence!=='NATIVE_TURN_SETTLED')return unknown;
    return {...i,state:['RUNNING','NEEDS_INPUT'].includes(o.state)?'RUNNING':'STOPPED',nativeSessionId:o.sessionId,nativeReceiptRef:nativeHash(o),observedAt:o.updatedAt};
  }
  async dispose():Promise<void>{this.preparations.clear();for(const policy of this.executionPolicies.values())policy.clear();this.executionPolicies.clear();this.projectScopes.clear();await this.runner.dispose();}
}
