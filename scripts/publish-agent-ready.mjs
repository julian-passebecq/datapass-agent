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
const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const host = { hostId: 'host:' + sha(JSON.stringify(os.hostname())).slice(0, 16), os: process.platform, architecture: process.arch, runtimeVersion: process.version };
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
const installed = JSON.parse(fs.readFileSync(path.join(root, '.datapass', 'night4', 'installed-latest.json')));
if (installed.error || installed.checks.some(c => !c.ok)) throw new Error('Installed path is not qualified.');
if (installed.vsixSha256 !== artifacts.find(a => a.kind === 'vsix').sha256) throw new Error('Installed proof belongs to another VSIX.');
const installedRef = add(path.join(installed.base, 'qualification.json'), 'report');
add(path.join(installed.base, 'contract-probe.json'), 'fixture', 'redacted-installed-facade-example.json');
const testsRef = add(path.join(root, '.datapass', 'night4', 'tests.log'), 'report', 'local-ci-tests.log');
const log = fs.readFileSync(path.join(root, '.datapass', 'night4', 'tests.log'), 'utf8');
if (!/pass 439/.test(log) || !/fail 0/.test(log)) throw new Error('Required local suite did not pass.');
for (const file of ['SHIP-REPORT.md', 'outcome.json', 'RESUME.md', 'public-interface-inventory.json']) {
  const p = path.join(root, 'handoff', 'night4', file); if (fs.existsSync(p)) add(p, 'report');
}
const ready = { schema: 'galaxy.component-ready/1', workstreamId: 'COCKPIT-20261008-NIGHT4', lane: 'AGENT', componentId: 'juliandatapass.agent-vscode', componentVersion: version, sourceSha, capturedAt: new Date().toISOString(), host, contractMajor: 1, contractMinor: 1,
  capabilities: ['summary', 'providerConfiguration', 'reveal', 'subscribe', 'incrementalExport', 'registeredContextReceipts', 'acceptedWork', 'assets', 'getScopes'].map(name => ({ name, version: 1, state: 'OK' })), artifacts,
  checks: [{ id: 'required-local-suite-439', status: 'PASS', evidenceRefs: [testsRef] }, { id: 'installed-synthetic-standalone-and-consumer-flow', status: 'PASS', evidenceRefs: [installedRef] }],
  unavailable: [{ capability: 'PM/Brain production integration', reason: 'Agent installed facade qualified with a synthetic same-host consumer; PM owns assembled multi-product installation.' }, { capability: 'real-history-export', reason: 'No real source scope selected; only owned synthetic fixtures exported.' }] };
const text = JSON.stringify(ready, null, 2) + '\n';
fs.writeFileSync(path.join(out, `READY-${sourceSha.slice(0, 12)}-${sha(text).slice(0, 12)}.json`), text, { flag: 'wx' });
fs.writeFileSync(path.join(out, 'READY.tmp'), text); fs.renameSync(path.join(out, 'READY.tmp'), path.join(out, 'READY.json'));
console.log(JSON.stringify({ ready: path.join(out, 'READY.json'), sourceSha, artifacts: artifacts.length }, null, 2));
