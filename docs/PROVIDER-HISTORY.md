# Bulk provider history export

Build from Agent main 0.8.2 or a descendant with `npm ci && npm run build` (Node 20+). The bundled CLI also ships in the VSIX under `extension/dist/export-provider-history.cjs`; extract the VSIX to use it without VS Code.

```powershell
node D:\PROJ\agent-bulk-provider-history\dist\export-provider-history.cjs export --provider codex --out D:\PROJ\AGENT-BULK-HISTORY-EVIDENCE\codex-final
node D:\PROJ\agent-bulk-provider-history\dist\export-provider-history.cjs export --provider claude --out D:\PROJ\AGENT-BULK-HISTORY-EVIDENCE\claude-final
```

Use a new empty output directory each time; existing bundles cannot be overwritten. Defaults are the existing adapters' provider roots (`CODEX_HOME` or `~/.codex`, `CLAUDE_CONFIG_DIR` or `~/.claude`). Optional `--codex-home` and `--claude-home` override them. Output must resolve outside both roots, including through directory links. The command is non-interactive and prints aggregate counts only. A failure exits nonzero; an incomplete bundle has no `cockpit.json` and must not be imported.

## Archive wrapper binding (PowerShell 7)

For each provider, validate the existing bundle without any archive writes:

```powershell
& 'D:\PROJ\datapass-conversation-history\scripts\sync-agent-history.ps1' -Provider codex -BundlePath 'D:\PROJ\AGENT-BULK-HISTORY-EVIDENCE\codex-final' -DryRun
& 'D:\PROJ\datapass-conversation-history\scripts\sync-agent-history.ps1' -Provider claude -BundlePath 'D:\PROJ\AGENT-BULK-HISTORY-EVIDENCE\claude-final' -DryRun
```

The wrapper can launch the same CLI directly. Run this in PowerShell 7, with the argument array preserved:

```powershell
$exporterArgs = @('D:\PROJ\agent-bulk-provider-history\dist\export-provider-history.cjs', 'export', '--provider', '{provider}', '--out', '{out}')
& 'D:\PROJ\datapass-conversation-history\scripts\sync-agent-history.ps1' -Provider codex -ExporterExe 'C:\Program Files\nodejs\node.exe' -ExporterArgs $exporterArgs -DryRun
& 'D:\PROJ\datapass-conversation-history\scripts\sync-agent-history.ps1' -Provider claude -ExporterExe 'C:\Program Files\nodejs\node.exe' -ExporterArgs $exporterArgs -DryRun
```

The archive checkout must be clean. `{provider}` and `{out}` are expanded by the wrapper; it removes its temporary derived bundle afterward. `-DryRun` performs validation and hashing without copying into the archive, committing or pushing. Omitting `-DryRun` commits an archive import; do that only after explicit authorization and content review. No separate provider parser is needed in the archive repository.

## Schema and provenance

`cockpit.json` uses **`datapass.provider-history/1`**. Its `records` array indexes source artifacts, not individual messages. The wrapper's `record_count` therefore equals `artifactCount`; `eventCount` is the complete JSONL record count. `sessionCount` includes parent/worker transcripts, excludes workflow journals, and is not a count of unique top-level chats.

Each index entry has provider, native session identity, provider-qualified key, recorded parent/worker relationship, workflow identity when applicable, source path/hash/byte boundary/mtime, output JSONL path/hash, counts by native record type, timestamps and cwd/project when known. Unknown repository correlation is `null`; the exporter never runs Git. Small Claude worker `.meta.json` companions retain their sanitized metadata and source hashes. `projection` is the existing bounded Agent observer interpretation; use JSONL for complete historical content.

`events/<artifact-hash>.jsonl` uses **`datapass.conversation-event/1`** per line, with an artifact/line-derived stable ID, source provider/session/key/path/hash/line provenance and `event`, the sanitized native JSON value. Native provider fields, tool/activity records, unknown record types and duplicate events are retained. No Codex/Claude normalization destroys provider semantics.

## Observer and security boundary

Discovery and metadata interpretation reuse Agent's Codex/Claude adapters; full content reuses its JSONL reader and recursive security/redaction machinery. Codex active/archived rollouts and underscore-named fork rollouts are included. Claude parent/subagent transcripts and provider-owned workflow agent/journal history are included; workflow traversal is export-only and does not expand cockpit discovery.

Only discovered native transcript files and eligible worker metadata are read. Linked artifacts, credential filenames, malformed JSONL, records over the shared 32 Mi-character limit, unreadable discovery and source rewrites/truncation fail closed. Credentials/auth files, SQLite, caches, unrelated provider files, binary attachments, encrypted provider payloads and structured environment snapshots are not exported. No provider processes, provider writes, network calls, Mongo writes or archive operations occur in the CLI.

Captured raw-byte prefixes are SHA-256 hashed before and after export. Verified external appends are reported; new files/bytes after capture require another run. Live providers are not paused. The bundle's completion manifest is written last. Pattern redaction covers structured secret keys, token shapes, credentials, connection strings and private keys, but arbitrary unlabeled secrets and personal data still require review before an authorized archive push.
