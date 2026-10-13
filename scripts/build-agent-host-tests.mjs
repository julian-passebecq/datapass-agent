import { build } from 'esbuild';
// The official SDK is ESM-only. Bundle just the affected test/fixture; legacy
// test compilation and product gates keep their existing CommonJS behavior.
await build({entryPoints:['test/agentHost.test.ts'],outfile:'out-test/test/agentHost.test.js',bundle:true,platform:'node',target:'node22',format:'cjs',external:['vscode'],logLevel:'warning'});
console.log('bundled official AHP SDK synthetic protocol tests');
