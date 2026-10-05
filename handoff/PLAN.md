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

Order: P1 → P2 → P3 (P1 and P2 touch different files and can run in parallel).
