import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { exportProviderHistory, hashPrefix } from '../src/export/providerHistory';
import { sanitize } from '../src/export/conversations';

const sid = '11111111-1111-4111-8111-111111111111';
const worker = '22222222-2222-4222-8222-222222222222';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
async function fixture() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-bulk-test-'));
  const codexHome = path.join(temp, 'codex'), claudeHome = path.join(temp, 'claude');
  const codex = path.join(codexHome, 'sessions', '2020', '01', '01', `rollout-2020-01-01T00-00-00-${sid}.jsonl`);
  const claude = path.join(claudeHome, 'projects', 'project', `${sid}.jsonl`);
  for (const file of [codex, claude]) await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(codex, JSON.stringify({ type: 'session_meta', timestamp: '2020-01-01T00:00:00Z',
    payload: { id: sid, cwd: temp, cli_version: '0.162.0-alpha.2' } }) + '\n');
  await fs.writeFile(claude, JSON.stringify({ type: 'user', sessionId: sid, uuid: 'parent', cwd: temp,
    timestamp: '2020-01-01T00:00:00Z', message: { role: 'user', content: 'hello' } }) + '\n');
  return { temp, codexHome, claudeHome, codex, claude };
}

test('bulk Codex includes old and archived workers; keeps full large/unknown native records and hashes', async () => {
  const f = await fixture();
  try {
    const archived = path.join(f.codexHome, 'archived_sessions', `rollout-old-${worker}.jsonl`);
    await fs.mkdir(path.dirname(archived), { recursive: true });
    await fs.writeFile(archived, JSON.stringify({ type: 'session_meta', payload: { id: worker, parent_thread_id: sid } }) + '\n');
    const text = (await fs.readFile(f.codex, 'utf8')) + JSON.stringify({ type: 'future-record',
      payload: { text: 'x'.repeat(600_000) + ' tail retained', api_key: 'bulk-secret-value',
        env: { UNLABELED: 'private-env-value' }, session_id: sid, image_url: 'data:image/png;base64,AAAA' } }) + '\n';
    await fs.writeFile(f.codex, text);
    const bundle = await exportProviderHistory({ ...f, provider: 'codex', out: path.join(f.temp, 'out') });
    assert.equal(bundle.sessionCount, 2); assert.equal(bundle.eventCount, 3);
    const parent = bundle.records.find(r => r.sessionId === sid)!;
    const child = bundle.records.find(r => r.sessionId === worker)!;
    assert.equal(child.parentKey, 'codex:' + sid); assert.equal(child.worker, true);
    assert.equal(parent.source.sha256, sha(text)); assert.equal(parent.source.prefixUnchanged, true);
    assert.equal(parent.source.changedDuringExport, false);
    const exported = await fs.readFile(path.join(f.temp, 'out', parent.file), 'utf8');
    assert.equal(sha(exported), parent.eventSha256);
    const events = exported.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(events[1].event.type, 'future-record');
    assert.match(events[1].event.payload.text, /tail retained$/);
    assert.doesNotMatch(exported, /bulk-secret-value|private-env-value|AAAA/);
    assert.equal(events[1].event.payload.session_id, sid);
    assert.equal(await fs.readFile(f.codex, 'utf8'), text);
    assert.equal(JSON.parse(await fs.readFile(path.join(f.temp, 'out', 'cockpit.json'), 'utf8')).schema, 'datapass.provider-history/1');
  } finally { await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('bulk Claude has distinct worker identity, parent linkage and hashed companion metadata', async () => {
  const f = await fixture();
  try {
    const child = path.join(path.dirname(f.claude), sid, 'subagents', 'agent-worker.jsonl');
    await fs.mkdir(path.dirname(child), { recursive: true });
    await fs.writeFile(child, JSON.stringify({ type: 'assistant', sessionId: sid, agentId: 'worker',
      parentUuid: 'parent', message: { role: 'assistant', content: [{ type: 'text', text: 'worker answer' }] } }) + '\n');
    await fs.writeFile(child.replace('.jsonl', '.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'find facts' }));
    const bundle = await exportProviderHistory({ ...f, provider: 'claude', out: path.join(f.temp, 'out') });
    assert.equal(bundle.sessionCount, 2);
    const record = bundle.records.find(r => r.worker)!;
    assert.equal(record.sessionId, sid + '/agent-worker'); assert.equal(record.parentKey, 'claude:' + sid);
    assert.equal(record.companions.length, 1); assert.equal(record.companions[0].prefixUnchanged, true);
    const event = JSON.parse((await fs.readFile(path.join(f.temp, 'out', record.file), 'utf8')).trim());
    assert.equal(event.event.sessionId, sid); assert.equal(event.event.parentUuid, 'parent');
    assert.equal((record.projection as any).sessionId, sid + '/agent-worker');
  } finally { await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('bulk fails closed on malformed records and does not overwrite a bundle', async () => {
  const f = await fixture();
  try {
    const out = path.join(f.temp, 'out');
    await exportProviderHistory({ ...f, provider: 'codex', out });
    await assert.rejects(exportProviderHistory({ ...f, provider: 'codex', out }), /empty directory/);
    await fs.appendFile(f.codex, 'invalid json\n');
    const failed = path.join(f.temp, 'failed');
    await assert.rejects(exportProviderHistory({ ...f, provider: 'codex', out: failed }), /malformed/);
    await assert.rejects(fs.stat(path.join(failed, 'cockpit.json')), { code: 'ENOENT' });
    assert.ok(await fs.stat(path.join(failed, 'INCOMPLETE.txt')));
  } finally { await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('output is refused anywhere under either provider root, including linked output ancestors', async () => {
  const f = await fixture();
  try {
    await assert.rejects(exportProviderHistory({ ...f, provider: 'codex', out: path.join(f.claudeHome, 'output') }), /outside both/);
    const alias = path.join(f.temp, 'alias');
    await fs.symlink(f.codexHome, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(exportProviderHistory({ ...f, provider: 'codex', out: path.join(alias, 'output') }), /outside both/);
    await assert.rejects(fs.stat(path.join(f.codexHome, 'output')), { code: 'ENOENT' });
  } finally { await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('discovery does not follow linked project directories', async () => {
  const f = await fixture();
  try {
    const external = path.join(f.temp, 'external'); await fs.mkdir(external);
    const linked = path.join(f.claudeHome, 'projects', 'alias');
    await fs.symlink(external, linked, process.platform === 'win32' ? 'junction' : 'dir');
    // Discovery must not follow a linked project directory.
    await fs.writeFile(path.join(external, `${worker}.jsonl`), JSON.stringify({ type: 'user', text: 'outside' }) + '\n');
    const bundle = await exportProviderHistory({ ...f, provider: 'claude', out: path.join(f.temp, 'out') });
    assert.equal(bundle.sessionCount, 1);
  } finally { await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('credential JSONL is refused and linked worker directories are ignored', async () => {
  const f = await fixture();
  try {
    const credential = path.join(path.dirname(f.claude), 'credentials.jsonl');
    await fs.writeFile(credential, '{"password":"must-not-read"}\n');
    await assert.rejects(exportProviderHistory({ ...f, provider: 'claude', out: path.join(f.temp, 'blocked') }), /Unsafe/);
    await assert.rejects(fs.stat(path.join(f.temp, 'blocked')), { code: 'ENOENT' });
    await fs.unlink(credential);
    const childDir = path.join(path.dirname(f.claude), sid, 'subagents');
    await fs.mkdir(childDir, { recursive: true });
    const realChildDir = path.join(f.temp, 'child'); await fs.mkdir(realChildDir);
    await fs.writeFile(path.join(realChildDir, 'agent-worker.jsonl'), '{"type":"assistant"}\n');
    await fs.writeFile(path.join(realChildDir, 'agent-worker.meta.json'), '{"description":"private"}');
    // A directory junction is available on Windows without symlink privileges.
    const linkedChild = path.join(path.dirname(f.claude), worker);
    await fs.mkdir(linkedChild);
    await fs.symlink(realChildDir, path.join(linkedChild, 'subagents'), process.platform === 'win32' ? 'junction' : 'dir');
    const bundle = await exportProviderHistory({ ...f, provider: 'claude', out: path.join(f.temp, 'safe') });
    assert.equal(bundle.sessionCount, 1);
  } finally { await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('CLI is noninteractive, requires provider selection and publishes direct cockpit.json', async () => {
  const f = await fixture();
  try {
    const cli = path.resolve('out-test/scripts/export-provider-history.js');
    const out = path.join(f.temp, 'cli');
    const stdout = execFileSync(process.execPath, [cli, 'export', '--provider', 'codex', '--codex-home', f.codexHome,
      '--claude-home', f.claudeHome, '--out', out], { encoding: 'utf8', windowsHide: true });
    assert.equal(JSON.parse(stdout).sessions, 1); assert.ok(await fs.stat(path.join(out, 'cockpit.json')));
    const rejected = spawnSync(process.execPath, [cli, 'export', '--provider', 'mixed', '--out', path.join(f.temp, 'bad')], { encoding: 'utf8', windowsHide: true });
    assert.equal(rejected.status, 1); assert.doesNotMatch(rejected.stderr, /private-env-value/);
  } finally { await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('hash evidence distinguishes append-only external activity from changed captured bytes', async () => {
  const f = await fixture();
  try {
    const before = await fs.readFile(f.codex);
    const hash = await hashPrefix(f.codex, before.length);
    await fs.appendFile(f.codex, 'new external record\n');
    assert.equal(await hashPrefix(f.codex, before.length), hash);
    await fs.writeFile(f.codex, Buffer.alloc(before.length, 0x78));
    assert.notEqual(await hashPrefix(f.codex, before.length), hash);
    await assert.rejects(hashPrefix(f.codex, before.length + 1), /truncated/);
  } finally { await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('shared sanitizer excludes environment snapshots, protects secret-shaped keys and preserves parent IDs', () => {
  const safe = sanitize({ parentSessionId: 'codex:' + sid, sessionId: sid + '/agent-worker', env: { PUBLIC_LOOKING: 'hidden' },
    ['ghp_' + 'x'.repeat(25)]: 'opaque', authorization: 'private-auth-value', password: 'private-password-value',
    text: 'prefixsk-' + 'x'.repeat(25), encrypted_content: 'opaque-encrypted-data' }) as any;
  assert.equal(safe.parentSessionId, 'codex:' + sid); assert.equal(safe.sessionId, sid + '/agent-worker');
  assert.doesNotMatch(JSON.stringify(safe), /hidden|ghp_|sk-|private-auth-value|private-password-value|opaque-encrypted-data/);
});

test('existing Codex adapter discovers underscore-separated fork rollouts in bulk', async () => {
  const f = await fixture();
  try {
    const file = path.join(path.dirname(f.codex), `rollout-2020-01-01T00-00-00-${sid}_${worker}.jsonl`);
    await fs.writeFile(file, JSON.stringify({ type: 'session_meta', payload: { id: worker, parent_thread_id: sid } }) + '\n');
    const bundle = await exportProviderHistory({ ...f, provider: 'codex', out: path.join(f.temp, 'fork') });
    assert.equal(bundle.sessionCount, 2);
    assert.equal(bundle.records.find(r => r.sessionId === worker)?.parentKey, 'codex:' + sid);
  } finally { await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('bulk includes workflow transcripts, parent identities and journals without changing default UI discovery', async () => {
  const f = await fixture();
  try {
    const workflow = path.join(path.dirname(f.claude), sid, 'subagents', 'workflows', 'wf_old');
    await fs.mkdir(workflow, { recursive: true });
    await fs.writeFile(path.join(workflow, 'agent-worker.jsonl'), JSON.stringify({ type: 'assistant', sessionId: sid,
      message: { role: 'assistant', content: [{ type: 'text', text: 'old workflow answer' }] } }) + '\n');
    await fs.writeFile(path.join(workflow, 'journal.jsonl'), JSON.stringify({ type: 'started', agentId: 'worker', phase: 'review' }) + '\n');
    const { ClaudeAdapter } = await import('../src/providers/claude/claude');
    assert.equal(new ClaudeAdapter(f.claudeHome).listArtifacts(0, 100).length, 1);
    const bundle = await exportProviderHistory({ ...f, provider: 'claude', out: path.join(f.temp, 'workflow') });
    assert.equal(bundle.artifactCount, 3); assert.equal(bundle.sessionCount, 2); assert.equal(bundle.eventCount, 3);
    const agent = bundle.records.find(r => r.worker)!;
    assert.equal(agent.parentKey, 'claude:' + sid); assert.equal(agent.workflowId, 'wf_old');
    assert.equal(bundle.records.find(r => r.kind === 'workflow-journal')?.parentKey, 'claude:' + sid);
  } finally { await fs.rm(f.temp, { recursive: true, force: true }); }
});
