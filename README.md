# Agent — local observer for Claude Code and Codex

Agent answers one question inside VS Code: **what are my coding agents doing, where, and what did they actually change?**

It **observes** provider-native sessions. It does not launch, schedule, steer, stop or route agents, and it adds no hooks to the providers.

- **Cockpit**: live sessions per provider, ended today, recent sessions.
- **Sessions**: tree grouped by provider, with workers nested under their parent where the provider exposes the link.
- **Timeline**: one chronological view of session start, commands, file changes, tests, commits, workers and end.
- **Activity**: a 7-day factual rollup (sessions, observed duration, commits, files, tests, repos) plus a session graph. There is no productivity score.
- **Inspector**: a result card (duration, model, HEAD before → after, commits, files, lines, tests, tokens, recorded cost, context), then status, location, change, verification, activity, and the evidence behind each field.

### Agent Workspace (`Agent: Open Workspace`, or the button in the Cockpit)

One editor panel: a navigation rail, the main surface, and a result card for the selected session on the right. Click selects; double-click or Enter opens the Inspector.

| Screen | What it shows |
|---|---|
| Overview | Live counts, attention count, sessions / commits / tests / tokens over 24 h, live agent cards (model · effort, context %, tokens, recorded cost, last action, lifecycle stages), the attention list and the 24 h swimlanes |
| Attention | Where to look: input requested, last test failed in a live session, context ≥ 80 %, open turn without activity, idle beyond `agent.idleAlertMinutes` (30), ended with edits but no commit. Each item names its basis |
| Board | Sessions in columns: needs input, running, idle, unknown, ended in the last 24 h |
| Team | A lead session and its workers in lanes, one per worker role the provider recorded (Claude subagent type, Codex agent nickname) |
| Flow | Provider → repository → observed outcome (live, commit observed, files edited without a commit, no file change). No commit is never shown as a failure |
| Worktrees | Repository → branch / worktree → the agents working there, with `Open in Tern` when Tern is installed |
| Last 24 h | Swimlanes from first to last observed activity, with commit and test marks. Probe sessions under 3 minutes with no edit fold into one row |
| Verification | Every observed test or build command, with its result and whether the result comes from an exit code or a tool status |
| Activity | 7-day bars per provider, an hour × day heatmap of observed events, and the daily table |
| Providers | Detection, versions, sessions and diagnostics per provider, plus the observability matrix |

Lifecycle stages (start → edit → verify → commit → end) come only from observed facts. Tokens and context come from what the provider recorded: Claude `message.usage` (counted once per message id) and Codex `token_count`. Cost is shown only when the provider records it itself (Claude Code `cost-state`). Agent never prices tokens.

Agent stands alone. It needs no DataPass, Tern, Factory, MongoDB or cloud backend. When Tern is installed, `Open in Tern` calls `tern.revealWorktree`; otherwise the command is hidden.

## Observability matrix (Claude Code 2.1.289 CLI / 2.1.286 desktop; Codex CLI 0.160.0)

| Field | Claude Code | Codex |
|---|---|---|
| Session id | OBSERVED: transcript `sessionId` | OBSERVED: rollout `session_meta.id` |
| Provider version | OBSERVED: record `.version`, live registry `.version` | OBSERVED: `session_meta.cli_version` |
| Model / effort | OBSERVED: `message.model`, record `.effort` | OBSERVED: `turn_context.model` / `.effort` |
| cwd | OBSERVED: record `.cwd`, `worktree-state.worktreePath` | OBSERVED: `session_meta.cwd` |
| Branch | OBSERVED: record `.gitBranch`; else DERIVED from git | OBSERVED: `session_meta.git.branch` when present; else DERIVED |
| HEAD before | DERIVED: `git rev-list -1 --before=<start>` | OBSERVED: `session_meta.git.commit_hash` |
| HEAD after, commits, diff | DERIVED: git within the session window | DERIVED: git within the session window |
| Files edited | OBSERVED: Edit/Write/MultiEdit tool inputs | OBSERVED: `FileChange` items |
| Commands | OBSERVED: Bash/PowerShell tool inputs | OBSERVED: `CommandExecution` items |
| Test outcome | OBSERVED: tool result `is_error` (no exit code exposed) | OBSERVED: `exit_code` |
| Live status | OBSERVED: `~/.claude/sessions/<pid>.json` (`busy`/`idle`) plus a pid-alive check (INFERRED) | INFERRED: open turn (`task_started` without `task_complete`) plus recency; archived means ENDED |
| Parent / worker | OBSERVED: `<session>/subagents/agent-*.jsonl` and `.meta.json` | OBSERVED: `session_meta.parent_thread_id`, `agent_nickname`, `agent_path` |
| Tokens / context | OBSERVED: assistant `message.usage` (once per message id); window not recorded | OBSERVED: `event_msg.token_count` totals and `model_context_window` |
| Cost | OBSERVED: `cost-state.totalCostUSD`, computed by Claude Code | not recorded |
| Title | OBSERVED: `custom-title`, `ai-title`, registry name; else the first prompt (bounded to 80 chars, redacted) | OBSERVED: `session_index.jsonl` `thread_name`; else the first prompt (bounded, redacted) |

Anything not in the table shows as *not exposed*. Agent never invents model, effort, hierarchy or authorship.

## Live status derivation

| Status | Claude Code | Codex |
|---|---|---|
| RUNNING | registry `busy` and pid alive | open turn and a write within `agent.idleMinutes` (default 10) |
| IDLE | registry `idle` and pid alive | last turn completed within `agent.idleMinutes` |
| NEEDS INPUT | registry status mentioning wait/input/permission/approval | never: Codex does not expose it |
| ENDED | no registry entry and no activity for 2 min (the registry is removed when the process exits); subagent ended once the parent recorded its result | thread archived, or a `codex exec` run whose turn completed |
| UNKNOWN | unrecognised registry status, or activity without a registry entry yet | open turn with no recent writes (stalled or crashed?), or inactive with no end event |

"Ended without a commit" is shown as **Ended — no commit observed**, never as FAILED.

## Git correlation

Git runs read-only in the session's cwd: `rev-parse`, `status --porcelain -uno` (live sessions only), `rev-list`, `log`, and `diff --numstat`. Every call is hardened with `core.fsmonitor=false`, no external diff or textconv, no pager, no credential helper and `GIT_TERMINAL_PROMPT=0`, so a repository named by an artifact cannot run its own programs. Commits are labelled **observed during session**. **Session ran git commit** appears only when the provider recorded a `git commit` command. In untrusted workspaces Git correlation is off.

## Privacy and security

- Local only. No network calls, no telemetry, no transcript copies. Provider artifacts stay the authority; Agent holds an in-memory projection that it rebuilds on reload.
- Kept text is limited to titles and command lines, single-line, length-bounded and redacted (API keys, GitHub/GitLab/Slack tokens, JWTs, `Authorization`/`Bearer`, `*_TOKEN=`/`*_SECRET=`, URL credentials, private keys).
- Environment: Agent reads only `USERPROFILE`, `HOME`, `CODEX_HOME` and `CLAUDE_CONFIG_DIR`. Child processes (`git`, `claude --version`, `codex --version`) get a minimal environment with no tokens.
- Artifacts are opened read-only. A path that resolves outside the provider root (traversal, symlink, junction) is rejected. Paths read from artifacts must be plausible absolute local paths.
- Webviews use a strict CSP (`default-src 'none'`, nonce scripts, no remote origins). Every webview message is validated: known session keys and a fixed command allow-list.

## Refresh model and cost

- Recursive `fs.watch` on provider folders (debounced 1.5 s), plus a 20 s tick for time-based status. One refresh runs at a time; one more is queued.
- Each artifact has a byte cursor. A refresh reads only appended bytes, so a growing multi-MB log is never re-read. Records over 512 KB are skipped (timestamp only), and a truncated or replaced file is re-read from 0.
- History is bounded by `agent.historyDays` (default 3) and `agent.maxSessions` (default 300).
- Run `Agent: Show Diagnostics` for refresh timings and memory.

## Develop

```
npm ci
npm run check     # tsc --noEmit
npm test          # fixtures, git, security, perf (node --test)
npm run build     # esbuild → dist/extension.js
npm run package   # agent-vscode-0.2.0.vsix
npm run smoke     # installs the VSIX into an isolated VS Code profile, drives it with Playwright, takes screenshots
```

`node out-test/scripts/observe.js <days>` prints a headless, redacted observation of this machine's real sessions. `node out-test/scripts/preview.js <dir> [dark|light]` renders every workspace screen from real local data to static HTML for review (local files only).

## Future seams (not in this version)

Open, resume, stop and steer would be provider-native control adapters next to `src/providers/*`. Agent stays observation only.
