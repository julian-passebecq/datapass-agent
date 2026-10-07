# DataPass cockpit and selected conversation exports

Agent 0.8.0 keeps the existing live observer, project / worktree views, Tern integration,
read-only Git probes and opt-in PR / CI feeds. It adds a small **DataPass: Start Here**
entry point and **DataPass: Export Selected Conversations** in the command palette,
Cockpit and session context menu. Installing the new VSIX upgrades the same extension
identity (`juliandatapass.agent-vscode`); it does not replace provider history.

## Export

Build with `npm ci` and `npm run build`. Node 20+ is sufficient for the standalone tools.

```powershell
node dist/export-conversations.cjs --list
node dist/export-conversations.cjs --project D:\PROJ\datapass-agent --out .datapass\exports
node dist/export-conversations.cjs --provider codex --session SESSION_ID --out .datapass\exports
node dist/export-conversations.cjs --input chatgpt=conversations.json --input csv=features.csv --input mongo=records.json --out .datapass\exports
```

Repeat `--project`, `--session` or `--input` as needed. Provider roots use `CODEX_HOME`
/ `CLAUDE_CONFIG_DIR` or the current user's `.codex` / `.claude`; explicit home options
are available. Only conversation JSONL is discovered, including archived Codex sessions
and Claude subagents. Authentication / credential files and symlinks are excluded.
Folder selection compares normalized paths with directory boundaries, never a filename
substring. A session without a recorded working directory needs explicit session selection.

Each run creates a **new** folder. Existing output and all authoritative sources stay intact.
JSONL exports include every parseable recorded event in the selected native file, source
path / provider / session / line / source modification time and a SHA256 over redacted events.
Markdown preserves those event payloads for manual reading. Tool calls, results, parent
links and provider metadata remain where recorded. ChatGPT JSON import keeps all nodes,
including alternate branches. It is not a live ChatGPT history connector. Mongo input is
an explicit local JSON / JSONL snapshot; no Mongo driver or write mechanism is added.
CSV supports quoted multiline fields. JSON / CSV inputs are capped at 128 MiB.

The native reader takes a file-size snapshot, reads from the beginning and reports changed
files, malformed / oversized rows and excerpt omissions. A row over 32 Mi characters is
counted as malformed rather than silently exported. Discovery inspects up to 256 header
rows per file. A malformed partial last event in an active session requires re-exporting
after that session settles. `INCOMPLETE.txt` marks a failed run; do not index it.

## Reconcile and query

`cockpit.json` is a bounded projection: up to 12 recent excerpts per conversation or the
first 12 imported CSV / Mongo rows. The full redacted events are separate JSONL files.
Import this manifest at `/datapass` in the local `t3code-datapass` fork. That cockpit adds
live T3 project / thread / input-request visibility and links the existing PR/MR screen.
It merges repeated exports by source file identity, with the newest export winning.
It does not infer that an old request is still active or accepted. The review-pack download
cites files and record IDs, stays under 16,000 characters and asks the receiving model to
reconcile conflicts and verify live evidence. No LLM, Hermes or Gemma is required to export.

For agents, query full events with the dependency-free fallback:

```powershell
node dist/search-knowledge.cjs --bundle .datapass\exports\BUNDLE --query 'architecture' --limit 8
```

The fallback matches all query terms, ranks by capped occurrence count, and returns cited,
bounded snippets. It is not BM25. Leviathan is an optional external BM25 backend:

```powershell
leviathan index .datapass\exports\BUNDLE\leviathan.jsonl --index .datapass\knowledge.db --id id --title title --text text --group group --strict
leviathan search 'architecture' --index .datapass\knowledge.db --json
leviathan mcp --index .datapass\knowledge.db
```

Index files are derived and rebuildable. Leviathan's stdio MCP can be configured in coding
clients. Connecting ChatGPT to a remote service requires a separately authenticated HTTPS
MCP deployment; this prototype does not deploy one. Brain V0's canonical retrieval remains
separate: discussion archives are not silently promoted to Mongo or accepted decisions.

## Privacy and scope

No automatic upload, push, publishing, transcript execution, provider control or Mongo
write occurs. Secret-named fields, common tokens, URL credentials, full Mongo URIs and
private key blocks are redacted; embedded binary attachments are excluded. Pattern
redaction cannot guarantee removal of arbitrary secrets or personal information: inspect
exports before publishing. Derived export folders and `.env` are Git-ignored. No real
conversations belong in fixtures or commits. Native sources remain read-only.

Graph / diagram integration, automatic account synchronization and an AI next-task planner
are future work. The cockpit shows evidence to reconcile; it cannot prove what you should
do next merely by reading old conversations.
