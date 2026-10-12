import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJson, sha256 } from '../galaxy';
import { hasLinkedAncestor, isPlausibleLocalPath } from '../util/paths';
import { isForbidden, parseToml } from '../feeds/settings';
import type { NativeSelection } from './nativeTransport';

export interface NativeStartupManifest {
  schema:'datapass.native-startup-manifest/1';transport:NativeSelection['transport'];cwd:string;home:string;
  files:{id:string;state:'ABSENT'|'HASHED'|'PRESENT_UNREVIEWED'|'UNKNOWN';sha256:string|null;bytes:number|null}[];
  directories:{id:string;state:'ABSENT'|'EMPTY'|'PRESENT_UNREVIEWED'|'UNKNOWN'}[];
  localState:'VERIFIED_NO_CUSTOMIZATIONS'|'PARTIAL';managedState:'UNKNOWN';isolationState:'ASSERTED';
  omissions:string[];manifestHash:string;
}
const hash=(value:unknown)=>sha256(canonicalJson(value));
/** Fixed startup inventory only. No CLI, auth store, history, arbitrary file path or payload projection. */
export async function captureNativeStartupManifest(selection:Pick<NativeSelection,'transport'|'cwd'|'home'|'providerHome'>):Promise<NativeStartupManifest>{
  const s={...structuredClone(selection),home:selection.providerHome??selection.home};
  if(!s || !['codex-app-server','codex-cli','claude-cli'].includes(s.transport) || ![s.cwd,s.home].every(p=>isPlausibleLocalPath(p)&&!hasLinkedAncestor(p)))throw Error('Invalid bounded startup inventory.');
  const files:NativeStartupManifest['files']=[],directories:NativeStartupManifest['directories']=[],issues:string[]=[];
  const codex=s.transport!=='claude-cli';
  const file=async(id:string,p:string,read:boolean)=>{
    try{
      const stat=await fs.lstat(p);
      if(stat.isSymbolicLink()||hasLinkedAncestor(p)||!stat.isFile()||stat.size>256*1024){files.push({id,state:'UNKNOWN',sha256:null,bytes:null});issues.push(id);return;}
      if(!read || isForbidden(p)){files.push({id,state:'PRESENT_UNREVIEWED',sha256:null,bytes:stat.size});issues.push(id);return;}
      const bytes=await fs.readFile(p);if(bytes.length!==stat.size){files.push({id,state:'UNKNOWN',sha256:null,bytes:null});issues.push(id);return;}
      files.push({id,state:'HASHED',sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});
      const text=bytes.toString('utf8').replace(/^\uFEFF/,'');
      // Unknown keys can acquire native startup semantics in another version. Fail closed.
      const parsed:any=path.extname(p)==='.toml'?parseToml(text):path.extname(p)==='.json'?JSON.parse(text):null;
      if(parsed){
        const allowed=codex?new Set(['model','model_reasoning_effort','approval_policy','sandbox_mode']):new Set(['model','effortLevel']);
        if(!parsed||Array.isArray(parsed)||Object.keys(parsed).some(k=>!allowed.has(k)))issues.push(id);
      }
      // Instruction files are exact-byte bound, but cannot certify managed/platform state.
    }catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')files.push({id,state:'ABSENT',sha256:null,bytes:null});else{files.push({id,state:'UNKNOWN',sha256:null,bytes:null});issues.push(id);}}
  };
  const directory=async(id:string,p:string)=>{
    try{const stat=await fs.lstat(p);if(stat.isSymbolicLink()||hasLinkedAncestor(p)||!stat.isDirectory()){directories.push({id,state:'UNKNOWN'});issues.push(id);return;}
      // Never recurse or enumerate names inside native plugin/skill/history trees.
      const handle=await fs.opendir(p);let nonempty=false;try{for await(const entry of handle){nonempty=true;break;}}finally{/* async iterator closes the directory */}
      directories.push({id,state:nonempty?'PRESENT_UNREVIEWED':'EMPTY'});if(nonempty)issues.push(id);
    }catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')directories.push({id,state:'ABSENT'});else{directories.push({id,state:'UNKNOWN'});issues.push(id);}}
  };
  const homeFiles=codex?['config.toml','hooks.json','requirements.toml','AGENTS.md']:['settings.json','managed-settings.json','.mcp.json','hooks/hooks.json','CLAUDE.md'];
  for(const relative of homeFiles)await file('home/'+relative,path.join(s.home,relative),true);
  // Global Claude JSON may mix native settings and credentials: presence blocks; contents never read.
  if(!codex)await file('home/.claude.json',path.join(s.home,'.claude.json'),false);
  for(const relative of codex?['plugins','skills','agents','rules','hooks']:['plugins','skills','agents','rules','hooks'])await directory('home/'+relative,path.join(s.home,relative));
  const projectFiles=codex?['.codex/config.toml','.codex/hooks.json','AGENTS.md']:['.claude/settings.json','.claude/settings.local.json','.mcp.json','CLAUDE.md'];
  for(const relative of projectFiles)await file('project/'+relative,path.join(s.cwd,relative),true);
  for(const relative of codex?['.codex/plugins','.codex/skills','.codex/agents','.codex/rules','.agents/skills']:['.claude/plugins','.claude/skills','.claude/agents','.claude/rules','.claude/hooks'])await directory('project/'+relative,path.join(s.cwd,relative));
  // The installed facade verifies cwd is the exact Git project root. An unbounded cwd cannot
  // certify native ancestor-layer discovery; do not read other projects or owner ancestors.
  try{await fs.lstat(path.join(s.cwd,'.git'));}catch{issues.push('project-root-unverified');}
  let depth=0;for(let ancestor=path.dirname(s.cwd);ancestor!==path.dirname(ancestor)&&depth<32;ancestor=path.dirname(ancestor),depth++){
    for(const relative of projectFiles)await file('ancestor/'+depth+'/'+relative,path.join(ancestor,relative),false);
    for(const relative of codex?['.codex/rules','.codex/plugins','.agents/skills']:['.claude/rules','.claude/plugins','.claude/hooks'])await directory('ancestor/'+depth+'/'+relative,path.join(ancestor,relative));
  }
  if(depth>=32)issues.push('ancestor-bound');
  const managed=codex?(process.platform==='win32'?[]:['/etc/codex/config.toml','/etc/codex/requirements.toml','/etc/codex/hooks.json']):[process.platform==='win32'?'C:/Program Files/ClaudeCode/managed-settings.json':process.platform==='darwin'?'/Library/Application Support/ClaudeCode/managed-settings.json':'/etc/claude-code/managed-settings.json'];
  for(let i=0;i<managed.length;i++)await file('system-managed/'+i,managed[i],false);
  const value={schema:'datapass.native-startup-manifest/1' as const,transport:s.transport,cwd:s.cwd,home:s.home,files,directories,localState:issues.length?'PARTIAL' as const:'VERIFIED_NO_CUSTOMIZATIONS' as const,managedState:'UNKNOWN' as const,isolationState:'ASSERTED' as const,
    omissions:['No auth/history read, credential payload, hook/MCP command or arbitrary startup source exported.','MDM, cloud-managed settings, version-specific sources and OS isolation cannot be established by a local file inventory.','Nonempty customization trees, unknown configuration keys, unreadable or inherited/system sources require a separate verified startup audit.']};
  return {...value,manifestHash:hash(value)};
}
/** A review digest binds actual local file facts and clearly labelled remaining assertions. */
export function nativeStartupReviewHash(selection:NativeSelection,manifest:NativeStartupManifest):string{
  return hash({manifestHash:manifest.manifestHash,transport:selection.transport,executableSha256:selection.executableSha256,nativeVersion:selection.nativeVersion,hostId:selection.hostId,capabilityAssertions:selection.startup.supported,isolationAssertion:selection.startup.isolated,hooksAssertion:selection.startup.hooks,mcpAssertion:selection.startup.mcp,managedAssertion:selection.startup.managed});
}
