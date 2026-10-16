// Pure local diagnostic: no providers, network, extension host, or retries.
// node scripts/profile-redact.cjs <source.ts> <rules|full|aws>
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const ts = require('typescript');
const source = fs.readFileSync(process.argv[2], 'utf8');
const code = ts.transpileModule(source + '\nexport const profileRules = RULES;', {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const exported = {};
vm.runInNewContext(code, { exports: exported, Buffer });
const samples = [
  'a'.repeat(1 << 20), 'password'.repeat(1 << 17), 'aws '.repeat(1 << 18),
  '://u:'.repeat(1 << 18), 'mysql '.repeat(1 << 17),
  '-----BEGIN PRIVATE KEY-----'.repeat(1 << 15),
  '"token":"'.repeat(1 << 17), 'x_key_'.repeat(1 << 17),
];
const measure = fn => { const start = performance.now(); fn(); return +(performance.now() - start).toFixed(3); };
const result = {
  runtime: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch,
  sourceSha256: crypto.createHash('sha256').update(source).digest('hex'),
  mode: process.argv[3], rounds: 4, coldMeaning: 'First invocation in this new process; not an OS cold-cache claim.',
};
if (result.mode === 'rules') {
  const input = samples[2];
  result.sample = { prefix: input.slice(0, 12), length: input.length, sha256: crypto.createHash('sha256').update(input).digest('hex') };
  result.rules = exported.profileRules.map((rule, index) => ({
    index, regex: String(rule.re), timingsMs: Array.from({ length: 4 }, () => measure(() => {
      if (rule.requires && !rule.requires.test(input)) return;
      input.replace(rule.re, (m, ...g) => rule.to ? rule.to(m, ...g) : exported.MARK);
    })),
  }));
} else if (result.mode === 'full' || result.mode === 'aws') {
  const inputs = result.mode === 'aws' ? [samples[2]] : samples;
  result.samples = inputs.map(input => ({ prefix: input.slice(0, 12), length: input.length,
    sha256: crypto.createHash('sha256').update(input).digest('hex'), timingsMs: [] }));
  for (let round = 0; round < 4; round++) {
    inputs.forEach((input, i) => result.samples[i].timingsMs.push(measure(() => exported.redact(input))));
  }
} else throw new Error('Expected rules, full, or aws');
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
