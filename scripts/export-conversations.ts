import * as path from 'node:path';
import { discoverConversations, exportConversations, projectMatches, sanitize, ConversationSource } from '../src/export/conversations';

async function main(): Promise<void> {
  const args = process.argv.slice(2), projects: string[] = [], ids: string[] = [], inputs: ConversationSource[] = [];
  let destination: string | undefined, list = false, provider: 'codex' | 'claude' | undefined;
  let codexHome: string | undefined, claudeHome: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--help') {
      console.log('DataPass export: --list | --project <folder> | --session <id> --out <folder>\nOptional: --provider codex|claude --codex-home <folder> --claude-home <folder>\nAdditional local inputs: --input chatgpt|mongo|csv=<file> (repeatable).\nOutputs: full redacted JSONL, Markdown, Leviathan JSONL, cockpit.json. No network or publication.'); return;
    }
    if (key === '--list') { list = true; continue; }
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error('Missing option value.');
    if (key === '--project') projects.push(value);
    else if (key === '--session') ids.push(value);
    else if (key === '--out') destination = value;
    else if (key === '--codex-home') codexHome = value;
    else if (key === '--claude-home') claudeHome = value;
    else if (key === '--provider' && (value === 'codex' || value === 'claude')) provider = value;
    else if (key === '--input') {
      const separator = value.indexOf('='), kind = value.slice(0, separator);
      if (separator < 0 || !['chatgpt', 'mongo', 'csv'].includes(kind)) throw new Error('Input must use chatgpt|mongo|csv=<file>.');
      const file = path.resolve(value.slice(separator + 1));
      inputs.push({ provider: kind as 'chatgpt' | 'mongo' | 'csv', file, id: path.basename(file) });
    } else throw new Error('Unknown option. Use --help.');
  }
  const native = list || projects.length || ids.length ? await discoverConversations({ provider, codexHome, claudeHome }) : [];
  if (list) { console.log(JSON.stringify(native.map(({ file: _file, ...source }) => sanitize(source)), null, 2)); return; }
  if (!destination) throw new Error('An output folder is required. Use --out.');
  if (!projects.length && !ids.length && !inputs.length) throw new Error('Select projects, sessions or explicit input files. All-history export is deliberately unavailable.');
  const selected = native.filter(source => ids.includes(source.id) || projects.some(project => projectMatches(source.project, project)));
  const bundle = await exportConversations([...selected, ...inputs], destination);
  console.log(JSON.stringify({ schema: bundle.schema, sessions: bundle.sessions.length,
    records: bundle.sessions.reduce((sum, session) => sum + session.records, 0),
    malformed: bundle.sessions.reduce((sum, session) => sum + session.malformed, 0), destination: bundle.directory }));
}
void main().catch(() => { console.error('DataPass export failed. Check selection, input format and folder permissions. No source was modified.'); process.exitCode = 1; });
