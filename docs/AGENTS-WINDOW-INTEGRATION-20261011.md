# Agent 0.10.6 integration candidate

Focused integration increment within COCKPIT-NATIVE-20261009-FULL. Baseline `8c120be6d4046c85cb16e7aa1f70e98de9f4c0bc`; dedicated branch `codex/agents-window-integration-20261011`. The canonical destination remains `julian-passebecq/agent-vscode`. No merge, owner-profile installation, live configuration apply, authentication automation or provider task launch is included.

## User-visible changes

The public `agent.workspace` serializer adopts the panel VS Code restores, keeping its selected screen, session selection, relevant navigation options and minimal ContextRef. Restarted scoped panels display the exact missing-grant reason with an inline scope-review action and retain their context reference. Previously saved cockpit grants are retired. Review the scope and reopen the selected project from PM to obtain a fresh return binding. Invalid metadata, revoked grants and disappearing provider sources cannot escape to an unrestricted panel through toolbar commands.

Agent now exposes scoped `getContextMappings` so PM can compare its selected local repository with actual Agent metadata before sending an opaque ID. The context strip offers a bounded Lens handoff that preserves the original PM return binding. Lens retains ownership of Git identity and reviewed source grants. A missing companion remains unavailable, with no implicit scope expansion.

Suspended panels stop source collectors and hide their data bodies. In a reviewed scoped panel, legacy collectors that discover provider-wide roots remain UNKNOWN/unavailable; exact-source Compact, transcript settings and bounded repository lessons remain available. The independent Agent workspace retains those provider-wide screens/readers. Scoped provider configuration stays available through the validated cockpit API and Config. A scoped cache cannot reuse independent local history.

Narrow rails constrain their width and bring the active screen into view. Existing bare digit shortcuts ignore editable content and unfocused documents. Public Ctrl+Alt numbered commands provide navigation when an Agent editor is active, with Go to screen available for every screen and scoped tab. The client independently checks actual editable focus, composition and document focus before accepting a numbered command: VS Code's `inputFocus` context does not describe inputs inside webviews. Installed qualification discovered that boundary; version 0.10.6 fixes it without expanding panel authority.

## Scoped acceptance disposition

| Canonical clause | This increment | Evidence | Remaining gate |
| --- | --- | --- | --- |
| AO-003 / CK-025 / CK-026 | Implemented scoped mapping, reveal, return and suspended restoration | Context mapping/return/lifecycle negative tests; synthetic headless restart | Installed PM → Agent → Lens → PM and native restart |
| NP-013 / FU-011 | Agent boundary implemented and testable through current public APIs | Lens dispatch binding/authority tests; family harness owned by PM | Native installed project roundtrip |
| AO-011 / CK-029 | Preserved independent observer and all 47 screens; additive commands only | Full existing regression and all-screen narrow fixture | Standalone native profile qualification FU-017 |
| FU-010 | Restart retains navigation/reference and requires explicit reconnect | Serializer lifecycle fixture; invalid metadata/revocation/source disappearance | Native host restart and approved reviewed reconnect |
| FU-023 | Headless narrow and wide layouts qualified | 47 screens at 420/600/700/1000/1500 px | Actual Cursor/Agents Window layout and profile identity remain UNTESTED |
| Other FULL/inherited clauses | Untouched accepted ownership and IDs | Existing product source retained | Not newly certified by this increment |

This disposition is an implementation/evidence snapshot. Canonical editable feature ownership remains Galaxy Prompt Spec/Backlog.

## Verification and receipt paths

Run `npm ci --no-audit --no-fund`, `npm run check`, `npm test`, and `npm run package`. Run the nonintrusive browser fixture after compiling tests with `node scripts/agents-integration-headless.mjs .smoke/agents-integration-headless`. It launches a separate headless Chromium process, fulfills fixture documents locally, reads no provider home and takes no physical input. All screenshots are synthetic. Product receipt and image hashes accompany the final candidate family report; a headless browser fixture does not certify an installed Windows extension host.

Meaningful negative cases cover caller-created scopes, wrong repository/revision, metadata tampering, source disappearance, asynchronous grant revocation/source drift, stale return binding, missing/rejecting Lens, contenteditable typing and blocked commands in restored scoped panels. The existing independent readers, collectors, exports, provenance and engine code remain intact.

## Native gate and installation path

Use the packaged `agent-vscode-0.10.6.vsix` with the family package hash vector in an owned draft-free disposable Stable/Insiders profile. Install through supported VS Code extension UI/CLI and open Agent: Open Workspace. For scoped qualification, review a synthetic project scope, select that exact repository in PM, open Agent Compact, inspect context in reviewed Lens, and return to PM. Reload only the disposable draft-free window. Confirm the selected screen and suspended context reappear, review the scope, and obtain a fresh PM handoff. Close/reopen the panel and repeat source disappearance/revocation cases.

Shared-desktop native automation remains blocked until nonintrusive PID/HWND/capture identity can be verified. Authentication, trust prompts and Agents Window opt-in are owner-controlled manual prerequisites. Native reload, host restart, installed keybindings, actual four-product journey and exact-head remote CI are UNTESTED here; do not promote the fixture checks to those gates. No login state is inferred from installation. PM owns the integrated family readiness and publication receipts.
