# Agent and Galaxy

Galaxy (`C:\Users\julia\.claude\effort-board\galaxy.json`) lists the cross-app contracts of Julian's apps. On 5 Oct 2026 it has no `agent` app and no Agent contract (audit A1, P1-8). This page is the **proposal**: two contracts, their field mapping from Agent's read model, and the app registration. Nothing is registered or written yet.

What exists in code (`src/galaxy/`), all pure (no fs, no network, no Mongo, no clock: the caller passes `capturedAt`):

| File | Export | Does |
|---|---|---|
| `index.ts` | `OBSERVATION_SCHEMA`, `CONFIG_SNAPSHOT_SCHEMA`, `pathRef`, `canonicalJson`, `sha256`, `validateGalaxyDoc` | schema ids, path → folder name + hash, canonical JSON for hashing, a minimal structural check (schema id, ISO `capturedAt`, kinds from the grammar, no absolute path) |
| `observation.ts` | `toObservation(snapshot, events, { capturedAt, freshness?, maxEvents? })`, `toObservations(...)` | one `AgentSessionSnapshot` + its `TimelineEvent`s → `galaxy.agent-observation/1` |
| `configSnapshot.ts` | `toConfigSnapshot({ settings?, catalog?, cli?, capturedAt })` | Settings report + Catalog report + CLI probes → `galaxy.agent-config-snapshot/1` with a content hash |

Tests: `test/galaxy.test.ts` (no free text, no absolute path, absent = UNKNOWN, stable hash, real fixture sessions validate).

Not done on purpose: an "Export Galaxy observation" command, any write to Galaxy's store, any read from Galaxy.

## Common rules

- Every document has `schema`, `capturedAt` (ISO) and `kinds` (evidence kind per exported field). A field that is absent is left out and its kind is `UNKNOWN`; an absence is never `OBSERVED`.
- A document is "as of `capturedAt`", never current truth. Observations also say `freshness: live | archived`.
- No free text leaves Agent: no prompt or reply, title, command line, commit subject, event label, todo text, tool detail, worker task description, hook command, env name or value, permission rule text, settings value.
- No absolute path: a path becomes `{ name, hash }` (folder name and the first 16 hex chars of sha256 of the lower-cased, forward-slash path), so the same repository joins across documents without exposing the path.

## galaxy.agent-observation/1

Source: `AgentSessionSnapshot` and `TimelineEvent` (`src/model.ts`).

| Field | Source | Kind |
|---|---|---|
| `observationId` | `key` (`provider:sessionId`) | OBSERVED |
| `provider`, `sessionId` | snapshot | OBSERVED |
| `providerVersion`, `model`, `effort` | snapshot | recorded evidence, else OBSERVED; UNKNOWN when absent |
| `status` | snapshot `status` | the recorded `status` evidence (Claude live registry), else INFERRED; UNKNOWN for UNKNOWN |
| `statusReason` | snapshot (Agent's own text, bounded, redacted) | as `status` |
| `startedAt`, `lastActivityAt`, `endedAt` | snapshot, ISO | OBSERVED; `endedAt` DERIVED when Agent derived it |
| `repo`, `worktree` (+ `linked`) | `repository`, `worktree`, `isLinkedWorktree` → `{ name, hash }` | DERIVED (git) or recorded evidence |
| `branch`, `headBefore`, `headAfter`, `dirty` | snapshot | recorded evidence, else DERIVED |
| `commits[] { sha, at, attribution }` | `commits` (no subject) | DERIVED (session window) |
| `tests[] { at, outcome, source, exitCode?, durationMs? }` | `tests` (no command) | OBSERVED |
| `changedFiles` (count), `linesAdded`, `linesRemoved` | snapshot | OBSERVED / DERIVED |
| `isWorker`, `parentKey`, `workerLabel` | snapshot; `workerLabel` keeps only the recorded type (Claude `agentType`, Codex nickname), never the task description | OBSERVED |
| `counts { tools, commands, fileEdits, turns }` | snapshot | OBSERVED |
| `usage { totalTokens, outputTokens, cachedInputTokens, contextTokens?, contextWindow?, costUSD? }` | `usage` | totals: DERIVED for Claude (sum per message), OBSERVED for Codex; context and cost OBSERVED |
| `facts { toolCounts, toolErrors, prompts, replies, compactions, permissionMode, sandbox, entrypoint, activeMs, spawns (count), web }` | flat, text-free subset of `facts` | OBSERVED; `activeMs` DERIVED |
| `events[] { at, type, kind }` | timeline of this session, oldest first, newest 500 by default (no label) | per event |
| `evidence[] { field, kind, source }` | `evidence` (source bounded) | meta |
| `capturedAt`, `freshness` | caller | OBSERVED |

## galaxy.agent-config-snapshot/1

Source: `SettingsReport` (`src/feeds/settings.ts`), `CatalogReport` (`src/feeds/catalog.ts`), `CliInfo[]` (Catalog CLI probe).

| Field | Source | Kind |
|---|---|---|
| `claude.layers[] { kind, root?, model, effortLevel, defaultMode, outputStyle, allow, deny, ask, hookEvents, hooks, env, enabledPlugins, apiKeyHelper }` | settings layers that exist and parse; rule lists and env as **counts**, hooks as event names | OBSERVED |
| `claude.effective { model, effortLevel, defaultMode }` | user scope (managed > user), `effective()` | DERIVED |
| `claude.rules { allow, deny, ask, hooks }` | `mergedRules()` over user scope | DERIVED |
| `claude.items[] { kind, scope, name }` | agents, skills, commands, output styles | OBSERVED |
| `codex[] { scope, root?, model, effort, approval, sandbox, serviceTier, profile, profiles, mcpServers, features, plugins, trustedProjects, notify }` | `config.toml` files (names only) | OBSERVED |
| `catalog.items[] { provider, kind, source, name, active, plugin? }` | catalog items (no description) | OBSERVED |
| `catalog.plugins[] { provider, id, version?, enabled?, installed }` | plugins | OBSERVED |
| `catalog.hooks[] { event, matcher, type, program, source }` | hooks, program basename only | OBSERVED |
| `catalog.mcp[] { provider, name, transport, source }` | MCP servers (no command, args, URL, headers) | OBSERVED |
| `catalog.settingsKeys[]` | distinct settings key names (no values) | OBSERVED |
| `cli[] { tool, status, version? }` | CLI probe | OBSERVED |
| `contentHash` | sha256 of the canonical JSON of everything above (keys sorted, lists sorted) | DERIVED |
| `capturedAt` | caller | OBSERVED |

A missing feed leaves its section out (`kinds.<section> = UNKNOWN`) rather than exporting an empty section as a fact. Equal configuration gives an equal `contentHash` whatever `capturedAt` or input order, so a consumer can store only changes.

## Proposed registration (galaxy.json)

```json
{
  "id": "agent",
  "name": "Agent",
  "path": "D:\\PROJ\\datapass-agent",
  "repo": "julian-passebecq/agent-vscode",
  "layer": "observability, read-only",
  "stack": "VS Code extension, TypeScript",
  "produces": [
    { "contract": "galaxy.agent-observation/1", "status": "planned", "adapter": "src/galaxy/observation.ts" },
    { "contract": "galaxy.agent-config-snapshot/1", "status": "planned", "adapter": "src/galaxy/configSnapshot.ts" }
  ],
  "consumes": [
    { "command": "tern.revealWorktree", "optional": true }
  ]
}
```

Before registering: check `galaxy.json` for a conflicting shape (Galaxy rule: check before changing a shared format), decide the transport (JSONL file written by a user-initiated command, or a Mongo collection owned by the consumer), and keep Agent's side a pure projection plus an explicit user action. Agent never writes to Mongo itself.

## Open questions (owner decisions)

- Transport and consumer: who reads these documents (DataPass, effort-board, a Galaxy store)?
- Whether commit subjects or session titles may ever be exported (today: never).
- Canonical repository: `agent-vscode` is used here; `datapass-agent` still exists (see README, Repository).
