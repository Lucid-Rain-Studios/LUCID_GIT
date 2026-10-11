# Unreal configuration and permissions

[Back to index](index.md)

## Source files

- [LucidGit_ClaudeCode_Spec.md](../../LucidGit_ClaudeCode_Spec.md)
- [electron/services/UnrealService.ts](../../electron/services/UnrealService.ts)
- [electron/util/binary-formats.ts](../../electron/util/binary-formats.ts)
- [src/lib/binaryFormats.ts](../../src/lib/binaryFormats.ts)

## Entities and evidence

- **UnrealService.ts** — `electron/services/UnrealService.ts:L1` · `electron_services_unrealservice_ts`
- **UnrealService** — `electron/services/UnrealService.ts:L196` · `unrealservice_unrealservice`
- **Requirement: repository permissions enforced in renderer and main** — `LucidGit_ClaudeCode_Spec.md:L1226-L1266` · `productdocs_rbac`
- **.detect()** — `electron/services/UnrealService.ts:L200` · `unrealservice_unrealservice_detect`
- **Requirement: force unlock, destructive history, cleanup and team config admin-gated** — `LucidGit_ClaudeCode_Spec.md:L1268-L1284` · `productdocs_admin_operations`
- **Requirement: session-only UI role preview leaves main IPC guards unchanged** — `LucidGit_ClaudeCode_Spec.md:L1355-L1384` · `productdocs_admin_preview`
- **.writeEditorConfig()** — `electron/services/UnrealService.ts:L380` · `unrealservice_unrealservice_writeeditorconfig`
- **.writeEngineConfig()** — `electron/services/UnrealService.ts:L409` · `unrealservice_unrealservice_writeengineconfig`
- **binary-formats.ts** — `electron/util/binary-formats.ts:L1` · `electron_util_binary_formats_ts`
- **.detectProject()** — `electron/services/UnrealService.ts:L209` · `unrealservice_unrealservice_detectproject`
- **.pluginStatus()** — `electron/services/UnrealService.ts:L292` · `unrealservice_unrealservice_pluginstatus`
- **.ueConfigStatus()** — `electron/services/UnrealService.ts:L349` · `unrealservice_unrealservice_ueconfigstatus`
- **Requirement: main IPC admin guard prevents renderer bypass** — `LucidGit_ClaudeCode_Spec.md:L1262-L1266` · `productdocs_ipc_permission_guard`
- **binaryFormats.ts** — `src/lib/binaryFormats.ts:L1` · `src_lib_binaryformats_ts`
- **setIniKeys()** — `electron/services/UnrealService.ts:L155` · `unrealservice_setinikeys`
- **.pakSizeEstimate()** — `electron/services/UnrealService.ts:L429` · `unrealservice_unrealservice_paksizeestimate`
- **.setupStatus()** — `electron/services/UnrealService.ts:L248` · `unrealservice_unrealservice_setupstatus`
- **.templates()** — `electron/services/UnrealService.ts:L283` · `unrealservice_unrealservice_templates`
- **.writeGitattributes()** — `electron/services/UnrealService.ts:L273` · `unrealservice_unrealservice_writegitattributes`
- **.writeGitignore()** — `electron/services/UnrealService.ts:L278` · `unrealservice_unrealservice_writegitignore`
- **Requirement: API failure falls back to write with warning** — `LucidGit_ClaudeCode_Spec.md:L1258-L1260` · `productdocs_permission_fallback`
- **Requirement: disabled admin controls remain discoverable and explain access** — `LucidGit_ClaudeCode_Spec.md:L1290-L1295` · `productdocs_discoverable_admin`
- **Specified admin/write/read mapping; maintain treated as write** — `LucidGit_ClaudeCode_Spec.md:L1230-L1243` · `productdocs_permission_mapping`
- **Rationale: GitHub blocks non-write pushes; admin gates destructive/team config** — `LucidGit_ClaudeCode_Spec.md:L1230-L1232` · `productdocs_permission_tiers_rationale`
- **Specified five-minute permission cache and background refresh** — `LucidGit_ClaudeCode_Spec.md:L1247-L1256` · `productdocs_permission_cache`
- **isBinaryPath()** — `electron/util/binary-formats.ts:L13` · `binary_formats_isbinarypath`
