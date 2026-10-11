# Agent context/return API 1.3

Use `extension.exports.cockpitV1`; major remains 1. Negotiate `revealContext` in `capabilities().data`, or check it is a function before calling it. All methods are actual current exports.

The caller first obtains a host-reviewed Scope from `getScopes()`. A PM selection does not grant Agent sources. If no corresponding scope exists, show the missing mapping and have the owner run `Agent: Review Cockpit Scope`; never use a global Agent workspace as an automatic fallback.

Call `getSummary({requestId, scope, generation})` to obtain enrolled native session IDs, canonical Agent repo IDs and observed worktree IDs. The response includes `host.hostId` and `epoch`. Native IDs from the response must be mapped to PM IDs explicitly; titles/time proximity do not authorize a mapping. Optional values that are not observed remain null.

Negotiate `getContextMappings` to verify the selected local repository independently. `getContextMappings({requestId,scope,epoch,generation})` returns the usual reply envelope with `{repoId,path,worktreeId,worktreePath,revision,sessionId}[]`. `sessionId` is the enrolled Agent session key. `revision` is observed HEAD-after or HEAD-before, otherwise null. Only reviewed sessions with a present, nonlinked provider source and local repository are returned. Missing sources/paths yield PARTIAL and omissions; source/grant drift during observation yields DENIED. Paths are inert local metadata, not grants. Compare the observed path to the selected PM repository before sending its opaque Agent repoId. Do not derive an ID or assume two products use identical host identifiers.

`revealContext` request:

```ts
{
  requestId, scope, epoch, generation,
  context: {
    organizationId, privacyDomainId, projectId,
    repoId,       // canonical Agent repo ID from reviewed Scope/SessionRef
    hostId,      // exact response host.hostId
    worktreeId: null, // or exact observed SessionRef.worktreeId
    revision: null,   // or an exact observed source revision
    selectedItemId: null, // or an enrolled native SessionRef.id
    returnToken, // opaque caller route token; 1..160 chars [a-zA-Z0-9._:/-]
    origin: { // optional inert PM selection metadata
      schema:'datapass.pm-origin/1', projectId,
      taskId:null, taskRevision:null, taskAuthorityHash:null
    }
  }
}
```

Agent validates every context field against the reviewed scope, host and native observations. An unmapped revision/worktree/session or stale epoch yields DENIED with opened=false. A valid native session opens scoped Compact at that selection; full transcript detail opens in the same filtered Agent editor. Back to Compact retains selection. The reply returns `{opened:true, returnToken}` with requestId/generation/scopeHash/epoch.

Optional `origin` must use the exact context project ID. Its three task fields are either all null, or a valid task ID, a safe nonnegative integer document revision and a 64-character lowercase SHA256 authority hash. Agent treats this as PM selection metadata, not a native-session task association. PM alone validates the authoritative task document before transfer and return. Unknown origin fields, task bodies and drafts are stripped from saved metadata.

The context strip offers **Return to PM**. It executes only the fixed, negotiated `datapassPm.returnFromAgent` command, with `{returnToken,requestId,generation,scopeHash,epoch}` captured from the original approved open. It never executes the token as a command. Agent rechecks the original grant epoch and source/session/Git-context identity immediately before and after returning; drift or revoked/regranted scope refuses both return and token copying. PM independently validates this envelope and restores its saved work selection. Agent reports RETURNED only for `{returned:true,...binding}` with every original binding field matching exactly. Missing acknowledgement yields UNVERIFIED; mismatched acknowledgement yields DENIED; PM rejection propagates. A missing command or missing original generation falls back to copying the token. **Copy return token** also remains available explicitly. Installed PM restoration requires separate family qualification.

**Inspect context in Lens** negotiates `tern.openCockpitContext` and sends `{schema:'datapass.cockpit-lens-context/1',context,binding,devContext}`. `binding` is the original PM return envelope; `devContext` uses the existing public `@galaxy/dev-context` parser and observed repository/worktree/revision. Agent rechecks its original grant epoch and source-context hash after command negotiation. Lens maps its own reviewed catalogue/project/source grant and validates local Git independently; installed command availability alone cannot produce OPENED. Missing Lens support keeps the scoped Agent panel and its direct Return to PM usable.

Only `{schema:'datapass.agent-workspace-state/1',view,selected,opts,scoped,context?}` is serialized. `opts` contains allowlisted navigation selections. No source grants, source content, search text, credentials, export approvals, feed state, or PM approval bindings are persisted. Host restart suspends scoped panels and requires reviewed scope plus a fresh PM handoff; saved return tokens cannot invoke stale approval. Invalid metadata fails closed. Independent Agent tabs restore navigation without acquiring any cockpit grant. An intentionally closed panel stays closed; reopening an independent panel in the same host retains its in-memory view selection.

Legacy fallback: `reveal({...request,target:{kind:'project',id:scope.projectIds[0]}})` can open the reviewed scoped Factory. Its reply is `{opened}` and has no return-token guarantee. Keep PM's current selection locally, visibly label return negotiation unavailable, and require a valid local grant. A caller requiring exact host/worktree/revision/return semantics should disable that action until the new capability is installed. `openWorkspace` is the independent legacy full-screen entry and must not substitute for scoped context transfer.

The published JSON fixture wraps each actual DTO in `{fixture:true,evidenceScope,data}`. Use `.data` as the example payload; its synthetic roots/IDs are not grants for a real project. Tests cover approved open, wrong project/revision, changed epoch, no broadening and ordinary-vs-security replies. The fixture host-open is mocked; PM owns installed four-product qualification and one desktop GUI slot.
