# FULL Agent observation additions

Source contract: COCKPIT-NATIVE-20261009-FULL, Agent AO-001..012 and 17 inherited Agent clauses. Existing Agent API, screens, commands, readers, exports and Lens links remain available. The candidate is 0.10.0; cockpitV1 remains major 1 and negotiates additive methods through capabilities().

## Shared configuration collection

`npm run build:provider-kit` builds the Agent-owned `@datapass/provider-kit` 1.0.1. `captureConfiguration(selection)` calls the same `collectConfiguration` implementation as cockpitV1's provider configuration method. Explicit homes, reviewed roots, SHA256 policy hash, provider, surface, native version, host and account identity are required. Unknown version/account is null. The package has no history reader or CLI probe, and does not create an Agent scope grant.

The capture includes sanitized ProviderConfig, opaque source references, timestamp, safe-projection hash and omissions. Multi-root effective values are UNKNOWN; individual layers remain visible. Role inventory carries requested model/effort/tool declarations separately from an UNKNOWN observed model. Hook inventory exposes event/type/source metadata and omits executable payloads. Config owns desired presets, version-specific resolution and capture persistence. Installed/configured entries never imply authentication or usability.

## Negotiated Agent methods

All requests carry the host-reviewed Scope, requestId, optional epoch and generation. Replies echo requestId/generation, scopeHash, current policy epoch and host. An async operation pins its starting epoch even if an older caller omits it. A revoked/replaced grant invalidates outstanding work and subscribed panels; restoring an identical-looking grant does not revive a previous operation. Session identities whose repository mapping drifted are excluded until review.

- `getObservation(request)`: bounded, paginated session census, native IDs/entrypoints, requested/observed model/effort/mode/Goal, recorded tools, input requests/results, source timestamps and provenance. Native process liveness, open turn, explicit end and one-shot completion remain separate. Missing telemetry stays null. Goal tool results are distinguished from Goal requests and Plan hints.
- `getEventPage({...request, afterSequence})`: per-scope retained event sequence (256 events), bounded pages, oldest sequence, gap indication and epoch. Duplicate or unrelated-session refreshes do not advance a scope's sequence. A gap/reset requires a fresh observation; subscriptions coalesce and emit RESYNC_REQUIRED under backpressure. Disposal/revocation stops delivery.
- `revealContext({...request, context})`: validates organization/privacy/project/repo/host/worktree/revision/selected native session and opaque return token. Unmapped context is denied. Full session detail stays inside the same bounded panel; Back to Compact preserves selection. A return token is data, never an imported executable command or fictional native URI.
- `prepareReply({...request, sessionId, questionId, text})`: pending observed ordinary input only. Returns a sanitized manual-copy draft, sent=false. Security/permission requests are denied. No verified native send transport is available; Agent does not emulate it.
- `getResourceObservations(request)`: only exact diagnostic files selected locally in Agent. Reads metadata, distinguishes disabled/stale/absent/blocked, and leaves causality UNKNOWN. It never executes or repairs scripts/watchers/tasks or kills processes.

## Export and evidence

The existing incremental exporter still commits an immutable manifest before advancing its cursor. Permission is rechecked during capture and immediately before commit. Approved export displays a committed receipt handoff. `getExportReceipt` can recover a receipt after restart from a newly selected destination, validating manifest/object hashes and scope. Cancellation/revocation/tampering never advances a cursor. Curated dialogue and separate native archive permissions are unchanged; QA fixtures never contain real histories.

Host-reviewed scoped receipt imports may include `evidenceRefs` with actual session/task/source/preset/config/prompt/QA IDs and hashes; UNKNOWN fields are null. These are links, not an editable task/config store. Image intake uses `datapass.image-producer-receipt/1`, an exact selected image and an enrolled native session when producer is declared. It verifies bytes/hash but labels generation REPORTED and publication NOT_APPROVED; unknown producers remain unknown. No image-generation provenance is fabricated from a changed PNG.

Per-session counters retain available input/cache/output/reasoning tokens, provider-recorded cost, quota windows and derived work/wait time. Period model-call samples are shown separately. Parent/child disjointness remains UNKNOWN and family counters are never added together. No billing, productivity or percentage-complete estimate is inferred from tokens.

## Qualification boundary

Local fixtures/builds/test suites are authorized. GUI/installed journeys are PM-scheduled. Real-history export, live provider launch/config apply, experiments/spend and remote publication require separate exact envelopes. No merge/deploy/tag/force-push. A local candidate or synthetic pass does not close installed or integrated acceptance.
