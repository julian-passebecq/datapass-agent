import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { cockpitFixture } from './cockpitFixture';
import { captureConfiguration, CaptureSelection, providerKitVersion } from '../src/provider-kit';
import { readConfiguration } from '../src/cockpit/configuration';

test('standalone kit uses the Agent collector, stable safe hashes and no history/secret payloads', async () => {
  const f = await cockpitFixture();
  try {
    await fs.writeFile(path.join(f.codexHome, 'config.toml'), 'model="fixture-model"\nmodel_reasoning_effort="high"\n[mcp_servers.fixture]\ncommand="demo"\nargs=["PRIVATE_ARGUMENT"]\n');
    await fs.writeFile(path.join(f.codexHome, 'auth.json'), '{"api_key":"PRIVATE_AUTH_VALUE"}');
    await fs.writeFile(path.join(f.claudeHome, 'settings.json'), JSON.stringify({ model: 'fixture-claude', env: { TEST: 'PRIVATE_ENV' }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'PRIVATE_EXECUTABLE_PAYLOAD' }] }] } }));
    const homes = { claudeHome: f.claudeHome, codexHome: f.codexHome, managedFile: path.join(f.temp, 'absent-managed.json') };
    const selection: CaptureSelection = { provider: 'codex', surface: 'IDE', nativeVersion: null, hostId: 'host:fixture', accountId: null, roots: [f.repo], policyHash: f.grant.scope.policyHash, homes };
    const one = await captureConfiguration(selection), two = await captureConfiguration(selection);
    assert.equal(providerKitVersion, '1.0.2'); assert.equal(one.sourceHash, two.sourceHash);
    assert.equal(one.configuration.effective.model.value, 'fixture-model');
    const agent = await readConfiguration(f.grant, 'codex', [], homes);
    assert.deepEqual(one.configuration.layers, agent.config.layers);
    assert.deepEqual(one.configuration.inventory, agent.config.inventory);
    assert.equal(one.configuration.observedSessions.length, 0);
    assert.equal(one.identity.nativeVersion, null);
    assert.doesNotMatch(JSON.stringify(one), /PRIVATE_|session_meta|hello|HIDDEN_REASONING/);
    await fs.writeFile(path.join(f.codexHome, 'config.toml'), 'model="changed-model"');
    assert.notEqual(one.sourceHash, (await captureConfiguration(selection)).sourceHash);
    await assert.rejects(captureConfiguration({ ...selection, roots: ['relative'] }), /Invalid reviewed/);
    await assert.rejects(captureConfiguration({ ...selection, policyHash: 'caller-text' }), /Invalid reviewed/);
    const other=path.join(f.temp,'other-project');await fs.mkdir(other);
    const multiple=await captureConfiguration({...selection,roots:[f.repo,other]});assert.equal(multiple.configuration.effective.model.value,null);
  } finally { await fs.rm(f.temp, { recursive: true, force: true }); }
});
