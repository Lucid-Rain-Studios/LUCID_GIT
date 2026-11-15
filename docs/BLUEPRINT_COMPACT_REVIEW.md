# Compact Blueprint review

November 15, 2026

The embedded Blueprint preview now shares its asset header with the surrounding
review. File selection replaces the repeated title when multiple files are
available. Path, asset class and engine version remain on the header tooltip.
Non-graph views retain their existing metadata and revision tools.

The graph preview removes the redundant outer revision row, package-object count
and Base/Selected switch, since both revisions are shown together. The graph
toolbar keeps graph selection, highlight count, previous/next change, linked
cameras, fit, zoom and inspector controls. Expansion, refresh and binary details
appear only in the outer header. The inner project-information row is omitted.

Each graph pane has a compact Base/Selected revision label and node count. Repeated
paths, read-only badges and persistent instruction overlays are omitted. Canvas
keyboard instructions remain in its accessible label. A short footer retains
comparison completeness and linked/read-only status. Warnings and coverage details
remain available. Standalone graph reviews retain their original controls.

Validation: TypeScript and all 22 diff tests plus 15 reader/browser tests pass.
The new Chromium test checks one file selector, one binary action, one fullscreen
action, revision labels, removal of duplicate rows, canvas space, inspector,
fullscreen focus restoration, narrow-window overflow, and file selection.
The captured 1280×900 layout was visually inspected; the canvas begins around
150 pixels below the top of the window. Test image:
`test-results/blueprint-viewer-embedded--5da81-ximizes-usable-canvas-space/compact-blueprint.png`.

Production build and packaging passed. The separate local app is at
`Build-app/Blueprint-clean-view/mac-arm64/Lucid Git.app`; deep/strict signature
verification passed. Quit the previous app before opening this copy.

The canonical functional and UI audit files/generators are absent from this
checkout. No LG-/UI- IDs were marked complete and progress cannot be calculated.
