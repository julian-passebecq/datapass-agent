# RC2 — Jul to native VS Code Agent Host

PM 0.5.4 consumes Agent 0.11.4's additive agentHostV1 interface. Agent owns the official Microsoft TypeScript AHP client, local transport, source/connection grants and session observation. Config 0.8.1 and Lens 0.3.7 remain unchanged. The protected direct-spawn transport and Ed25519 checks remain separate.

## Product workflow

Select one project and persisted task, connect its planning source, choose a reviewed Jul role, and compile its exact task with Config. In Conversations, **Jul → native Agent Host** shows Codex/Claude availability, actual model inventory and the host's negotiated protocol. Requested model and effort are distinct from effective engine observations.

1. **Review exact project scope in Agent** authorizes only this root, revision and source scope. A local-only repository must have its real root identity; remote identities must match actual Git remotes.
2. **Review native host connection** opens Agent's explicit endpoint picker and separate sensitive-access consent. Select only the documented endpoint entry for the intended approved native environment. Tokens stay in Agent memory and never enter PM, task journals or evidence. No host, SDK download, sign-in or security approval is started automatically.
3. Inspect the exact connected host, then **Prepare exact Agent Host dispatch**. This saves the Config-compiled prompt, task/role/project/Git/planning revision, preset and policy hashes. The editable manual fallback message is separate.
4. **Run via Agent Host** requires an exact dispatch review and current source, host, protocol and capability validation. Agent durably records creation/send intent before submitting one ordinary prompt. This creates a task-bound AHP session; it never migrates an OpenAI-extension session.
5. PM displays bounded redacted streaming output and native turn state. Authentication, tools, subagents and permission decisions remain native. PM does not approve tools or chain dependent tasks.
6. Reopen PM, reconnect current source/Config permissions and review the same host connection as needed. **Recover exact native session** reads stored session/chat/turn identities and snapshots without resending. A changed host, project, scope, protocol or capability blocks recovery rather than guessing ownership.

Current connection/state and retained turn evidence are shown separately. Missing connection authorization is UNAVAILABLE with liveness UNKNOWN; it is not evidence that the process stopped. AUTH REQUIRED and PERMISSION REQUIRED need native input. RUNNING, COMPLETED, FAILED, STOPPED and UNCERTAIN are distinct. Native completion never accepts a PM task automatically.

## Supported boundaries

- Official SDK 1.0.0 negotiates the supported 1.0.0/0.9.0 protocol offers. Installed Stable 1.141.0 and Insiders 1.142.0 have compatible baselines; a live handshake is still required.
- Codex and Claude requested effort maps only to a uniquely selected model's source-qualified `thinkingLevel` string enum. Missing, ambiguous, disabled or unsupported model/effort is refused. No permission enum or security setting is substituted.
- DEFAULT ordinary tasks are supported by the adapter. PLAN/GOAL mapping remains explicitly unqualified on this route; use native mode controls and the preserved Copy/Open workflow.
- **Copy observed session reference** preserves real AHP identifiers, not a guessed provider-internal thread ID. **Open native Chat** uses a discovered public command without session arguments and preserves PM selection. Automatic exact-session reveal has no qualified public extension/CLI contract; no private workbench command or fabricated URI is used.
- New preparation time cannot permit a duplicate send. Action identity includes provider, exact host, root, task/planning revision, Git revision, source authority and prompt. Revised tasks or another provider require their own explicit approval. Uncertain dispatch never auto-retries.

## Qualification and installation

The candidate packages and their SHA256/source receipts are published through the existing private carrier and draft PRs. RC2 package/evidence manifests list exact paths and authenticated remote artifact URLs. Installation uses the existing prepared profile and guarded CLI with explicit directories; normal profiles and account settings are not changed.

For installation, download each VSIX from the authenticated artifact URL in `rc2-outcome.json`, compare `Get-FileHash -Algorithm SHA256` with its manifest value, and use VS Code's supported **Extensions: Install from VSIX** in the intended approved installation. The mission's existing prepared profile already contains these exact candidates; no owner installation or QA step is required. Keep PM 0.5.4 with Agent 0.11.4, Config 0.8.1 and Lens 0.3.7. Package installation does not enable a live host, authorize a connection or establish independent GUI isolation.

The Codex and Claude cross-product demonstrations are **SYNTHETIC**: actual PM/Agent code, official client negotiation, real synthetic-project Git identity, streamed fixture answers, duplicate refusal and reopened identity recovery. They do not prove a real provider turn. Named-pipe WebSocket transport is separately tested with an owned synthetic server. Installed package bytes/synthetic activation and actual extension-host/GUI journeys have separate acceptance gates.

The prepared profile had no running Agent Host during read-only inspection. Live endpoint credential access, standalone-host startup and new native task execution are not authorized by source-write approval. No real native turn or installed GUI success is claimed. Owner-operated synthetic QA is not requested. Required GitHub checks remain separately billing-blocked; GitLab is not relabelled as GitHub success. The FULL acceptance set remains open.
