# Resume Agent NIGHT4

Lane AGENT; canonical repository julian-passebecq/agent-vscode; branch codex/night4-agent; PR https://github.com/julian-passebecq/agent-vscode/pull/84. Product source candidate 7b47beb877114c841aa8d2716df900b927d1eca5, version 0.9.0. Do not reset/cherry-pick another writer's checkout or merge main.

Implementation, 439 tests, targeted privacy/export checks and actual installed standalone/same-host-consumer qualification are complete. SHIP-REPORT and outcome.json retain separate installation/integration/merge/deploy/owner-verification states. The immutable package hash is in READY; use the package, not this worktree.

Late producer publication from this checkout, after verifying `.datapass/night4/installed-latest.json` still matches the current VSIX:

```powershell
node scripts/publish-agent-ready.mjs <selected-shared-integration-root>/COCKPIT-20261008-NIGHT4/AGENT
```

One explicit isolated installation action (paths selected by the operator; the installer validates READY/hash before invoking the known Code CLI):

```powershell
pwsh -File scripts/install-agent.ps1 -ReadyPath <AGENT-READY.json> -UserDataDir <isolated-profile> -ExtensionsDir <isolated-extensions>
```

PM owns the final multi-product setup/assembly script and consumes this READY. In the installed Agent, Review Cockpit Scope grants exact selected native sessions to stable organization/privacy/project IDs. No caller JSON grants access. Review a local export-enabled scope and a concrete plan before an actual export; no real history was selected during qualification. Context/accepted-work/assets use the scoped registered-receipt envelope described in docs/COCKPIT-V1.md.

Do not re-run unchanged provider history/audit suites to integrate a peer artifact. Reuse exact package/CI evidence. Any changed export, permission or isolation path requires its affected checks. A final PM/Brain integration outcome is still owned by PM; Agent availability is source/package-ready, not proof of the assembled product.
