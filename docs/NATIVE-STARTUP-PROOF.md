# Exact startup facts and independent platform proof

Agent 0.11.1/provider-kit 1.1.1/nativeTransportV1 1.0.1 closes the prior configuration-drift hole. Caller startup booleans/hashes/capability lists were insufficient. The installed API now exposes `captureStartup(request,selection)` returning `{manifest,configurationHash,reviewHash,verification}`. PM previews actual captured facts and uses them in the exact prepared task. `preflight` checks them again; the runner repeats preflight immediately before process creation after durable intent/lease work. No native CLI, model request, setting change or authentication store read occurs during capture.

The manifest uses fixed startup config/instruction paths in the explicitly reviewed native home and exact project root. It records byte hashes/absence, bounded named startup-directory presence, and metadata-only inherited/system locations. It never scans histories, enumerates plugin contents, reads auth files or projects outside scope. A mixed global Claude `.claude.json` is presence-only and unreviewed. Unknown config keys, nonempty hooks/plugins/skills/agents/rules trees, inherited/system files, unreadable/linked sources or incomplete project coverage fail closed. Hashing an empty safe projection cannot conceal a changed hook/config. Auth/history fixture changes deliberately do not alter startup hashes or authenticate anything.

The child explicitly sets HOME, USERPROFILE, CODEX_HOME and CLAUDE_CONFIG_DIR to the selected home; it inherits no credential/PATH environment. Native environmentHash binds those exact values. File inventory cannot prove MDM/cloud-managed/global fallback resolution, account access, tool usability or OS isolation. An independent platform verifier must supply an externally signed receipt and remain responsible for the reports it signs. Its enforced boundary must cover descendants and sealed/disabled ambient global/server-managed sources. Opaque local/inherited customizations remain blocked even with a signature.

`agent.reviewNativePlatformVerifier` imports only a bounded regular `.native-platform-verifier.json` containing exactly `{issuerId,publicKeyPem,fingerprint}`. The PEM must be an Ed25519 PUBLIC KEY; fingerprint is SHA256 of its SPKI DER. An Agent-owned local modal records the explicitly reviewed trusted verifier. PM selection JSON cannot register a key, and no key is trusted by default. This mission did not invoke the command, alter owner settings or manufacture a real platform certificate.

The external receipt has `schema: datapass.native-platform-proof/1`, `issuerId`, `keyFingerprint`, `signature` (Ed25519 signature over UTF-8 canonical JSON of payload, base64) and payload:

```text
hostId, transport, cwd, home, permission,
executableSha256, nativeVersion, startupManifestHash,
environmentHash, toolPolicyHash, supportedCapabilities,
managed: {state: COMPLETE_NO_STARTUP_EFFECTS, sourceHash, sourceRef},
ambient: {state: DISABLED_OR_SEALED, sourceHash, sourceRef},
isolation: {state: ENFORCED, descendants: ENFORCED, boundaryId, policyHash},
issuedAt, expiresAt
```

The lifetime is at most ten minutes. Every field must match the actual selected/captured target and exact binary before start. `toolPolicyHash = nativeHash(nativeToolPolicy(selection))`; explicit Claude tools contain exact `configToolRefs` and native `toolNames`, with no shell patterns/argv. The signer must independently verify capability/managed/ambient/isolation evidence; signing caller JSON without such verification is not a legitimate platform audit. Renewal of the same exact stable proof facts can support a newly reviewed owned continuation; changed permission/config/tool/boundary facts cannot.

Preflight distinguishes EXACT_BINARY_VERIFIED, LOCAL_MANIFEST_VERIFIED, TRUSTED_VERIFIER_REPORTED and UNKNOWN. Signature verification authenticates the independently trusted issuer's report; it does not itself enforce or intrinsically certify OS state. AUTHENTICATED and WORKING stay UNKNOWN until actual native evidence. Claude's default file-tools projection does not certify implementation/testing/subagents; explicit mapped names preserve native capabilities inside a certified boundary without `--allowedTools` or bypass. Its print CLI human permission-response round trip remains UNSUPPORTED_CLI_MANUAL. Codex retains native-owned default tools and refusal policy; per-tool selection/usability and entitlement are not inferred from a catalogue.

Official sources reviewed:

- [Codex config layering](https://learn.chatgpt.com/docs/config-file/config-basic): active project/user/profile/system and cloud-managed sources.
- [Codex lifecycle hooks](https://learn.chatgpt.com/docs/hooks): hooks merge across active config layers and plugins.
- [Claude settings sources](https://code.claude.com/docs/en/settings): managed files, MDM and server-managed settings.
- [Claude restricted/tools flags](https://code.claude.com/docs/en/cli-reference): restricted mode still loads managed settings; named tools and native permission mode remain distinct.

Synthetic Ed25519 fixtures test drift, missing/untrusted/expired/tampered proof, tool mapping, unknown inherited/customization sources and no process on changed proof. They certify transport/verification logic only. This owner host, native accounts, actual isolated platform, installed GUI and full native capabilities remain unqualified until genuine independent evidence exists.
