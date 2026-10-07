import { exportProviderHistory, HistoryOptions } from '../src/export/providerHistory';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('Agent bulk history: export --provider codex|claude --out <empty-directory>\nOptional: --codex-home <directory> --claude-home <directory>\nRead-only, local redacted bundle. No Git, network, archive commit or push.'); return;
  }
  if (args.shift() !== 'export') throw new Error('Expected export subcommand.');
  const values = new Map<string, string>();
  while (args.length) {
    const key = args.shift()!, value = args.shift();
    if (!['--provider', '--out', '--codex-home', '--claude-home'].includes(key) || values.has(key) || !value || value.startsWith('--'))
      throw new Error('Invalid arguments.');
    values.set(key, value);
  }
  const provider = values.get('--provider'), out = values.get('--out');
  if ((provider !== 'codex' && provider !== 'claude') || !out) throw new Error('Provider and output are required.');
  const options: HistoryOptions = { provider, out, codexHome: values.get('--codex-home'), claudeHome: values.get('--claude-home') };
  const bundle = await exportProviderHistory(options);
  console.log(JSON.stringify({ schema: bundle.schema, provider, sessions: bundle.sessionCount, artifacts: bundle.artifactCount, records: bundle.eventCount,
    changedExternally: bundle.records.filter(r => r.source.changedDuringExport).length }));
}
void main().catch(error => {
  // Never print source content, source paths or credentials in CLI failures.
  const message = error instanceof Error ? error.message : '';
  const category = /malformed|oversize/.test(message) ? 'invalid native record' : /Captured source|truncated/.test(message)
    ? 'source changed externally' : /No native/.test(message) ? 'no provider history' : /Output|output/.test(message)
      ? 'unsafe or nonempty output' : 'arguments, discovery or read failure';
  console.error(`Agent history export failed: ${category}. No provider source was written. No archive was committed or pushed.`);
  process.exitCode = 1;
});
