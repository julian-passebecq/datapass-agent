# Publication correction

The first push of commit `9b663f407525d19706765bcb998453bd2e71b0ce` used the inherited checkout `origin`, `julian-passebecq/datapass-agent`. That repository is public. The privacy check performed before the push had checked `julian-passebecq/agent-vscode`, a different private repository. This was a publication error.

Only the newly created branch `codex/agent-maf-headless-20261023` was removed from the public repository, using a lease bound to the exact pushed commit. A subsequent `git ls-remote --heads` returned no matching branch. No existing public branch, repository visibility or other owner's Git state was changed.

The same contribution was then pushed explicitly to `https://github.com/julian-passebecq/agent-vscode.git`, after verifying `isPrivate=true`. The new local branch's tracking remote was set to that explicit private URL, leaving the shared `origin` unchanged. All later publication uses explicit verified private URLs.

Branch removal does not establish that GitHub has purged uploaded objects or that no reader accessed them. The affected contribution contains source code, synthetic test logs, documentation and the provider-kit archive. No credential or live-provider payload was intentionally included. The public branch exposure remains a limitation of this pass and is disclosed to the user.
