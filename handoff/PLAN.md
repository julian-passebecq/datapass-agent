# Agent — plan

State: 0.3.0 on `feat/agent-v01`, PR julian-passebecq/agent-vscode#1 open (merge = Julian's gate). Evidence `D:\PROJ\AGENT-V03-EVIDENCE`.
Rule for every package: observe only, local only, every value carries its evidence kind; no LLM judgement, no control of sessions.

## Idées de Julian (2026-10-05, via ACC 2: 5 screenshots)

| Idea | Fit for Agent | Decision |
|---|---|---|
| Week calendar of agent sessions + detail panel (outcome checks, commits, files) | strong: same data as "Last 24 h" | **P1** |
| LiteLLM Lens failure signals (unsolved, blocked, permissions, swallowed, looping, invented, unhappy, unsafe) | partial: only signals with an observable basis | **P2** (5 of 8) |
| Animated end-to-end flow with session log, step lighting, pause / speed / layout | adapted: replay of one session's real events | **P3** |
| "Beacon": one workspace for all repos (commits, PR checks, stash, merge) | Git product, not Agent | → **Tern** (Agent already links via Open in Tern) |
| Fabric tenant tree next to Claude Code | needs Fabric credentials and a tenant API; outside a local observer | → DataPass / X-Ray, not Agent |

## Packages (each ≤ 60 M, one coder subagent, different files)

**P1 · Week calendar** — `src/render/calendar.ts`, workspace view `week`.
Mon–Sun columns × hours, one block per session (first → last activity), colour = repo identity, provider border, live blocks pulse. Week ←/→ and Today. Clicking a block fills the side result card. Filter chips by repo / provider. Done: renders 7 days of real data; 1 test (block geometry across midnight); smoke screenshot dark + light.

**P2 · Failure-signal badges** — `src/activity/signals.ts`, badges on cards, Attention items, Inspector "Signals" section.
Only signals with a recorded basis:
- *unsolved*: ended, last test FAIL or edits with no commit (never called "failed");
- *blocked*: tool result error mentioning not found / missing / not installed;
- *permissions*: tool result denied / permission / approval rejected;
- *swallowed*: tool or test error followed by no retry of that command before the session ended;
- *looping*: same command (normalised) ≥ 4 times with no file change in between.
*invented*, *unhappy* and *unsafe* need judgement of the text: excluded.
Each badge names its basis and the event times. Done: unit tests per signal on fixtures, including no false positives on clean sessions.

**P3 · Session replay** — `src/render/replay.ts`, Inspector tab "Replay".
Left: the session log (real timeline events with t+offset). Centre: the session → workers → repo / worktree → tests / commits diagram, lighting each node as its event plays. Controls: play / pause, 1× / 4× / 16×, step. Pure client-side animation of already-rendered events; no new data. Done: replays a fixture session; respects reduced motion; smoke step.

**P4 · Agent topology** (idea: donvito "Agent Monitor" + orchestrator sidebar trees) — `src/render/topology.ts`, Team view toggle "Lanes | Tree". Real parent → worker → nested-worker tree (only recorded edges) as connected nodes, each with status, model, tokens, recorded cost and a rolled-up subtree total ("Done N / live N"). Done: renders the fixture tree and a 50-worker real lead without overlap; 1 rollup test.

### More ideas (2026-10-05, via ACC 2: agent kanban, project sidebar, reui DevOps blocks, Factory Log)

- **P5 · Review board** (agent kanban): Board columns Working / Needs you / In review / Ready to merge / CI failed, using PR + CI state read **opt-in** from the local `gh` / `glab` CLI (read-only, off by default, shows "provider state unavailable" when off).
- **P6 · Run strips** (cron-job runs): one row per repo, one tick per session over 14 days, coloured by observed outcome; click a tick to select the session.
- **P7 · Audit trail**: a chronological list of observed transitions (status changes, commits, test fails, workers started or ended), derived and rebuildable, with local JSONL export only.
- **P8 · Health tiles** (SLO / error-budget style): 7-day test pass rate, commits per session, and context use per live Codex session, each with a sparkline and its basis.
- **P9 · Project tree in the rail**: repo → live sessions under the screen list, with counts; click scopes every screen to that repo.
- Not for Agent: architecture map / code-path flow (Tern / Factory), firewall, canary deploys, connection-sync tiles (not agent observation).

### Last batch (2026-10-05, via ACC 2: Cezar cockpit, crawler visual, T3 orchestrator, context thread, calendar, Lens, kanban)

- Into **P1**: the 24 h / week bars end with a commit or PR chip (Cezar night timeline).
- Into **P4**: workers grouped under their lead, collapsed by default ("3 subagents · 3 done"), each with duration and a one-line result (the parent's recorded Agent tool result, cut to 120 characters and redacted) (T3 orchestrator).
- Into **P7**: the newest event flashes briefly in the live trail (crawler TL;DR feed).
- Into **P8**: a context bar marker at a configurable long-context threshold (default 272k), labelled as a setting, not a fact (Codex context thread).
- **P10 · PR stage**: the stage strip gains a "PR" step when the session ran `gh pr create` or `glab mr create` (Cezar autofix chain: verify → implement → review → PR).
- **P11 · Concurrency**: peak sessions running at once per hour over the last 24 h, against an optional `agent.parallelTarget`; "waiting for you" is counted separately from running (Cezar slots).
- Skipped: spider and crawler animation (decoration), queueing and dispatch of tasks (control, which Agent never does), the Chrome extension prompt.

### Final 3 (CodeAlta, remediation Sankey, trading dashboard)

- **P12 · Flow drill-down** (remediation Sankey): Flow gains a 4th column, verification (tests pass / fail / none); clicking a node or band filters a session table under the diagram.
- **P13 · Per-file changes** (CodeAlta "Modified files"): the Inspector lists files with +/− per file (git `diff --numstat` over the session window, live and recent sessions only).
- **P14 · Status strip** (trading dashboard footer): a thin bottom bar with last refresh ms, Git ms, bytes read, memory, and a ticker of live repos with their status dots.
- Into **P8**: compact context readout "17.5k / 272k · 6 %" in cards (CodeAlta status bar).
- Skipped: the Effect TS layer tree and AGENTS.md tweet (not UI), mermaid rendering and tabs (VS Code already has these), and the trading widgets themselves.

Order: P1 → P2 → P3 → P4 → P5–P14 (P5 is the only one that reaches the network, and only on opt-in) (P1 and P2 touch different files and can run in parallel).
