# RC2 native AHP permission guard

Config selects the additive policy with testEnvelope.nativeExecutionPolicy = READ_ONLY_NO_DELEGATION. PM binds the full test-envelope hash to the exact compiled task; Agent includes this policy in preparation, intent and recovery. Tasks without this selection retain existing native/manual permission handling.

Agent calls public resolveSessionConfig for the exact Codex provider and project. It rejects missing or incompatible schema, unsafe values, a permissions preset, added directories and inherited host approval/network/artifact settings. The selected restrictive config is transmitted in createSession.config, never inferred from the prompt. Host configuration changes invalidate preparation; restored sessions retain the same policy hash. Pending owned tool confirmations are explicitly denied through public chat/toolCallConfirmed, never approved.

The public AHP1.0/0.9 interface supplies server configuration, not an independent statement that native filesystem/network/delegation and all host-owned operations are effectively restricted. Therefore this policy remains PERMISSION_REQUIRED and Agent refuses the first turn even when the session echoes the exact config. No custom trusted receipt, Microsoft binary change or simulated runtime PASS is introduced. Native authentication does not remove this permission blocker.

Tests use the Agent-owned official SDK fixture and are SYNTHETIC. They qualify configuration transmission, rejection and policy-bound recovery without a prompt. They do not qualify native sandbox enforcement, provider authentication, a real reply or editor GUI. Protected direct-spawn startup/platform-proof checks are unchanged.
