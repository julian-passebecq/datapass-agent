# AGENT v0.5 AUDIT & CONSOLIDATION REPORT

Agent (`agent-vscode`), release 0.7.0. Sources: audits A1-A6 (`AGENT-V04-EVIDENCE/audit/`), merged PRs #51-#68, `git log 3833276..eba8437`, README, `docs/ARCHITECTURE.md`, `docs/GALAXY.md`, `src/galaxy/*`, 0.6.0 `RESULT.md`. Audits ran on 0.6.0 (main 56b9f71). Numbers marked "PR-measured" are copied from the PR bodies (#58, #67), taken on a loaded host. Nothing was removed; every screen is kept.

## 1. Exact baseline

| Item | Baseline | Final |
|---|---|---|
| Repository | julian-passebecq/agent-vscode (private); checkout `D:\PROJ\datapass-agent\.claude\worktrees\agent-vscode-v01-d9ca29` | same, branch `release/0.7.0` |
| SHA | `3833276ac49a546d7af6bad827031def98172484` | main `eba8437` + version bump to 0.7.0 |
| Version | 0.5.0 | 0.7.0 (0.6.0 shipped in between, PR #54) |
| Tests | 254/254 | 375/375 locally on eba8437 |
| CI | run 37331851998 | green on merges. #53 was cancelled by a GitHub runner outage (0.6.0 RESULT). #62 repaired a red main after #55 x #61 |
| VSIX | n/a | `agent-vscode-0.7.0.vsix`, sha256 `2fc29469f942e5d13f5f0765dda448ddc351fc09afa580d12390cf7e362ccf6b` |
| Screens | n/a | 43 (10 core + 33 add-on), 12 commands in the 0.6.0 audit |
| Repo identity | `package.json` pointed at datapass-agent | agent-vscode (#57, metadata only). datapass-agent stays an open owner decision |

## 2. Product verdict

- Agent is a local, read-only observer of Claude Code and Codex sessions. It has no LLM, no writes to provider files and no auth-file reads. Network use is opt-in (gh / glab). Audits A2 and A4 found no auth-file read path.
- Every value carries an evidence kind (OBSERVED / DERIVED / INFERRED / UNKNOWN), and absence is never OBSERVED.
- The audit found places where this was broken: dispatch "99 % success", the test classifier, ENDED inferred as fact. #59, #61, #64, #65 and #68 fixed them.
- Weakness: breadth. 43 screens overlap (A1 matrix), and the menu is not yet grouped by the target grammar (section 13).
- It is an observability cockpit, not a harness. "Verified" now needs the worker's own passing test or own `git commit`.

## 3. Architecture verdict

| Verdict | Area | Evidence |
|---|---|---|
| Good | Artifacts -> adapters (byte cursor) -> accumulation -> store -> feeds -> pure transforms -> renderers -> hosts | `docs/ARCHITECTURE.md` (#57) |
| Good | One redaction layer `src/util/redact.ts`; CSP nonce-only scripts, `enableCommandUris:false`, `validateMessage` | A2 |
| Good | Process exec via `resolveExe`, no shell, timeouts, hardened git, opt-in network | A2 P2-12 |
| Weak, fixed | Git correlation redone every minute, no diff cache, all-or-nothing cold git | A5 -> #58 |
| Weak, fixed | Sync ingest blocked the host; whole history re-listed on idle | A5 -> #58, #67 |
| Weak, fixed | Evidence tags did not match their basis (usage, tests, ended, PR link, commits) | A3, A4 -> #59, #61, #64, #68 |
| Weak, fixed | Loading states that never resolve | A6 -> #60, #63 |
| Weak, remaining | git/gh feeds spawn independently (A5 P2-3); workflow rescan every 3 s (A5 P2-2); no shared toolbar (A6 P2-4) | section 13 |
| Weak, remaining | `CORE_GROUP` in `workspace.ts` still uses Now / Sessions / Time / Git / Usage / Quality / System, not the NOW / AGENTS / WORK / CHANGE / VERIFY / TIME / USAGE / SYSTEM grammar | A1 P1-2 |

## 4. Data and authority model

Source: `docs/ARCHITECTURE.md`.

| Authority | Owns | Agent's role |
|---|---|---|
| Provider (Claude Code, Codex) | sessions, transcripts, rollouts, live registry, usage, recorded cost, settings | reads only; no hooks, no auth files |
| Git | commits, branches, worktrees, diffs | hardened read-only commands. Commit attribution is "during session window" unless the session ran `git commit` itself (OBSERVED) |
| CI (GitHub, GitLab) | PR / MR, checks, pipelines | gh / glab only on opt-in (`agent.review.prState`, `agent.pipelines.enabled`) |
| Agent | in-memory projection, DERIVED / INFERRED values, UI state | rebuilds on reload; no control of sessions |
| Archive (`~/.agent/`) | what Agent saw on a given day | append-only per day, "as of" semantics. Raw transcript copies are opt-in and NOT redacted (#56, #66) |
| Galaxy | cross-app contracts | Agent proposes two contracts and writes no Mongo or Galaxy state |
| Harness (PM, watch.py, coders) | dispatch, merge, next package | out of scope. The only exception is Launcher, after modal confirm, in a trusted workspace (#56) |

Process exec exceptions (README "Processes and network"):
- git
- Catalog `claude --help` (default on)
- version probes (allow-list claude, codex, git, gh, glab, node, #66)
- opt-in gh / glab
- Launcher

## 5. Screen audit (43 screens)

O = OBSERVED, D = DERIVED, I = INFERRED. "ok" means no finding in A1-A6. Core-screen kinds come from A1. Add-on kinds come from the README.

| # | Screen | Group (code) | Purpose | Sources | Evidence | State |
|---|---|---|---|---|---|---|
| 1 | Overview | Now | Counts, live cards, attention, 24 h swimlanes | artifacts, git | O D I | KPI evidence titles partial (A6 P2-10); inferred end shown (#68) |
| 2 | Attention | Now | What needs me | artifacts | O D I | uses testVerdict (#64) |
| 3 | Board | Sessions | Sessions by status column | artifacts | O | clipping fixed (#60) |
| 4 | Team | Sessions | Lead and workers in lanes | artifacts | O D I | ok |
| 5 | Flow | Usage | Provider -> repo -> outcome Sankey | artifacts, git | O D | label collisions reduced (#60); tiny-repo merge open |
| 6 | Worktrees | Git | Repo -> branch -> agents | artifacts, git | O D I | ok |
| 7 | Last 24 h | Time | Swimlanes with commit/test marks | artifacts, git | O D I | ok |
| 8 | Verification | Quality | Every observed test/build with result | artifacts | O D I | classifier fixed (#61, #64); no paging (A6 P2-2) |
| 9 | Activity | Usage | 7-day bars, heatmap | artifacts | O D I | ok |
| 10 | Sources | System | Collector status, log storage | artifacts, git | O | Codex rollouts labelled undocumented (#59) |
| 11 | Panes | Now | 2-4 screens side by side | screens shown | as each pane | pane toolbars not compacted (A6 P2-8) |
| 12 | Live | Now | Live sessions, current tool, tokens/min | artifacts | O D I | provider facts (#65) |
| 13 | Session HUD | Now | Per-session terminal card | artifacts, feeds | O D I | "none observed" DERIVED, needs-input state, loading (#61, #65) |
| 14 | Workflows | Now | Workflow runs, background workers | workflow files, transcripts | O D I | async_launched fixed (#59); loading (#60); 3 s rescan open |
| 15 | Projects | Now | Scope setter | sessions, `agent.projects` | O D I | ok |
| 16 | Codex | Now | Codex app state | sqlite copy, read-only | O | temp swept (#66); loading (#63) |
| 17 | Roles | Sessions | Role per session, scorecard | sessions, titles | O D I | ok |
| 18 | Topology | Sessions | Lead/worker tree with roll-ups | artifacts | O D I | overlaps Team |
| 19 | Transcript | Sessions | One conversation, redacted | one transcript | O D I | JSON secrets redacted (#56); long picker (A6 P2-2) |
| 20 | Replay | Sessions | Step through one session | recorded events | O D I | Inspector button (#68) |
| 21 | Week | Time | Mon-Sun calendar | artifacts | O D I | empty day columns (A6 P2-5) |
| 22 | Run strips | Time | Repo x concurrency, 14 days | artifacts | O D I | ok |
| 23 | Forecast | Time | ETA from own history | local history | I | labelled INFERRED; loading (#60) |
| 24 | History | Time | Weeks side by side, archive | `~/.agent/history`, archive | D | "Status at capture" (#63) |
| 25 | Repositories | Git | Branches, worktrees, dirty state | git | O D | loading (#63) |
| 26 | Changes | Git | Per-file +/- per session | git, edit calls | O D | wrap fixed (#60); window caveat (#68) |
| 27 | Review | Git | PR/CI lanes | sessions, gh/glab opt-in | O D I | branch-only link INFERRED (#61) |
| 28 | Pipelines | Git | GitHub/GitLab runs and jobs | gh/glab opt-in | O D I | loading (#63) |
| 29 | Explore | Usage | Pivot sessions, CSV | loaded sessions | D | ok |
| 30 | Limits | Usage | Codex limits, Claude 5 h blocks | rollouts, tokens | O (Codex) / I (Claude) | labels verified correct (A3); empty Codex card (A6 P2-5) |
| 31 | Token rhythm | Usage | Tokens/min by provider, model, repo | usage records | O D | usage DERIVED sum + OBSERVED fields (#59) |
| 32 | Context cost | Usage | Tokens each tool adds to context | transcripts | chars O, tokens I | compaction/cache strip (#65) |
| 33 | Model benchmarks | Usage | Cost vs quality, local weekly DB | `~/.agent/benchmarks`, opt-in fetch | O public, D local | new in #55, 16 tests |
| 34 | Dispatches | Usage | Worker outcome and cost | spawn calls, sessions | O D I | rebuilt as verified / unverified / failed / unknown (#61) |
| 35 | Signals | Quality | Unsolved, blocked, looping | artifacts | O D I | testVerdict (#64) |
| 36 | Health | Quality | Pass rate, context use | artifacts | O D | glyph and colour issues open (A6) |
| 37 | Lifecycle ("Started") | Quality | Status and work-loop machines | snapshots, events | O D I | edges by weakest kind (#61) |
| 38 | Backlog | Quality | Plan items with linked sessions | plan files (read-only) | O D | loading (#63) |
| 39 | Scope map | Quality | Milestones, what is left | plan files, archive | O D | overlaps Backlog |
| 40 | Audit trail | System | Transitions, JSONL export | artifacts | O D I | export redacted (#56); status evidence (#64) |
| 41 | Catalog | System | Installed skills, agents, hooks, MCP | config files, `claude --help` | O D | exec default on, documented (#57) |
| 42 | Launcher | System | Start/resume a session in a terminal | allow-lists | O | EXPERIMENTAL label, trust gate (#56) |
| 43 | Settings | System | Effective config layers, redacted | settings files, config.toml | O | loading (#60) |

`test/xss.test.ts` (#66) renders every screen with hostile fields. Add-ons have `test/<id>.test.ts`.

## 6. Changes implemented (by PR)

| PR | Package | Files / features |
|---|---|---|
| #51 | Scope map | `scope` screen |
| #52 | Session HUD | `hud` screen, `src/activity/hud.ts` |
| #53 | Context cost | `ctxcost` screen |
| #54 | Version 0.6.0 | `package.json` |
| #55 | Model benchmarks | `benchmarks` screen, `scripts/benchmarks.ts`, `~/.agent/benchmarks/YYYY-Www.json`, `agent.benchmarks.dir`, `test/benchmarks.test.ts` (16) |
| #56 | Security (A2) | `src/util/redact.ts` (patterns, `redactDeep`, `isCredentialPath`), launcher trust gate, `ActCtx.openFile` credential guard, raw-archive setting text, `test/redact.test.ts`, `test/redact-launcher.test.ts` |
| #57 | Docs, IA, Galaxy (A1) | `README.md`, `docs/ARCHITECTURE.md`, `docs/GALAXY.md`, `src/galaxy/{index,observation,configSnapshot}.ts`, RAIL_ORDER and group tooltips in `workspace.ts`, `package.json` repo metadata, `handoff/PLAN.md`, NIGHT.md banner, `.github/workflows/release.yml` |
| #58 | Performance (A5) | `src/sessions/store.ts` (git change signals, time-sliced ingest, progressive git, snapshot reuse), `src/git/git.ts` (diffStat cache), `src/ui/workspace.ts` (idle render skip), `scripts/perf.ts`, `test/storePerf.test.ts` |
| #59 | Provider adapters (A4) | `claude.ts`, `codex.ts`, accumulator, model fields, `test/adapters.test.ts` |
| #60 | UX (A6) | `kit.loading()` / `kit.loadError()`, header filter, keyboard, `DIGIT_VIEWS`, narrow widths, contrast, 11 px floor, Board, Sankey labels, footer, smoke 700 px pass, `test/ux.test.ts` |
| #61 | Evidence grammar + Inspector | `classify.ts` (`checkKind`, `testVerdict`), dispatch four-state outcome, HUD `needs`, lifecycle edges, PR link INFERRED, Inspector State / Usage / Related |
| #62 | Test fix | benchmark fixture aligned with #61 |
| #63 | UX follow-up | `feeds.ts` restart after timeout, 7 screens on kit loading, History "Status at capture", `test/loading.test.ts` |
| #64 | Evidence follow-up | `TestObservation.kind`, flag-only chained/piped tests UNKNOWN, `testVerdict` in insights and signals, `statusEvidenceOf()`, `test/evidence.test.ts` |
| #65 | Provider facts on screens | HUD / Live / Transcript / Settings modes; Context cost / Health compaction and cache strip; `test/providerFacts.test.ts` |
| #66 | Security follow-up | raw-archive warning, atomic archive lock, versions allow-list, Codex temp sweep, `test/xss.test.ts`, `test/sec.test.ts` |
| #67 | I/O performance | `src/providers/discover.ts` `DirCache`, shared read buffer, chunked reads for files > 4 MB, Codex index byte cursor, `test/io.test.ts` |
| #68 | Wiring | `endInferred()`, commit caveat, `git n/N` strip, Inspector Replay / HUD buttons, `viewNeedsRender` for sidebars, ENDED-git pause while hidden, Esc clears selection, `test/wiring.test.ts` |

## 7. Correctness fixes (evidence classification)

| Finding | Before | After | PR |
|---|---|---|---|
| A3 P0-1 Dispatch "success 99 %" | success = ended and no failing last test; any window commit verified | `verified` (own passing test or own `git commit`), `finished, unverified`, `failed`, `unknown`. Window commits are INFERRED `≈n` | #61 |
| A3 P0-2 / A4 P1-3 Test classifier | regex on whole command, so `grep -rn tsc` and `git log --grep="npm test"` counted | command-position match with quotes masked; builds/lints get `kind`; chained/piped flag-only = UNKNOWN; TEST INFERRED unless the provider recorded an exit code | #61, #64, #59 |
| A4 P0-1 async_launched | background subagent shown as ended | ends on `<task-notification>`; final-turn rule INFERRED | #59 |
| A4 P0-2 usage OBSERVED | per-call sum re-counts cache reads | `usage` DERIVED, `usage.fields` OBSERVED, new cache fields | #59 |
| A3 P1-3 "none run" OBSERVED | absence tagged OBSERVED | "none observed", DERIVED | #61 |
| A3 P1-5 ENDED from registry absence | shown as "Ended" | "No longer active (inferred)", "inactive since", end time INFERRED | #61, #68 |
| A3 P1-6 Lifecycle | inferred edges look recorded | weakest-kind edges, dashed / dotted, legend | #61 |
| A3 P1-7 NEEDS_INPUT as idle | counted idle | `needs` state | #61 |
| A3 P1-8 Session-PR link | OBSERVED by branch name | INFERRED "linked by branch" | #61 |
| A3 P1-9 Commits as authorship | no caveat | caveat in Review, Inspector, cockpit, KPI | #61, #68 |
| A3 P1-10 Archived status | "Status" | "Status at capture" | #63 |
| A3 P2-12/13/14/16 | todos, CI fallback, spawn type OBSERVED; stale footnotes | DERIVED / INFERRED; footnotes match code | #61 |
| A3 P2-11 audit status | OBSERVED for any registry status | `statusEvidenceOf()` | #64 |
| A4 P1-4..10 | modes, pr-link, compaction, Codex tokens / modes / spawns dropped or duplicated | OBSERVED facts; calls INFERRED; compactions DERIVED; one spawn = one worker | #59, #65 |
| A4 P2-13/15 | alive check merged into status; undocumented label missing | `status` OBSERVED + `status.alive` INFERRED; "undocumented" labels added | #59 |

## 8. Security and privacy

| Finding | Fix | PR |
|---|---|---|
| A2 P0-1 JSON-quoted secrets | JSON, escaped-JSON and single-quote forms redacted | #56 |
| A2 P0-2 key-name list, headers | `*_KEY`, AccountKey, pwd, cookie, subscription key, secret headers | #56 |
| A2 P0-3 token formats | github_pat_, npm_, AIza, ya29., sk_live_, xapp-, ASIA, unlabelled AWS secret | #56 |
| A2 P0-4 `&key=` query secrets | redacted after `&` and `&amp;`; `?token=` no longer swallows the URL | #56 |
| A2 P0-5 `p@ss@host`, `mysql -p` | redacted to last `@`; mysql family only | #56 |
| PEM, structured data, export | multi-line and escaped PEM, `redactDeep`, final pass on transcript export, linear-time test on 1 MB | #56 |
| A2 P1-6 raw archive | setting text says NOT redacted (#56); one-time warning on enable (#66). chmod 600 not done | #56, #66 |
| A2 P1-7 Launcher | refuses start / resume in untrusted workspace; EXPERIMENTAL label | #56 |
| A2 P1-8 `openFile` | central guard refuses auth / credential files | #56 |
| A2 P1-9 XSS / CSP | render test with hostile fields on every screen. CSP still has `style-src 'unsafe-inline'` | #66 |
| A2 P2-12 version probe | allow-list claude, codex, git, gh, glab, node | #66 |
| A2 P2-13 Codex temp copies | own folder, deleted on deactivate, leftovers swept on start | #66 |
| A2 P2-14 archive lock race | atomic `wx` create, mtime stale check, atomic takeover, token-checked release | #66 |
| A2 P2-11, P2-15, P2-16 | no issue | n/a |

Not verified and not changed: whether gh / glab / CLI-catalog calls honour workspace trust (A2 P2-12).

## 9. Performance

Audit baseline on 0.6.0 (real history, ~700 MB, 193 sessions):
- Cold with git off: 9.3 s.
- Cold with git on: 20-45 s, 124 git spawns.
- Idle refresh: 1.6 s.
- Idle with nothing changed: 38 git processes per minute.
- Longest sync block: 502-686 ms per large artifact.

PR-measured before / after, same PC under load, noisy:

| Pass (real history) | Before | After | PR |
|---|---|---|---|
| git off cold | 17 260 ms, longest block 3 343 ms | 6 408 ms, longest 575 ms | #58 |
| git off idle / idle+1m | 801 / 628 ms | 265 / 269 ms | #58 |
| git on cold | 45 386 ms, first paint 14.5 s, longest 7 260 ms | 41 405 ms, first paint 7.2 s, longest 1 560 ms | #58 |
| git on idle | 5 189 ms, 9 spawns | 921 ms, 4 spawns | #58 |
| git on idle+1m, nothing changed | 5 240 ms, 9 spawns | 472 ms, 1 spawn | #58 |
| cold, git off (second run) | 20 355 ms, longest 1 572 ms | 11 348 ms, longest 783 ms | #67 |
| idle storeSync | 491 ms | 246 ms | #67 |
| Claude `listArtifacts`, warm | 264-339 ms | 186-228 ms, 0 readdir | #67 |

| Pass (synthetic, 100 sessions + 12 MB log) | Before | After | PR |
|---|---|---|---|
| git on cold | 7 113 ms, longest 2 104 ms | 2 144-2 678 ms, longest ~420 ms | #58 |
| git on idle / incremental | 609 ms / 2 937 ms | 16-18 ms / 19 ms, 0 spawns | #58 |
| git off cold, longest block | 922 ms | 40 ms | #67 |

Release-run numbers on eba8437: `npm run perf` on the 0.7.0 candidate, real history (186 sessions, 721 MB), two runs; run 1 ran right after the smoke on a loaded disk and is noisy, run 2 is the reference:

| Pass | 0.6.0 audit (A5) | 0.7.0 run 2 | 0.7.0 run 1 |
|---|---|---|---|
| git off cold | 9.3 s | 7.6 s, longest 780 ms | 31.5 s (cold disk) |
| git off idle | 1.6 s | 0.15 s | 6.0 s |
| git on cold | 20-45 s, 124 spawns | 19.6 s, first emit 6.6 s, 118 spawns, longest 2.8 s | 18.4 s, first emit 8.0 s, longest 0.6 s |
| git on idle / idle+1m | 38 git spawns per minute | 0.27 s / 0.25 s, **0 spawns** | 0.53 s / 0.37 s, 0 spawns |
| git on incremental (3 s) | n/a | 0.30 s | 0.34 s |

Logs: `perf.log`, `perf-run2.log`. A single 2.8 s synchronous block on the cold git-on pass (run 2 only) stays a P2.

Notes:
- The cold git phase is still about 34 s (PR-measured), now progressive and in the background.
- Idle still stats every artifact, about 190-230 ms.
- The 0.6.0 smoke "1.1 s median switch" came from navigation during initial discovery on a loaded host. Pure render of every screen is 5-115 ms (A5).

## 10. UX qualification

| Area | Result | PR |
|---|---|---|
| Loading | marker, elapsed seconds, 60 s note, Retry, error state; hung feed restarts | #60, #63 |
| Header | filter in the header flow, no longer covers the subtitle | #60 |
| Keyboard | all `[data-select]` focusable; j/k, Enter, Space; focus ring; digits 1-0 fixed to screens; Esc clears filter, then selection | #60, #68 |
| Narrow widths | no page overflow at 650 / 700 px on all screens with fixtures; smoke gains a 700 px pass | #60 |
| Light theme | foreground-derived colours, chip styles defined once, 11 px floor, reduced motion | #60 |
| Board, Flow, footer, Changes | clipping, label collision, truncation fixed | #60 |
| Inspector | State, Usage, Related; Replay / HUD buttons | #61, #68 |
| Still open | jump-to-screen picker, paging, shared toolbar, Panes compact mode, Health glyphs / colours, Flow tiny-repo merge, 600 / 900 px smoke, per-KPI evidence titles | section 13 |

Installed-VSIX smoke: PASS: **111 / 111 checks, 0 FAIL**, 43 screens in dark and light, 96 screenshots, installed `agent-vscode-0.7.0.vsix` in an isolated VS Code (Playwright `_electron`), then reload. Screen switch median 280 ms, max 1 066 ms. Activation 1.6-3.3 s; initial discovery 50-57 s (207 artifacts, 721 MB, git 28 s, in background). Note: Panes, Repositories and Audit were still showing their loading state after 20 s while initial discovery ran (they resolve later; not a failure). Log: `smoke.log`, `smoke-result.json`, `screenshots/`. For reference, 0.6.0 was 108 PASS / 0 FAIL over 42 screens in dark and light.

## 11. Provider qualification

### Claude Code

| Item | Status |
|---|---|
| Sources | transcripts, subagents, live registry, usage, cost-state; allow-listed fields; no auth file read |
| Background subagents | end on task notification, not on `async_launched` (#59) |
| Usage | DERIVED sum plus OBSERVED per-field values, 5 m / 1 h cache creation (#59) |
| Test outcome | test is INFERRED. Claude records no Bash exit code, so the outcome comes from `is_error`; interrupted or background = UNKNOWN (#59, #61) |
| Modes | dated `modeChanges` and `sessionMode` (#59), shown on HUD / Live (#65) |
| pr-link, queue, compact metadata | OBSERVED facts (#59) |
| Live status | registry busy/idle OBSERVED, pid alive INFERRED, split (#59) |
| Remaining | parent not always listed with its subagents under the scan cap (A4 P2-11, mitigated only); registry `statusUpdatedAt` unused |

### Codex

| Item | Status |
|---|---|
| Sources | rollouts, session index, sqlite app state (temp copy, read-only, whitelisted columns, swept by #66) |
| Usage | cache write and reasoning tokens kept; single source `token_count` (#59) |
| Modes | approval, sandbox and collaboration are separate facts; plan mode from collaboration mode (#59, #65). `permissionMode` stays as a legacy alias for approval |
| Spawns | three record forms linked into one worker (#59) |
| Compaction, calls | compactions DERIVED, calls INFERRED (#59) |
| Test outcome | OBSERVED with `exit_code`, else INFERRED (#59). Test records have no `kind` yet (not in #64) |
| Status | liveness INFERRED; inactive = UNKNOWN, not ENDED |
| Remaining | only 3 archived rollouts existed, so archive paths are weakly tested; `updated_at` of the index unused; record shapes are vendor-undocumented |

## 12. Galaxy alignment

| Item | State |
|---|---|
| Contracts | `galaxy.agent-observation/1` and `galaxy.agent-config-snapshot/1` had 0 hits in `galaxy.json` (A1 P1-8). They are proposals documented in `docs/GALAXY.md` (#57) |
| Code | pure projections in `src/galaxy/{index,observation,configSnapshot}.ts`: no I/O, no clock (caller passes `capturedAt`), no network, no Mongo |
| Privacy | no secrets, no free text, no absolute paths (folder name + 16-hex path hash); config snapshot has a content hash; absent = UNKNOWN |
| Wiring | not wired to any command. The optional `agent.exportGalaxy` from A1 was not built |
| Registration | the proposed `galaxy.json` app entry (id `agent`, repo julian-passebecq/agent-vscode, layer "observability, read-only", produces both contracts as planned, consumes none) is written up in `docs/GALAXY.md`. It is NOT registered and `galaxy.json` was not edited |
| Authority | Agent writes no Mongo or Galaxy state. Archive semantics stay "as of X" |

## 13. Remaining issues

No P0 remains. Some rows group several audit ids.

| Sev | Issue | Source |
|---|---|---|
| P1 | Rail groups not renamed to the NOW / AGENTS / WORK / CHANGE / VERIFY / TIME / USAGE / SYSTEM grammar (only tooltips added) | A1 P1-2 |
| P1 | Galaxy contracts not registered in `galaxy.json`; no export command | A1 P1-8 |
| P1 | No jump-to-screen picker; digits cover 10 of 43 screens | A1 P1-3, A6 P1-5 |
| P1 | CSP keeps `style-src 'unsafe-inline'`; XSS safety rests on `esc()` plus the render test | A2 P1-9 |
| P1 | Overlap badge for two sessions sharing a worktree window not done | A3 P1-9 |
| P2 | Cold git phase still about 34 s in the background; idle stats the whole history (PR-measured) | A5 P1-4 |
| P2 | git / gh feeds not behind one cached runner; workflow scan every 3 s | A5 P2-2, P2-3 |
| P2 | Whether gh / glab / catalog calls honour workspace trust: not verified | A2 P2-12 |
| P2 | chmod 600 on raw archive copies | A2 P1-6 |
| P2 | No "≥" on durations ending at last activity; alive-INFERRED suffix in `audit.ts` | A3 P2-11, P2-15 |
| P2 | Per-KPI evidence titles missing on Overview, Board, Week, Explore, Health | A6 P2-10 |
| P2 | No paging helper; toolbars inconsistent; Panes toolbars not compact; Health glyphs / colours; Flow tiny-repo merge; empty states in Week / History / Limits | A6 P2-2, 4, 5, 8, 11, P1-7c, P1-8 |
| P2 | Smoke lacks 600 / 900 px and Panes layouts | A6 P2-7, P2-8 |
| P2 | Parents not guaranteed listed with subagents under the scan cap | A4 P2-11 |
| P2 | Archive screen "captured at X" wording; Codex index `updated_at` unused | A4 P2-14 |
| P2 | `ran` verdict ("test ran, outcome not recorded") in `insights.ts` not explicitly claimed by #64 | A3 P1-4 |
| P2 | Codex test records have no `kind` | #64 |

Counts: P0 0, P1 5, P2 14 rows.

## 14. Menu recommendations

Nothing was removed; owner decides. Tiers combine A1, A3 and A6, and where they differ I took the more cautious one. Every one of the 43 screens appears exactly once.

| # | Screen | Tier | Reason |
|---|---|---|---|
| 1 | Overview | CORE | landing page |
| 2 | Attention | CORE | what needs me, each item names its basis |
| 3 | Live | CORE | unique: current tool and rate |
| 4 | Session HUD | CORE | one-session terminal view (A6 core, A1 secondary) |
| 5 | Last 24 h | CORE | main time view |
| 6 | Review | CORE | PR / CI lanes, INFERRED where linked by branch |
| 7 | Verification | CORE | do tests pass; classifier fixed |
| 8 | Worktrees | CORE | where agents work |
| 9 | Team | CORE | lead / worker structure |
| 10 | Projects | CORE | scope setter for all screens |
| 11 | Changes | CORE | what changed per session |
| 12 | Limits | CORE | quota; labels verified correct |
| 13 | Token rhythm | CORE | budget |
| 14 | Sources | CORE | collector status |
| 15 | Settings | CORE | effective config |
| 16 | Board | MERGE-CANDIDATE | subset of Live; could be a toggle |
| 17 | Topology | MERGE-CANDIDATE | same edges as Team |
| 18 | Run strips | MERGE-CANDIDATE | same sessions-over-time data as Last 24 h / Week |
| 19 | Activity | MERGE-CANDIDATE | TIME data sitting in Usage |
| 20 | Lifecycle ("Started") | MERGE-CANDIDATE | one-session time view next to Replay |
| 21 | Scope map | MERGE-CANDIDATE | parses the same plan files as Backlog |
| 22 | Workflows | SECONDARY | AGENTS family |
| 23 | Transcript | SECONDARY | unique, redacted |
| 24 | Replay | SECONDARY | one-session step-through |
| 25 | Week | SECONDARY | calendar view |
| 26 | Repositories | SECONDARY | overlaps Worktrees |
| 27 | Signals | SECONDARY | full list behind Attention |
| 28 | Health | SECONDARY | pass rate, context use |
| 29 | Backlog | SECONDARY | plan items with linked sessions |
| 30 | Context cost | SECONDARY | useful, but tokens are chars / 4 INFERRED |
| 31 | Flow | SECONDARY | mis-grouped; fits WORK |
| 32 | Model benchmarks | SECONDARY | new; mixes public and local data |
| 33 | Panes | ADVANCED | meta screen |
| 34 | Codex | ADVANCED | undocumented source, labelled |
| 35 | Roles | ADVANCED | pattern-based role mapping |
| 36 | Dispatches | ADVANCED | belongs to AGENTS; price table is a setting; stricter after #61 |
| 37 | History | ADVANCED | archive weeks; needs the weekly job |
| 38 | Explore | ADVANCED | pivot tool |
| 39 | Pipelines | ADVANCED | opt-in network |
| 40 | Audit trail | ADVANCED | export and transitions |
| 41 | Catalog | ADVANCED | process exec, default on |
| 42 | Forecast | EXPERIMENTAL | ETA is INFERRED from own history |
| 43 | Launcher | EXPERIMENTAL | only screen that starts provider sessions; conflicts with "not a harness" |

Count: CORE 15, MERGE-CANDIDATE 6, SECONDARY 11, ADVANCED 9, EXPERIMENTAL 2, total 43.

## 15. Release evidence

| Item | Value |
|---|---|
| Baseline | 3833276, 0.5.0, CI run 37331851998, 254/254 |
| Final | eba8437 + 0.7.0 bump, 375/375 local |
| VSIX | `agent-vscode-0.7.0.vsix`, sha256 `2fc29469f942e5d13f5f0765dda448ddc351fc09afa580d12390cf7e362ccf6b` |
| Commits | 18 in `git log --oneline 3833276..eba8437` (PRs #51-#68) |
| Release gate | `.github/workflows/release.yml` (#57): npm ci, check, test, build, package, VSIX hash, installed-VSIX smoke, artifacts |
| Installed-VSIX smoke | PASS 111/111, see section 10 |
| Perf run | see section 9 (perf.log, perf-run2.log) |
| Test caveat | one catalog timing test is load-sensitive (#64, #68 bodies); it passes alone |

## 16. Verdict

**PASS WITH NON-BLOCKING LIMITATIONS**

0 P0. All audit P0s fixed and merged with green CI; 375/375 tests; installed-VSIX smoke 111/111; idle cost down from 1.6 s and 38 git spawns/min to ~0.2 s and 0 spawns. Non-blocking limitations: the 5 P1s in section 13 (rail grammar rename, Galaxy registration, jump-to-screen picker, CSP `unsafe-inline` styles, worktree-overlap badge), cold start still ~20 s with git in the background, and some screens show loading during the first ~50 s. Version 0.7.0 (not 1.0). Nothing was removed; the owner decides tiers from section 14.
