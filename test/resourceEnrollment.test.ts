import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { enrollDiagnosticResources, RESOURCE_ENABLED_CHOICES, type EnabledAssertion } from '../src/cockpit/resourceEnrollment';
import { observeResources } from '../src/cockpit/resources';
import type { SelectedFileResource } from '../src/cockpit/resources';
import { cockpitFixture } from './cockpitFixture';

test('resource enrollment reviews explicit metadata and preserves kinds, bounds and unknown default', async () => {
  assert.equal(RESOURCE_ENABLED_CHOICES[0].id, 'UNKNOWN');
  for (const item of RESOURCE_ENABLED_CHOICES) assert.match(item.detail, /No resource is changed/);
  for (const assertion of ['UNKNOWN', 'ENABLED', 'DISABLED'] as const) {
    let registered: SelectedFileResource[] = [];
    const order: string[] = [];
    assert.equal(await enrollDiagnosticResources({
      chooseFiles: async () => { order.push('files'); return ['C:/owned/watch.py', 'C:/owned/state.lock', 'C:/owned/task.json']; },
      reviewEnabled: async choices => { order.push('metadata-choice'); assert.equal(choices, RESOURCE_ENABLED_CHOICES); return assertion; },
      stillAuthorized: () => true,
      register: items => { order.push('register'); registered = items; },
    }), true);
    assert.deepEqual(order, ['files', 'metadata-choice', 'register']);
    assert.deepEqual(registered.map(item => item.kind), ['SCRIPT', 'LOCK', 'FILE']);
    assert.ok(registered.every(item => item.enabled === (assertion === 'UNKNOWN' ? null : assertion === 'ENABLED')));
    assert.ok(registered.every(item => item.staleAfterMs === 3600000));
  }
  let count = 0;
  await enrollDiagnosticResources({chooseFiles: async () => Array.from({length: 60}, (_, n) => `C:/owned/${n}.ps1`), reviewEnabled: async () => 'UNKNOWN', stillAuthorized: () => true, register: items => { count = items.length; }});
  assert.equal(count, 50);
});

test('resource enrollment cancel, invalid choice and authorization changes never register files', async () => {
  for (const outcome of ['no-files', 'cancel-metadata', 'invalid-metadata', 'revoked-after-files', 'revoked-after-review'] as const) {
    let authorized = true, registered = false, reviews = 0;
    const result = await enrollDiagnosticResources({
      chooseFiles: async () => { if (outcome === 'no-files') return undefined; if (outcome === 'revoked-after-files') authorized = false; return ['C:/owned/watch.py']; },
      reviewEnabled: async () => { reviews++; if (outcome === 'revoked-after-review') authorized = false; return outcome === 'cancel-metadata' ? undefined : outcome === 'invalid-metadata' ? 'fabricated' as EnabledAssertion : 'DISABLED'; },
      stillAuthorized: () => authorized,
      register: () => { registered = true; },
    });
    assert.equal(result, false, outcome); assert.equal(registered, false, outcome);
    if (outcome === 'no-files' || outcome === 'revoked-after-files') assert.equal(reviews, 0);
  }
});

test('reviewed metadata keeps unknown, disabled, stale, absent and blocked distinct without executing a script', async () => {
  const f = await cockpitFixture();
  try {
    const file = path.join(f.temp, 'watch.py'), original = '# Generated inert file; never execute.\n'; await fs.writeFile(file, original);
    const before = await fs.stat(file); let enrolled: SelectedFileResource[] = [];
    await enrollDiagnosticResources({chooseFiles: async () => [file], reviewEnabled: async () => 'UNKNOWN', stillAuthorized: () => true, register: items => { enrolled = items; }});
    const unknown = (await observeResources(enrolled, () => true))[0];
    assert.equal(unknown.state, 'OBSERVED'); assert.equal(unknown.enabled, null); assert.equal(unknown.enabledBasis, 'UNKNOWN');
    await fs.utimes(file, before.atime, new Date(Date.now() - 7200000));
    await enrollDiagnosticResources({chooseFiles: async () => [file], reviewEnabled: async () => 'ENABLED', stillAuthorized: () => true, register: items => { enrolled = items; }});
    const stale = (await observeResources(enrolled, () => true))[0];
    assert.equal(stale.state, 'STALE'); assert.equal(stale.enabled, true); assert.equal(stale.enabledBasis, 'HOST_REVIEWED_ASSERTION'); assert.equal(stale.causality, 'UNKNOWN');
    await fs.utimes(file, before.atime, before.mtime);
    const reviewedStat = await fs.stat(file); // The fixture's explicit utimes may round sub-millisecond precision.
    await enrollDiagnosticResources({chooseFiles: async () => [file], reviewEnabled: async () => 'DISABLED', stillAuthorized: () => true, register: items => { enrolled = items; }});
    const result = await observeResources(enrolled, () => true);
    assert.equal(result[0].state, 'DISABLED'); assert.equal(result[0].enabled, false); assert.equal(result[0].enabledBasis, 'HOST_REVIEWED_ASSERTION'); assert.equal(result[0].causality, 'UNKNOWN');
    assert.equal(await fs.readFile(file, 'utf8'), original); assert.equal((await fs.stat(file)).mtimeMs, reviewedStat.mtimeMs);
    await fs.unlink(file); assert.equal((await observeResources(enrolled, () => true))[0].state, 'ABSENT');
    await fs.mkdir(file); assert.equal((await observeResources(enrolled, () => true))[0].state, 'BLOCKED');
  } finally { await fs.rm(f.temp, {recursive: true, force: true}); }
});
