# Changelog

## 0.11.9 — 2026-10-17 (private qualification candidate)

- Fix fresh reviewed truncations being refused as a newer export. A shorter selected full-session resnapshot may commit only while its reviewed prior cursor and commit remain current.
- Bind changed capture plans to their previous immutable manifest, refusing stale new/append/rewrite plans even when byte lengths match. Preserve unchanged re-plan/repeat idempotence and historical receipt recovery.
- Preserve exact source/approval/hash/lock/staging checks, curated redaction and immutable prior objects. No provider history is written.
- New source tests cover positive truncation/reappend, concurrent stale plans and original 0.11.8-format receipt/object bytes. Exact new installed export qualification remains pending; prior 0.11.8 smoke results retain their original package scope.

## 0.11.8 — 2026-10-17 (private qualification candidate)

- Let the existing diagnostic-file enrollment explicitly record UNKNOWN, Enabled or Disabled metadata, after exact source-scope and file selection.
- Label Enabled/Disabled as `HOST_REVIEWED_ASSERTION`, separate from observed runtime state. The command changes, executes and re-enables no selected resource.
- Cancelled metadata review or changed source authority enrolls nothing. Existing resource kinds, one-hour staleness boundary, metadata-only reads and no-kill behavior remain.
- Installed qualification of these exact new bytes remains a campaign gate. Generated source tests and a Windows Server result do not establish native-provider execution, Windows 11 or Cursor acceptance.

## 0.11.7 — 2026-10-17 (private qualification prerelease)

- Assign a unique package identity to the corrected 0.11.6 candidate `4c77f99ad55c1ca09611b95793754c680992b7b0`.
- Retain the AWS redaction prefilter correction and all original safety assertions.
- No runtime source change. Historical 525/525 Windows results remain evidence for the original candidate; this package requires its own qualification receipt.

Original V1 installed dark/light smoke, AO-011 completeness, live native sessions, Launcher/AHP and Windows 11/Cursor acceptance remain separate gates. This prerelease does not claim full V1 RELEASE_PASS.
