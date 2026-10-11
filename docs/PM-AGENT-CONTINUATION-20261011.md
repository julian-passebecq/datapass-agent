# Agent 0.10.7 PM continuation

This focused continuation starts from Agent `b9c5f5aa7097668c6dc2d0eeb89a43c06089e250` on the existing approved integration branch. It changes Agent only; PM owns its task authority and the original return selection.

The context strip now shows the original PM project/task identity, task document revision and authority hash separately from the observed native session. This selection metadata does not establish a task execution association. Restored panels retain these safe hints while suspending source access and return until a fresh reviewed PM handoff. Task bodies, drafts and grants are never persisted by this route.

Agent reports a completed PM return only when the fixed public command acknowledges every field of the original binding. A legacy missing acknowledgement is visibly unverified; mismatched acknowledgements and changed authority are denied. PM independently checks its persisted task bytes and current session mapping.

Scoped transcript saving and full-session export require export consent. The destination dialog and plan review recheck current authority before writing. The generic scoped export action uses only reviewed session IDs and never falls through to provider-wide discovery. Missing files, same-path replacements and linked source paths suspend the open panel; ordinary source appends retain its observation identity.

The existing 47 screens, original commands, views, independent readers, exports and companion integrations remain present. Navigation and focused typing retain the 0.10.6 guard. Existing fixture tests and headless qualification cover the changed boundaries; the existing Windows installed smoke must run against the published final head. Generated runner screenshots remain distinct from owner-host acceptance. Owner desktop interaction, live provider authentication, real project reconnect and native PM roundtrip remain separate manual gates.

Run `npm run check`, `npm test`, `npm run build:provider-kit`, `node scripts/agents-integration-headless.mjs .smoke/pm-agent-continuation`, and `npm run package`. Continuation receipts belong to `QA/pm-agent-continuation-20261011/agent`; prior 0.10.6 receipts remain historical evidence.
