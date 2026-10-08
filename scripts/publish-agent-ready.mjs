// Publish already-built immutable artifacts. This never builds, launches agents, installs or executes READY data.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? path.join(root, 'integration', 'COCKPIT-20261008-NIGHT4', 'AGENT'));
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version;
const reportRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const installed = JSON.parse(fs.readFileSync(path.join(root, '.datapass', 'night4', 'installed-latest.json')));
const sourceSha = installed.sourceSha;
if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('Installed source revision is missing.');
const changedRuntime = execFileSync('git', ['diff', '--name-only', sourceSha, '--', 'src', 'test', 'package.json', 'package-lock.json', 'README.md', 'scripts/build.mjs'], { cwd: root, encoding: 'utf8' }).trim();
if (changedRuntime) throw new Error('Product source changed since installed qualification: ' + changedRuntime);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const publisherHost = { hostId: 'host:' + sha(JSON.stringify(os.hostname())).slice(0, 16), os: process.platform, architecture: process.arch, runtimeVersion: process.version };
const host = JSON.parse(fs.readFileSync(path.join(installed.base, 'contract-probe.json'))).summary.host;
if (host.hostId !== publisherHost.hostId || host.os !== publisherHost.os || host.architecture !== publisherHost.architecture) throw new Error('Installed runtime host differs from publisher host.');
fs.mkdirSync(out, { recursive: true });
const artifacts = [];
function add(file, kind, label = path.basename(file)) {
  const bytes = fs.readFileSync(file), hash = sha(bytes);
  const relativePath = `${sourceSha.slice(0, 12)}-${hash.slice(0, 12)}-${label}`;
  const target = path.join(out, relativePath);
  if (fs.existsSync(target)) { if (sha(fs.readFileSync(target)) !== hash) throw new Error('Artifact collision'); }
  else fs.writeFileSync(target, bytes, { flag: 'wx' });
  artifacts.push({ relativePath, sha256: hash, bytes: bytes.length, kind });
  return relativePath;
}
add(path.join(root, `agent-vscode-${version}.vsix`), 'vsix');
add(path.join(root, 'src', 'cockpit', 'interfaces.ts'), 'source', 'cockpit-interfaces.ts');
add(path.join(root, 'docs', 'COCKPIT-V1.md'), 'report');
add(path.join(root, 'scripts', 'install-agent.ps1'), 'source');
if (installed.error || installed.checks.some(c => !c.ok)) throw new Error('Installed path is not qualified.');
if (installed.vsixSha256 !== artifacts.find(a => a.kind === 'vsix').sha256) throw new Error('Installed proof belongs to another VSIX.');
const installedRef = add(path.join(installed.base, 'qualification.json'), 'report');
add(path.join(installed.base, 'contract-probe.json'), 'fixture', 'redacted-installed-facade-example.json');
for (const file of ['incremental-evidence.json', 'synthetic-incremental-pack.zip']) {
  const p = path.join(root, '.datapass', 'night4', file); if (fs.existsSync(p)) add(p, 'fixture');
}
const testsRef = add(path.join(root, '.datapass', 'night4', 'tests.log'), 'report', 'local-ci-tests.log');
const log = fs.readFileSync(path.join(root, '.datapass', 'night4', 'tests.log'), 'utf8');
const passCount = Number(/pass (\d+)\s*(?:\r?\n|$)/.exec(log)?.[1]);
if (!passCount || !/fail 0\s*(?:\r?\n|$)/.test(log)) throw new Error('Required local suite did not pass.');
for (const file of ['SHIP-REPORT.md', 'outcome.json', 'RESUME.md', 'public-interface-inventory.json']) {
  const p = path.join(root, 'handoff', 'night4', file); if (fs.existsSync(p)) add(p, 'report');
}
const ready = { schema: 'galaxy.component-ready/1', workstreamId: 'COCKPIT-20261008-NIGHT4', lane: 'AGENT', componentId: 'juliandatapass.agent-vscode', componentVersion: version, sourceSha, reportRevision, capturedAt: new Date().toISOString(), host, publisherHost, contractMajor: 1, contractMinor: 1,
  capabilities: ['summary', 'providerConfiguration', 'reveal', 'subscribe', 'incrementalExport', 'registeredContextReceipts', 'acceptedWork', 'assets', 'getScopes'].map(name => ({ name, version: 1, state: 'OK' })), artifacts,
  checks: [{ id: 'required-local-suite-' + passCount, status: 'PASS', evidenceRefs: [testsRef] }, { id: 'installed-synthetic-standalone-and-consumer-flow', status: 'PASS', evidenceRefs: [installedRef] }],
  unavailable: [{ capability: 'PM/Brain production integration', reason: 'Agent installed facade qualified with a synthetic same-host consumer; PM owns assembled multi-product installation.' }, { capability: 'real-history-export', reason: 'No real source scope selected; only owned synthetic fixtures exported.' }] };
const text = JSON.stringify(ready, null, 2) + '\n';
fs.writeFileSync(path.join(out, `READY-${sourceSha.slice(0, 12)}-${sha(text).slice(0, 12)}.json`), text, { flag: 'wx' });
fs.writeFileSync(path.join(out, 'READY.tmp'), text); fs.renameSync(path.join(out, 'READY.tmp'), path.join(out, 'READY.json'));
console.log(JSON.stringify({ ready: path.join(out, 'READY.json'), sourceSha, artifacts: artifacts.length }, null, 2));
