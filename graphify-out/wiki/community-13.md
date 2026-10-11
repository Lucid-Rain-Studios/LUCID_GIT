# Recovery instructions and bug logs

[Back to index](index.md)

## Source files

- [AGENTS.md](../../AGENTS.md)
- [LucidGit_ClaudeCode_Spec.md](../../LucidGit_ClaudeCode_Spec.md)
- [docs/troubleshooting/git-lfs-auth-and-index-errors.md](../../docs/troubleshooting/git-lfs-auth-and-index-errors.md)
- [src/components/logs/BugLogsPanel.tsx](../../src/components/logs/BugLogsPanel.tsx)

## Entities and evidence

- **BugLogsPanel.tsx** — `src/components/logs/BugLogsPanel.tsx:L1` · `src_components_logs_buglogspanel_tsx`
- **Windows troubleshooting guide: LFS credentials and write-index failures** — `docs/troubleshooting/git-lfs-auth-and-index-errors.md:L1-L8` · `productdocs_lfs_guide`
- **Requirement: persistent last-five-session Bug Logs for diagnosing field failures** — `LucidGit_ClaudeCode_Spec.md:L1926-L1934` · `productdocs_bug_logs`
- **Documented diagnosis: Desktop/app runtimes, helpers or accounts may differ** — `docs/troubleshooting/git-lfs-auth-and-index-errors.md:L10-L20` · `productdocs_runtime_mismatch`
- **Instruction: canonical functional audit and stable LG finding IDs** — `AGENTS.md:L13-L26` · `productdocs_functional_audit`
- **Requirement: refresh, suggested fix and save-as-text; available without repo** — `LucidGit_ClaudeCode_Spec.md:L1994-L2012` · `productdocs_log_panel`
- **Documented diagnosis: app authentication can succeed while LFS batch auth fails** — `docs/troubleshooting/git-lfs-auth-and-index-errors.md:L22-L26` · `productdocs_lfs_auth_separation`
- **Project instructions: graph navigation and verified audit tracking** — `AGENTS.md:L1-L34` · `productdocs_instructions`
- **Specified Git stderr, authentication and startup/shutdown logging hooks** — `LucidGit_ClaudeCode_Spec.md:L1980-L1985` · `productdocs_log_collection`
- **Documented historical recovery commands: abort merge and remove index.lock** — `docs/troubleshooting/git-lfs-auth-and-index-errors.md:L104-L115` · `productdocs_failed_merge_recovery`
- **Guide incident evidence: in-app auth succeeded; LFS a186ac1 batch Bad credentials** — `docs/troubleshooting/git-lfs-auth-and-index-errors.md:L172-L174` · `productdocs_incident_evidence`
- **Instruction: preserve caching, deduplication, debounce and bounded recovery** — `AGENTS.md:L24` · `productdocs_optimization_preservation`
- **Instruction: query knowledge graph before raw reads** — `AGENTS.md:L7-L11` · `productdocs_graph_first`
- **Instruction: separate UI audit with stable UI finding IDs** — `AGENTS.md:L28-L34` · `productdocs_ui_audit`
- **Specified known-error pattern matching into plain-English fix hints** — `LucidGit_ClaudeCode_Spec.md:L1970-L1974` · `productdocs_log_suggestions`
- **Documented checks: processes, permissions, antivirus, disk, status and fsck** — `docs/troubleshooting/git-lfs-auth-and-index-errors.md:L131-L145` · `productdocs_write_index_diagnostics`
- **Documented recovery: explicit pull, LFS logs and exact-object fetch** — `docs/troubleshooting/git-lfs-auth-and-index-errors.md:L117-L128` · `productdocs_lfs_retry_diagnostics`
- **Documented recovery: reinstall local LFS hooks/config and inspect env** — `docs/troubleshooting/git-lfs-auth-and-index-errors.md:L96-L102` · `productdocs_lfs_hooks_repair`
- **Documented recovery: validate remote/helper/endpoint, clear credentials and reauthenticate** — `docs/troubleshooting/git-lfs-auth-and-index-errors.md:L59-L94` · `productdocs_auth_recovery`
- **Instruction: UI completion requires acceptance checks; functional completion independent** — `AGENTS.md:L31-L34` · `productdocs_ui_acceptance`
- **Instruction: compare Git runtime, version, helper and LFS env between apps** — `docs/troubleshooting/git-lfs-auth-and-index-errors.md:L147-L158` · `productdocs_runtime_comparison`
- **Instruction: complete only after relevant behavior verification** — `AGENTS.md:L19-L22` · `productdocs_audit_verification`
- **Instruction: inspect LFS env inside valid repository before permission verdict** — `docs/troubleshooting/git-lfs-auth-and-index-errors.md:L29-L57` · `productdocs_repo_context`
- **Instruction: regenerate functional report and synchronize completion counts** — `AGENTS.md:L18-L23` · `productdocs_audit_generator`
- **Instruction: standardize auth, grant LFS permissions and document remote/account** — `docs/troubleshooting/git-lfs-auth-and-index-errors.md:L160-L170` · `productdocs_team_prevention`
- **Instruction: wiki index is navigation; stale graph is not implementation evidence** — `AGENTS.md:L11` · `productdocs_wiki_navigation`
- **Specified two-second debounced async flush and synchronous shutdown flush** — `LucidGit_ClaudeCode_Spec.md:L1958-L1964` · `productdocs_log_flush`
- **handleClear()** — `src/components/logs/BugLogsPanel.tsx:L54` · `buglogspanel_handleclear`
- **handleCopy()** — `src/components/logs/BugLogsPanel.tsx:L41` · `buglogspanel_handlecopy`
- **handleSave()** — `src/components/logs/BugLogsPanel.tsx:L69` · `buglogspanel_handlesave`
