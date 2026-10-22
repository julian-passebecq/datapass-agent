# Headless MAF transport (source successor)

The private provider-kit 1.2.0 adds native transport API 1.0.3 and `createHeadlessNativeHost`. PM's matching client accepts this version alongside 1.0.1 and 1.0.2. Frozen PM 0.5.18 / Agent 0.11.11 VSIX packages are not changed or qualified by this source work. Pair the new kit with the reviewed PM successor; older PM builds may reject API 1.0.3.

The first supported MAF backend is explicitly `offline-replay-v1`, using `agent-framework-core==1.23.0`. It performs one host-reviewed `write_artifact` action through the real framework approval and tool loop. This is a connected source integration, not a live model backend or a release claim. The upstream harness is MIT; DataPass source stays private/UNLICENSED. See `maf/FRAMEWORK-LICENSE.txt` in the kit and the hash-locked Python dependency vector.

## Host contract

1. Build with `npm ci --ignore-scripts --no-audit --no-fund` and `npm run build:provider-kit`. Install the Python lock into an explicitly selected disposable environment using `pip install --require-hashes -r runtime/maf/requirements.lock`. No dependency installation happens during task execution.
2. The host supplies a `MafRuntime` object with exact Python and worker paths/hashes, an explicit site-packages directory, and hashes for **every file**, including bytecode, below that directory. `mafRuntimeHash(runtime)` is the runtime identity. Inspect this vector before registering it; calculating a hash grants no authority.
3. Select `transport: 'maf-harness'`, that `mafRuntimeHash`, `nativeVersion: 'agent-framework-core:1.23.0'`, `permission: 'workspace-write'`, and requested identity `{model:'offline-replay-v1', effort:null, accountId:null}`. Required capabilities are `maf/1`, `exact-tool-approval`, `offline-replay`, `owned-process`.
4. Supply the existing startup manifest and an independent platform proof signed by a verifier trusted by the host. The proof still has to cover managed/ambient effects and enforced descendant isolation. No fixture key or automatic trust enrollment is shipped.
5. Call `createHeadlessNativeHost({ledgerDirectory,hostId,grant,review,trusted,platformVerifiers,mafRuntime})`. All authority and review callbacks are explicit. `grant` is the existing reviewed Agent scope; `review(task)` must show the exact prepared task and action to the host's approver. Use one canonical ledger per host/writer domain. Separately chosen ledgers cannot exclude each other's writers.
6. Attach PM with `NativeTransportClient.forAgentHost(() => host.api)`. Prepare the normal bound task with `mafAction: {tool:'write_artifact', filename:'result.txt', content:'exact reviewed text'}`. Only a bounded simple `.txt` filename and at most 16 KiB of exact content are supported. Review and start using its exact prepared hash. Neither task text nor model text grants tool authority.

The host retains ownership of `dispose()` and `revoke()`. Disposing PM's observer does not grant or cancel execution. The factory neither starts a service nor discovers accounts, credentials, configuration, model endpoints or projects. It exports no sign-in or automatic retry path.

## Runtime and durable behavior

The existing Agent runner writes exclusive spawn intent and exact approval before creating the Python child. Existing canonical repository leases prevent a second writer within the same ledger domain. Startup rechecks the registered Python, worker and complete import tree. Python launches with fixed `-I -S -B` arguments, no shell, inherited PATH or credential environment, and an explicit import directory. It does not process `.pth`, user site modules, skills, hooks, MCP, file memory, shell tools or background agents.

The worker runs the real harness until it requests the exact function call. Agent verifies task, preparation, scope, session and action hash, persists that approval, rechecks current authority, then answers only that request. Repeated or foreign requests fail closed. This applies an already reviewed exact action; it does not approve model-selected operations in general.

The file tool records effect intent, exclusively creates the reviewed artifact, flushes it, records its result and persists the framework session. Agent verifies the artifact bytes and session hash and requires a matching completion event **and zero process exit** before recording `COMPLETED`. PM also checks the returned artifact against the approved action. File contents and session data are local to the host ledger; diagnostics do not publish them.

Restart recovery is receipt lookup in a fresh host, with no worker start or duplicate action. Execution resume/replay of MAF tasks is explicitly unsupported. Cancellation observes the owned child; uncertain outcomes retain the attempt and writer leases for owner reconciliation. An existing artifact is never overwritten. A terminal file does not imply a terminal task receipt, and missing completion evidence never becomes a successful retry.

## Qualification boundary and remaining work

The connected source test uses real PM/Agent code, a real Python process, the real MAF harness and a real fixed-file tool, with a deterministic replay client. Its platform verifier is deliberately synthetic and confined to the fixture: **no operating-system isolation acceptance is claimed**. Python audit guards are defense in depth. The standard library, shared Python runtime libraries and operating-system loader remain part of the independent host/platform qualification, not the site-packages hash inventory.

The host review UI, deployed isolated host, live-model backend, general tools, abrupt termination during the file write, and production recovery operations remain unqualified. No new model/provider, desktop, Windows service CI or Oracle execution is implied. The earlier Oracle result binds earlier source only. `releasePass=false`.

Framework API reference: https://learn.microsoft.com/en-us/agent-framework/concepts/harness . The implementation uses the pinned local 1.23.0 package, not an automatically upgraded runtime.
