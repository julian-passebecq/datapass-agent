import * as fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJson, sha256 } from '../galaxy';
import { hasLinkedAncestor, isPlausibleLocalPath } from '../util/paths';
import { NativeStartupManifest, captureNativeStartupManifest, nativeStartupReviewHash } from './nativeStartup';
import { NativePlatformProof, NativePlatformVerifier, NativePlatformVerification, verifyNativePlatformProof } from './nativePlatform';
import { MafRuntime, MafAction, validateMafAction, verifyMafRuntime } from './nativeMaf';

export const nativeTransportVersion = '1.0.3' as const;
export type NativeTransport = 'codex-app-server' | 'codex-cli' | 'claude-cli' | 'maf-harness';
export interface NativeIdentity { model: string; effort: string | null; accountId: string | null; }
export interface NativeSelection {
  transport: NativeTransport;
  /** Explicit host-registered runtime, currently the offline replay backend only. */
  mafRuntimeHash?:string;
  /** Regular executable, never a shell, script shim, PATH lookup or caller-supplied argv. */
  executable: string; executableSha256: string; nativeVersion: string;
  cwd: string; home: string; hostId: string;
  /** Explicit provider-state directory; omitted legacy targets use home directly. Never discover credentials. */
  providerHome?: string;
  permission: 'read-only' | 'workspace-write';
  requestedIdentity: NativeIdentity;
  /** Explicit Config reference to native-name mapping, independently reported by the platform verifier. */
  nativeTools?:{configToolRefs:string[];toolNames:string[]};
  /** Reviewed exact startup effect inventory; local host must independently approve its digest. */
  startup: { reviewHash: string; configurationHash: string; hooks: 'NONE' | 'REVIEWED'; mcp: 'NONE' | 'REVIEWED'; managed: 'NONE' | 'REVIEWED'; isolated: boolean; supported: string[]; manifest?:NativeStartupManifest;platformProof?:NativePlatformProof };
}
export interface NativeTaskInput {
  selection: NativeSelection; taskId: string; text: string;
  mafAction?:MafAction;
  targetHash: string; permissionHash: string; configHash: string; presetHash: string; promptHash: string; bindingHash: string; scopeHash: string; configScopeHash:string;
  /** Only an Agent-owned, completed/interrupted session ledger can be resumed. */
  resumeFromTaskId?: string;
}
export interface PreparedNativeTask extends NativeTaskInput { schema: 'datapass.native-task/1'; preparedHash: string; }
export interface NativePreflight {
  schema: 'datapass.native-preflight/1'; version: typeof nativeTransportVersion;
  state: 'READY' | 'BLOCKED'; selectionHash: string; reasons: string[];
  verification:{installed:'EXACT_BINARY_VERIFIED'|'UNKNOWN';configured:'LOCAL_MANIFEST_VERIFIED'|'UNKNOWN';authenticated:'UNKNOWN';working:'UNKNOWN';platform:NativePlatformVerification;capabilities:'TRUSTED_VERIFIER_REPORTED'|'ASSERTED';};
  limitations:string[];
  tools:{policy:'NATIVE_PROVIDER_OWNED_UNPROBED'|'RESTRICTED_DEFAULT_UNPROBED'|'MAPPED_REPORTED_UNPROBED'|'EXACT_MAF_ACTION';toolNames:string[]|null;working:'UNKNOWN';humanApprovalRoundTrip:'NATIVE_REFUSAL'|'UNSUPPORTED_CLI_MANUAL'|'EXACT_HOST_REVIEW';};
  capabilities: { start: boolean; stream: boolean; resume: boolean; cancel: 'OWNED_TURN' | 'OWNED_PROCESS'; securityRequests: 'NATIVE_REFUSAL'; observedIdentity: 'PROVIDER_EVIDENCE_ONLY' };
}
export const nativeHash = (value: unknown): string => sha256(canonicalJson(value));
/** Renewing a signed proof alone does not change an owned session's native identity/configuration. */
export function nativeSelectionBinding(selection:NativeSelection):string{
  const s=structuredClone(selection),proof=s.startup.platformProof;
  if(proof){const {issuedAt,expiresAt,...stable}=proof.payload;s.startup.platformProof={...proof,signature:'',payload:{...stable,issuedAt:'',expiresAt:''}};}
  return nativeHash(s);
}
export const hashOk = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export const nativeIdOk = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9._:-]{1,160}$/.test(v);
const identityOk = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9._:/-]{1,160}$/.test(v);
async function executableHash(file:string,expectedBytes:number):Promise<string>{
  const hash=createHash('sha256');let bytes=0;
  for await(const chunk of createReadStream(file)){bytes+=chunk.length;if(bytes>512*1024*1024)throw Error('Executable exceeds bounded verification');hash.update(chunk);}
  if(bytes!==expectedBytes)throw Error('Executable changed during verification');return hash.digest('hex');
}
export function nativeToolPolicy(selection:NativeSelection):{configToolRefs:string[];toolNames:string[]}|null{
  if(selection.transport==='maf-harness')return {configToolRefs:[],toolNames:['write_artifact']};
  if(selection.transport!=='claude-cli')return null;
  return selection.nativeTools??{configToolRefs:[],toolNames:selection.permission==='read-only'?['Read','Glob','Grep']:['Read','Glob','Grep','Edit','Write']};
}
export function validateNativeSelection(s: NativeSelection): boolean {
  return !!s && ['codex-app-server','codex-cli','claude-cli','maf-harness'].includes(s.transport) &&
    (s.transport==='maf-harness' ? hashOk(s.mafRuntimeHash) && s.nativeVersion==='agent-framework-core:1.23.0' && s.permission==='workspace-write' && s.requestedIdentity?.model==='offline-replay-v1' && s.requestedIdentity.effort===null && s.requestedIdentity.accountId===null && s.providerHome===undefined : s.mafRuntimeHash===undefined) &&
    [s.executable,s.cwd,s.home,...(s.providerHome===undefined?[]:[s.providerHome])].every(p=>isPlausibleLocalPath(p) && !hasLinkedAncestor(p)) && hashOk(s.executableSha256) && identityOk(s.nativeVersion) && nativeIdOk(s.hostId) &&
    ['read-only','workspace-write'].includes(s.permission) && !!s.requestedIdentity && identityOk(s.requestedIdentity.model) && (s.requestedIdentity.effort===null || ['minimal','low','medium','high','xhigh','max'].includes(s.requestedIdentity.effort)) && (s.requestedIdentity.accountId===null || identityOk(s.requestedIdentity.accountId)) &&
    (s.nativeTools===undefined || s.transport==='claude-cli' && !!s.nativeTools && Array.isArray(s.nativeTools.configToolRefs)&&s.nativeTools.configToolRefs.length>0&&s.nativeTools.configToolRefs.length<=20&&s.nativeTools.configToolRefs.every(identityOk)&&Array.isArray(s.nativeTools.toolNames)&&s.nativeTools.toolNames.length>0&&s.nativeTools.toolNames.length<=8&&new Set(s.nativeTools.toolNames).size===s.nativeTools.toolNames.length&&s.nativeTools.toolNames.every(t=>['Read','Glob','Grep','Edit','Write','Bash','Agent','Task'].includes(t))) &&
    !!s.startup && hashOk(s.startup.reviewHash) && hashOk(s.startup.configurationHash) && ['NONE','REVIEWED'].includes(s.startup.hooks) && ['NONE','REVIEWED'].includes(s.startup.mcp) && ['NONE','REVIEWED'].includes(s.startup.managed) && typeof s.startup.isolated==='boolean' && Array.isArray(s.startup.supported) && s.startup.supported.length<=40 && s.startup.supported.every(identityOk);
}
export async function preflightNativeTransport(selection: NativeSelection,trustedKeys:NativePlatformVerifier[]=[],mafRuntime?:MafRuntime): Promise<NativePreflight> {
  const s=structuredClone(selection), reasons:string[]=[];
  let installed:NativePreflight['verification']['installed']='UNKNOWN',configured:NativePreflight['verification']['configured']='UNKNOWN';
  if(!validateNativeSelection(s)) throw Error('Invalid native transport selection.');
  for(const directory of [s.cwd,s.home,s.providerHome??s.home]) { try { if(!(await fs.lstat(directory)).isDirectory() || hasLinkedAncestor(directory))reasons.push('Reviewed directories must be real local directories.'); }catch{reasons.push('Reviewed directory is unavailable.');} }
  try {
    const stat=await fs.lstat(s.executable);
    if(!stat.isFile() || stat.isSymbolicLink() || /\.(cmd|bat|ps1|sh|js|cjs|mjs)$/i.test(s.executable) || stat.size>512*1024*1024 || await executableHash(s.executable,stat.size)!==s.executableSha256) reasons.push('Exact native executable hash is unavailable or changed.');else installed='EXACT_BINARY_VERIFIED';
  }catch{reasons.push('Exact native executable is unavailable.');}
  if(s.transport==='maf-harness')try{await verifyMafRuntime(mafRuntime,s.mafRuntimeHash!,s.executable,s.executableSha256);}catch{reasons.push('Exact host-registered MAF worker/import inventory is missing or changed.');}
  const current=await captureNativeStartupManifest(s);
  if(!s.startup.manifest || nativeHash(s.startup.manifest)!==nativeHash(current)||s.startup.configurationHash!==current.manifestHash||s.startup.reviewHash!==nativeStartupReviewHash(s,current))reasons.push('Exact Agent startup manifest/review proof is missing or changed.');
  else if(current.localState!=='VERIFIED_NO_CUSTOMIZATIONS')reasons.push('Local startup sources/customizations are incomplete or unreviewed.');else configured='LOCAL_MANIFEST_VERIFIED';
  const platform=verifyNativePlatformProof(s,current,trustedKeys,nativeHash(nativeEnvironment(s)),nativeHash(nativeToolPolicy(s)));if(platform.state==='UNKNOWN')reasons.push(platform.reason!);
  if(s.startup.hooks!=='NONE'||s.startup.mcp!=='NONE')reasons.push('Hook/MCP startup effects require complete dependency verification; declarations cannot authorize them.');
  // CLI switches and receipt signatures do not themselves impose OS isolation.
  if(!s.startup.isolated) reasons.push('Verified isolated native execution host is required.');
  const required=s.transport==='maf-harness'?['maf/1','exact-tool-approval','offline-replay','owned-process']:s.transport==='codex-app-server'?['initialize','thread/start','thread/resume','turn/start','turn/interrupt']:s.transport==='codex-cli'?['exec','json','resume','sandbox']:['print','stream-json','resume','restricted','tools','strict-mcp-config','mcp-config','permission-mode','input-format','include-partial-messages','verbose','disallowedTools'];
  if(required.some(cap=>!s.startup.supported.includes(cap))) reasons.push('Installed native version lacks a reviewed required capability.');
  if(s.transport==='claude-cli' && s.requestedIdentity.effort!==null && !s.startup.supported.includes('effort')) reasons.push('Requested effort is not supported by this installed version.');
  if(s.permission==='read-only' && s.nativeTools?.toolNames.some(t=>['Edit','Write'].includes(t)))reasons.push('Read-only permission cannot select native file write tools.');
  return {schema:'datapass.native-preflight/1',version:nativeTransportVersion,state:reasons.length?'BLOCKED':'READY',selectionHash:nativeHash(s),reasons,
    verification:{installed,configured,authenticated:'UNKNOWN',working:'UNKNOWN',platform,capabilities:platform.state==='TRUSTED_VERIFIER_REPORTED'?'TRUSTED_VERIFIER_REPORTED':'ASSERTED'},
    limitations:s.transport==='maf-harness'?['Offline replay backend only; no live provider, general file access, shell, skills or subprocess tools.','One exact host-reviewed artifact action. Completed receipt lookup does not re-execute a task; unknown outcomes require reconciliation.']:s.transport==='claude-cli'?['Print CLI has no verified human permission-response transport; native denial/manual handling remains authoritative.','Default restricted file tools do not imply Bash, testing, subagent or full task capability. Explicit mapped Config tools require the exact signed tool policy and descendant isolation.','No --allowedTools, bypass, auto-approval or permission elevation flag.']:['Provider-owned tools remain unprobed; installed/configured/startup-safe does not certify testing, tool execution, subagent support or account entitlement.','Native permission requests are refused for native/manual handling.'],
    tools:{policy:s.transport==='maf-harness'?'EXACT_MAF_ACTION':s.transport!=='claude-cli'?'NATIVE_PROVIDER_OWNED_UNPROBED':s.nativeTools?'MAPPED_REPORTED_UNPROBED':'RESTRICTED_DEFAULT_UNPROBED',toolNames:nativeToolPolicy(s)?.toolNames??null,working:'UNKNOWN',humanApprovalRoundTrip:s.transport==='maf-harness'?'EXACT_HOST_REVIEW':s.transport==='claude-cli'?'UNSUPPORTED_CLI_MANUAL':'NATIVE_REFUSAL'},
    capabilities:{start:!reasons.length,stream:!reasons.length,resume:!reasons.length&&s.transport!=='maf-harness',cancel:s.transport==='codex-app-server'?'OWNED_TURN':'OWNED_PROCESS',securityRequests:'NATIVE_REFUSAL',observedIdentity:'PROVIDER_EVIDENCE_ONLY'}};
}
export function prepareNativeTask(input: NativeTaskInput): PreparedNativeTask {
  const i=structuredClone(input);
  if(i.selection?.transport==='maf-harness' ? !validateMafAction(i.mafAction!) || i.resumeFromTaskId!==undefined : i.mafAction!==undefined)throw Error('Exact MAF action is required; process replay/resume is not an execution permission.');
  if(!validateNativeSelection(i.selection) || !nativeIdOk(i.taskId) || typeof i.text!=='string' || !i.text.trim() || Buffer.byteLength(i.text)>64*1024 || i.text.includes('\0') || ![i.targetHash,i.permissionHash,i.configHash,i.presetHash,i.promptHash,i.bindingHash,i.scopeHash,i.configScopeHash].every(hashOk) || i.resumeFromTaskId!==undefined && !nativeIdOk(i.resumeFromTaskId))throw Error('Invalid exact prepared native task.');
  const task={...i,schema:'datapass.native-task/1' as const};
  return {...task,preparedHash:nativeHash(task)};
}
/** Fixed native command vocabulary. Prompt is delivered over stdin, never shell text or argv. */
export function nativeLaunchArguments(task: PreparedNativeTask, resumeId?:string, mafRuntime?:MafRuntime): string[] {
  const s=task.selection;
  if(s.transport==='maf-harness'){
    if(!mafRuntime || resumeId!==undefined)throw Error('Registered MAF runtime required; resume execution is unsupported.');
    return ['-I','-S','-B',mafRuntime.worker,'--site-packages',mafRuntime.sitePackages];
  }
  if(resumeId!==undefined && !nativeIdOk(resumeId))throw Error('Invalid owned native session.');
  if(s.transport==='codex-app-server')return ['-c','cli_auth_credentials_store="file"','app-server','--listen','stdio://'];
  if(s.transport==='codex-cli') {
    const args=['exec',...(resumeId?['resume',resumeId]:[]),'--json','-c','cli_auth_credentials_store="file"','-c','approval_policy="never"','-c',`sandbox_mode="${s.permission}"`,'-c','sandbox_workspace_write.network_access=false','--model',s.requestedIdentity.model];
    if(s.requestedIdentity.effort)args.push('-c',`model_reasoning_effort="${s.requestedIdentity.effort}"`);
    return [...args,'-'];
  }
  const tools=nativeToolPolicy(s)!.toolNames.join(',');
  return ['--print','--input-format','text','--output-format','stream-json','--verbose','--include-partial-messages','--restricted','--permission-mode','default','--tools',tools,'--disallowedTools','mcp__*','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--model',s.requestedIdentity.model,...(s.requestedIdentity.effort?['--effort',s.requestedIdentity.effort]:[]),...(resumeId?['--resume',resumeId]:[])];
}
/** Deliberately no inherited PATH, credentials, command hooks, agents or token environment. Native owns auth in reviewed home. */
export function nativeEnvironment(selection:NativeSelection): NodeJS.ProcessEnv {
  if(selection.transport==='maf-harness')return {HOME:selection.home,USERPROFILE:selection.home,...(process.platform==='win32'?{SystemRoot:process.env.SystemRoot}:{})};
  const providerHome=selection.providerHome??selection.home;
  return {HOME:selection.home,USERPROFILE:selection.home,CODEX_HOME:providerHome,CLAUDE_CONFIG_DIR:providerHome,...(process.platform==='win32'?{SystemRoot:process.env.SystemRoot}:{} )};
}
