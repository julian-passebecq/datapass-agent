# Agent architecture (0.7.0)

Agent is a local, read-only observer of Claude Code and Codex sessions inside VS Code. It holds no state of its own that matters: everything on screen is rebuilt from provider artifacts, git, and (opt-in) CI APIs. This page describes the data path, where each outside source enters, who is the authority for what, and the evidence, performance and security models.

## Data path

```
 provider artifacts                         git (read-only, hardened)        gh / glab (opt-in, network)
 ~/.claude/projects/**/*.jsonl              src/git/git.ts, repos.ts,         src/feeds/review.ts,
 ~/.claude/sessions/<pid>.json              changes.ts                        src/feeds/pipelines.ts
 ~/.codex/sessions/**/rollout-*.jsonl              │                                  │
 ~/.codex/session_index.jsonl, sqlite              │                                  │
          │                                        │                                  │
          ▼                                        │                                  │
 1 adapters            src/providers/claude, codex │                                  │
   byte cursor per artifact, parse records         │                                  │
          │                                        │                                  │
          ▼                                        │                                  │
 2 session accumulation  src/sessions/accumulator.ts (facts, usage, tests, evidence)  │
          │                                        │                                  │
          ▼                                        ▼                                  │
 3 store              src/sessions/store.ts: snapshots + timeline, status classify    │
                      (classify.ts), git correlation (HEAD before/after, commits)     │
          │                                                                           │
          ├──────────────────────────────┐                                            │
          ▼                              ▼                                            ▼
 4 feeds (async, per visible screen)  src/render/extra/feeds.ts + src/feeds/*  ◄──────┘
   settings, catalog (+ CLI --help), backlog / scope (plan files), lessons, history, archive
          │
          ▼
 5 pure activity transforms   src/activity/*.ts (insights, live, dispatch, lifecycle, ctxcost, scope …)
          │                   no I/O, no clock except the `now` they are given
          ▼
 6 renderers                  src/render/workspace.ts (core screens, rail), src/render/extra/*.ts (add-ons),
          │                   src/render/views.ts (Cockpit, Timeline, Activity, Inspector), html.ts (CSP page)
          ▼
 7 hosts                      src/ui/workspace.ts (Workspace panels, tabs, feed pump, actions),
                              src/ui/webviews.ts (Cockpit / Timeline / Activity views, Inspector),
                              src/ui/sessionsTree.ts, src/extension.ts (activation, watchers, commands)
```

1. **Adapters** (`src/providers/claude/claude.ts`, `workflows.ts`; `src/providers/codex/codex.ts`, `state.ts`) find artifacts under the provider roots, keep a byte cursor per file and parse only appended records. They never write. Paths that resolve outside the provider root are rejected.
2. **Accumulation** (`src/sessions/accumulator.ts`) folds records into one session: identity, model, effort, cwd, branch, tool counts, tests with their outcome source, files edited, usage, spawns, todos, tool-result sizes. Every field set here also records an `Evidence` entry (field, kind, source).
3. **Store** (`src/sessions/store.ts`) owns the in-memory projection: `AgentSessionSnapshot[]` (`src/model.ts`) plus a bounded timeline of `TimelineEvent`s. It classifies live status (`classify.ts`) and runs git correlation (HEAD before / after, commits in the session window) in trusted workspaces. Nothing in the store is persisted.
4. **Feeds** (`src/render/extra/feeds.ts`, `src/feeds/*.ts`) are async loaders a screen declares. Only feeds of the visible screen (or visible panes) run, each at its own `intervalMs`, cached per feed and scope. Rendering stays synchronous: a screen reads the last cached value and shows "loading" until it lands.
5. **Activity transforms** (`src/activity/*.ts`) are pure functions from snapshots, events, feed values and settings to view models. This is where DERIVED and INFERRED values are computed, each with its basis.
6. **Renderers** produce escaped HTML strings. Every dynamic string goes through `esc()`; no renderer does I/O.
7. **Hosts** put the HTML into webviews with a strict CSP, validate every message against a fixed allow-list, run screen actions (open file, copy, export, launch after confirm) and pump feeds.

## Where other inputs enter

| Input | Enters at | Notes |
|---|---|---|
| Git | store (correlation), feeds (Repositories, Changes, Health) | `src/git/git.ts` `HARDEN` flags, no fsmonitor / textconv / pager / credential helper, `GIT_TERMINAL_PROMPT=0`; trusted workspaces only |
| CI and PR APIs | feeds `review.ts`, `pipelines.ts` (gh / glab) | opt-in settings `agent.review.prState`, `agent.pipelines.enabled` (default off), trusted only, read-only commands, 5 s timeout |
| Daily / weekly archive | `src/archive/reader.ts`, `src/feeds/history.ts`, `src/feeds/scope.ts` | written only by `scripts/archive.ts` / `scripts/weekly.ts` (or *Build now*) under `~/.agent/`; read back as ARCHIVED |
| Settings | `src/feeds/settings.ts` | Claude settings layers, agents, skills, commands, memory files, Codex `config.toml`; names and safe scalars only |
| Catalog | `src/feeds/catalog.ts` | inventory of skills, agents, plugins, hooks (program name only), MCP (name and transport only), settings keys; optional `claude --help` / `--version`, `codex --help` |
| Provider versions | `src/providers/versions.ts` | `claude --version`, `codex --version` once at activation, minimal environment |
| VS Code settings | `WsData.config` at render time | thresholds, reference windows and price tables are settings, labelled as such |
| Galaxy (future) | `src/galaxy/*` | pure projections out of Agent, see [GALAXY.md](GALAXY.md); nothing is read from Galaxy |

## Authority boundaries

| Authority | Owns | Agent's role |
|---|---|---|
| Provider (Claude Code, Codex) | sessions, transcripts, rollouts, live registry, usage, recorded cost, settings files | reads; never writes, never adds hooks, never reads auth files |
| Git | commits, branches, worktrees, diffs | reads with hardened read-only commands; attribution is "during session window" unless the provider recorded the commit command |
| CI (GitHub, GitLab) | PR / MR, checks, pipelines, jobs | reads via gh / glab only on opt-in; shows "off" otherwise |
| Agent | the in-memory projection, DERIVED and INFERRED values, its own UI state | rebuilds everything on reload; no control of sessions |
| Agent archive (`~/.agent/`) | what Agent saw on a given day | append-only per day; values are "as of" that day, never current truth |
| Galaxy | cross-app contracts and registrations | Agent proposes `galaxy.agent-observation/1` and `galaxy.agent-config-snapshot/1`; no writes until registered |
| Harness (PM, watch.py, coders) | dispatch, merges, starting the next package | out of scope: Agent never dispatches, merges or starts work. The Launcher only starts a session you confirmed by hand |

## Evidence grammar

`EvidenceKind` (`src/model.ts`): OBSERVED (recorded by the source), DERIVED (deterministic calculation), INFERRED (heuristic: recency, process presence, medians, chars / 4), UNKNOWN (not exposed). Rules applied everywhere:

- An absence is never OBSERVED: "no test observed", "no commit observed", never "passed" or "failed".
- A value built from several kinds takes the weakest one.
- Archived values are OBSERVED as of their archive day and carry the ARCHIVED chip.
- Settings (context reference window, thresholds, price per token) are shown as settings, not facts.
- No LLM computes or judges any value.

## Performance model

- **Watch and tick**: recursive `fs.watch` on provider roots, debounced 1.5 s, plus a 20 s tick for time-based status. One refresh at a time, one queued.
- **Incremental reads**: a byte cursor per artifact; a refresh reads only appended bytes. Records over 512 KB are skipped (timestamp only); a truncated or replaced file is re-read from 0. History is bounded by `agent.historyDays` (3) and `agent.maxSessions` (300).
- **Git** is the expensive part: one process per call (repository location and log results cached in `git.ts`), capped per screen by `agent.repos.*` / `agent.changes.*`.
- **Feeds** run only for the visible screen or panes, at their own interval; results are cached per feed and scope. Panes add render time (sum of cells) and feed loads (union), not store scans.
- **Rendering** is synchronous string building from the snapshot; no sync fs in the render path.
- Measured on a real 3-day history (A5 audit, 5 Oct 2026): 211 artifacts / 699 MB, cold refresh 9.3 s without git, 20 to 45 s with git (124 spawns); idle refresh 1.6 s. The status strip shows refresh, git time, bytes read and heap for every pass; `Agent: Show Diagnostics` has the details.

## Security model

- **Read-only**: provider files are opened read-only; Agent never writes provider files. Its only writes are its own archive (`~/.agent/`, by the archive / weekly scripts), user-initiated exports, and temporary copies of Codex sqlite files in the OS temp folder.
- **No secrets**: auth files (`~/.claude/.credentials.json`, `~/.codex/auth.json`, `secrets/`) are never opened. Env: only `USERPROFILE`, `HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR` are read; child processes get a minimal environment with no tokens.
- **Redaction**: kept text (titles, command lines, labels) is single-line, length-bounded and passed through `src/util/redact.ts`. Settings and catalog values pass an allow-list before redaction; env values, hook commands, MCP args / URLs / headers are never kept.
- **Processes**: executables are resolved on absolute PATH entries only, never from a session cwd; `.cmd` / `.bat` are never run through a shell. Git calls are hardened. gh / glab run only on opt-in, trusted, read-only.
- **Network**: none, except the opt-in gh / glab calls. No telemetry.
- **Webviews**: CSP `default-src 'none'`, nonce scripts, no remote origins, `enableCommandUris: false`, every message validated against known session keys and a fixed command allow-list.
- **Workspace trust**: in untrusted workspaces git correlation, git feeds, gh / glab and the Catalog CLI probe are off.
