# Agent: what can it control? (official mechanisms only) - 2026-10-05

Principle: Agent stays an observer by default. Anything that writes is opt-in, shows a diff, backs up the file, touches only user-owned config files, and never touches credentials or transcripts.
Docs: CC = https://code.claude.com/docs/en (old docs.claude.com redirects there: hooks, settings, statusline, headless, sdk, sub-agents, output-styles, monitoring-usage, iam/permission-modes). CX = Codex: https://developers.openai.com/codex (config-advanced, redirects to learn.chatgpt.com/docs/config-file/config-advanced) and https://github.com/openai/codex.
Verified this session: CC hooks page (event list, common fields), CX advanced config page (notify, otel, profiles, paths). Other rows come from my knowledge of the docs: re-check before building. Hook list and fields change fast (CC hooks page now lists 32 events).

## 1. More real-time observation (read-only, zero risk)
| Feature | Mechanism | Risk | ToS / safety | Reco |
|---|---|---|---|---|
| Live tool/turn/permission events from Claude Code | Hooks (CC /hooks): PreToolUse, PostToolUse(+Failure), PermissionRequest, Notification, Stop, StopFailure, SubagentStart/Stop, PreCompact, PostModelSwitch, ConfigChange. Hook gets JSON on stdin with session_id, transcript_path, cwd, permission_mode, effort.level, agent_id/agent_type. A logger hook appends to a local JSONL that Agent tails. | low (user installs a hook entry; must exit 0, never block) | Documented. Hook runs with user rights: keep it append-only, no network. | build now (opt-in install of the logger) |
| Per-turn cost, model, context % | Statusline command (CC /statusline): receives session JSON on stdin (model, cwd, cost, context window). Only one statusline per user: chain, do not replace. | low | Documented. Do not overwrite the user's existing statusline. | build now (chained) |
| Metrics and events (tokens, cost, tool results, API errors) | OpenTelemetry (CC /monitoring-usage): CLAUDE_CODE_ENABLE_TELEMETRY=1, OTEL_*_EXPORTER=otlp, endpoint = local collector run by Agent on localhost. Prompt text is off unless OTEL_LOG_USER_PROMPTS=1. | low | Documented, local only. Keep prompt logging off. | build later (needs a small local OTLP receiver) |
| Codex turn end | notify in ~/.codex/config.toml: runs a program with one JSON arg (type agent-turn-complete, thread-id, turn-id, cwd, input-messages, last-assistant-message) (CX config-advanced) | low | Documented. Payload contains prompts: store locally only. One notify slot: chain. | build now (opt-in) |
| Codex telemetry | [otel] in config.toml, otlp-http/grpc, log_user_prompt redaction (CX config-advanced) | low | Documented; keep redaction on. | build later |
| Codex hooks | hooks.json or [hooks] in config; project hooks need trust (CX config-advanced) | low | Documented. | opt-in later |
| Transcripts / rollouts | ~/.claude/projects/*.jsonl, ~/.codex/sessions/rollout-*.jsonl: read-only tailing (what Agent does today) | none | Undocumented formats, may change: parse defensively, never write. | keep |

## 2. Safe config editing
| Feature | Mechanism | Risk | ToS / safety | Reco |
|---|---|---|---|---|
| Default model / effort for Claude Code | settings.json keys model, effortLevel (CC /settings), or env ANTHROPIC_MODEL; user scope ~/.claude/settings.json, project .claude/settings.json, local .claude/settings.local.json | low | Documented. Affects only new sessions: a running session is not changed (matches Julian's rule). Edit via JSON merge, keep comments/other keys, backup first. | build now (write to settings.local.json by default) |
| Default permission mode | settings.json permissions.defaultMode (default, acceptEdits, plan, ...) + allow/deny/ask rules (CC /iam) | medium | Documented. Offer only stricter or equal choices in the UI; bypassPermissions behind a typed confirm, off by default. Managed settings may override: show the winning layer, read only. | opt-in later (deny rules: build now) |
| Subagent files | .claude/agents/*.md frontmatter (name, description, tools, model) (CC /sub-agents) | low | Documented plain markdown in the repo; git gives undo. | build now (form editor with diff) |
| Output style | .claude/output-styles/*.md and outputStyle setting (CC /output-styles) | low | Documented. | opt-in later |
| Hooks editing | hooks block in settings.json (CC /hooks) | medium | Hooks run arbitrary commands: only add Agent's own logger entry; show any other hook read-only. | opt-in later (logger only) |
| Codex model / approval / sandbox | ~/.codex/config.toml: model, model_reasoning_effort, approval_policy, sandbox_mode; profiles via --profile (CX config-advanced) | low-medium | Documented. TOML edit must preserve comments (use a round-trip parser). Do not offer danger-full-access + never as one click. | build later (read first, then opt-in write) |
| Codex MCP servers | [mcp_servers] in config.toml (CX mcp docs) | medium | Starts third-party processes: view only. | never write, view now |
| Read effective config | Show merged settings layers (user/project/local/managed) and which wins | none | Read only. | build now |

## 3. Session launch / stop
| Feature | Mechanism | Risk | ToS / safety | Reco |
|---|---|---|---|---|
| Open a new interactive session | VS Code terminal running `claude` or `codex` in a chosen folder, with --model, --permission-mode, --profile flags from the UI | low | The user's own CLI under the user's own login. Agent does not touch the auth. | build now |
| Resume | `claude --resume <id>` / `claude --continue`; `codex resume` | low | Documented CLI. | build now |
| Headless task | `claude -p "..." --output-format stream-json --max-turns N --allowedTools ...` (CC /headless); `codex exec` (CX) | medium | Documented. Spends the user's quota: show cost cap and confirm; always pass an explicit tool allowlist. | opt-in later |
| Programmatic control | Claude Agent SDK (CC /sdk) | medium | Documented, but SDK usage must follow Anthropic's commercial terms and auth rules (API key; do not route a consumer subscription login through a third-party app). Check current terms before shipping. | opt-in later, API key only |
| Codex programmatic | app-server / proto (openai/codex repo) | medium | Marked experimental, protocol may change. | never for now (watch) |
| Stop a session | Send Ctrl+C / close the terminal that Agent itself launched (Terminal API) | low | Only for sessions Agent started: never kill other PIDs by guess. | build now (own terminals only) |
| Cancel a foreign session | kill by PID | high | Can lose work, bypasses the tool's own shutdown. | never |

## 4. Never do
- Read, copy, display or send auth: ~/.claude/.credentials.json, OAuth tokens, ~/.codex/auth.json, API keys, keychain. No token reuse to call APIs directly or to read quota with a stolen login.
- Edit or delete transcripts / rollouts / history, or fabricate sessions (breaks resume and audit).
- Bypass permissions: no auto-answering of permission prompts via hook output or keystroke injection, no silent defaultMode=bypassPermissions, no writing to managed settings (admin scope, may need elevation; policy violation).
- Scrape the TUI / terminal buffer, use screen automation on the CLIs, or patch the CLI install (cli.js / binaries).
- Proxy or rewrite model traffic (ANTHROPIC_BASE_URL man-in-the-middle) to alter prompts or hide usage.
- Run a hook that blocks (exit 2) or makes network calls on the user's behalf without explicit opt-in.
- Change model/effort of a session that is running (not supported; only at start).

## Suggested control screens (order)
1. Live: hook-logger + statusline chain feeding the existing view (build now).
2. Defaults: model, effort, permission-mode (stricter only), deny rules, effective-layer viewer; diff + backup + undo (build now, local scope).
3. Agents: .claude/agents editor (build now).
4. Launcher: new/resume session in an Agent-owned terminal with flags (build now).
5. Later, opt-in: OTLP receiver for cost, Codex config write, headless runner with cost cap.
