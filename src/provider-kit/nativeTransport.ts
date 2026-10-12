import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJson, sha256 } from '../galaxy';
import { hasLinkedAncestor, isPlausibleLocalPath } from '../util/paths';

export const nativeTransportVersion = '1.0.0' as const;
export type NativeTransport = 'codex-app-server' | 'codex-cli' | 'claude-cli';
export interface NativeIdentity { model: string; effort: string | null; accountId: string | null; }
export interface NativeSelection {
  transport: NativeTransport;
  /** Regular executable, never a shell, script shim, PATH lookup or caller-supplied argv. */
  executable: string; executableSha256: string; nativeVersion: string;
  cwd: string; home: string; hostId: string;
  permission: 'read-only' | 'workspace-write';
  requestedIdentity: NativeIdentity;
  /** Reviewed exact startup effect inventory; local host must independently approve its digest. */
  startup: { reviewHash: string; configurationHash: string; hooks: 'NONE' | 'REVIEWED'; mcp: 'NONE' | 'REVIEWED'; managed: 'NONE' | 'REVIEWED'; isolated: boolean; supported: string[] };
}
export interface NativeTaskInput {
  selection: NativeSelection; taskId: string; text: string;
  targetHash: string; permissionHash: string; configHash: string; presetHash: string; promptHash: string; bindingHash: string; scopeHash: string; configScopeHash:string;
  /** Only an Agent-owned, completed/interrupted session ledger can be resumed. */
  resumeFromTaskId?: string;
}
export interface PreparedNativeTask extends NativeTaskInput { schema: 'datapass.native-task/1'; preparedHash: string; }
export interface NativePreflight {
  schema: 'datapass.native-preflight/1'; version: typeof nativeTransportVersion;
  state: 'READY' | 'BLOCKED'; selectionHash: string; reasons: string[];
  capabilities: { start: boolean; stream: boolean; resume: boolean; cancel: 'OWNED_TURN' | 'OWNED_PROCESS'; securityRequests: 'NATIVE_REFUSAL'; observedIdentity: 'PROVIDER_EVIDENCE_ONLY' };
}
export const nativeHash = (value: unknown): string => sha256(canonicalJson(value));
export const hashOk = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export const nativeIdOk = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9._:-]{1,160}$/.test(v);
const identityOk = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9._:/-]{1,160}$/.test(v);
export function validateNativeSelection(s: NativeSelection): boolean {
  return !!s && ['codex-app-server','codex-cli','claude-cli'].includes(s.transport) &&
    [s.executable,s.cwd,s.home].every(p=>isPlausibleLocalPath(p) && !hasLinkedAncestor(p)) && hashOk(s.executableSha256) && identityOk(s.nativeVersion) && nativeIdOk(s.hostId) &&
    ['read-only','workspace-write'].includes(s.permission) && !!s.requestedIdentity && identityOk(s.requestedIdentity.model) && (s.requestedIdentity.effort===null || ['minimal','low','medium','high','xhigh','max'].includes(s.requestedIdentity.effort)) && (s.requestedIdentity.accountId===null || identityOk(s.requestedIdentity.accountId)) &&
    !!s.startup && hashOk(s.startup.reviewHash) && hashOk(s.startup.configurationHash) && ['NONE','REVIEWED'].includes(s.startup.hooks) && ['NONE','REVIEWED'].includes(s.startup.mcp) && ['NONE','REVIEWED'].includes(s.startup.managed) && typeof s.startup.isolated==='boolean' && Array.isArray(s.startup.supported) && s.startup.supported.length<=40 && s.startup.supported.every(identityOk);
}
export async function preflightNativeTransport(selection: NativeSelection): Promise<NativePreflight> {
  const s=structuredClone(selection), reasons:string[]=[];
  if(!validateNativeSelection(s)) throw Error('Invalid native transport selection.');
  for(const directory of [s.cwd,s.home]) { try { if(!(await fs.lstat(directory)).isDirectory() || hasLinkedAncestor(directory))reasons.push('Reviewed directories must be real local directories.'); }catch{reasons.push('Reviewed directory is unavailable.');} }
  try {
    const stat=await fs.lstat(s.executable);
    if(!stat.isFile() || stat.isSymbolicLink() || /\.(cmd|bat|ps1|sh|js|cjs|mjs)$/i.test(s.executable) || stat.size>200*1024*1024 || createHash('sha256').update(await fs.readFile(s.executable)).digest('hex')!==s.executableSha256) reasons.push('Exact native executable hash is unavailable or changed.');
  }catch{reasons.push('Exact native executable is unavailable.');}
  // CLI switches are not OS isolation. The trusted host must review startup before ANY process launch.
  if(!s.startup.isolated) reasons.push('Verified isolated native execution host is required.');
  const required=s.transport==='codex-app-server'?['initialize','thread/start','thread/resume','turn/start','turn/interrupt']:s.transport==='codex-cli'?['exec','json','resume','sandbox']:['print','stream-json','resume','restricted','tools','strict-mcp-config'];
  if(required.some(cap=>!s.startup.supported.includes(cap))) reasons.push('Installed native version lacks a reviewed required capability.');
  if(s.transport==='claude-cli' && s.requestedIdentity.effort!==null && !s.startup.supported.includes('effort')) reasons.push('Requested effort is not supported by this installed version.');
  return {schema:'datapass.native-preflight/1',version:nativeTransportVersion,state:reasons.length?'BLOCKED':'READY',selectionHash:nativeHash(s),reasons,
    capabilities:{start:!reasons.length,stream:!reasons.length,resume:!reasons.length,cancel:s.transport==='codex-app-server'?'OWNED_TURN':'OWNED_PROCESS',securityRequests:'NATIVE_REFUSAL',observedIdentity:'PROVIDER_EVIDENCE_ONLY'}};
}
export function prepareNativeTask(input: NativeTaskInput): PreparedNativeTask {
  const i=structuredClone(input);
  if(!validateNativeSelection(i.selection) || !nativeIdOk(i.taskId) || typeof i.text!=='string' || !i.text.trim() || Buffer.byteLength(i.text)>64*1024 || i.text.includes('\0') || ![i.targetHash,i.permissionHash,i.configHash,i.presetHash,i.promptHash,i.bindingHash,i.scopeHash,i.configScopeHash].every(hashOk) || i.resumeFromTaskId!==undefined && !nativeIdOk(i.resumeFromTaskId))throw Error('Invalid exact prepared native task.');
  const task={...i,schema:'datapass.native-task/1' as const};
  return {...task,preparedHash:nativeHash(task)};
}
/** Fixed native command vocabulary. Prompt is delivered over stdin, never shell text or argv. */
export function nativeLaunchArguments(task: PreparedNativeTask, resumeId?:string): string[] {
  const s=task.selection;
  if(resumeId!==undefined && !nativeIdOk(resumeId))throw Error('Invalid owned native session.');
  if(s.transport==='codex-app-server')return ['app-server','--listen','stdio://'];
  if(s.transport==='codex-cli') {
    const args=['exec',...(resumeId?['resume',resumeId]:[]),'--json','-c','approval_policy="never"','-c',`sandbox_mode="${s.permission}"`,'-c','sandbox_workspace_write.network_access=false','--model',s.requestedIdentity.model];
    if(s.requestedIdentity.effort)args.push('-c',`model_reasoning_effort="${s.requestedIdentity.effort}"`);
    return [...args,'-'];
  }
  const tools=s.permission==='read-only'?'Read,Glob,Grep':'Read,Glob,Grep,Edit,Write';
  return ['--print','--input-format','text','--output-format','stream-json','--verbose','--include-partial-messages','--restricted','--tools',tools,'--allowedTools',tools,'--disallowedTools','mcp__*','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--model',s.requestedIdentity.model,...(s.requestedIdentity.effort?['--effort',s.requestedIdentity.effort]:[]),...(resumeId?['--resume',resumeId]:[])];
}
/** Deliberately no inherited PATH, credentials, command hooks, agents or token environment. Native owns auth in reviewed home. */
export function nativeEnvironment(selection:NativeSelection): NodeJS.ProcessEnv {
  return {HOME:selection.home,USERPROFILE:selection.home,CODEX_HOME:selection.home,CLAUDE_CONFIG_DIR:selection.home,...(process.platform==='win32'?{SystemRoot:process.env.SystemRoot}:{} )};
}
