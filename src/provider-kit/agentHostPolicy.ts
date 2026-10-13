import type { AHPExecutionPolicy } from './agentHostTypes';

export const readOnlyConfig = () => ({
  'codex.sandboxMode':'read-only', 'codex.approvalPolicy':'never',
  'codex.networkAccessEnabled':false, 'codex.webSearchMode':'disabled',
  'codex.additionalDirectories':[], permissions:{allow:[],deny:[]},
});
export class AHPPermissionError extends Error {
  constructor(message:string){super(message);this.name='AHPPermissionError';}
}
export function validExecutionPolicy(p:unknown):p is AHPExecutionPolicy {
  const v=p as AHPExecutionPolicy;
  return !!v && Object.keys(v).sort().join(',')==='mode,sourcePolicyHash' &&
    v.mode==='READ_ONLY_NO_DELEGATION' && /^[a-f0-9]{64}$/.test(v.sourcePolicyHash);
}
const object=(v:unknown):v is Record<string,unknown> => !!v && typeof v==='object' && !Array.isArray(v);
const empty=(v:unknown)=>Array.isArray(v)&&v.length===0;
export function restrictiveValues(v:unknown):boolean {
  if(!object(v)||Object.hasOwn(v,'codex.permissionsPreset'))return false;
  return v['codex.sandboxMode']==='read-only' && v['codex.approvalPolicy']==='never' &&
    v['codex.networkAccessEnabled']===false && v['codex.webSearchMode']==='disabled' &&
    empty(v['codex.additionalDirectories']) && object(v.permissions) &&
    empty(v.permissions.allow) && empty(v.permissions.deny);
}
/** Only declared public schema keys and server-resolved values; no private tool filter. */
export function validateResolvedPolicy(result:unknown):Record<string,unknown> {
  if(!object(result)||!object(result.schema)||!object(result.schema.properties)||!restrictiveValues(result.values))
    throw new AHPPermissionError('Restrictive configuration is missing, unsafe or overridden by a permission preset.');
  const props=result.schema.properties;
  for(const [key,wanted]of Object.entries(readOnlyConfig())){
    const p=props[key];
    if(!object(p))throw new AHPPermissionError('Provider does not declare the required permission configuration.');
    const type=typeof wanted==='boolean'?'boolean':typeof wanted==='string'?'string':Array.isArray(wanted)?'array':'object';
    if(p.type!==type || Array.isArray(p.enum)&&!p.enum.includes(wanted) ||
      p.readOnly===true && JSON.stringify(p.default)!==JSON.stringify(wanted))
      throw new AHPPermissionError('Provider permission schema does not support the restrictive value.');
  }
  return readOnlyConfig();
}
/** Hash only security-related host state, never account metadata or connection secrets. */
export function reviewedHostPolicy(root:unknown):Record<string,unknown> {
  if(!object(root)||!object(root.config)||!object(root.config.values))
    throw new AHPPermissionError('Host permission configuration is unavailable.');
  const values=root.config.values, schema=root.config.schema;
  const properties=object(schema)&&object(schema.properties)?schema.properties:{};
  const selected:Record<string,unknown>={};
  for(const key of ['globalAutoApproveEnabled','terminalAutoApproveEnabled','agentMerge.enabled','artifactTools']){
    const property=properties[key];
    const value=Object.hasOwn(values,key)?values[key]:object(property)?property.default:undefined;
    if(value!==false)throw new AHPPermissionError('Host auto-approval, network or artifact controls are unsafe or unknown.');
    selected[key]={value,source:Object.hasOwn(values,key)?'SERVER_VALUE':'SERVER_SCHEMA_DEFAULT'};
  }
  const permissions=values.permissions;
  if(!object(permissions)||!empty(permissions.allow)||!empty(permissions.deny))
    throw new AHPPermissionError('Inherited host tool permissions are unsafe or unknown.');
  selected.permissions={allow:[],deny:[]};
  return selected;
}
/** Public AHP 1.0/0.9 publishes configuration, not independent native sandbox/tool enforcement. */
export function requireEffectivePermissionEvidence():never {
  throw new AHPPermissionError('Effective native read-only, network and delegation enforcement and complete host-tool restrictions are UNKNOWN: public AHP exposes configuration only. No turn sent.');
}
