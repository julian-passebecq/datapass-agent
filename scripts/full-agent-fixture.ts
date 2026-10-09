import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { cockpitFixture } from '../test/cockpitFixture';
import { CockpitFacade, localHost } from '../src/cockpit/facade';
import { ScopePolicy, repoId } from '../src/cockpit/policy';
import { IncrementalExporter } from '../src/export/incremental';
import type { ContextRef } from '../src/cockpit/interfaces';

async function main() {
  const destination=path.resolve(process.argv[2]);await fs.mkdir(destination,{recursive:true});
  const f=await cockpitFixture();
  try {
    const policy=new ScopePolicy();policy.set(f.grant);const opened:unknown[]=[];
    const facade=new CockpitFacade({all:()=>f.snapshots,opts:{historyDays:3},lastStats:{at:Date.now()},onDidChange:()=>({dispose(){}})},policy,{open:(view,grant,id,context,returnBinding)=>{opened.push({view,scope:grant.scope,id,context,returnBinding});},async openSource(){}},new IncrementalExporter([f.adapter]));
    const request={requestId:'fixture:context',scope:f.grant.scope,epoch:policy.epoch,generation:'fixture:generation:1'};
    const context:ContextRef={organizationId:f.grant.scope.organizationIds[0],privacyDomainId:f.grant.scope.privacyDomainIds[0],projectId:f.grant.scope.projectIds[0],repoId:repoId(f.repo),hostId:localHost().hostId,worktreeId:null,revision:null,selectedItemId:f.snapshots[0].key,returnToken:'pm:work:synthetic-1'};
    const contextRequest={...request,context};
    const positive=await facade.api.revealContext(contextRequest);
    const denied=await facade.api.revealContext({...contextRequest,context:{...context,projectId:'other-private-project'}});
    const capabilities=await facade.api.capabilities(),scopes=await facade.api.getScopes(),summary=await facade.api.getSummary(request),observation=await facade.api.getObservation(request);
    for(const [name,data] of Object.entries({'capabilities':capabilities,'scopes':scopes,'summary':summary,'observation':observation,'context-request':contextRequest,'context-roundtrip':{positive,denied,opened}}))await fs.writeFile(path.join(destination,name+'.json'),JSON.stringify({fixture:true,evidenceScope:'ACTUAL_FACADE_WITH_SYNTHETIC_STORE_AND_MOCKED_HOST_OPEN; no installed/UI claim',data},null,2)+'\n',{flag:'wx'});
    facade.dispose();
  }finally{await fs.rm(f.temp,{recursive:true,force:true});}
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
