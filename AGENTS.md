# Project instructions

## graphify
- **graphify** (`~/.Codex/skills/graphify/SKILL.md`) — any input to a knowledge graph. Trigger: `/graphify`.
- When the user types `/graphify`, invoke the graphify skill before doing anything else.

## Context navigation
When you need to understand the codebase, docs, or files in this project:
1. Always query the knowledge graph first: `/graphify query "your question"`.
2. Read raw files as needed after querying the knowledge graph. Explicit user permission is not required for raw-file reads.
3. Use `graphify-out/wiki/index.md` as the navigation entry point when available. If absent or outdated, report that limitation rather than treating the graph as current implementation evidence.

## Persistent audit tracking
The user has requested that fixes automatically update the LUCID GIT audit checklist.

- Canonical report: `audit/LUCID-GIT-AUDIT.md`.
- Structured findings: `audit/findings.json`.
- Report generator: `audit/build-report.cjs`; examples, solutions and tradeoff notes: `audit/annotations.cjs`.
- Before fixing an issue, check the report for matching finding IDs. Keep IDs stable and retain the separate Undo category.
- Whenever a fix fully resolves a listed finding, verify the relevant behavior, change its report checkbox to `[x] Implemented and verified`, then run `node audit/build-report.cjs` to synchronize completion fields and the progress count. The generator preserves the visible report's checked and unchecked states.
- Never mark a finding done solely because code changed, a fix was proposed, or an unrelated test passed. Leave partial or unverified work unchecked and record what remains under that finding.
- Add a short resolution note under the finding's `Note` field in `audit/annotations.cjs`: describe the actual fix and relevant verification. Regenerate the report afterward. Record limitations honestly.
- If a regression reopens a completed finding, uncheck it, update the note and regenerate the report.
- Preserve optimization work when implementing fixes: caching and in-flight deduplication, bounded/batched work, watcher debounce, safe read preemption, authenticated LFS recovery and avoidance of repeated scans/downloads/retry loops. Explain any necessary performance tradeoff.
- Include the resolved finding IDs and audit progress in the final response for fixes. Do not implement unrelated findings merely to update the checklist.
- Treat this report as an audit baseline, not proof that later code still has every listed issue. Recheck the relevant implementation before changing it.

## Separate UI audit tracking
- UI report: `audit/LUCID-GIT-UI-AUDIT.md`; structured data: `audit/ui-findings.json`.
- UI generator: `audit/build-ui-report.cjs`; editable finding definitions and notes: `audit/ui-findings-source.cjs`.
- Check both reports when fixing UI behavior. Keep `UI-` and `LG-` IDs separate and stable.
- Mark a UI item `[x] Implemented and verified` only after its stated acceptance checks pass. Add the actual resolution and verification to its note in `audit/ui-findings-source.cjs`, then run `node audit/build-ui-report.cjs` to preserve checkboxes and synchronize progress/data.
- Partial implementations stay unchecked. Reopen items when regressions occur. A UI-only change does not automatically complete a related functional finding; verify and update each applicable report independently.
- UI audit baseline: current-source review and isolated lock-selection diagnostics, not live visual/accessibility testing. Suggestions are proposed work; source-supported defects and reproductions are labeled separately.
