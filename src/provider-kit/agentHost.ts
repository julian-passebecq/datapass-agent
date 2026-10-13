import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AhpClient, AhpTransport, ClientEvent } from '@microsoft/agent-host-protocol/client';
import type { AgentInfo, ChatState, SessionState, Snapshot, ActionEnvelope, ChatAction, SessionModelInfo } from '@microsoft/agent-host-protocol';
import { canonicalJson } from '../galaxy';
import { bounded } from '../util/redact';
import { idOk, repoId, validateRequest } from '../cockpit/policy';
import type { Request } from '../cockpit/interfaces';
import type { AHPBinding, AHPHost, AHPInspection, AHPPrepared, AHPObservation, AHPReply, AHPState, AgentHostApi, AHPApproval } from './agentHostTypes';
export * from './agentHostTypes';
export const ahpHash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
export const ahpTextHash=(value:string)=>createHash('sha256').update(value).digest('hex');
const ROOT='ahp-root://', versions=['1.0.0','0.9.0'];
/** Exact Stable/Insiders native schema key; no permission/config enum guessing. */
export function qualifiedAHPEfforts(provider:string,model:SessionModelInfo):string[]{
  const allowed=provider==='codex'?['none','minimal','low','medium','high','xhigh','max','ultra']:provider==='claude'?['low','medium','high','xhigh','max']:[];
  const property=model.configSchema?.properties?.thinkingLevel;
  if(!allowed.length||!property||property.type!=='string'||property.readOnly||!Array.isArray(property.enum)||!property.enum.length||property.enum.length>allowed.length||property.enum.some(v=>typeof v!=='string'||!allowed.includes(v))||new Set(property.enum).size!==property.enum.length)return [];
  return property.enum as string[];
}
const sdk=()=>Promise.all([import('@microsoft/agent-host-protocol'),import('@microsoft/agent-host-protocol/client')]);
type SDK=Awaited<ReturnType<typeof sdk>>;
/** Only the extension host can register a connection. No transport/token is accepted in request JSON. */
export interface ReviewedAHPHost { host:AHPHost; scopeHash:string; root:string; revision:string; authorized():boolean; open():Promise<AhpTransport>; }
export interface AHPStorage { load():unknown; save(records:AHPLedger[]):Promise<void>; }
export interface AHPLedger { prepared:AHPPrepared; observation:AHPObservation; request:Request; clientId:string; phase:'PREPARED'|'CREATE_INTENT'|'SESSION_BOUND'|'SEND_INTENT'|'SENT'; integrityHash:string; }
interface Connection { descriptor:ReviewedAHPHost; client:AhpClient; sdk:SDK; agents:AgentInfo[]; protocolVersion:string; inventoryHash:string; sessions:Map<string,SessionState>; chats:Map<string,ChatState>; seq:Map<string,number>; active:boolean; }
export interface AHPServices {
  storage:AHPStorage; authorize(request:Request):boolean; sourceGrantCurrent?(request:Request):boolean; verifySource(binding:AHPBinding,request?:Request):Promise<boolean>;
  reviewProject(request:Request,binding:AHPBinding):Promise<boolean>;
  reviewConnection(request:Request,binding:AHPBinding):Promise<ReviewedAHPHost|null>;
  reviewTask(prepared:AHPPrepared):Promise<boolean>;
}
function bindingOk(b:AHPBinding,r:Request):boolean {
  return !!b && Object.keys(b).every(k=>['taskId','roleId','root','revision','authorityHash','preparedTaskHash','compiledPromptHash','configScopeHash','presetHash','provider','requestedModel','requestedEffort','prompt','promptHash','requestedMode','testPolicyHash','outputPolicyHash','taskRevision'].includes(k)) && (b.taskRevision===undefined||Number.isSafeInteger(b.taskRevision)&&b.taskRevision>0) && [b.taskId,b.roleId].every(idOk) && ['codex','claude'].includes(b.provider) && path.isAbsolute(b.root) && !/[\x00-\x1f]/.test(b.root) && /^[a-f0-9]{40}$/.test(b.revision) &&
    [b.authorityHash,b.preparedTaskHash,b.compiledPromptHash,b.configScopeHash,b.presetHash,b.promptHash].every(h=>typeof h==='string' && /^[a-f0-9]{64}$/.test(h)) &&
    typeof b.prompt==='string' && b.prompt.trim().length>0 && b.prompt.length<=32768 && ahpTextHash(b.prompt)===b.promptHash &&
    [b.testPolicyHash,b.outputPolicyHash].every(h=>h===undefined||typeof h==='string'&&/^[a-f0-9]{64}$/.test(h)) &&
    [b.requestedModel,b.requestedEffort??null].every(s=>s===null || typeof s==='string' && /^[a-zA-Z0-9_.:@/+ -]{1,160}$/.test(s)) && r.scope.repoIds.length>0;
}
const sameRoot=(a:string,b:string)=>path.resolve(a).replace(/\\/g,'/').toLowerCase()===path.resolve(b).replace(/\\/g,'/').toLowerCase();
const safeUri=(v:unknown,kind:'session'|'chat')=>typeof v==='string' && new RegExp('^ahp-'+kind+':/[a-zA-Z0-9._-]{1,160}$').test(v);
const ledgerHash=(r:Omit<AHPLedger,'integrityHash'>)=>ahpHash(r);
/** One approved ordinary action; capture time and preparation UUID are not a new task. */
const taskActionKey=(p:AHPPrepared)=>ahpHash({hostId:p.hostId,provider:p.binding.provider,root:process.platform==='win32'?path.resolve(p.binding.root).toLowerCase():path.resolve(p.binding.root),taskId:p.binding.taskId,taskRevision:p.binding.taskRevision??null,revisionGit:p.binding.revision,authorityHash:p.binding.authorityHash,promptHash:p.binding.promptHash});
/** Agent-owned protocol adapter. Native tools, approvals, auth and subagents remain on the host. */
export class AgentHostAdapter {
  readonly api:AgentHostApi;
  private hosts=new Map<string,ReviewedAHPHost>(); private connections=new Map<string,Connection>();
  private prepared=new Map<string,AHPPrepared>(); private records=new Map<string,AHPLedger>();
  private sourceGrants=new Map<string,string>(); private listeners=new Set<{request:Request;handleId:string;listener:(e:AHPObservation)=>void}>();
  private writes:Promise<void>=Promise.resolve(); private execution=new Set<string>(); private corrupt=false;
  constructor(private services:AHPServices) {
    const stored=services.storage.load();
    if(stored!==undefined)try{if(!Array.isArray(stored)||stored.length>100)throw Error();for(const item of stored){const {integrityHash,...rest}=item as AHPLedger;if(integrityHash!==ledgerHash(rest)||!idOk(item.observation?.handleId)||item.prepared?.preparedHash!==ahpHash({...item.prepared,preparedHash:undefined}))throw Error();this.records.set(item.observation.handleId,structuredClone(item));this.prepared.set(item.prepared.preparedHash,structuredClone(item.prepared));}}catch{this.corrupt=true;}
    this.api={major:1,inspect:i=>this.inspect(i.request,i.target.provider,i.target.hostId),reviewProject:i=>this.reviewProject(i.request,i.binding),reviewHostConnection:i=>this.reviewConnection(i.request,i.binding),prepare:i=>this.prepare(i.request,i.binding,i.hostId),execute:i=>this.execute(i.request,i.preparedHash,i.approval),observe:i=>this.observe(i.request,i.handleId,false),recover:i=>this.observe(i.request,i.handleId,true),cancel:i=>this.cancel(i.request,i.handleId),reveal:async i=>this.reply(i.request,'UNAVAILABLE',{opened:false},'No documented public same-session Agents Window reveal action is qualified.'),subscribe:(i,listener)=>this.subscribe(i.request,i.handleId,listener)};
  }
  private reply<T>(r:Request,state:AHPState,data:T,message=''):AHPReply<T>{return {schema:'datapass.agent-host-reply/1',requestId:idOk(r?.requestId)?r.requestId:'invalid',scopeHash:r?.scope?ahpHash(r.scope):'',state,data:structuredClone(data),message:bounded(message,1000)};}
  private authorized(r:Request,b?:AHPBinding):boolean{return validateRequest(r) && this.services.sourceGrantCurrent?.(r)!==false && (!b||bindingOk(b,r)) && (this.services.authorize(r)||this.sourceGrants.get(ahpHash(r.scope))===ahpHash({scope:r.scope,epoch:r.epoch??null,root:b?.root??this.rootFor(r)}));}
  private reviewedRoots=new Map<string,string>();
  private reviewedBindings=new Map<string,AHPBinding>();
  private rootFor(r:Request):string|undefined {return this.reviewedRoots.get(ahpHash(r.scope)) ?? [...this.records.values()].find(x=>x.observation.scopeHash===ahpHash(r.scope))?.observation.root ?? [...this.prepared.values()].find(x=>x.scopeHash===ahpHash(r.scope))?.binding.root;}
  async reviewProject(r:Request,b:AHPBinding):Promise<AHPReply<{authorized:boolean}>>{
    if(!validateRequest(r)||!bindingOk(b,r)||!await this.services.verifySource(b,r))return this.reply(r,'DENIED',{authorized:false},'Exact source root/revision is unavailable.');
    if(!await this.services.reviewProject(r,structuredClone(b))||!await this.services.verifySource(b,r))return this.reply(r,'DENIED',{authorized:false},'Source review declined or source changed.');
    this.sourceGrants.set(ahpHash(r.scope),ahpHash({scope:r.scope,epoch:r.epoch??null,root:b.root}));this.reviewedRoots.set(ahpHash(r.scope),b.root);this.reviewedBindings.set(ahpHash(r.scope),structuredClone(b)); return this.reply(r,'AHP_AVAILABLE',{authorized:true});
  }
  async reviewConnection(r:Request,b:AHPBinding):Promise<AHPReply<AHPInspection>>{
    if(!this.authorized(r,b)||!await this.services.verifySource(b,r))return this.reply(r,'DENIED',this.empty('DENIED'),'Review exact source scope first.');
    let selection:ReviewedAHPHost|null;try{selection=await this.services.reviewConnection(r,structuredClone(b));}catch{return this.reply(r,'UNAVAILABLE',this.empty('UNAVAILABLE'),'Selected endpoint unavailable, unsafe or stale; credentials and raw connection errors are not exposed.');}
    if(!selection)return this.reply(r,'UNAVAILABLE',this.empty('UNAVAILABLE'),'No reviewed endpoint or connection authorization; actual host liveness is unknown. No host is started automatically.');
    if(!this.authorized(r,b)||!await this.services.verifySource(b,r)||selection.scopeHash!==ahpHash(r.scope)||!sameRoot(selection.root,b.root)||selection.revision!==b.revision||!selection.authorized())return this.reply(r,'DENIED',this.empty('DENIED'),'Host connection authority does not match this source scope.');
    this.registerHost(selection);return this.inspect(r,b.provider,selection.host.hostId,b);
  }
  /** Host-owned only; synthetic fixtures use this same entry point with explicit SYNTHETIC identity. */
  registerHost(selection:ReviewedAHPHost):void {
    if(!idOk(selection.host.hostId)||!['SYNTHETIC','VSCODE_AGENT_HOST','STANDALONE_AGENT_HOST'].includes(selection.host.kind)||!/^[a-f0-9]{64}$/.test(selection.host.identityHash)||!selection.authorized())throw Error('Invalid independently reviewed host connection.');
    const previous=this.hosts.get(selection.host.hostId); if(previous&&previous.host.identityHash!==selection.host.identityHash)throw Error('Ambiguous host identity.');
    this.hosts.set(selection.host.hostId,selection);
  }
  private empty(state:AHPState):AHPInspection {return {state,hosts:[],providers:[],capabilities:[],selectedHostId:null,protocolVersion:null,sessions:[],message:state==='HOST_NOT_RUNNING'?'No reviewed running endpoint.':'Review the exact source and local host connection separately.'};}
  private async connect(host:ReviewedAHPHost):Promise<Connection> {
    const existing=this.connections.get(host.host.hostId);if(existing?.active)return existing;
    if(!host.authorized())throw Error('DENIED');
    const libs=await sdk(),transport=await host.open(); if(!host.authorized()){await transport.close();throw Error('DENIED');}
    const client=new libs[1].AhpClient(transport,{requestTimeoutMs:5000,subscriptionBuffer:512});
    const c:Connection={descriptor:host,client,sdk:libs,agents:[],protocolVersion:'',inventoryHash:'',sessions:new Map(),chats:new Map(),seq:new Map(),active:true};
    const stream=client.events();client.connect();
    try {
      const init=await client.initialize({clientId:'datapass-agent-'+host.host.identityHash.slice(0,24),protocolVersions:versions,initialSubscriptions:[ROOT]});
      if(!versions.includes(init.protocolVersion))throw Error('PROTOCOL_UNSUPPORTED');
      c.protocolVersion=init.protocolVersion;
      for(const snap of init.snapshots)this.snapshot(c,snap);
      c.inventoryHash=ahpHash(this.inventory(c));this.connections.set(host.host.hostId,c);
      void this.pump(c,stream);void this.monitor(c);
      return c;
    }catch(error){await client.shutdown();throw error;}
  }
  private inventory(c:Connection){return c.agents.slice(0,30).map(a=>({provider:bounded(a.provider,160),state:a.models.length?'AHP_AVAILABLE' as const:'AUTH_REQUIRED' as const,models:a.models.slice(0,100).filter(m=>m.provider&&m.id&&m.policyState!=='disabled').map(m=>({id:bounded(m.id,160),provider:bounded(m.provider,160),name:bounded(m.name,160),efforts:qualifiedAHPEfforts(a.provider,m)}))}));}
  private snapshot(c:Connection,s:Snapshot):void{
    if(!Number.isSafeInteger(s.fromSeq)||s.fromSeq<0)throw Error('Malformed snapshot');
    c.seq.set(s.resource,s.fromSeq);
    if(s.resource===ROOT){const state=s.state as {agents:AgentInfo[]};if(!Array.isArray(state.agents)||state.agents.length>100)throw Error('Malformed inventory');c.agents=state.agents;}
    else if(safeUri(s.resource,'session'))c.sessions.set(s.resource,s.state as SessionState);
    else if(safeUri(s.resource,'chat'))c.chats.set(s.resource,s.state as ChatState);
  }
  private async pump(c:Connection,stream:AsyncIterable<ClientEvent>):Promise<void>{
    try{for await(const event of stream){if(!c.active)break;if(!c.descriptor.authorized())throw Error('DENIED');
      if(event.event.type==='authRequired'){for(const rec of this.records.values())if(rec.observation.hostId===c.descriptor.host.hostId&&event.channel===rec.observation.chatId)this.transition(rec,'AUTH_REQUIRED','Native authentication is required.');continue;}
      if(event.event.type!=='action')continue;const env=event.event.params;
      if(!Number.isSafeInteger(env.serverSeq)||env.serverSeq<0)throw Error('Malformed sequence');
      if(env.serverSeq<=(c.seq.get(env.channel)??-1))continue;c.seq.set(env.channel,env.serverSeq);
      if(env.channel===ROOT)c.agents=c.sdk[0].rootReducer({agents:c.agents},env.action as Parameters<SDK[0]['rootReducer']>[1]).agents;
      else if(c.sessions.has(env.channel))c.sessions.set(env.channel,c.sdk[0].sessionReducer(c.sessions.get(env.channel)!,env.action as Parameters<SDK[0]['sessionReducer']>[1]));
      else if(c.chats.has(env.channel))c.chats.set(env.channel,c.sdk[0].chatReducer(c.chats.get(env.channel)!,env.action as ChatAction));
      for(const rec of this.records.values())if(rec.observation.hostId===c.descriptor.host.hostId&&[rec.observation.sessionId,rec.observation.chatId].includes(env.channel))await this.project(c,rec,env);
    }}catch{c.active=false;for(const rec of this.records.values())if(rec.observation.hostId===c.descriptor.host.hostId&&!['COMPLETED','FAILED','STOPPED'].includes(rec.observation.state))this.transition(rec,'UNCERTAIN','Host stream unavailable. Recovery never resends.');}
  }
  private async monitor(c:Connection){for await(const state of c.client.stateChanges())if(state.status==='closed'){c.active=false;for(const rec of this.records.values())if(rec.observation.hostId===c.descriptor.host.hostId&&!['COMPLETED','FAILED','STOPPED'].includes(rec.observation.state))this.transition(rec,'UNCERTAIN','Connection closed. Recover exact session; no retry.');}}
  async inspect(r:Request,provider:'codex'|'claude',hostId?:string,b?:AHPBinding):Promise<AHPReply<AHPInspection>>{
    if(!this.authorized(r,b)||!['codex','claude'].includes(provider))return this.reply(r,'DENIED',this.empty('DENIED'));
    const source=b??this.reviewedBindings.get(ahpHash(r.scope))??[...this.records.values()].find(x=>x.observation.scopeHash===ahpHash(r.scope))?.prepared.binding;
    if(source&&!await this.services.verifySource(source,r))return this.reply(r,'DENIED',this.empty('DENIED'),'Reviewed source root/revision or repository identity changed.');
    const hosts=[...this.hosts.values()].filter(h=>h.scopeHash===ahpHash(r.scope)&&h.authorized());
    if(!hosts.length)return this.reply(r,'UNAVAILABLE',this.empty('UNAVAILABLE'),'No reviewed endpoint or connection authorization; actual host liveness is unknown. Its credentials are not implicitly authorized.');
    const selected=hostId?hosts.find(h=>h.host.hostId===hostId):hosts.length===1?hosts[0]:undefined;
    if(!selected)return this.reply(r,'DENIED',{...this.empty('DENIED'),hosts:hosts.map(h=>h.host)},'Select one exact host. Multiple hosts cannot be inferred.');
    try{const c=await this.connect(selected);const providers=this.inventory(c),state=providers.find(p=>p.provider===provider)?.state??'PROVIDER_UNSUPPORTED';
      return this.reply(r,state,{state,hosts:hosts.map(h=>({...h.host,protocolVersion:h===selected?c.protocolVersion:null,connectionState:h===selected?'AHP_AVAILABLE':'UNAVAILABLE'})),providers,capabilities:['createSession','subscribe','chat/turnStarted','chat/delta','chat/turnComplete','ownedSnapshotRecovery','ownedCancel'],selectedHostId:selected.host.hostId,protocolVersion:c.protocolVersion,sessions:[...this.records.values()].filter(x=>x.observation.scopeHash===ahpHash(r.scope)&&x.observation.hostId===selected.host.hostId&&x.observation.sessionId).map(x=>({hostId:x.observation.hostId,sessionId:x.observation.sessionId!,taskId:x.observation.taskId})),message:'Negotiated public AHP. Provider inventory is observed; authentication remains native.'});
    }catch(error){const state=this.errorState(error);return this.reply(r,state,{...this.empty(state),hosts:[selected.host]},'Connection/negotiation unavailable; raw endpoint errors are suppressed.');}
  }
  private errorState(e:unknown):AHPState {const code=(e as {code?:number})?.code;return code===-32002?'PROVIDER_UNSUPPORTED':code===-32007||String(e).includes('AUTH_REQUIRED')?'AUTH_REQUIRED':code===-32005||String(e).includes('PROTOCOL_UNSUPPORTED')?'PROTOCOL_UNSUPPORTED':code===-32009?'PERMISSION_REQUIRED':String(e).includes('DENIED')?'DENIED':'UNAVAILABLE';}
  async prepare(r:Request,b:AHPBinding,hostId:string):Promise<AHPReply<AHPPrepared|null>>{
    if(!this.authorized(r,b)||!await this.services.verifySource(b,r))return this.reply(r,'DENIED',null,'Source scope, task or revision unavailable.');
    const inspection=await this.inspect(r,b.provider,hostId,b);if(inspection.state!=='AHP_AVAILABLE')return this.reply(r,inspection.state,null,inspection.message);
    const c=this.connections.get(hostId)!;const models=c.agents.find(a=>a.provider===b.provider)?.models.filter(m=>m.id===b.requestedModel&&m.policyState!=='disabled')??[];const model=models.length===1?models[0]:undefined;
    if(b.requestedMode&&b.requestedMode!=='DEFAULT')return this.reply(r,'PROVIDER_UNSUPPORTED',null,'Native PLAN/GOAL mode mapping is not qualified.');
    if(b.requestedModel&&!model)return this.reply(r,'PROVIDER_UNSUPPORTED',null,'Requested model is absent from this exact provider inventory.');
    if(b.requestedEffort&&(!model||!qualifiedAHPEfforts(b.provider,model).includes(b.requestedEffort)))return this.reply(r,'PROVIDER_UNSUPPORTED',null,'Requested effort is absent from the qualified thinkingLevel enum for this exact native model. No other configuration key or permission mapping is used.');
    const data={schema:'datapass.agent-host-prepared/1' as const,handleId:'ahp:'+randomUUID(),hostId,hostIdentityHash:c.descriptor.host.identityHash,protocolVersion:c.protocolVersion,scopeHash:ahpHash(r.scope),binding:structuredClone(b),inventoryHash:ahpHash(this.inventory(c)),capturedAt:new Date().toISOString()};
    const prepared={...data,preparedHash:ahpHash(data)};this.prepared.set(prepared.preparedHash,prepared);
    const observation=this.initialObservation(prepared,c,'AHP_AVAILABLE');await this.persist({prepared,observation,request:structuredClone(r),clientId:'datapass-agent-'+prepared.hostIdentityHash.slice(0,24),phase:'PREPARED',integrityHash:''});
    return this.reply(r,'AHP_AVAILABLE',prepared);
  }
  private async persist(rec:AHPLedger):Promise<void>{const {integrityHash,...rest}=rec;rec.integrityHash=ledgerHash(rest);this.records.set(rec.observation.handleId,rec);const records=structuredClone([...this.records.values()]);if(records.length>100)throw Error('Owned handle bound exceeded');this.writes=this.writes.then(()=>this.services.storage.save(records));await this.writes;}
  private transition(rec:AHPLedger,state:AHPState,message:string){rec.observation={...rec.observation,state,message:bounded(message,1000),capturedAt:new Date().toISOString()};void this.persist(rec).then(()=>this.emit(rec.observation)).catch(()=>{rec.observation.state='UNCERTAIN';});}
  private emit(o:AHPObservation){for(const sub of this.listeners)if(sub.handleId===o.handleId&&this.authorized(sub.request)&&ahpHash(sub.request.scope)===o.scopeHash)try{sub.listener(structuredClone(o));}catch{/* consumer isolation */}}
  async execute(r:Request,hash:string,a:AHPApproval):Promise<AHPReply<AHPObservation|null>>{
    const p=this.prepared.get(hash);if(this.corrupt||!p||!this.authorized(r,p.binding)||p.scopeHash!==ahpHash(r.scope)||!await this.services.verifySource(p.binding,r))return this.reply(r,'DENIED',null,'Reviewed immutable preparation unavailable.');
    const executionKey=taskActionKey(p);
    const existing=[...this.records.values()].find(x=>x.phase!=='PREPARED'&&taskActionKey(x.prepared)===executionKey);
    if(existing&&existing.observation.scopeHash!==ahpHash(r.scope))return this.reply(r,'DENIED',null,'This exact action has a durable intent in another scope; no resend or cross-scope result disclosure.');
    if(existing)return this.reply(r,existing.observation.state,existing.observation,'Existing durable intent. No duplicate task or resend.');
    if(this.execution.has(executionKey))return this.reply(r,'UNCERTAIN',null,'This exact task is already being submitted.');
    if(!a||a.preparedHash!==hash||a.taskId!==p.binding.taskId||a.promptHash!==p.binding.promptHash||a.hostId!==p.hostId||a.provider!==p.binding.provider||a.protocolVersion!==p.protocolVersion)return this.reply(r,'DENIED',null,'Exact task approval binding differs.');
    this.execution.add(executionKey);
    let rec:AHPLedger|undefined;
    try{
      const c=this.connections.get(p.hostId);if(!c?.active||c.protocolVersion!==p.protocolVersion||c.descriptor.host.identityHash!==p.hostIdentityHash||!c.descriptor.authorized()||ahpHash(this.inventory(c))!==p.inventoryHash)return this.reply(r,'PROTOCOL_UNSUPPORTED',null,'Host identity, protocol or provider capability changed.');
      if(!await this.services.reviewTask(structuredClone(p))||!this.authorized(r,p.binding)||!await this.services.verifySource(p.binding,r))return this.reply(r,'DENIED',null,'Native task review declined or source changed.');
      const handleId=p.handleId,sessionId='ahp-session:/'+randomUUID(),turnId='turn-'+randomUUID();
      const observation:AHPObservation={schema:'datapass.agent-host-observation/1',handleId,taskId:p.binding.taskId,roleId:p.binding.roleId,preparedHash:hash,scopeHash:p.scopeHash,hostId:p.hostId,hostIdentityHash:p.hostIdentityHash,protocolVersion:p.protocolVersion,provider:p.binding.provider,root:p.binding.root,revision:p.binding.revision,promptHash:p.binding.promptHash,sessionId,chatId:null,turnId,state:'RUNNING',resultText:'',resultHash:ahpTextHash(''),requestedModel:p.binding.requestedModel,requestedEffort:p.binding.requestedEffort??null,observedModel:null,observedEffort:null,lastServerSeq:0,capturedAt:new Date().toISOString(),evidence:c.descriptor.host.kind==='SYNTHETIC'?'SYNTHETIC':'NATIVE_AHP_OBSERVED',message:'Durable create intent recorded; native completion is separate from task acceptance.',acceptedTaskCompletion:false};
      rec={prepared:p,observation,request:structuredClone(r),clientId:'datapass-agent-'+p.hostIdentityHash.slice(0,24),phase:'CREATE_INTENT',integrityHash:''};await this.persist(rec);
      if(!this.authorized(r,p.binding)||!c.descriptor.authorized())throw Error('DENIED');
      await c.client.request('createSession',{channel:sessionId,provider:p.binding.provider,workingDirectories:[pathToFileURL(p.binding.root).href]});
      const subscribed=await c.client.subscribe(sessionId);if(!subscribed.result.snapshot)throw Error('Missing session snapshot');this.snapshot(c,subscribed.result.snapshot);
      const session=await this.readySession(c,sessionId);if(!this.sessionMatches(rec,session)||!safeUri(session.defaultChat,'chat'))throw Error('Session binding changed');
      rec.observation.chatId=session.defaultChat!;rec.phase='SESSION_BOUND';await this.persist(rec);
      const chat=await c.client.subscribe(rec.observation.chatId!);if(!chat.result.snapshot)throw Error('Missing chat snapshot');this.snapshot(c,chat.result.snapshot);
      if(!this.chatMatches(rec,c.chats.get(rec.observation.chatId!)!)||!this.authorized(r,p.binding)||!c.descriptor.authorized()||!await this.services.verifySource(p.binding,r))throw Error('DENIED');
      rec.phase='SEND_INTENT';await this.persist(rec);
      // The intent is durable before this fire-and-forget action. An uncertain outcome is never retried.
      c.client.dispatch(rec.observation.chatId!,{type:c.sdk[0].ActionType.ChatTurnStarted,turnId,startedAt:new Date().toISOString(),message:{text:p.binding.prompt,origin:{kind:c.sdk[0].MessageKind.User},...(p.binding.requestedModel?{model:{id:p.binding.requestedModel,...(p.binding.requestedEffort?{config:{thinkingLevel:p.binding.requestedEffort}}:{})}}:{})}});
      rec.phase='SENT';await this.persist(rec);this.emit(rec.observation);return this.reply(r,rec.observation.state,rec.observation);
    }catch(error){if(rec){const state:AHPState=String(error).includes('AHP_FAILED')?'FAILED':(error as {code?:number})?.code!==undefined?this.errorState(error):'UNCERTAIN';this.transition(rec,state,state==='UNCERTAIN'?'Submission or startup uncertain. Recover exact stored identities; do not retry.':'Host reported failed or unavailable startup; no prompt retry.');await this.writes;return this.reply(r,state,rec.observation);}return this.reply(r,this.errorState(error),null,'Native route unavailable; raw connection errors omitted.');}
    finally{this.execution.delete(executionKey);}
  }
  private initialObservation(p:AHPPrepared,c:Connection,state:AHPState):AHPObservation{return {schema:'datapass.agent-host-observation/1',handleId:p.handleId,taskId:p.binding.taskId,roleId:p.binding.roleId,preparedHash:p.preparedHash,scopeHash:p.scopeHash,hostId:p.hostId,hostIdentityHash:p.hostIdentityHash,protocolVersion:p.protocolVersion,provider:p.binding.provider,root:p.binding.root,revision:p.binding.revision,promptHash:p.binding.promptHash,sessionId:null,chatId:null,turnId:null,state,resultText:'',resultHash:ahpTextHash(''),requestedModel:p.binding.requestedModel,requestedEffort:p.binding.requestedEffort??null,observedModel:null,observedEffort:null,lastServerSeq:0,capturedAt:new Date().toISOString(),evidence:c.descriptor.host.kind==='SYNTHETIC'?'SYNTHETIC':'NATIVE_AHP_OBSERVED',message:'Prepared ordinary task; no native session created or prompt sent.',acceptedTaskCompletion:false};}
  private sessionMatches(rec:AHPLedger,s:SessionState):boolean{return !!s&&s.provider===rec.observation.provider&&s.workingDirectories?.length===1&&s.workingDirectories[0]===pathToFileURL(rec.observation.root).href;}
  private chatMatches(rec:AHPLedger,s:ChatState):boolean{return !!s&&s.resource===rec.observation.chatId&&(!s.workingDirectories||s.workingDirectories.length===1&&s.workingDirectories[0]===pathToFileURL(rec.observation.root).href);}
  private async readySession(c:Connection,id:string):Promise<SessionState>{const until=Date.now()+5000;while(c.active&&c.descriptor.authorized()&&Date.now()<until){const s=c.sessions.get(id);if(s?.lifecycle==='ready')return s;if(s?.lifecycle==='failed')throw Error('AHP_FAILED');await new Promise(resolve=>setTimeout(resolve,20));}throw Error('Host startup disappeared');}
  private async project(c:Connection,rec:AHPLedger,env?:ActionEnvelope):Promise<void>{
    if(!this.authorized(rec.request,rec.prepared.binding)||!await this.services.verifySource(rec.prepared.binding,rec.request)){this.transition(rec,'DENIED','Source permission, root or revision changed during observation.');return;}
    const o=rec.observation,s=c.sessions.get(o.sessionId!),chat=c.chats.get(o.chatId!);
    if(!s||!this.sessionMatches(rec,s)||chat&&!this.chatMatches(rec,chat)){this.transition(rec,'DENIED','Host session/root/provider binding changed.');return;}
    if(!chat)return;
    const turn=[...chat.turns,chat.activeTurn].filter(t=>t?.id===o.turnId);if(turn.length>1){this.transition(rec,'DENIED','Ambiguous native turn identity.');return;}if(!turn.length)return;
    const selected=turn[0]!;if(ahpTextHash(selected.message.text)!==o.promptHash){this.transition(rec,'DENIED','Observed prompt differs from durable task.');return;}
    const parts=selected.responseParts??[];if(parts.length>2000)throw Error('Response part bound exceeded');const text=bounded(parts.filter(p=>p.kind==='markdown').map(p=>(p as {content:string}).content.slice(0,16384)).join('').slice(0,16384),12000);
    let state:AHPState='RUNNING';const done=chat.turns.find(t=>t.id===o.turnId);
    if(done)state=done.state==='complete'?'COMPLETED':done.state==='cancelled'?'STOPPED':'FAILED';
    else if(parts.some(p=>p.kind==='toolCall'&&p.toolCall.status==='auth-required'))state='AUTH_REQUIRED';
    else if(parts.some(p=>p.kind==='toolCall'&&['pending-confirmation','pending-result-confirmation'].includes(p.toolCall.status))||parts.some(p=>p.kind==='inputRequest'))state='PERMISSION_REQUIRED';
    // message.model is a requested selection echoed by the host. It is not an
    // independent observation of the provider's effective engine/model/effort.
    rec.observation={...o,resultText:text,resultHash:ahpTextHash(text),state,observedModel:null,observedEffort:null,lastServerSeq:Math.max(o.lastServerSeq,env?.serverSeq??c.seq.get(o.chatId!)??0),capturedAt:new Date().toISOString(),message:state==='PERMISSION_REQUIRED'?'Resolve native tool/input permission in the owning host. No automatic approval.':state==='COMPLETED'?'Native turn completed; effective model/effort remain unknown; PM task acceptance remains separate.':''};
    await this.persist(rec);this.emit(rec.observation);
  }
  async observe(r:Request,id:string,recover:boolean):Promise<AHPReply<AHPObservation|null>>{
    const rec=this.records.get(id);if(this.corrupt||!rec||!this.authorized(r,rec.prepared.binding)||rec.observation.scopeHash!==ahpHash(r.scope)||!await this.services.verifySource(rec.prepared.binding,rec.request))return this.reply(r,'DENIED',null,'Owned durable task and renewed source scope required.');
    if(recover){rec.request=structuredClone(r);const h=this.hosts.get(rec.observation.hostId);if(!h?.authorized()||h.host.identityHash!==rec.observation.hostIdentityHash)return this.reply(r,'UNAVAILABLE',rec.observation,'No reviewed connection authority for this exact host; its liveness is unknown. Review the same host connection again; endpoint secrets are never persisted.');
      try{const c=await this.connect(h);if(c.protocolVersion!==rec.observation.protocolVersion||ahpHash(this.inventory(c))!==rec.prepared.inventoryHash)return this.reply(r,'PROTOCOL_UNSUPPORTED',rec.observation,'Recovered host protocol/capability differs.');
        if(rec.observation.sessionId){const sub=await c.client.subscribe(rec.observation.sessionId);if(!sub.result.snapshot)throw Error('Missing session snapshot');this.snapshot(c,sub.result.snapshot);const s=c.sessions.get(rec.observation.sessionId)!;if(!this.sessionMatches(rec,s))throw Error('DENIED');
          if(!rec.observation.chatId&&safeUri(s.defaultChat,'chat')){rec.observation.chatId=s.defaultChat!;await this.persist(rec);}
          if(rec.observation.chatId){const chat=await c.client.subscribe(rec.observation.chatId);if(!chat.result.snapshot)throw Error('Missing chat snapshot');this.snapshot(c,chat.result.snapshot);await this.project(c,rec);}}
      }catch{this.transition(rec,'UNCERTAIN','Recovery unavailable; no session creation or prompt resend.');await this.writes;}}
    return this.reply(r,rec.observation.state,rec.observation);
  }
  private async cancel(r:Request,id:string):Promise<AHPReply<AHPObservation|null>>{const rec=this.records.get(id);if(!rec||!this.authorized(r,rec.prepared.binding)||!await this.services.verifySource(rec.prepared.binding,rec.request))return this.reply(r,'DENIED',null);const c=this.connections.get(rec.observation.hostId);if(!c?.active||!c.descriptor.authorized()||!rec.observation.chatId||!rec.observation.turnId||!['RUNNING','PERMISSION_REQUIRED','AUTH_REQUIRED'].includes(rec.observation.state))return this.reply(r,'UNAVAILABLE',rec.observation,'Only an owned observed active turn can be cancelled.');try{c.client.dispatch(rec.observation.chatId,{type:c.sdk[0].ActionType.ChatTurnCancelled,turnId:rec.observation.turnId,duration:0});return this.reply(r,rec.observation.state,rec.observation,'Cancellation requested; native acknowledgement remains pending.');}catch{return this.reply(r,'UNCERTAIN',rec.observation,'Cancellation uncertain.');}}
  private subscribe(r:Request,id:string,listener:(o:AHPObservation)=>void){const rec=this.records.get(id);if(!rec||!this.authorized(r,rec.prepared.binding)||typeof listener!=='function'||this.listeners.size>=100)return {dispose(){}};const entry={request:structuredClone(r),handleId:id,listener};this.listeners.add(entry);return {dispose:()=>this.listeners.delete(entry)};}
  revoke():void{this.sourceGrants.clear();this.reviewedRoots.clear();this.reviewedBindings.clear();this.hosts.clear();for(const c of this.connections.values())void c.client.shutdown();this.connections.clear();this.prepared.clear();this.listeners.clear();}
  async dispose():Promise<void>{for(const c of this.connections.values())await c.client.shutdown();this.listeners.clear();await this.writes;}
}
