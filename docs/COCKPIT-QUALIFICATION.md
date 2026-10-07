# Cockpit prototype qualification — 2026-10-07

Source baseline: `agent-vscode` `7420b69` (0.7.1), fast-forwarded into the existing
`datapass-agent` history after inspecting the clean checkout. Work branch:
`codex/cockpit-exports`. Installed VS Code extension 0.7.1 was not changed.

- Agent typecheck, build and installable `agent-vscode-0.8.0.vsix` packaging passed.
- VS Code CLI installed that package successfully in the ignored isolated
  `.datapass/vsix-profile`; the normal extension installation was untouched.
- Final full Agent suite: **416/416 passed**, serial execution. An earlier concurrent
  run failed the existing catalog timing assertion (180.8 ms vs its 50 ms threshold).
  The catalog suite passed alone and the final full serial suite passed; no threshold
  or unrelated catalog implementation was changed.
- Real read-only local export: one selected Codex source **891 events**, one selected
  Claude source **6,736 events**; no malformed rows and both files stable during export.
- Leviathan **v0.1.0**, source SHA `702ea92dc4695de00c488a66b43d75419bbb78e8`:
  Windows release binary indexed **7,627 / 7,627 records**, zero skipped lines, strict mode.
  Full-event lexical fallback and Leviathan both returned matches for `architecture`.
  Leviathan stdio MCP initialized, exposed `search`, `resolve_group`, `get`, `describe`,
  and returned three search results from the same real export index.
- Atlas plugin successfully read **11 metadata records** from `dataprojects_control`:
  5 `context_routes`, 1 `short_memory`, 5 `work_items`. Explicit field projection;
  no Mongo writes or credential serialization. This qualifies plugin reads and local
  JSON import, **not a live Mongo connection in the cockpit**. Earlier direct-driver
  TLS failures have not been claimed fixed.
- T3 parsed real native and Mongo manifests and built a valid review pack including all
  three inputs (**11,613 characters**) within the 16,000-character budget. Real bundles
  are ignored local data.

T3 branch `codex/datapass-cockpit`, source baseline `bfec2387b`:
web typecheck, **19 focused knowledge/integrations tests**, production web build and server
bundle passed. A fresh isolated server profile served `/datapass` with HTTP 200 and
the exact built SPA shell. It was stopped afterward using its captured child handle.
Final cockpit, bundle and store sources matched their production source maps. Targeted
lint passed; linting the edited existing CommandPalette also reported five pre-existing
warnings in unchanged code, with no errors.

No browser or installed-extension UI smoke was performed. T3 repository instructions
require explicit agreement before browser/computer-use verification. No existing T3
userdata or installed Agent profile was modified. Native mobile has no new cockpit page.
Desktop shares the web UI but no Electron installer was built. Graphs and AI reconciliation
remain future work. Pattern redaction requires human inspection before publication.

GitHub CLI is `2.52.0`; the current T3 source-control documentation requires `2.81+`.
Live PR/MR screens need a supported CLI and normal authentication. The ETA repositories
contained only `README.md` at inspection; no real feature CSV or ChatGPT export was
available for qualification. Synthetic CSV and branched ChatGPT inputs passed tests.
