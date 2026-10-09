import { captureConfiguration } from '../.provider-kit/index.cjs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const destination = resolve(process.argv[2]);
const temp = await mkdtemp(join(tmpdir(), 'agent-provider-kit-fixture-'));
try {
  const homes = { codexHome: join(temp, 'codex'), claudeHome: join(temp, 'claude'), managedFile: join(temp, 'managed.json') };
  const root = join(temp, 'project');
  await Promise.all([homes.codexHome, homes.claudeHome, root].map(dir => mkdir(dir)));
  await writeFile(join(homes.codexHome, 'config.toml'), 'model = "synthetic-model"\nmodel_reasoning_effort = "high"\n');
  await writeFile(join(homes.claudeHome, 'settings.json'), JSON.stringify({ model: 'synthetic-claude', permissions: { defaultMode: 'plan' } }));
  await mkdir(destination, { recursive: true });
  for (const provider of ['codex', 'claude']) {
    const capture = await captureConfiguration({ provider, surface: 'IDE', nativeVersion: null, hostId: 'host:synthetic', accountId: null, roots: [root], policyHash: createHash('sha256').update('synthetic-fixture-policy').digest('hex'), homes });
    await writeFile(join(destination, provider + '-capture.json'), JSON.stringify({ fixture: true, source: 'Agent-owned synthetic corpus; no account or native history', capture }, null, 2) + '\n', { flag: 'wx' });
  }
} finally { await rm(temp, { recursive: true, force: true }); }
