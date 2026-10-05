# RESEARCH-WEB: what to extract from Claude Code / Codex local data (2026-10-05)

Limits: WebSearch snippets only, mostly GitHub and blogs. Reddit and X returned almost nothing directly (one X post found); user-praise claims below come from tool READMEs, not threads. Table schemas: unknown (not verified, read a real file before coding).

## 1. Data sources

| Path | Holds | Stability | Source |
|---|---|---|---|
| `~/.claude/projects/<proj>/<session>.jsonl` | every message, tool call, result; big outputs, subagent transcripts, file history spill to side folders; purged after `cleanupPeriodDays` (30) | Plain JSONL, de facto stable (ccusage and others parse it) | [ghinda](https://allaboutcoding.ghinda.com/where-ai-coding-clis-store-session-logs/), [ccusage](https://github.com/ryoppippi/ccusage) |
| `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` | record types session_meta, event_msg (incl. TokenCount), response_item, turn_context, compacted; may be zstd-compressed | Undocumented, changes between versions | [ghinda](https://allaboutcoding.ghinda.com/where-ai-coding-clis-store-session-logs/), [Vaughan](https://codex.danielvaughan.com/2026/06/08/codex-cli-session-lifecycle-archive-resume-fork-rollout-persistence-management/), [DeepWiki](https://deepwiki.com/openai/codex/3.5.2-rollout-persistence-and-replay) |
| Codex `token_count` events | `rate_limits`: primary/secondary `used_percent`, window minutes (300 = 5 h, 10080 = week), `resets_at`, `plan_type` | Window layout changed over time (older: 300+10080, newer: weekly only) | [tokenatlas #89](https://github.com/Magnus-Gille/tokenatlas/issues/89), [pravrudhi PR](https://github.com/AxisMeru/pravrudhi/pull/218) |
| `~/.codex/state_5.sqlite` (number = migration) | `threads` table: cwd, git branch, origin URL, first message, model_provider, archived flag; metadata index, rollout is source of truth | Versioned filename; bugs show it can be blank or malformed | [X: life of a codex conversation](https://x.com/alxfazio/article/2081415650912727439), [#29083](https://github.com/openai/codex/issues/29083), [#23247](https://github.com/openai/codex/issues/23247) |
| `logs_2.sqlite` | trace logs, huge WAL writes (37 TB in 21 days reported); skip it | Internal | [lilting](https://lilting.ch/en/articles/codex-sqlite-log-ssd-writes) |
| `goals_1.sqlite` | one current goal per thread: objective, status, token budget | Recent, schema moved (see issue) | [X post above](https://x.com/alxfazio/article/2081415650912727439), [#23984](https://github.com/openai/codex/issues/23984) |
| `memories_1.sqlite` | summarized past conversations (memory rows) | Internal | [X post above](https://x.com/alxfazio/article/2081415650912727439) |
| `~/.codex/history.jsonl`, `log/codex-tui.log` | typed input only; TUI log | Documented / diagnostic | [ghinda](https://allaboutcoding.ghinda.com/where-ai-coding-clis-store-session-logs/), [Vaughan](https://codex.danielvaughan.com/2026/05/21/codex-cli-log-files-debug-tracing-diagnostic-toolkit-troubleshooting/) |
| Automations | empty threads (has_user_event = 0) with only session_meta in rollout; filter them | Buggy on Windows | [#24905](https://github.com/openai/codex/issues/24905) |
| Location override | `sqlite_home` / `CODEX_SQLITE_HOME` move all SQLite state | Config | [X post above](https://x.com/alxfazio/article/2081415650912727439) |

Not covered by sources (unknown): Claude `todos`, `plans`, `shell-snapshots`, `statsig`, and any local copy of Claude 5 h / weekly usage. Official way is `/usage`, `/status` ([sessionwatcher](https://sessionwatcher.com/guides/how-to-check-claude-code-usage)).

## 2. Features worth adding (value / effort, best first)

1. Codex rate-limit gauge from latest `token_count.rate_limits` (5 h and weekly %, reset time, plan). High value, low effort, no auth. [tokenatlas #89](https://github.com/Magnus-Gille/tokenatlas/issues/89). Keep history to feed Forecast.
2. 5-hour block grouping and live burn rate for Claude (blocks, `--live`). High, low. [ccusage](https://github.com/ryoppippi/ccusage)
3. Burn-rate prediction of time-to-limit, with warnings. High, medium. [Claude-Code-Usage-Monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor)
4. Threshold notifications at 70 / 90 % of session and week. Medium, low. [SessionWatcher](https://sessionwatcher.com/guides/how-to-check-claude-code-usage)
5. Cost and tokens per project / model / day, active time, tool-use stats. High, low. [claude-code-stats](https://github.com/shdennlin/claude-code-stats), [claude-monitor](https://github.com/szaher/claude-monitor)
6. Error analysis: tool errors by type (reported: "content not found" 20-30 %). Medium, medium. [Sniffly](https://github.com/chiphuyen/sniffly), [X](https://x.com/claude_code/status/1945532878961414230)
7. Codex goals view (objective, status, token budget) and thread list with git branch from `threads`. Medium, low; read-only open with busy tolerance. [X post](https://x.com/alxfazio/article/2081415650912727439), [resume-skills #103](https://github.com/aa22396584/resume-skills/issues/103)
8. Subagent tree from Claude side-folder transcripts; cross-agent worktree/branch board (the common architecture of Claude Squad, Vibe Kanban). Medium, medium-high. [Augment list](https://www.augmentcode.com/tools/open-source-agent-orchestrators), [dev.to](https://dev.to/stravukarl/best-tools-for-managing-parallel-ai-coding-agents-in-2026-14l8)
9. Cache hit rate (cache read vs input tokens), full-text transcript search. Medium, low. [claude-monitor](https://github.com/szaher/claude-monitor)
10. Rate-limit cost-per-token drift alarm (users report sudden 10-20x jumps). Low-medium, medium. [codex #28879](https://github.com/openai/codex/issues/28879)

## 3. Avoid

- Do not copy: remote approval of tool permissions ([claude-code-monitor](https://github.com/bruceyxli/claude-code-monitor)), proxy / traffic interception tools (ccflare/ccproxy class; not verified in results), anything reading OAuth tokens or `auth.json` to call usage endpoints. Our tool stays read-only and local.
- Never open Codex SQLite read-write or hold it; hot state can return busy ([#103](https://github.com/aa22396584/resume-skills/issues/103)). Copy or open `mode=ro`, retry, fall back to rollouts.
- Do not parse `logs_*.sqlite` (huge, internal, WAL churn: [lilting](https://lilting.ch/en/articles/codex-sqlite-log-ssd-writes)).
- Do not hard-code SQLite names or schemas: discover `state_*` by glob, tolerate blank fields, tolerate .zst rollouts.
- Crystal is deprecated (replaced by Nimbalyst), so do not model on it ([Munder Difflin](https://munderdiffl.in/blog/claude-code-orchestration-tools-compared/)).
