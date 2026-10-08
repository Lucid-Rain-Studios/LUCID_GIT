---
type: "query"
date: "2026-10-08T22:56:15.548217+00:00"
question: "Why does Branches right-click merge report Branch no longer exists dev_Jake?"
contributor: "graphify"
source_nodes: ["BranchPanel.tsx"]
---

# Q: Why does Branches right-click merge report Branch no longer exists dev_Jake?

## Answer

The current BranchPanel right-click merge handler passed branch.displayName, dropping origin/ from remote identity. Merge, compare and remote-row selection now use branch.name. Two new controlled-renderer tests backed by real Git and two existing LG-020 regressions pass. The graph is outdated and its wiki entrypoint is absent; the diagnosis used user-authorized current source.

## Source Nodes

- BranchPanel.tsx