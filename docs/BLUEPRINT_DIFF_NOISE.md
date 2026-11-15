# Blueprint comparison noise

November 15, 2026

The node comparison now excludes confirmed editor presentation fields:
`AdvancedPinDisplay`, `bCommentBubblePinned`, `bCommentBubbleVisible`, and
`bCommentBubbleMakeVisible`. Stale `ErrorType`/`ErrorMsg` values are ignored when
`bHasCompilerMessage` is not true; an active compiler banner remains visible to
comparison. Unreal's local EdGraphNode.h documents these display settings and
the compiler-message flag. Raw saved properties remain available in the inspector.

The native reader resolves ordinary wire links to node IDs, but parent, sub-pin
and pass-through references still contain package export indices. Those indices
can change independently of the target. Comparison now resolves these references
against each graph and compares stable node/pin identities. Only complete targets
with a nonempty node ID and an existing pin qualify. Missing or ambiguous export
indices retain their raw values, as do unknown fields. Lookup maps are built once
per graph comparison, avoiding repeated node scans.

The hidden-pin identity rule also recognizes references stored as objects, not
just strings, so a referenced hidden pin cannot be treated as an unused one.

Defaults, pin types, pin identities, function targets, enabled state, unknown
properties, and actual connection changes remain compared. Comment and layout
changes retain their existing distinct classifications. No general rule discards
changes merely because nodes look identical, and no matching by appearance was
introduced.

Validation: 24 diff/performance tests and 14 reader/browser tests pass. Production
build and TypeScript checks pass. A separate local Mac build is available at
`Build-app/Blueprint-diff-fixed/mac-arm64/Lucid Git.app`; deep/strict signature
verification passed. Quit the previous copy before opening this build.

Regression coverage includes display-only differences, active versus inactive
compiler data, export renumbering, real reference changes, missing/ambiguous
targets, object-referenced hidden pins, and preservation of behavioral fields.
The user's exact problematic pair of revisions has not been supplied, so these
changes address identified sources of noise rather than claiming to eliminate
every possible false positive.

Audit reports and generators are absent from this checkout. No LG-/UI- finding
has been marked complete, and audit progress cannot be computed.
