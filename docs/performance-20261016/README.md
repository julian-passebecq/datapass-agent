# AWS redaction performance diagnostic

Baseline: private `agent-vscode` candidate `b65c6b7b7de9fa95afe0a5cc2a6bb63669b4f92f`.
Local branch: `codex/galaxy-v1-agent-performance-20261016`.
Measurement date: 2026-10-16/17 Europe/Zurich. No remote publication or CI allocation.

## Measured cause and scope

The existing AWS rule retries a bounded search of up to 160 characters after every
`aws` anchor. On `'aws '.repeat(1 << 18)` (1,048,576 characters), its first isolated
invocation took 363.024 ms; three subsequent invocations took 396.062, 396.178,
389.286 ms. Every other isolated rule took <=13.407 ms on this input. This
identifies the dominant local cost, not a claim of superlinear asymptotic behavior:
the repeated search already has a fixed upper bound.

The reported historical Windows run had 523/524 tests passing and 1,717 ms for
this input. That timing failure was **not reproduced** here: unchanged targeted
baseline tests passed 8/8. Host load and runtime conditions differ; these samples
cannot establish the cause of that historical variability.

The change adds a necessary-condition check for a 40-character AWS candidate.
If there is no `[A-Za-z0-9/+]{40}` run, the existing AWS regex cannot possibly
match. The single scan avoids all repeated bounded searches in that case. The
AWS matching regex, callback, ordering and mixed-case policy are unchanged. If
a candidate exists, the original search still executes; this is not a general
performance guarantee for every possible distribution of candidates and anchors.

## Fixed measurements (ms)

Each mode uses one process and exactly four rounds: first invocation/pass plus
three subsequent rounds. Measurements are diagnostic, never retry-until-green.
The `aws` mode starts with the AWS sample, so its first full `redact` invocation
is cold with respect to that process. This is not an OS cold-cache measurement.
In `full` mode the AWS sample is third; call those values a first pass, not a
cold function invocation. Rule profiling exercises each rule separately on the
same original AWS input; its first AWS-rule invocation is cold for that rule.

| Measurement | Baseline first | Baseline subsequent | Candidate first | Candidate subsequent |
| --- | ---: | --- | ---: | --- |
| Isolated AWS rule including condition | 363.024 | 396.062 / 396.178 / 389.286 | 18.192 | 51.888 / 11.981 / 11.914 |
| Complete redaction, AWS first in new process | 433.348 | 440.630 / 394.178 / 355.278 | 37.392 | 30.813 / 30.955 / 32.661 |
| Complete redaction, AWS in original eight-sample order | 452.189 | 484.290 / 457.474 / 424.158 | 37.223 | 49.524 / 33.068 / 27.570 |

Raw JSON retains every per-rule/per-sample result and input/source SHA256.
All eight original large samples are retained in both test and profiling code.
The 1,500 ms per-sample test threshold is unchanged. Maximum measured candidate
sample across the four full passes: 276.957 ms (the quoted-token sample).
The finite samples show local improvement; no isolated execution, CPU scheduling
control, or complete Windows release qualification is claimed.

## Validation and reproduction

Runtime: existing read-only binary
`C:/GitLab-Runner/builds/.ci-tools/node/node-v22.23.3-win-x64/node.exe`;
Node v22.23.3, V8 12.4.254.21-node.57, win32 x64.
Binary SHA256: `9c9245166b4a8e182e0b797da9c20136117ff24368eaff1fec8343a123c8db0e`.
No Node executable was found under the requested convergence directory; an
existing receipt there identified this exact local runtime. No runner/service
configuration was changed. Compilation and profiling output stayed in this
worktree; test TEMP/TMP were set to `out-test/perf`.

Dependencies were restored once with `npm ci --offline --ignore-scripts
--no-audit --no-fund` (295 packages). Pure TypeScript compilation used
`node node_modules/typescript/lib/tsc.js -p tsconfig.test.json`, without the
additional agent-host bundler in the package compile-tests script.
The two test commands, each executed once at its respective source state, were:

```text
node --test out-test/test/redact.test.js out-test/test/redact-launcher.test.js
```

Baseline: 8 passed, 0 failed, 0 skipped. Candidate: 9 passed, 0 failed, 0 skipped.
The added regression covers AWS and access-key anchors, 160/161-character gaps,
newlines, candidate lengths, mixed case, trailing boundaries and repeated calls.
TAP results are retained. Full TypeScript `tsc -p . --noEmit` also passed.

For profiling, save the baseline `src/util/redact.ts` from the frozen Git commit
to an ignored temporary file. Run each source once per mode with the exact
runtime above:

```text
node scripts/profile-redact.cjs <baseline-or-candidate.ts> rules
node scripts/profile-redact.cjs <baseline-or-candidate.ts> full
node scripts/profile-redact.cjs <baseline-or-candidate.ts> aws
```

The script transpiles only the specified redaction module in memory and uses
synthetic text. It performs no provider/AHP/login/MCP/GUI/native-permission calls.
No full release suite, build, provider-kit build, packaging or other product
rebuild was run. Those remain with the release coordinator on the new candidate.
