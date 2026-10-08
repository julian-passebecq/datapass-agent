import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { cockpitFixture } from './cockpitFixture';
import { IncrementalExporter } from '../src/export/incremental';
import { digest } from '../src/cockpit/policy';

test('incremental stable-prefix export: new, unchanged, append, same-mtime rewrite, generation and idempotence', async () => {
  const f = await cockpitFixture();
  try {
    const exporter = new IncrementalExporter([f.adapter]), out = path.join(f.temp, 'out'), redaction = digest('shared/1');
    if (process.platform === 'win32') {
      const alias = f.snapshots.map(s => ({ ...s, artifactPath: s.artifactPath.toUpperCase() }));
      assert.equal((await exporter.plan(f.grant, alias, f.grant.sessionKeys, redaction, out)).newCount, 1);
    }
    const sourceBefore = await fs.readFile(f.files[0]);
    await fs.appendFile(f.files[0], '{"type":"response_item","payload":');
    const plan = await exporter.plan(f.grant, f.snapshots, f.grant.sessionKeys, redaction, out); assert.equal(plan.newCount, 1);
    const receipt = await exporter.execute(f.grant, plan.hash, out);
    assert.equal((await exporter.execute(f.grant, plan.hash, out)).manifestHash, receipt.manifestHash);
    const events = await fs.readFile(path.join(out, receipt.artifactRefs.find(a => a.endsWith('.jsonl'))!), 'utf8');
    assert.match(events, /hello|answer/); assert.doesNotMatch(events, /PRIVATE_HIDDEN_REASONING|fixture-secret-value/);
    const unchanged = await exporter.plan(f.grant, f.snapshots, f.grant.sessionKeys, redaction, out); assert.equal(unchanged.unchangedCount, 1);
    await fs.appendFile(f.files[0], '{"type":"message","role":"assistant","content":[{"type":"output_text","text":"appended answer"}]}}\n');
    const appended = await exporter.plan(f.grant, f.snapshots, f.grant.sessionKeys, redaction, out); assert.equal(appended.appendedCount, 1); await exporter.execute(f.grant, appended.hash, out);
    const st = await fs.stat(f.files[0]);
    const rewrite = (await fs.readFile(f.files[0], 'utf8')).replace('appended answer', 'rewritten reply');
    await fs.writeFile(f.files[0], rewrite); await fs.utimes(f.files[0], st.atime, st.mtime);
    const rewritten = await exporter.plan(f.grant, f.snapshots, f.grant.sessionKeys, redaction, out); assert.equal(rewritten.rewrittenCount, 1);
    assert.equal((await exporter.plan(f.grant, f.snapshots, f.grant.sessionKeys, digest('shared/2'), out)).newCount, 1);
    assert.equal((await fs.readFile(f.files[0])).subarray(0, sourceBefore.length).toString(), sourceBefore.toString());
    const recovered = new IncrementalExporter([f.adapter]); assert.equal((await recovered.plan(f.grant, f.snapshots, f.grant.sessionKeys, redaction, out)).rewrittenCount, 1);
  } finally { await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('cancel, malformed/rewrite after preview, identity mismatch, cross-scope and unsafe destination never commit a cursor', async () => {
  const f = await cockpitFixture();
  try {
    const exporter = new IncrementalExporter([f.adapter]), out = path.join(f.temp, 'out'), redaction = digest('shared/1');
    await assert.rejects(exporter.plan(f.grant, f.snapshots, [f.snapshots[1].key], redaction, out), /outside approved/);
    await assert.rejects(exporter.plan({ ...f.grant, exportConsent: false }, f.snapshots, f.grant.sessionKeys, redaction, out), /consent/);
    await assert.rejects(exporter.plan(f.grant, f.snapshots, f.grant.sessionKeys, redaction, path.join(f.codexHome, 'out')), /provider storage/);
    const plan = await exporter.plan(f.grant, f.snapshots, f.grant.sessionKeys, redaction, out);
    const abort = new AbortController(); abort.abort(); await assert.rejects(exporter.execute(f.grant, plan.hash, out, abort.signal), /cancelled/);
    assert.equal((await exporter.plan(f.grant, f.snapshots, f.grant.sessionKeys, redaction, out)).newCount, 1);
    const original = await fs.readFile(f.files[0], 'utf8'); await fs.writeFile(f.files[0], original.replace('answer', 'change'));
    await assert.rejects(exporter.execute(f.grant, plan.hash, out), /Source changed/);
    await fs.writeFile(f.files[0], original + 'invalid json\n');
    const malformed = await exporter.plan(f.grant, f.snapshots, f.grant.sessionKeys, redaction, out);
    await assert.rejects(exporter.execute(f.grant, malformed.hash, out), /Malformed/);
    assert.deepEqual(await fs.readdir(path.join(out, 'commits')), []);
    await fs.writeFile(f.files[0], original.replace(f.snapshots[0].sessionId, f.snapshots[1].sessionId));
    await assert.rejects(exporter.plan(f.grant, f.snapshots, f.grant.sessionKeys, redaction, out), /identity mismatch/);
  } finally { await fs.rm(f.temp, { recursive: true, force: true }); }
});
