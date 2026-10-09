# Agent context/return API 1.2

Use `extension.exports.cockpitV1`; major remains 1. Negotiate `revealContext` in `capabilities().data`, or check it is a function before calling it. All methods are actual current exports.

The caller first obtains a host-reviewed Scope from `getScopes()`. A PM selection does not grant Agent sources. If no corresponding scope exists, show the missing mapping and have the owner run `Agent: Review Cockpit Scope`; never use a global Agent workspace as an automatic fallback.

Call `getSummary({requestId, scope, generation})` to obtain enrolled native session IDs, canonical Agent repo IDs and observed worktree IDs. The response includes `host.hostId` and `epoch`. Native IDs from the response must be mapped to PM IDs explicitly; titles/time proximity do not authorize a mapping. Optional values that are not observed remain null.

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
    returnToken // opaque caller route token; 1..160 chars [a-zA-Z0-9._:/-]
  }
}
```

Agent validates every context field against the reviewed scope, host and native observations. An unmapped revision/worktree/session or stale epoch yields DENIED with opened=false. A valid native session opens scoped Compact at that selection; full transcript detail opens in the same filtered Agent editor. Back to Compact retains selection. The reply returns `{opened:true, returnToken}` with requestId/generation/scopeHash/epoch.

The context strip offers **Return to PM**. It executes only the fixed, negotiated `datapassPm.returnFromAgent` command, with `{returnToken,requestId,generation,scopeHash,epoch}` captured from the original approved open. It never executes the token as a command. Agent rechecks the original grant epoch and source/session/Git-context identity immediately before returning; drift or revoked/regranted scope refuses both return and token copying. PM independently validates this envelope and restores its saved work selection. A missing command or missing original generation falls back to copying the token. **Copy return token** also remains available explicitly. Installed PM restoration requires separate family qualification.

Legacy fallback: `reveal({...request,target:{kind:'project',id:scope.projectIds[0]}})` can open the reviewed scoped Factory. Its reply is `{opened}` and has no return-token guarantee. Keep PM's current selection locally, visibly label return negotiation unavailable, and require a valid local grant. A caller requiring exact host/worktree/revision/return semantics should disable that action until the new capability is installed. `openWorkspace` is the independent legacy full-screen entry and must not substitute for scoped context transfer.

The published JSON fixture wraps each actual DTO in `{fixture:true,evidenceScope,data}`. Use `.data` as the example payload; its synthetic roots/IDs are not grants for a real project. Tests cover approved open, wrong project/revision, changed epoch, no broadening and ordinary-vs-security replies. The fixture host-open is mocked; PM owns installed four-product qualification and one desktop GUI slot.
