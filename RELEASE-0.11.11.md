# Agent 0.11.11 - reviewed policy invalidation candidate

Reviewing or revoking a cockpit scope now immediately notifies existing scoped panels. They recheck authority through the unchanged 300ms coalesced scheduler; hidden and disposed panels retain their existing lifecycle. Provider discovery is not refreshed, navigation does not grant authority, and source/scope/return guards are unchanged. The source-loss correction from 0.11.10 remains intact.

Native tests reproduce stale panel state after real review and revoke command handlers with no store notification: baseline two failures and one pass; candidate 37 affected tests pass. Independent review passes 42 tests, including queued/coalesced notifications, persistence failure, multiple/disposed panels and hidden panels. Compilation, typecheck and build pass. These use the real policy/facade/panel/renderer source with a stubbed VS Code surface; they are not installed editor qualification.

Actual family122, on earlier Agent0.11.10, passed the source-loss UI step then timed out waiting for the revoked alert. The later failure snapshot already contains revoked state, so its precise timeout chronology remains unproven. This native reproduction establishes the missing command notification, not a retrospective causal claim about that run.

This is a distinct candidate. Original Agent0.11.9, 0.11.10, diagnostic assets and prior qualification remain preserved. Affected installed family/focused and declared-minimum qualification are pending for these new bytes. Prior135, export and minimum acceptance are not transferred. No public release or whole Galaxy V1 release claim. RELEASE_PASS=false.
