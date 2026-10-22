import { ScopePolicy, LocalGrant } from '../cockpit/policy';
import { NativeTransportFacade } from './nativeFacade';
import { NativeTaskRunner } from './nativeRunner';
import { PreparedNativeTask } from './nativeTransport';
import { NativePlatformVerifier } from './nativePlatform';
import { MafRuntime } from './nativeMaf';

/** Explicit host composition, with no editor discovery, default grants or automatic review. */
export function createHeadlessNativeHost(options:{
  ledgerDirectory:string;hostId:string;grant:LocalGrant;
  review:(task:PreparedNativeTask)=>Promise<boolean>;
  trusted:()=>boolean;platformVerifiers:()=>NativePlatformVerifier[];
  mafRuntime?:MafRuntime;
}) {
  if(typeof options.review!=='function'||typeof options.trusted!=='function'||typeof options.platformVerifiers!=='function')throw Error('Explicit host authority and review callbacks are required.');
  const policy=new ScopePolicy();policy.set(structuredClone(options.grant));
  const runner=new NativeTaskRunner(options.ledgerDirectory,undefined,options.platformVerifiers,options.mafRuntime);
  const facade=new NativeTransportFacade(runner,policy,options.hostId,options.review,options.trusted);
  return Object.freeze({api:facade.api,epoch:policy.epoch,revoke:()=>policy.clear(),dispose:()=>facade.dispose()});
}
