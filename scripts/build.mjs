import { build } from 'esbuild';
import { copyFile } from 'node:fs/promises';

await build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  sourcemap: false,
  minify: true,
  legalComments: 'none',
  logLevel: 'warning',
});
console.log('built dist/extension.js');
await copyFile('docs/first-jul-journey-20261013/RC2-THIRD-PARTY-NOTICES.txt','dist/RC2-THIRD-PARTY-NOTICES.txt');
await build({
  entryPoints: ['scripts/export-conversations.ts'], bundle: true, platform: 'node', target: 'node20',
  format: 'cjs', outfile: 'dist/export-conversations.cjs', logLevel: 'warning',
});
console.log('built dist/export-conversations.cjs');
await build({
  entryPoints: ['scripts/search-knowledge.ts'], bundle: true, platform: 'node', target: 'node20',
  format: 'cjs', outfile: 'dist/search-knowledge.cjs', logLevel: 'warning',
});
console.log('built dist/search-knowledge.cjs');
await build({
  entryPoints: ['scripts/export-provider-history.ts'], bundle: true, platform: 'node', target: 'node20',
  format: 'cjs', outfile: 'dist/export-provider-history.cjs', logLevel: 'warning',
});
console.log('built dist/export-provider-history.cjs');
