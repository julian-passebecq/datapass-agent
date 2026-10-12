// Product-owned exact-runtime checks. No provider task or GUI is launched.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
const node=path.resolve(process.argv[2]??process.execPath),nodeHash=sha(fs.readFileSync(node));
if(process.argv[3] && nodeHash!==process.argv[3])throw Error('Exact qualification runtime hash mismatch.');
const nodeHome=path.dirname(node),npm=path.join(nodeHome,'node_modules/npm/bin/npm-cli.js');
if(!fs.existsSync(npm))throw Error('Selected runtime npm CLI unavailable.');
const root=process.cwd(),destination=path.resolve(process.argv[4]??path.join(root,'docs/complete-native-20261012')),temp=fs.mkdtempSync(path.join(os.tmpdir(),'agent-complete-native-qa-'));
const childEnvironment={...process.env,HOME:temp,USERPROFILE:temp,CODEX_HOME:path.join(temp,'codex'),CLAUDE_CONFIG_DIR:path.join(temp,'claude'),APPDATA:path.join(temp,'appdata'),LOCALAPPDATA:path.join(temp,'localappdata'),PATH:nodeHome+path.delimiter+process.env.PATH};
for(const key of Object.keys(childEnvironment))if(/token|secret|password|api[_-]?key|credential/i.test(key))delete childEnvironment[key];
for(const key of ['CODEX_HOME','CLAUDE_CONFIG_DIR','APPDATA','LOCALAPPDATA'])fs.mkdirSync(childEnvironment[key],{recursive:true});
fs.mkdirSync(destination,{recursive:true});
const gates=[],startedAt=new Date().toISOString();
const run=(name,args)=>{const start=new Date().toISOString(),r=spawnSync(node,args,{cwd:root,env:childEnvironment,encoding:'utf8',windowsHide:true,shell:false,maxBuffer:32*1024*1024}),log=(r.stdout??'')+(r.stderr??'');fs.writeFileSync(path.join(destination,name+'.log'),log);gates.push({name,command:args,exitCode:r.status,startedAt:start,completedAt:new Date().toISOString(),log:name+'.log',logSha256:sha(log)});process.stdout.write(`${name}: exit ${r.status}\n`);if(r.error||r.status!==0)throw Error(`${name} failed; inspect product-owned log.`);};
let state='FAILED';
try{
  for(const action of ['check','compile-tests'])run(action,[npm,'run',action]);
  run('targeted',['--test','out-test/test/nativeTransport.test.js','out-test/test/render.test.js','out-test/test/providerKit.test.js']);
  run('locale-en-CH',['--require','./docs/complete-native-20261012/force-en-CH.cjs','--test','out-test/test/render.test.js']);
  for(const action of ['test','build','build:provider-kit','package'])run(action,[npm,'run',action]);
  state='LOCAL_WINDOWS_MANDATORY_PASS';
}finally{
  fs.writeFileSync(path.join(destination,'qa-receipt.json'),JSON.stringify({schema:'datapass.agent-native-qa/1',state,startedAt,completedAt:new Date().toISOString(),runtime:{version:spawnSync(node,['--version'],{encoding:'utf8'}).stdout.trim(),sha256:nodeHash},productVersion:JSON.parse(fs.readFileSync('package.json')).version,gates,isolation:'Dedicated synthetic home and fixture processes; not an OS security sandbox',nativeProviderTasks:0,ownerDesktopInput:false,installedGuiJourney:'BLOCKED_NOT_EXECUTED',liveAccounts:'UNQUALIFIED'},null,2)+'\n');
  fs.rmSync(temp,{recursive:true,force:true});
}
