import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import * as net from 'node:net';
import { WebSocket } from 'ws';
import type { AhpTransport, JsonRpcMessage, TransportFrame } from '@microsoft/agent-host-protocol/client';
import type { ReviewedAHPHost } from './agentHost';
import { ahpHash } from './agentHost';
import { hasLinkedAncestor, isPlausibleLocalPath } from '../util/paths';
interface EndpointEntry {schemaVersion:2;type:'editor'|'standalone';pid:number;instanceId:string;protocolVersion:string;connectionToken:string;endpoint:{type:'socket';path:string}|{type:'tcp';host:string;port:number};}
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
/** Pure validator used on selected bytes only. Never returns tokens to PM or diagnostics. */
export function validateSelectedEndpoint(value:unknown,file:string,userData:string,pidAlive:(pid:number)=>boolean):boolean{
  const e=value as EndpointEntry;
  if(!e||e.schemaVersion!==2||!['editor','standalone'].includes(e.type)||!Number.isSafeInteger(e.pid)||e.pid<1||!pidAlive(e.pid)||!/^[a-zA-Z0-9_-]{8,160}$/.test(e.instanceId)||!/^[a-zA-Z0-9_-]{16,512}$/.test(e.connectionToken)||!/^\d+\.\d+\.\d+$/.test(e.protocolVersion))return false;
  const expected=path.join(userData,'agent-host','local-endpoint','entries',digest(`${e.type}\0${e.pid}\0${e.instanceId}`)+'.json');
  if(path.resolve(file)!==path.resolve(expected))return false;
  if(e.endpoint?.type==='socket')return typeof e.endpoint.path==='string'&&e.endpoint.path.length<=512&&!/[\x00-\x1f]/.test(e.endpoint.path)&&(process.platform==='win32'?/^\\\\\.\\pipe\\vscode-agent-host-[a-zA-Z0-9_-]+$/.test(e.endpoint.path):path.isAbsolute(e.endpoint.path)&&e.endpoint.path.endsWith('.sock'));
  return e.type==='standalone'&&e.endpoint?.type==='tcp'&&['127.0.0.1','::1','localhost'].includes(e.endpoint.host)&&Number.isSafeInteger(e.endpoint.port)&&e.endpoint.port>0&&e.endpoint.port<65536;
}
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
/** This function requires an independently confirmed sensitive-access grant BEFORE invocation. */
export async function selectedEndpointHost(input:{file:string;userData:string;root:string;revision:string;scopeHash:string;authorized:()=>boolean}):Promise<ReviewedAHPHost>{
  if(!input.authorized()||!isPlausibleLocalPath(input.file)||!isPlausibleLocalPath(input.userData)||hasLinkedAncestor(input.file)||hasLinkedAncestor(input.userData))throw Error('Selected endpoint access denied.');
  const stat=await fs.lstat(input.file);if(!stat.isFile()||stat.size>8192||process.platform!=='win32'&&(stat.mode&0o077)!==0)throw Error('Unsafe endpoint metadata.');
  const bytes=await fs.readFile(input.file,'utf8');if(!input.authorized())throw Error('Selected endpoint access revoked.');
  const entry=JSON.parse(bytes) as EndpointEntry;if(!validateSelectedEndpoint(entry,input.file,input.userData,alive))throw Error('Selected endpoint metadata invalid or stale.');
  const identityHash=ahpHash({type:entry.type,pid:entry.pid,instanceId:entry.instanceId,userData:path.resolve(input.userData),endpoint:entry.endpoint});
  // Sensitive bearer remains only inside this Agent-owned closure; never journaled or returned.
  return {host:{hostId:'ahp-host:'+identityHash.slice(0,32),kind:entry.type==='editor'?'VSCODE_AGENT_HOST':'STANDALONE_AGENT_HOST',label:entry.type==='editor'?'Reviewed VS Code editor host':'Reviewed standalone host (separate session authority)',protocolVersion:entry.protocolVersion,connectionState:'UNAVAILABLE',identityHash},scopeHash:input.scopeHash,root:input.root,revision:input.revision,authorized:input.authorized,
    open:async()=>{if(!input.authorized()||hasLinkedAncestor(input.file)||!alive(entry.pid))throw Error('DENIED');const current=await fs.readFile(input.file,'utf8');if(current!==bytes||!input.authorized())throw Error('DENIED');return connectEndpoint(entry,input.authorized);}};
}
/** Standard WebSocket framing over the documented pipe/socket/TCP address. SDK owns JSON-RPC. */
async function connectEndpoint(entry:EndpointEntry,authorized:()=>boolean):Promise<AhpTransport>{
  if(!authorized())throw Error('DENIED');
  const query='/?tkn='+encodeURIComponent(entry.connectionToken);
  const url=entry.endpoint.type==='tcp'?`ws://${entry.endpoint.host==='::1'?'[::1]':entry.endpoint.host}:${entry.endpoint.port}${query}`:'ws://localhost'+query;
  const socket=entry.endpoint.type==='socket'?entry.endpoint.path:null;
  return new Promise((resolve,reject)=>{
    const ws=new WebSocket(url,{handshakeTimeout:5000,maxPayload:2*1024*1024,perMessageDeflate:false,...(socket?{createConnection:()=>net.createConnection(socket)}:{})});
    const queue:TransportFrame[]=[];const waiters:((frame:TransportFrame|null)=>void)[]=[];let closed=false;
    const end=()=>{closed=true;while(waiters.length)waiters.shift()!(null);};
    ws.on('message',(data,isBinary)=>{if(!authorized()||queue.length>=512){ws.close();end();return;}const text=data.toString();try{JSON.parse(text);}catch{ws.close();end();return;}const frame:TransportFrame=isBinary?{kind:'binary',data:new Uint8Array(Buffer.isBuffer(data)?data:Buffer.from(data as ArrayBuffer))}:{kind:'text',text};const waiter=waiters.shift();if(waiter)waiter(frame);else queue.push(frame);});
    ws.on('close',end);ws.on('error',()=>{end();reject(Error('Local AHP connection unavailable.'));});
    ws.on('unexpected-response',(_request,response)=>{end();response.destroy();reject(Error(response.statusCode===403?'AUTH_REQUIRED':'Local AHP connection unavailable.'));ws.terminate();});
    ws.once('open',()=>{if(!authorized()){ws.close();reject(Error('DENIED'));return;}resolve({send(message:JsonRpcMessage|string){if(!authorized()||closed||ws.readyState!==WebSocket.OPEN)throw Error('Connection closed.');ws.send(typeof message==='string'?message:JSON.stringify(message));},recv(){if(queue.length)return Promise.resolve(queue.shift()!);if(closed)return Promise.resolve(null);return new Promise(resolve=>waiters.push(resolve));},close(){ws.close();end();}});});
  });
}
