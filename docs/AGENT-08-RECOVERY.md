# Agent 0.8 recovery and promotion

Qualification dates: 2026-10-07 to 2026-10-08, Europe/Zurich.

## Exact source and main preservation

The latest qualified local Agent 0.8 release is **0.8.2**, recovered from
`D:/PROJ/agentic-dev-atlas-source/datapass-agent`, clean branch
`codex/agent-atlas-v1`, commit **06c8bf5b68adc8de82f09d60ce286a0a403a3e1e**.
Its source identity is recorded in
`D:/PROJ/agentic-dev-atlas-trial/{FINAL-REPORT.md,evidence/source-heads.json}`.

Earlier qualified candidates remain intact:

| Version | Branch | Commit | Worktree |
| --- | --- | --- | --- |
| 0.8.0 | codex/cockpit-exports | f11660841f99677b7233a6574fe3ba788f2f138a | D:/PROJ/datapass-agent |
| 0.8.1 | codex/cursor-vsmux-agent-trial | 540ec1d5ca9554943e830e8507f59e43715d527f | D:/PROJ/agentic-trial-source/datapass-agent |
| 0.8.2 | codex/agent-atlas-v1 | 06c8bf5b68adc8de82f09d60ce286a0a403a3e1e | D:/PROJ/agentic-dev-atlas-source/datapass-agent |

Promotion worktree: `D:/PROJ/agent-0.8-canonical`, branch
`codex/agent-0.8-canonical`, targeting `julian-passebecq/agent-vscode` main.
Recovery adds qualification documentation and smoke-harness corrections only;
the recovered implementation and package version remain unchanged.

Remote main at comparison: **7420b6915ae494e1fbf094210bdda168d5b1567a**,
manifest version **0.7.1**. Tag `v0.7.1` is the earlier
`76dc15b` commit. Main includes three subsequent merged changes: rail grammar
(#79), workflow topology (#80), and grouped/collapsible overview (#81).
Main is an ancestor of the recovered release: no main commit is replaced or
discarded. The unrelated local `main` tracks `datapass-agent`'s initial commit;
it is not the release baseline and was not changed.

## Diff against current main

Recovered release: seven commits, 27 files, 863 insertions and 22 deletions
(including one new vendored dependency tarball).

- DataPass naming and version 0.8.2.
- Analyzer with active, attention, recent and export sections.
- Evidence-gated Lens worktree, change, commit and file navigation using
  vendored `@galaxy/dev-context` 0.1.0.
- Bounded observation and development-observation APIs, preserving provenance
  and UNKNOWN verification; development DTOs contain no conversation text.
- Optional Agent Map, retaining all original commands and contributed views.
- Existing selected-conversation export and knowledge/search tooling inherited
  from the recovered 0.8.0 prototype, plus its tests and documentation.

No new provider-history exporter was implemented or run for this recovery.
The inherited selected-export code was preserved without modification. Its
bounded observer window must not be described as a complete provider history.

## Fresh qualification

Evidence directory: `D:/PROJ/AGENT-08-RECOVERY-EVIDENCE` (local logs, sanitized
aggregate results and VSIX; no raw provider conversations published).

- `npm ci`, TypeScript check and test compilation: PASS (Node 26.9.0, npm 11.19.1).
- Full unit suite, serial execution: **421 passed**, zero failures/skips.
  Log: `tests.log`; duration 75.85 seconds. Serial execution follows the earlier
  qualification's documented sensitivity of the catalog timing test to load.
- Remote Windows CI on the smoke-harness commit `6b6a667`: **421 passed**,
  typecheck/build/package PASS under Node 22. Run:
  https://github.com/julian-passebecq/agent-vscode/actions/runs/37693019703.
- Build/package: PASS. VSIX version **0.8.2**, nine files, about 403.53 KB.
- Fresh VSIX SHA-256:
  `c5f3228c26d571ae3f8a6ac65b03a2083717f992e63b86300d060e0e0a9a5169`.
- Extension bundle SHA-256:
  `da871cba26ee9eb7b8d5c50585bb78290a52c145dfac32dd63852d31a4ddcede`,
  exactly matching the previously qualified installed VS Code/Cursor bundle.
  ZIP/VSIX bytes differ from the prior package (archive metadata); source and
  executable bundle agree.
- Fresh installed VSIX smoke on VS Code **1.140.0**: **PASS**, 117 checks,
  106 screenshots, zero failed checks/errors. All 44 rail screens passed in
  dark and light mode; 600/700/900 px dark-mode overflow, multi-pane layouts,
  keyboard/filtering, reload and extension-host diagnostics passed.
  Logs/results: `smoke.log`, `smoke-result.json`, `screenshots/`.

The initial inherited smoke harness assumed Cockpit/Sessions/Timeline were
expanded on first open. They are collapsed in 0.8's Analyzer-first layout.
The harness now explicitly expands them and allocates a fresh isolated profile
per run to avoid stale profile state and Windows locks. Shutdown is bounded
because the Windows launcher pipe can remain open after the editor has exited;
the light pass also respects an already-visible restored sidebar. No runtime UI change
was needed. Original-attempt evidence is retained as `smoke-original-harness.log`.

Prior installed evidence at the exact recovered implementation covers VS Code,
Cursor, bounded observer API, Analyzer and Agent Map. Agent-only operation with
Lens absent also passed (`agentic-dev-atlas-trial/evidence/companion-results.json`).
This recovery's broad smoke uses synthetic provider histories and isolated
profiles; the real-history probe below separately qualifies actual readers.

## Real Codex / Claude history compatibility

Read-only adapter/store probe, 30-day window, maximum 300 artifacts per provider,
Git correlation disabled. `real-history.cjs` and `real-history.json` are in the
evidence directory. No transcript text was persisted by the probe.

| Provider | Observed version | Sessions | Workers | Timeline events | Malformed/oversize-session warnings | Adapter diagnostics |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Codex | 0.162.0-alpha.2 | 121 | 7 | 11,443 | 0 | 0 |
| Claude Code | 2.1.293 | 300 | 210 | 17,057 | 0 | 0 |

All sessions had a cwd. Codex: 121 with model and usage. Claude: 297 with model,
298 with usage. Missing fields remain unknown. Codex statuses: one RUNNING,
115 UNKNOWN, five ENDED; Claude: three IDLE, 289 ENDED, eight UNKNOWN.
Unknown status is expected when live evidence is absent; it is not proof of
execution failure. This is bounded parser/observer compatibility, not a claim
of exhaustive lifetime history or full transcript export fidelity.

## Remaining release considerations

- `npm audit`: seven development-tool advisories (six high, one moderate),
  including vsce/transitives and esbuild. Affected locked versions match main;
  recovery introduced no dependency upgrades. They still need release-tooling
  triage; no automatic dependency fix was applied.
- CI and merge/release status must be checked on the PR's final head. Creating
  a remote release branch/PR does not merge main or publish a Marketplace release.
- Real-history reader compatibility is bounded to this machine's recorded
  artifacts and versions; future provider record shapes remain unqualified.
- Optional navigation was qualified with the trial Lens 0.1.0/0.2.0 companions
  and with Lens absent. Older Tern/Lens command compatibility was not requalified.
- Prior broader Atlas/T3 production qualifications remain partial, including
  dense rendering, mobile/desktop WebGL and live in-thread T3 publication. These
  are separate companion-product limits, not claims about Agent standalone smoke.

The remote recovery PR is the canonical review candidate. Provider-history
exporter development remains deferred until Agent 0.8 is accepted as canonical.
