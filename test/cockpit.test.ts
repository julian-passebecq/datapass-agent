import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodexAdapter } from '../src/providers/codex/codex';
import { CockpitFacade, usageWindows } from '../src/cockpit/facade';
import { digest, makeGrant, repoId, ScopePolicy } from '../src/cockpit/policy';
import { readConfiguration } from '../src/cockpit/configuration';
import { IncrementalExporter } from '../src/export/incremental';
import { compactSessions, renderCompact } from '../src/render/extra/compact';
import { scanAssets } from '../src/feeds/assets';

import { cockpitFixture } from "./cockpitFixture";

test('facade denies caller-created grants/counts, isolates sessions, and returns detached snapshots', async () => {
  const f = await cockpitFixture();
  try {
    const policy = new ScopePolicy(), opened: string[] = [];
    const store = { all: () => f.snapshots, opts: { historyDays: 3 }, lastStats: { at: Date.now() }, onDidChange: () => ({ dispose() {} }) };
    const facade = new CockpitFacade(store, policy, { open: (_v, _g, id) => { opened.push(id); }, openSource: async () => {} }, new IncrementalExporter([f.adapter]));
    const r = { requestId: 'selection-1', scope: f.grant.scope };
    assert.equal((await facade.api.getSummary(r)).state, 'DENIED');
    policy.set(f.grant);
    const reply = await facade.api.getSummary(r);
    assert.equal(reply.data.sessions.length, 1); assert.equal(reply.data.sessions[0].id, f.snapshots[0].key);
    assert.doesNotMatch(JSON.stringify(reply), new RegExp(f.snapshots[1].sessionId));
    reply.data.sessions[0].model.value = 'mutated';
    assert.notEqual((await facade.api.getSummary(r)).data.sessions[0].model.value, 'mutated');
    assert.equal((await facade.api.getSummary({ ...r, scope: { ...r.scope, organizationIds: ['other-client'] } })).state, 'DENIED');
    assert.equal((await facade.api.reveal({ ...r, target: { kind: 'session', id: f.snapshots[1].key } })).state, 'DENIED');
    assert.equal((await facade.api.reveal({ ...r, target: { kind: 'source', id: 'C:/private/auth.json' } })).state, 'DENIED');
    assert.equal((await facade.api.reveal({ ...r, target: { kind: 'session', id: f.snapshots[0].key } })).state, 'OK');
    assert.deepEqual(opened, [f.snapshots[0].key]); facade.dispose();
  } finally { await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('late config answer after grant revocation is denied, and subscriber failure/overflow is isolated', async () => {
  const f = await cockpitFixture();
  try {
    const policy = new ScopePolicy(); policy.set(f.grant);
    let changed = () => {}; let resolveConfig!: (value: Awaited<ReturnType<typeof readConfiguration>>) => void;
    const facade = new CockpitFacade({ all: () => f.snapshots, opts: { historyDays: 3 }, onDidChange: fn => { changed = fn; return { dispose() {} }; } }, policy, { open: () => {}, openSource: async () => {}, configuration: () => new Promise(resolve => { resolveConfig = resolve; }) }, new IncrementalExporter([f.adapter]));
    const r = { requestId: 'selection-1', scope: f.grant.scope };
    const events: string[] = [];
    facade.api.subscribe(r, () => { throw new Error('consumer failed'); });
    const sub = facade.api.subscribe(r, e => { events.push(e.kind); });
    for (let i = 0; i < 40; i++) changed();
    await new Promise(resolve => setTimeout(resolve, 40)); assert.deepEqual(events, ['RESYNC_REQUIRED']);
    sub.dispose(); changed(); await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(events.length, 1);
    const late = facade.api.getProviderConfiguration({ ...r, provider: 'codex' }); policy.clear();
    resolveConfig({ at: Date.now(), sources: new Map(), config: { provider: 'codex', cliVersion: { value: null, kind: 'UNKNOWN', sourceIds: [] }, layers: [], effective: {}, resolution: 'UNKNOWN', inventory: [], observedSessions: [], sourceOpenIds: [] } });
    assert.equal((await late).state, 'DENIED'); facade.dispose();
  } finally { await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('configuration is sanitized/inert, carries provenance, and ignores linked secret files', async () => {
  const f = await cockpitFixture();
  try {
    await fs.writeFile(path.join(f.codexHome, 'config.toml'), 'model = "fixture-model"\nmodel_reasoning_effort = "high"\n[mcp_servers.test]\nurl = "https://private-server.test"\n[mcp_servers.test.env]\nUNLABELED = "PRIVATE_ENV_VALUE"\n');
    await fs.writeFile(path.join(f.claudeHome, 'settings.json'), JSON.stringify({ model: 'fixture-claude', env: { UNLABELED: 'PRIVATE_ENV_VALUE' }, hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo PRIVATE_HOOK_COMMAND' }] }] } }));
    const homes = { codexHome: f.codexHome, claudeHome: f.claudeHome, managedFile: path.join(f.temp, 'absent') };
    const c = await readConfiguration(f.grant, 'codex', [], homes), text = JSON.stringify(c.config);
    assert.equal(c.config.effective.model.value, 'fixture-model'); assert.equal(c.config.resolution, 'PARTIAL');
    assert.ok(c.config.effective.model.sourceIds.length); assert.doesNotMatch(text, /PRIVATE_ENV_VALUE|PRIVATE_HOOK_COMMAND|private-server|UNLABELED|config\.toml/);
    const secret = path.join(f.temp, 'secret-config'); await fs.mkdir(secret); await fs.writeFile(path.join(secret, 'config.toml'), 'model = "LINKED_PRIVATE_MODEL"');
    await fs.symlink(secret, path.join(f.repo, '.codex'), process.platform === 'win32' ? 'junction' : 'dir');
    const denied = await readConfiguration(f.grant, 'codex', [], homes); assert.doesNotMatch(JSON.stringify(denied.config), /LINKED_PRIVATE_MODEL/);
  } finally { await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('compact keeps independent roots, escapes labels, isolates project/session selection, and partial windows remain useful', async () => {
  const f = await cockpitFixture();
  try {
    const other = { ...f.snapshots[1], repository: path.join(f.temp, 'other'), title: '<script>unsafe()</script>', status: 'UNKNOWN' as const };
    const d = { sessions: [f.snapshots[0], other], providers: [], events: [], now: Date.now(), ternAvailable: false };
    assert.equal(compactSessions(d, { view: 'compact', opts: { 'compact-scope': 'project', 'compact-project': repoId(f.repo).slice(5) } }).length, 1);
    assert.equal(compactSessions(d, { view: 'compact', selected: other.key, opts: { 'compact-scope': 'session' } })[0].key, other.key);
    const html = renderCompact(d, { view: 'compact', opts: { 'compact-view': 'factory' } });
    assert.doesNotMatch(html, /<script>/); assert.match(html, /independent leads/); assert.match(html, /Unknown/);
    const windows = usageWindows([f.snapshots[0], f.snapshots[0]], Date.now(), 3) as { sessions: number; coverage: { complete: boolean } }[];
    assert.equal(windows.length, 3); assert.ok(windows.every(w => w.sessions === 1 && !w.coverage.complete));
    const assets = path.join(f.temp, 'images'); await fs.mkdir(assets); await fs.writeFile(path.join(assets, 'image.png'), Buffer.from([137, 80, 78, 71]));
    const gallery = await scanAssets([assets]); assert.equal(gallery[0].state, 'FILE_OBSERVED'); assert.equal(gallery[0].producer, null);
  } finally { await fs.rm(f.temp, { recursive: true, force: true }); }
});

test('export approval cannot be manufactured in caller JSON; registered context is explicit and scoped', async () => {
  const f = await cockpitFixture();
  try {
    const policy = new ScopePolicy(); policy.set(f.grant);
    const facade = new CockpitFacade({ all: () => f.snapshots, opts: { historyDays: 3 }, onDidChange: () => ({ dispose() {} }) }, policy, { open: () => {}, openSource: async () => {} }, new IncrementalExporter([f.adapter]));
    const r = { requestId: 'export-selection', scope: f.grant.scope };
    facade.setDestination('destination:fixture', path.join(f.temp, 'out'));
    const plan = await facade.api.planExport({ ...r, sourceIds: f.grant.sessionKeys, redactionProfileHash: digest('test/1') }); assert.equal(plan.state, 'OK');
    const request = { ...r, approval: { approvedPlanHash: plan.data.hash, destinationId: 'destination:fixture', scopePolicyHash: r.scope.policyHash } };
    assert.equal((await facade.api.executeApprovedLocalExport(request)).state, 'DENIED');
    facade.approve(plan.data.hash, f.grant, 'destination:fixture'); assert.equal((await facade.api.executeApprovedLocalExport(request)).state, 'OK');
    assert.throws(() => facade.registerInputs(f.grant, { contexts: [{ id: 'q:1', projectId: 'other-client', sourceIds: [], backend: 'fts', generationId: 'g:1', queriedAt: new Date().toISOString(), state: 'OK' }], assets: [], acceptedWork: [] }), /Invalid context/);
    facade.registerInputs(f.grant, { contexts: [{ id: 'q:1', projectId: 'fixture', sourceIds: [f.grant.sessionKeys[0]], backend: 'fts', generationId: 'g:1', queriedAt: new Date().toISOString(), state: 'OK' }], assets: [], acceptedWork: [] });
    const summary = await facade.api.getSummary(r); assert.match(JSON.stringify(summary.data.contextReceipts), /consumption UNKNOWN/); facade.dispose();
  } finally { await fs.rm(f.temp, { recursive: true, force: true }); }
});
