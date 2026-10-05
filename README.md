# Agent — local observer for Claude Code and Codex

Agent answers one question inside VS Code: **what are my coding agents doing, where, and what did they actually change?**

It **observes** provider-native sessions. It does not launch, schedule, steer, stop or route agents, and it adds no hooks to the providers.

- **Cockpit**: live sessions per provider, ended today, recent sessions.
- **Sessions**: tree grouped by provider, with workers nested under their parent where the provider exposes the link.
- **Timeline**: one chronological view of session start, commands, file changes, tests, commits, workers and end.
- **Activity**: a 7-day factual rollup (sessions, observed duration, commits, files, tests, repos) plus a session graph. There is no productivity score.
- **Inspector**: a result card (duration, model, HEAD before → after, commits, files, lines, tests, tokens, recorded cost, context), then status, location, change, verification, activity, and the evidence behind each field.

### Agent Workspace (`Agent: Open Workspace`, or the button in the Cockpit)

One editor panel: a navigation rail, the main surface, and a result card for the selected session on the right. Click selects; double-click or Enter opens the Inspector. Keyboard: `1`–`0` switch screens, `j`/`k` or arrows move the selection, Enter inspects, `/` filters sessions on the current screen, Esc clears, `r` refreshes. The rail shows a collector summary (for example *9 ready · 1 partial*).

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
| Sources | Collectors (Claude transcripts, subagents, live registry, usage; Codex rollouts, archive, titles, live status, usage; Git) each marked ready / partial / missing / off with the reason and collection time; provider log storage with the largest sessions (read-only, Reveal only); providers and the observability matrix |

Lifecycle stages (start → edit → verify → commit → end) come only from observed facts. Tokens and context come from what the provider recorded: Claude `message.usage` (counted once per message id) and Codex `token_count`. Cost is shown only when the provider records it itself (Claude Code `cost-state`). Agent never prices tokens.

Agent stands alone. It needs no DataPass, Tern, Factory, MongoDB or cloud backend. When Tern is installed, `Open in Tern` calls `tern.revealWorktree`; otherwise the command is hidden.

## Screens

Add-on screens sit in the rail under group headings. Every value shows its evidence kind (OBSERVED, DERIVED, INFERRED, UNKNOWN) in a tooltip or legend. "Git" means read-only hardened git in repositories the agents used. "gh / glab" means the GitHub / GitLab CLI, run only when the opt-in setting is on and the workspace is trusted. Nothing else starts a process or uses the network.

| Group | Screen | What it shows | Source | Evidence | Git | gh / glab |
|---|---|---|---|---|---|---|
| Now | Live | Every live session and worker: current tool, tokens per minute, pace | provider artifacts | OBSERVED, DERIVED, INFERRED | no | no |
| Now | Workflows | Claude Code workflow runs: phases, agents, model, time, tokens; background subagents and Codex workers | workflow files, transcripts | OBSERVED, DERIVED, INFERRED | no | no |
| Now | Projects | Company, project, repository, sessions tree; click sets the scope for every screen | sessions + `agent.projects` | OBSERVED, DERIVED, INFERRED | no | no |
| Sessions | Topology | Lead, workers and nested workers as a tree with rolled-up tokens, cost, time | provider artifacts | OBSERVED, DERIVED, INFERRED | no | no |
| Sessions | Transcript | One session as a conversation (prompts, replies, tool calls), redacted | one transcript / rollout, read on demand | OBSERVED, DERIVED, INFERRED | no | no |
| Sessions | Replay | Step through one session's events with play, pause, speed | recorded events | OBSERVED, DERIVED, INFERRED | no | no |
| Time | Week | Sessions on a Monday to Sunday calendar | provider artifacts | OBSERVED, DERIVED, INFERRED | no | no |
| Time | Run strips | One row per repository over 14 days, concurrency per hour against `agent.parallelTarget` | provider artifacts | OBSERVED, DERIVED, INFERRED | no | no |
| Time | Forecast | Gantt of running work with end times projected from your own history (median and quartiles, sample size shown) | local history | INFERRED from OBSERVED durations | no | no |
| Time | History | Weeks side by side from the weekly archive | `~/.agent/history` | DERIVED | no | no |
| Git | Repositories | Branches, worktrees, dirty state, ahead / behind, recent commits | git | OBSERVED, DERIVED | yes | no |
| Git | Changes | Per-file +/- over each session's commit window, uncommitted work per worktree, edit heat | git, edit calls | OBSERVED, DERIVED | yes | no |
| Git | Review | Working / Needs you / In review / Ready to merge / CI failed lanes | sessions, recorded commands, PR / MR state | OBSERVED, DERIVED, INFERRED | no | yes, opt-in network (`agent.review.prState`) |
| Git | Pipelines | GitHub Actions and GitLab runs, jobs as a Gantt, what blocks, runner | gh / glab | OBSERVED, DERIVED, INFERRED | no | yes, opt-in network (`agent.pipelines.enabled`) |
| Usage | Explore | Pivot sessions by dimension and metric as bars, table, treemap, heatmap or line; CSV export | loaded sessions | DERIVED | no | no |
| Usage | Token rhythm | Tokens per minute, hour or day by provider, model, repo or session; peaks, context growth | provider usage records | OBSERVED, DERIVED | no | no |
| Quality | Signals | Unsolved, blocked, permissions, swallowed, looping, each with its basis | provider artifacts | OBSERVED, DERIVED, INFERRED | no | no |
| Quality | Health | Test pass rate, commits per session, context use against a reference window | provider artifacts | OBSERVED, DERIVED | no | no |
| Quality | Backlog | Packages and checklist items from `handoff/PLAN.md`, `ROADMAP.md`, `TODO.md` with the sessions that mention them | plan files (read-only, size cap) | OBSERVED, DERIVED, INFERRED | no | no |
| System | Audit trail | Observed transitions, filters, local JSONL export | provider artifacts | OBSERVED, DERIVED, INFERRED | no | no |
| System | Settings | Effective Claude Code and Codex configuration layers, agents, hooks (read-only, redacted) | settings files, `config.toml` | OBSERVED | no | no |

The Launcher screen is not enabled in this version.

### Multiple tabs and project scope

`Agent: Open Workspace in New Tab` (or `+ tab` in the rail) opens another workspace panel with its own screen, selection, filters and scope. Pick a project in **Projects** to set a scope: every screen then shows only that repository's sessions. The scope appears next to the screen title; click it to clear. `Open in new tab` on a project opens the tab already scoped.

Map sessions to company and project with `agent.projects`. A rule's `match` is a path prefix, a glob (`*`, `?`, `**`) or a bare repository folder name. The most specific rule wins. Unmatched sessions are inferred from the path.

## Weekly history

```
npm run weekly
```

This reads all local Claude Code and Codex history (archived Codex sessions included) and merges it into `~/.agent/history/YYYY-Www.json`, plus a markdown audit report `YYYY-Www.md` per week. It stores counts, tokens, repositories, models and outcomes. **No prompt, title or command text is stored.** Weeks already archived are kept after the provider deletes its logs.

Options (after `--`, for example `npm run weekly -- --dry`): `--out <dir>` archive folder, `--days <n>` days to scan (default 3650), `--no-git` skip git correlation (commits are then not counted), `--max <n>` most artifacts per provider, `--dry` compute and print only.

The History screen reads that folder (`agent.history.dir`, `agent.history.maxWeeks`) and can build it with *Build now*.

Windows Task Scheduler, every Monday 08:00 (run `npm run compile-tests` once in the checkout first, so `out-test` exists):

```
schtasks /Create /SC WEEKLY /D MON /ST 08:00 /TN "Agent weekly history" /TR "node <checkout>\out-test\scripts\weekly.js"
```

## Daily archive (nothing disappears)

Claude Code deletes transcripts older than `cleanupPeriodDays` (default 30) and Codex rotates its data, so Agent keeps its own durable archive:

```
npm run archive
```

It reads all local Claude Code and Codex history still on disk (subagents, Codex archived sessions, workflow runs) and the plan files of the repositories agents used, then writes `~/.agent/archive/` (setting `agent.archive.dir`):

- `sessions/YYYY/MM/YYYY-MM-DD.jsonl`: one line per session archived or changed that day (every snapshot field, facts, tests, commits, up to 2000 timeline events, redacted). Re-running the same day replaces that session's line; lines of earlier days stay forever, even after the provider deleted the transcript. **No prompt or reply text**; a title is kept only when the provider named the session.
- `backlog/YYYY-MM-DD.json`: plan items seen that day, so closed or removed items stay visible.
- `workflows/YYYY-MM-DD.jsonl`: workflow run summaries (phases, agents, status, tokens; no agent results).
- `index.json`: session → first / last archived day.
- `raw/` (opt-in: `--raw` or `agent.archive.rawTranscripts`, capped by `agent.archive.rawMaxGB`, default 5 GB): gzip copies of transcripts / rollouts. These hold the full conversation text, locally. Auth and secret files are never copied.

Provider files are only read; writes go through a temp file + rename under the archive folder, with a lock file, so it is safe while Claude or Codex run. Options (after `--`): `--out <dir>`, `--days <n>`, `--no-git`, `--no-backlog`, `--raw`, `--raw-max-gb <n>`, `--settings <settings.json>`, `--dry`. The script reads only the `agent.archive.*` keys of your VS Code user settings.

History and Backlog have a toggle (*+ Archive* / *+ Daily archive*) that adds sessions and items known only from the archive, tagged ARCHIVED with the archive day (OBSERVED on that day).

Schedule it daily at 03:17 (Windows Task Scheduler, current user, no admin). Run this yourself once, from the checkout:

```
powershell -ExecutionPolicy Bypass -File scripts\install-archive-task.ps1
```

It compiles `out-test` and registers the task "Agent daily archive" with the `node` on your PATH (`-Raw` adds `--raw`, `-Time 03:17` changes the hour, `-Uninstall` removes it). Check it with `schtasks /Query /TN "Agent daily archive"`.

To make Claude Code itself keep transcripts longer, raise `cleanupPeriodDays` in `~/.claude/settings.json` (for example `"cleanupPeriodDays": 365`); the default is 30 days.

## Settings

Defined in `package.json`. Commands are in the Command Palette under "Agent:".

| Setting | Type | Default | Meaning |
|---|---|---|---|
| `agent.historyDays` | number | `3` | How many days of provider session history to load. |
| `agent.maxSessions` | number | `300` | Upper bound on session artifacts ingested. |
| `agent.claude.enabled` | boolean | `true` | Observe Claude Code sessions (~/.claude). |
| `agent.codex.enabled` | boolean | `true` | Observe Codex sessions (~/.codex). |
| `agent.idleMinutes` | number | `10` | Minutes without activity before an open session is shown as IDLE rather than RUNNING (Codex). |
| `agent.idleAlertMinutes` | number | `30` | Minutes an IDLE session waits before it appears in the Attention queue. |
| `agent.projects` | list | `[]` | Maps sessions to company / project for the Projects screen. match is a path prefix, a glob (* ? **) or a bare repository folder name; the most specific rule wins. Unmatched sessions are inferred from the path. |
| `agent.repos.maxRepos` | number | `20` | Repositories screen: most repositories read (live first, then most recent session activity). |
| `agent.repos.maxWorktrees` | number | `24` | Repositories screen: most worktrees per repository whose git status is read (worktrees with live sessions first). |
| `agent.repos.commits` | number | `8` | Repositories screen: recent commits listed per repository (0 = off). |
| `agent.repos.untracked` | boolean | `true` | Repositories screen: count untracked files (false is faster). |
| `agent.repos.extra` | list | `[]` | Repositories screen: extra repository paths always shown, even without a session. |
| `agent.settings.extraRoots` | list | `[]` | Settings screen: extra folders scanned for .claude/settings*.json, agents, skills and CLAUDE.md. |
| `agent.settings.maxRepos` | number | `40` | Settings screen: most repositories (most recent first) read for project settings layers. |
| `agent.settings.managed` | boolean | `true` | Settings screen: also read the machine managed-settings.json (admin policy layer) if present. |
| `agent.transcript.maxBytes` | number | `5242880` | Transcript screen: bytes read from the end of a transcript. |
| `agent.transcript.maxRecords` | number | `2000` | Transcript screen: most conversation entries kept per transcript (oldest dropped first). |
| `agent.transcript.pageSize` | number | `150` | Transcript screen: entries per page. |
| `agent.parallelTarget` | number | `0` | Target number of agents running at once: draws a target line on concurrency charts (0 = no target). |
| `agent.health.contextWindow` | number | `272000` | Reference context window and marker line; used as the window when the provider records none (Claude Code). A setting, not a fact. |
| `agent.health.warnPercent` | number | `80` | Context % at which bars, KPIs and badges turn red. |
| `agent.backlog.extraRoots` | list | `[]` | Backlog screen: extra folders scanned for plan files besides the repositories agents used. |
| `agent.backlog.maxRepos` | number | `40` | Backlog screen: most recent repositories scanned. |
| `agent.backlog.maxKB` | number | `200` | Backlog screen: plan files larger than this (KB) are skipped and listed. |
| `agent.backlog.archive` | boolean | `true` | Backlog screen: also read handoff/archive/*.md for the weekly archive. |
| `agent.review.prState` | boolean | `false` | Review screen: read PR / MR, CI and review state with gh / glab (read-only, network). Off: lanes from sessions and recorded commands only. |
| `agent.review.maxRepos` | number | `12` | Review screen: repositories queried (most recent first). |
| `agent.review.limit` | number | `30` | Review screen: PRs / MRs listed per remote. |
| `agent.changes.maxSessions` | number | `60` | Changes screen: most recent sessions whose commit window gets a git diff --numstat. |
| `agent.changes.maxWorktrees` | number | `16` | Changes screen: worktrees inspected for uncommitted work. |
| `agent.changes.worktreeHours` | number | `24` | Changes screen: inspect a worktree if a session there is live or was active within this many hours. |
| `agent.changes.untracked` | boolean | `true` | Changes screen: count untracked files. |
| `agent.pipelines.enabled` | boolean | `false` | Pipelines screen: read GitHub Actions / GitLab CI through the gh / glab CLIs (read-only, network). Off by default. |
| `agent.pipelines.maxRepos` | number | `12` | Pipelines screen: most recently used agent repositories checked. |
| `agent.pipelines.runsPerRepo` | number | `20` | Pipelines screen: runs listed per remote. |
| `agent.pipelines.jobRuns` | number | `4` | Pipelines screen: runs per remote whose jobs are loaded (active first, then newest, then latest failures). |
| `agent.pipelines.gitlabHosts` | list | `[]` | Pipelines screen: extra self-managed GitLab host names. |
| `agent.pipelines.extraRepos` | list | `[]` | Pipelines screen: extra local repository paths to include. |
| `agent.history.dir` | string | `""` | History screen: folder holding the weekly archive (empty = ~/.agent/history). Written by npm run weekly or the screen's Build now. |
| `agent.history.maxWeeks` | number | `52` | History screen: how many of the newest week files are read. |
| `agent.archive.dir` | string | `""` | Daily archive folder (empty = ~/.agent/archive). Written by npm run archive; read by the History and Backlog screens. |
| `agent.archive.maxDays` | number | `400` | History / Backlog screens: how many of the newest daily archive files are read. |
| `agent.archive.rawTranscripts` | boolean | `false` | Daily archive: also keep gzip copies of transcripts and rollouts in <archive>/raw (full text, local only; auth / secret files never copied). |
| `agent.archive.rawMaxGB` | number | `5` | Daily archive: size cap of the raw copies, in GB. |

## No AI

Agent uses no LLM. Every number is read from a provider artifact or computed by a fixed rule from those artifacts. Estimates (Forecast) are medians of your own past durations, labelled INFERRED with their basis. Nothing leaves the machine, except the read-only `gh` / `glab` calls you turn on yourself in Review and Pipelines.

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

Git runs read-only in the session's cwd (and, for Repositories and Changes, in the repositories agents used): `rev-parse`, `status --porcelain -uno` (live sessions only), `rev-list`, `log`, and `diff --numstat`. Every call is hardened with `core.fsmonitor=false`, no external diff or textconv, no pager, no credential helper and `GIT_TERMINAL_PROMPT=0`, so a repository named by an artifact cannot run its own programs. Commits are labelled **observed during session**. **Session ran git commit** appears only when the provider recorded a `git commit` command. In untrusted workspaces Git correlation is off.

## Privacy and security

- Local only. No telemetry, no transcript copies. The only network use is the opt-in read-only `gh` / `glab` calls of Review and Pipelines (both off by default). Provider artifacts stay the authority; Agent holds an in-memory projection that it rebuilds on reload.
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
npm run package   # agent-vscode-0.4.0.vsix
npm run smoke     # installs the VSIX into an isolated VS Code profile, drives it with Playwright, takes screenshots
```

`node out-test/scripts/observe.js <days>` prints a headless, redacted observation of this machine's real sessions. `node out-test/scripts/preview.js <dir> [dark|light]` renders every workspace screen from real local data to static HTML for review (local files only).

## Future seams (not in this version)

Open, resume, stop and steer would be provider-native control adapters next to `src/providers/*`. Agent stays observation only.
