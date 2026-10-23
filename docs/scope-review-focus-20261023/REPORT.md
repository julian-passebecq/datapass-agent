# Scope review survives window switches: private evaluation

The five prompts in `agent.reviewCockpitScope` now set `ignoreFocusOut: true`. A person can switch between VS Code and another window while reviewing the exact sessions, project, organization, privacy domain and final permission. Escape or another explicit dismissal still cancels. All cancellation returns, exact-session filtering and the final `policy.set` remain unchanged; focus retention grants no permission.

The original wizard omitted this option. The [VS Code API](https://code.visualstudio.com/api/references/vscode-api#QuickPickOptions) documents it for keeping input open across window focus changes. This explains a possible way to lose an unfinished review, but does not retrospectively establish the cause of every observed closed dialog.

## Source and artifact

- Original installed source: `cf2a9303d9eeaa784a0d8d05d5c6afe5a2df3bc1`.
- Fix source, committed before packaging: `d29644bb20cbbdca6ad73e1517e993995e76c937`.
- Evaluation: `agent-vscode-0.11.11-review-focus-d29644b-evaluation.vsix`.
- SHA-256: `01cf2cf9de3852153f1d19f1d62707309ae12e3b933eee545e325ca5a13d88c3`.
- Runtime bundle SHA-256: `fefe0d53838618d2390560921f6696a8f17e01bf00cdb515e06d6746c06541fd`.
- Original `agent-vscode-0.11.11.vsix` remains unchanged at `6a500547b5d6e20dd1ac950a1faf4ad72162e23cdba4596ba62aa256bfc681d1`.

The evaluation intentionally retains version 0.11.11 and has a distinct immutable filename and hash. It is not a replacement for the pinned release candidate. A byte comparison of all 15 archive entries found only `extension/dist/extension.js` changed. Removing the five inserted focus-retention flags from that bundle produces the original bundle exactly. `RESULT.json` records source, package and entry hashes. The archive has no embedded source commit metadata; its source binding is external, through the committed build source and exact bundle comparison.

## Validation

Typecheck, test compilation, build and VSIX packaging passed. Six new checks use the existing actual command/facade/policy harness: each of the five cancellation stages leaves scope data and policy epoch unchanged, and holding the final choice creates no grant or success notification. The selected-session grant appears only after the final explicit observation choice. Existing facade isolation, export authority, panel invalidation and lifecycle checks also pass: **16 passed, zero failures/skips**. The host UI is simulated; these are source tests, not native acceptance.

The first harness run passed 12 and failed four newly added assertions because the assertions compared changing `capturedAt` timestamps. The assertions now compare policy data and epoch. Both initial and corrected logs are preserved. No product code was changed to resolve that test-only issue.

## Problems, questions and next gate

No blocking implementation question remains. Ordinary-user installed testing must still verify that a review survives switching to another window, Escape cancels without a grant, and a human's final Observation only choice creates exactly the reviewed scope. The current installed VSIX was not modified. No UI, profile, permission, provider, runner, server or deployment action occurred in this pass.

This evaluation has no installed, CI or native qualification. Earlier acceptance receipts remain attached to the original artifact. **RELEASE_PASS=false.**

Publication uses private `julian-passebecq/agent-vscode` (repository ID `1404682511`) and the existing local 0.11.11 branch. A separate frozen base at the original source keeps the draft review bounded and leaves successor MAF branches untouched. Remote tree and selected raw-byte readback are recorded separately.
