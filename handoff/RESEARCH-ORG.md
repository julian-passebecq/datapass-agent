# RESEARCH-ORG: how people organise and visualise multi-agent coding (5 Oct 2026)

Scope note: Reddit and X were not reachable by the search tool (no thread found or quoted, nothing invented). Evidence is GitHub issues/repos and 2026 comparison blogs. "Praised" = how the source describes it, not measured popularity.

## 1. Patterns seen

| # | Pattern | What it shows | Source |
|---|---|---|---|
| P1 | Agent tree + status icons | Main agent and spawned subagents, icons running/waiting/done/failed/pending, elapsed time; beside it a task checklist and stats (context %, tokens, cost, compactions) and an activity stream. Proposed as a 3-column layout; modelled on k9s/tmux. Issue lists 20+ related requests; "tree view" is the most asked. | [claude-code #24537](https://github.com/anthropics/claude-code/issues/24537) |
| P2 | Parent/child hierarchy from hooks | Which subagent was spawned by which parent; timeline icons jump to events; filter by agent/tool; session replay; token and cost breakdown per session. | [agents-observe](https://github.com/simple10/agents-observe) |
| P3 | Swimlane timeline (Gantt) | Canvas horizontal lanes per agent, zoom/pan; plus $/min burn rate and per-agent file heatmap (proposal). | [#24537](https://github.com/anthropics/claude-code/issues/24537) |
| P4 | Kanban of agent work | Columns of issues; each card is an isolated workspace with agent, diff and preview. Described as "purest board-first workflow". Project now community-maintained. | [Nimbalyst review](https://nimbalyst.com/blog/best-agent-management-tools-2026/), [Vibe Kanban review](https://vibecodinghub.org/tools/vibe-kanban) |
| P5 | Sidebar of worktrees + diff/PR review | One worktree per agent, list on the left, detail and diff on the right; praised as clean and low overhead (Conductor); Crystal adds run comparison. | [Nimbalyst](https://nimbalyst.com/blog/best-agent-management-tools-2026/), [Augment list](https://www.augmentcode.com/tools/open-source-agent-orchestrators) |
| P6 | tmux TUI session list | Text list of parallel agents (Claude Squad), agent-agnostic (Codex, Aider). | [Nimbalyst](https://nimbalyst.com/blog/best-agent-management-tools-2026/) |
| P7 | Queen/worker topology | Hierarchical tree: queen on top, specialised agents (A1-A3) then sub-workers (A4-A6); mesh/adaptive variants. Mostly a config diagram, not live telemetry. | [ruflo Hive Mind](https://github.com/ruvnet/ruflo/wiki/Hive-Mind-Intelligence) |
| P8 | Read-only renderer | Scope "doesn't orchestrate, it renders": state in `.scope/sessions/`, live dashboard with attach/steer/abort. Closest to our observer stance. | [adagradschool/scope](https://github.com/adagradschool/scope) |
| P9 | Handoff / lifecycle trace | Task handoffs, tool failures, permission requests, subagent start/stop, compaction events across concurrent sessions. | [multi-agent-observability](https://github.com/jaydubya818/multi-agent-observability) |
| P10 | Rich terminal swarm UI | Decompose task, coordinate agents, "visualize everything" in a TUI. | [claude-swarm](https://github.com/affaan-m/claude-swarm) |
| P11 | Named workspaces + self-updating dashboard | Orchestrator workspace plus isolated feature workspaces; dashboard generated from per-workspace session files (Obsidian Bases). | [artemxtech](https://artemxtech.substack.com/p/how-i-manage-10-claude-code-agents) |
| P12 | Attention / mobile oversight | Native notifications for done/failed/needs approval; iOS app for oversight (Nimbalyst); approval workflows (Sculptor). | [#24537](https://github.com/anthropics/claude-code/issues/24537), [Nimbalyst](https://nimbalyst.com/blog/best-agent-management-tools-2026/) |

Not found with evidence: success rate per role (no source shows it; treat as our own idea). Terragon, Omnara, OpenHands, Codex cloud tasks: not covered by fetched sources, left unsourced.

Recurring gap: users say first-party data is missing (agent_id in hook payloads, 19 upvotes [#7881](https://github.com/anthropics/claude-code/issues/7881); per-subagent tokens [#22625](https://github.com/anthropics/claude-code/issues/22625)). Most tools need hooks; a file-only observer is therefore differentiating.

## 2. What a local read-only observer can derive (our inference, to verify against our parsers)

| Pattern | Derivable from local files | Weak point |
|---|---|---|
| P1/P7 tree | Task/Agent tool_use `subagent_type` + sidechain transcripts linked to parent session; session titles ("PM", "coder") for top-level roles | Roles for top-level sessions rely on title/Team-table convention |
| P3 swimlanes | Event timestamps per session/sidechain; workflow phase start/stop | Idle vs thinking not distinguishable |
| P4/P5 board/review | Our PLAN/Team rows, branch and MR names from git/gh | Needs repo read, not only Claude files |
| P2/P9 cost | usage fields per message, summed per sidechain = per-role cost | Per-subagent attribution depends on transcript linkage (see #22625) |
| P12 attention | Last event is a pending tool_use or question; no event for N min | Heuristic |
| Success rate | Role runs ending with merged MR vs retries (same fix twice) | Needs MR join; unvalidated |

## 3. Screen ideas for Agent (we have Topology, Team lanes, Workflows+Gantt, Live, Forecast, Board, Review)

1. **Attention queue** (P12): one list of sessions needing a human (pending approval, stalled over N min, red CI), sorted by age, click opens the session. Extends Live.
2. **Role cost table** (P1/P2): per role (PM, coder, architect, debug) tokens, $ , runs, median duration; sparkline per day. Extends Forecast.
3. **Topology with live status** (P1): add status icons, elapsed time and context % per node, collapsible subagent children; click jumps to Gantt lane.
4. **Wave Gantt with role colours** (P3): group lanes by wave/package, colour by role, mark merge and CI events; tie to the "waves" language of our rules.
5. **Handoff graph** (P9): arrows PM to coder to MR to merge, from Team rows and inbox lines; shows who is waiting on whom and chip waves.
6. **File-overlap heatmap** (P3): files touched per concurrent agent from tool_use paths; flags two lanes touching the same file (our "packages touch different files" rule).
7. **Role scorecard** (success rate, our idea): per role, packages merged first try vs retries or hand-offs; flagged "unvalidated" until joined to MR data.
8. **Replay scrubber per wave** (P2): extend existing replay to a whole wave, lanes light up in time order, with filters by role and tool.
