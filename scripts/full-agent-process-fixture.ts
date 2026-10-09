import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { readProcessMetadata } from '../src/cockpit/processMetadata';

async function main(){
  const destination=path.resolve(process.argv[2]);
  // Only this owned fixture process is selected; no unowned provider PID or argument inventory.
  const lookup=await readProcessMetadata(process.pid);
  if(lookup.state!=='OBSERVED' || lookup.process.alive!==true || lookup.process.pid!==process.pid)throw new Error('Own fixture PID observation failed.');
  await fs.mkdir(path.dirname(destination),{recursive:true});
  await fs.writeFile(destination,JSON.stringify({schema:'datapass.selected-process-fixture/1',fixture:true,scope:'Actual native metadata query of this owned Node fixture process only; no installed UI claim',lookup,capturedAt:new Date().toISOString()},null,2)+'\n',{flag:'wx'});
  console.log('Owned fixture process metadata PASS');
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
