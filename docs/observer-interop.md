# Observer exports and navigation

Agent remains a reader of provider artifacts. The Analyzer exposes bounded active,
recent, attention and export rows; existing workspace, timeline and full conversation
exports remain available. The observation sidecar uses `agent.observation-export/1`.
It preserves field evidence and UNKNOWN verification, applies the existing redaction
policy, and points readers to the sibling complete JSONL rather than claiming the
300-event normalized window is complete history.

Navigation uses `@galaxy/dev-context`, packaged from Lens's canonical pure parser.
An observed worktree, changed file or commit is required for its corresponding action.
No cwd-to-worktree substitution is made. The provider-native session identifier is
the return address; it is not a T3 application thread identifier.

Agent publishes explicit OBSERVED annotations to Lens after a user opens the worktree.
These annotations are transient evidence, not a scheduling or task database. Lens
checks exact checkout and file evidence before offering a return to Agent. Missing
companions produce an informational result. No prompt is submitted or runtime started.
