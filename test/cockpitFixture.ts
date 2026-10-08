import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { CodexAdapter } from "../src/providers/codex/codex";
import { makeGrant } from "../src/cockpit/policy";
export async function cockpitFixture() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cockpit-test-'));
  const codexHome = path.join(temp, 'codex'), claudeHome = path.join(temp, 'claude'), repo = path.join(temp, 'repo');
  const sessionsDir = path.join(codexHome, 'sessions', '2026', '10', '08');
  await Promise.all([sessionsDir, claudeHome, repo].map(p => fs.mkdir(p, { recursive: true })));
  const adapter = new CodexAdapter(codexHome);
  const ids = ['11111111-1111-7111-8111-111111111111', '22222222-2222-7222-8222-222222222222'];
  const files: string[] = [], snapshots = [];
  for (const id of ids) {
    const file = path.join(sessionsDir, `rollout-2026-10-08T10-00-00-${id}.jsonl`);
    const text = [
      { type: 'session_meta', timestamp: new Date().toISOString(), payload: { id, cwd: repo, cli_version: '0.162.0' } },
      { type: 'turn_context', payload: { model: 'gpt-6', effort: 'high', approval_policy: 'never' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello api_key=fixture-secret-value' }] } },
      { type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'PRIVATE_HIDDEN_REASONING' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] } },
    ].map(x => JSON.stringify(x)).join('\n') + '\n';
    await fs.writeFile(file, text); const st = await fs.stat(file);
    files.push(file); snapshots.push(adapter.ingest({ path: file, size: st.size, mtimeMs: st.mtimeMs })!.toSnapshot());
  }
  const grant = makeGrant({ id: 'local:fixture', organization: 'local', privacy: 'fixture', project: 'fixture', sessions: [snapshots[0]], configuration: true, exportConsent: true });
  return { temp, repo, codexHome, claudeHome, files, snapshots, adapter, grant };
}
