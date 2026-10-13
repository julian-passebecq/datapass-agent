import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { InMemoryTransport, type AhpTransport } from '@microsoft/agent-host-protocol/client';
import { chatReducer, sessionReducer, negotiateProtocolVersion, ActionType, type ChatState, type ChatAction, type SessionState, type Snapshot, type AgentInfo, type StateAction } from '@microsoft/agent-host-protocol';
import { AgentHostAdapter, ahpHash, ahpTextHash, type ReviewedAHPHost, type AHPLedger } from '../src/provider-kit/agentHost';
import type { AHPBinding, AHPApproval } from '../src/provider-kit/agentHostTypes';
import type { Request } from '../src/cockpit/interfaces';
import { repoId } from '../src/cockpit/policy';
export async function syntheticAHPFixture(root:string,options:{version?:string;revision?:string;providers?:AgentInfo[];startupDrop?:boolean;midTurnDrop?:boolean;permission?:boolean;auth?:boolean;manual?:boolean}={}) {
  const request:Request={requestId:'rc2:synthetic',epoch:1,scope:{scopeId:'rc2:scope',organizationIds:['synthetic'],projectIds:['synthetic'],privacyDomainIds:['synthetic'],repoIds:[repoId(root)],sourceVectorHash:'a'.repeat(64),policyHash:'b'.repeat(64)}};
  const prompt='Read the synthetic README and summarize it. Do not change files or use network tools.';
  const binding:AHPBinding={taskId:'rc2:task',roleId:'Jul',root,revision:options.revision??'1'.repeat(40),authorityHash:'c'.repeat(64),preparedTaskHash:'d'.repeat(64),compiledPromptHash:'e'.repeat(64),configScopeHash:'f'.repeat(64),presetHash:'0'.repeat(64),provider:'codex',requestedModel:'fixture-codex',requestedEffort:null,requestedMode:'DEFAULT',prompt,promptHash:ahpTextHash(prompt)};
  let valid=true,source=true,connection=true,seq=0;let persisted:AHPLedger[]=[];
  const sessions=new Map<string,SessionState>(),chats=new Map<string,ChatState>(),servers:AhpTransport[]=[],sent:{method:string;params:any}[]=[];
  const agents:AgentInfo[]=options.providers??[{provider:'codex',displayName:'Synthetic Codex',description:'SYNTHETIC ONLY',models:[{id:'fixture-codex',provider:'openai',name:'Synthetic fixture model'}]},{provider:'claude',displayName:'Synthetic Claude',description:'SYNTHETIC ONLY',models:[{id:'fixture-claude',provider:'anthropic',name:'Synthetic fixture model'}]}];
  const snapshot=(uri:string):Snapshot=>({resource:uri,fromSeq:seq,state:uri==='ahp-root://'?{agents}:sessions.get(uri)??chats.get(uri)!});
  async function broadcast(channel:string,action:ChatAction){const s=chats.get(channel)!;chats.set(channel,chatReducer(s,action));seq++;for(const server of servers)await server.send({jsonrpc:'2.0',method:'action',params:{channel,action,serverSeq:seq}});}
  async function hostAction(channel:string,action:StateAction){seq++;for(const server of servers)await server.send({jsonrpc:'2.0',method:'action',params:{channel,action,serverSeq:seq}});}
  async function hostLoop(server:AhpTransport){for(;;){const frame=await server.recv();if(!frame)break;if(frame.kind!=='text')continue;const msg=JSON.parse(frame.text);sent.push({method:msg.method,params:msg.params});const p=msg.params;
    const result=(value:unknown)=>server.send({jsonrpc:'2.0',id:msg.id,result:value});
    if(msg.method==='initialize'){const offered=p.protocolVersions as string[];const chosen=options.version??negotiateProtocolVersion(offered);await result({protocolVersion:chosen,serverSeq:seq,snapshots:[snapshot('ahp-root://')]});}
    else if(msg.method==='createSession'){if(options.startupDrop){server.close();continue;}const chatId='ahp-chat:/'+randomUUID();const session:SessionState={provider:p.provider,title:'Synthetic task',status:1,lifecycle:'ready' as any,workingDirectories:p.workingDirectories,activeClients:[],chats:[{resource:chatId,title:'Synthetic',status:1,modifiedAt:new Date().toISOString()}],defaultChat:chatId};sessions.set(p.channel,session);chats.set(chatId,{resource:chatId,title:'Synthetic',status:1,modifiedAt:new Date().toISOString(),turns:[],workingDirectories:p.workingDirectories});await result(null);}
    else if(msg.method==='subscribe')await result({snapshot:snapshot(p.channel)});
    else if(msg.method==='dispatchAction'){await broadcast(p.channel,p.action);if(p.action.type===ActionType.ChatTurnStarted){if(options.midTurnDrop){server.close();continue;}if(options.manual)continue;setTimeout(()=>{void (async()=>{const turnId=p.action.turnId;
      if(options.auth){await server.send({jsonrpc:'2.0',method:'auth/required',params:{channel:p.channel,resource:{resource:'https://synthetic.example.invalid/provider',resource_name:'Synthetic authentication requirement',required:true}}});return;}
      if(options.permission){await broadcast(p.channel,{type:ActionType.ChatToolCallStart,turnId,toolCallId:'tool1',toolName:'fixture',displayName:'Synthetic permission'});await broadcast(p.channel,{type:ActionType.ChatToolCallReady,turnId,toolCallId:'tool1',invocationMessage:'Synthetic native approval required'});return;}
      await broadcast(p.channel,{type:ActionType.ChatResponsePart,turnId,part:{kind:'markdown' as any,id:'answer',content:''}});
      await broadcast(p.channel,{type:ActionType.ChatDelta,turnId,partId:'answer',content:'Synthetic README response. '});
      await broadcast(p.channel,{type:ActionType.ChatDelta,turnId,partId:'answer',content:'api_key="sk-fixturesecretvalue123456789"'});
      await broadcast(p.channel,{type:ActionType.ChatTurnComplete,turnId,duration:1});})().catch(()=>{});},10);}}
    else if(msg.id!==undefined)await result(null);
  }}
  const descriptor:ReviewedAHPHost={host:{hostId:'ahp-host:synthetic',kind:'SYNTHETIC',label:'Approved deterministic synthetic host',protocolVersion:null,connectionState:'UNAVAILABLE',identityHash:'9'.repeat(64)},scopeHash:ahpHash(request.scope),root,revision:binding.revision,authorized:()=>connection,open:async()=>{const [client,server]=InMemoryTransport.pair();servers.push(server);void hostLoop(server);return client;}};
  const makeAdapter=()=>new AgentHostAdapter({storage:{load:()=>persisted.length?structuredClone(persisted):undefined,save:async records=>{persisted=structuredClone(records);}},authorize:()=>valid,sourceGrantCurrent:()=>valid,verifySource:async b=>source&&b.root===root&&b.revision===binding.revision,reviewProject:async()=>true,reviewConnection:async()=>descriptor,reviewTask:async()=>true});
  const adapter=makeAdapter();adapter.registerHost(descriptor);
  const approval=(p:{preparedHash:string;hostId:string;protocolVersion:string}):AHPApproval=>({...p,taskId:binding.taskId,promptHash:binding.promptHash,provider:binding.provider});
  return {adapter,request,binding,descriptor,sent,sessions,chats,approval,makeAdapter,broadcast,hostAction,persisted:()=>persisted,revoke:()=>{valid=false;},changeSource:()=>{source=false;},revokeConnection:()=>{connection=false;},close:async()=>{for(const server of servers)server.close();await adapter.dispose();},uri:pathToFileURL(root).href};
}
