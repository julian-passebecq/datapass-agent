# DataPass Cockpit RC1 — installed assisted native workflow

Candidate family: PM 0.5.3, Agent 0.11.3, unchanged Config 0.8.1 and Lens 0.3.7. This is a draft release candidate, not main or Marketplace. The mission installs and verifies PM/Agent in the existing prepared Insiders profile; it does not modify normal profiles.

## Candidate packages and installation

The two exact-source Windows carrier packages have already been installed by this mission in the existing prepared profile. All 121 PM/Agent payload entries match their respective VSIX files. No owner installation or manual qualification task is required for this RC delivery.

Authenticated artifact downloads are available from the [PM carrier job](https://gitlab.com/juliandatapass-group/datapass-codex-test/-/jobs/17140362784/artifacts/browse/evidence/) and [Agent carrier job](https://gitlab.com/juliandatapass-group/datapass-codex-test/-/jobs/17139915790/artifacts/browse/evidence/), through November 12, 2026. These are private candidate artifacts, not a public release.

| Package | Exact package source | SHA256 |
|---|---|---|
| datapass-pm-0.5.3.vsix | a05c58167e58040a199ae39e5bebdf9f5a287538 | bb21f4a6b1c3f32ec3be074018b71e864f591f6147e88b34c751660ab30c6cec |
| agent-vscode-0.11.3.vsix | b3050cd8ddebc26b69f63953c873a361b389886f | bad7ead08a894575d3952b2b1bc56774d70e61763e6d6ab6000512dae48e0531 |

For a separately authorized installation, verify the package hash, then use VS Code's **Extensions: Install from VSIX** in the intended approved profile. The mission's guarded CLI installation uses explicit user-data/extensions directories and empty allowlisted child environment; it does not create or authenticate an Agent Host. Installation alone is not GUI or native-turn qualification. Later documentation commits do not change these package-source revisions.

## Open and use

Open the prepared cockpit profile and use **PM: Open Product Cockpit**. Existing standalone Agent, Config and Lens views remain available. The documented `extensions.supportAgentsWindow` opt-in already includes all four products in that profile; ordinary Chat view also works.

1. In PM, register/select the project and connect its persisted task source. A repository with no supported remote receives an explicit `local:` identity bound to its real Git root; it never acquires a fabricated GitHub/GitLab identity. Select one task.
2. In Conversations, select a Jul role scoped to this project, with its reviewed Config binding. Compose the message. Prepare the campaign and task with the existing Config preset. Config remains the authority for requested provider/model/effort; native observations are separate.
3. In **Jul → native coding session**, review the exact message and save the manual handoff. Its task, role, project, Git revision, Config context and prompt are retained in this workspace.
4. **Copy exact message**, then **Open native chat**. The Open action focuses the native Chat view when available and otherwise gives its shortcut. Select the intended Codex or Claude session; verify workspace, model and native permissions, then paste and send yourself. PM does not submit, continue or cancel a native turn through this workflow.
5. In Agent, review the actual session sources for this project. Reconnect that reviewed scope in PM. **Review observed session** presents genuine session IDs mapped to the exact project root; explicitly approve the task/role association. Matching a title or timestamp never links a task.
6. PM displays the available answer with its observed model, provider version and provenance. **Refresh available answer** reads only this associated, reviewed session. It does not send another message.
7. Close/reopen PM. The workspace journal recovers the exact task, role, prompt, association and result state. Reload task authority and revalidate companion scopes before further Copy/Open/association actions. Changed source, Git revision, role or permissions refuses those actions; retained evidence is never a new execution grant.

## Meaning of answer states

| State | Meaning |
|---|---|
| PROVIDER OBSERVED | Agent found one exact redacted/normalized prompt and bounded parsed replies in the reviewed provider source. Owner separately reviewed the PM task/role link. Completion and CI success are not asserted. |
| OWNER CONFIRMED | A person explicitly reviewed a bounded answer copied from the associated native session. Agent did not observe that answer. |
| NATIVE VISIBLE ONLY | No parsed reply is available to PM for the exact observed prompt. Any native-UI result remains outside PM evidence. |
| UNAVAILABLE | A matching source, unique prompt, identity or answer cannot currently be qualified. |

The observer refuses ambiguous prompts, missing or mismatched literal native identity/cwd, changed sources, revoked grants, malformed/incomplete captures and sources outside its bounded complete window. Reader limits are 5 MiB, 2000 entries, 6000 prompt characters and a 12000-character reply projection. Longer manual messages remain usable; their complete provider match is unavailable. Thinking/tool bodies and other turns are omitted.

## Native engines and limits

The assisted UI supports Codex and Claude without implementing a coding harness. Authentication, tool execution, subagents and approvals remain native. The separate direct-spawn transport retains its signed Ed25519 platform-proof checks.

VS Code Agent Host Codex is experimental and has its own supported setup/account choices. Claude Agent Host authentication is not automatically a Claude Code subscription login. No new paid service or account/security setting was activated by this mission.

Actual native turns and installed VS Code GUI automation remain separately blocked when an authorized noninteractive/isolated route is unavailable. Headless product-HTML screenshots, installed package-byte checks and synthetic recovery tests are explicitly labelled; they are not actual Codex completion or installed GUI acceptance. The selected FULL contract and its original acceptance IDs remain open.
