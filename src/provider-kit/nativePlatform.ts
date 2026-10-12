import { createHash, createPublicKey, verify } from 'node:crypto';
import { canonicalJson, sha256 } from '../galaxy';
import type { NativeSelection } from './nativeTransport';
import type { NativeStartupManifest } from './nativeStartup';
export interface NativePlatformVerifier {issuerId:string;publicKeyPem:string;fingerprint:string;}
export interface NativePlatformProof {
  schema:'datapass.native-platform-proof/1';issuerId:string;keyFingerprint:string;signature:string;
  payload:{hostId:string;transport:NativeSelection['transport'];cwd:string;home:string;permission:NativeSelection['permission'];executableSha256:string;nativeVersion:string;startupManifestHash:string;environmentHash:string;toolPolicyHash:string;supportedCapabilities:string[];
    managed:{state:'COMPLETE_NO_STARTUP_EFFECTS';sourceHash:string;sourceRef:string};ambient:{state:'DISABLED_OR_SEALED';sourceHash:string;sourceRef:string};isolation:{state:'ENFORCED';descendants:'ENFORCED';boundaryId:string;policyHash:string};issuedAt:string;expiresAt:string;};
}
export interface NativePlatformVerification {state:'TRUSTED_VERIFIER_REPORTED'|'UNKNOWN';issuerId:string|null;reason:string|null;}
export function validateNativePlatformVerifier(value:NativePlatformVerifier):boolean{
  try{if(typeof value.publicKeyPem!=='string'||value.publicKeyPem.length>2048||!/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\s*$/.test(value.publicKeyPem))return false;const key=createPublicKey(value.publicKeyPem);return /^[a-zA-Z0-9._:-]{1,160}$/.test(value.issuerId)&&key.asymmetricKeyType==='ed25519'&&createHash('sha256').update(key.export({format:'der',type:'spki'})).digest('hex')===value.fingerprint;}catch{return false;}
}
/** Keys come from Agent host authority, never selection JSON. Signatures authenticate the verifier's report. */
export function verifyNativePlatformProof(selection:NativeSelection,manifest:NativeStartupManifest,trustedKeys:NativePlatformVerifier[],environmentHash:string,toolPolicyHash:string,now=Date.now()):NativePlatformVerification{
  const fail=(reason:string):NativePlatformVerification=>({state:'UNKNOWN',issuerId:null,reason});
  const proof=selection.startup.platformProof;if(!proof||proof.schema!=='datapass.native-platform-proof/1')return fail('An independent signed platform verification receipt is required.');
  const anchor=trustedKeys.find(k=>k.issuerId===proof.issuerId&&k.fingerprint===proof.keyFingerprint&&validateNativePlatformVerifier(k));
  if(!anchor)return fail('Platform verifier is not trusted by the Agent host.');
  try{
    if(typeof proof.signature!=='string'||proof.signature.length!==88||!verify(null,Buffer.from(canonicalJson(proof.payload)),createPublicKey(anchor.publicKeyPem),Buffer.from(proof.signature,'base64')))return fail('Platform proof signature is invalid.');
    const p=proof.payload,issued=Date.parse(p.issuedAt),expires=Date.parse(p.expiresAt);
    if(!Number.isFinite(issued)||!Number.isFinite(expires)||issued>now+30000||expires<=now||expires-issued>10*60*1000)return fail('Platform proof is expired or has an invalid bounded lifetime.');
    if(p.hostId!==selection.hostId||p.transport!==selection.transport||p.cwd!==selection.cwd||p.home!==selection.home||p.permission!==selection.permission||p.executableSha256!==selection.executableSha256||p.nativeVersion!==selection.nativeVersion||p.startupManifestHash!==manifest.manifestHash||p.environmentHash!==environmentHash||p.toolPolicyHash!==toolPolicyHash||canonicalJson(p.supportedCapabilities)!==canonicalJson(selection.startup.supported))return fail('Platform proof does not bind the exact host, executable, startup inventory, permission, environment, tool policy and capability set.');
    if(p.managed?.state!=='COMPLETE_NO_STARTUP_EFFECTS'||!/^[a-f0-9]{64}$/.test(p.managed.sourceHash)||!/^[a-zA-Z0-9._:/-]{1,160}$/.test(p.managed.sourceRef)||p.ambient?.state!=='DISABLED_OR_SEALED'||!/^[a-f0-9]{64}$/.test(p.ambient.sourceHash)||!/^[a-zA-Z0-9._:/-]{1,160}$/.test(p.ambient.sourceRef)||p.isolation?.state!=='ENFORCED'||p.isolation.descendants!=='ENFORCED'||!/^[a-zA-Z0-9._:/-]{1,160}$/.test(p.isolation.boundaryId)||!/^[a-f0-9]{64}$/.test(p.isolation.policyHash))return fail('Platform managed/ambient startup-effect coverage or isolation fence is incomplete.');
    return {state:'TRUSTED_VERIFIER_REPORTED',issuerId:anchor.issuerId,reason:null};
  }catch{return fail('Malformed platform verification receipt.');}
}
