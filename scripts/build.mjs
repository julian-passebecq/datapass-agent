import { build } from 'esbuild';

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
