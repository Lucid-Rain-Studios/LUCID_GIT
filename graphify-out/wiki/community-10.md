# Presence and dependency analysis

[Back to index](index.md)

## Source files

- [docs/BLUEPRINT_REVISION_VIEWER_IMPLEMENTATION_PLAN.md](../../docs/BLUEPRINT_REVISION_VIEWER_IMPLEMENTATION_PLAN.md)
- [docs/FIREBASE-PRESENCE.md](../../docs/FIREBASE-PRESENCE.md)
- [electron/db/database.ts](../../electron/db/database.ts)
- [electron/db/migrations.ts](../../electron/db/migrations.ts)
- [electron/services/DependencyService.ts](../../electron/services/DependencyService.ts)
- [electron/services/HeatmapService.ts](../../electron/services/HeatmapService.ts)
- [src/lib/presence.ts](../../src/lib/presence.ts)

## Entities and evidence

- **DependencyService.ts** — `electron/services/DependencyService.ts:L1` · `electron_services_dependencyservice_ts`
- **docs/FIREBASE-PRESENCE.md** — `docs/FIREBASE-PRESENCE.md:L1` · `assetdocs_doc_fb`
- **presence.ts** — `src/lib/presence.ts:L1` · `src_lib_presence_ts`
- **HeatmapService.ts** — `electron/services/HeatmapService.ts:L1` · `electron_services_heatmapservice_ts`
- **getDb()** — `electron/db/database.ts:L8` · `database_getdb`
- **DependencyService** — `electron/services/DependencyService.ts:L130` · `dependencyservice_dependencyservice`
- **.buildGraphCurrent()** — `electron/services/DependencyService.ts:L142` · `dependencyservice_dependencyservice_buildgraphcurrent`
- **HeatmapService** — `electron/services/HeatmapService.ts:L46` · `heatmapservice_heatmapservice`
- **database.ts** — `electron/db/database.ts:L1` · `electron_db_database_ts`
- **.blameWithDependencies()** — `electron/services/DependencyService.ts:L335` · `dependencyservice_dependencyservice_blamewithdependencies`
- **.computeHeatmap()** — `electron/services/HeatmapService.ts:L79` · `heatmapservice_heatmapservice_computeheatmap`
- **.buildGraph()** — `electron/services/DependencyService.ts:L134` · `dependencyservice_dependencyservice_buildgraph`
- **.recordLockEvent()** — `electron/services/HeatmapService.ts:L48` · `heatmapservice_heatmapservice_recordlockevent`
- **.countEdges()** — `electron/services/DependencyService.ts:L260` · `dependencyservice_dependencyservice_countedges`
- **.findReferences()** — `electron/services/DependencyService.ts:L421` · `dependencyservice_dependencyservice_findreferences`
- **.getNodeByPackage()** — `electron/services/DependencyService.ts:L295` · `dependencyservice_dependencyservice_getnodebypackage`
- **.getNodeByPath()** — `electron/services/DependencyService.ts:L287` · `dependencyservice_dependencyservice_getnodebypath`
- **.graphStatus()** — `electron/services/DependencyService.ts:L271` · `dependencyservice_dependencyservice_graphstatus`
- **.refreshCache()** — `electron/services/DependencyService.ts:L279` · `dependencyservice_dependencyservice_refreshcache`
- **.rowToNode()** — `electron/services/DependencyService.ts:L303` · `dependencyservice_dependencyservice_rowtonode`
- **.cutoff()** — `electron/services/HeatmapService.ts:L74` · `heatmapservice_heatmapservice_cutoff`
- **.getFileCommits()** — `electron/services/DependencyService.ts:L313` · `dependencyservice_dependencyservice_getfilecommits`
- **.getTimeline()** — `electron/services/HeatmapService.ts:L231` · `heatmapservice_heatmapservice_gettimeline`
- **Rules allow own member/status actions but deny others/role changes/roster/invalid fields/client timestamps** — `docs/FIREBASE-PRESENCE.md:L65-L75` · `assetdocs_rules`
- **.groupByFolder()** — `electron/services/HeatmapService.ts:L170` · `heatmapservice_heatmapservice_groupbyfolder`
- **.groupByType()** — `electron/services/HeatmapService.ts:L193` · `heatmapservice_heatmapservice_groupbytype`
- **.markConflictsResolved()** — `electron/services/HeatmapService.ts:L64` · `heatmapservice_heatmapservice_markconflictsresolved`
- **.rankSuspects()** — `electron/services/DependencyService.ts:L389` · `dependencyservice_dependencyservice_ranksuspects`
- **.recordConflictEvent()** — `electron/services/HeatmapService.ts:L56` · `heatmapservice_heatmapservice_recordconflictevent`
- **.topContended()** — `electron/services/HeatmapService.ts:L215` · `heatmapservice_heatmapservice_topcontended`
- **Commit enabled .lucid-git/firebase-presence.json public identifiers through project repository** — `docs/FIREBASE-PRESENCE.md:L33` · `assetdocs_sharedconfig`
- **First admin bootstraps lucidGit/workspace/members/UID record in Firebase Console** — `docs/FIREBASE-PRESENCE.md:L19-L30` · `assetdocs_bootstrap`
- **filePathToPackageName()** — `electron/services/DependencyService.ts:L99` · `dependencyservice_filepathtopackagename`
- **makeCacheKey()** — `electron/services/DependencyService.ts:L77` · `dependencyservice_makecachekey`
- **migrations.ts** — `electron/db/migrations.ts:L1` · `electron_db_migrations_ts`
- **simpleHash()** — `electron/services/DependencyService.ts:L68` · `dependencyservice_simplehash`
- **.groupMeanDuration()** — `electron/services/HeatmapService.ts:L226` · `heatmapservice_heatmapservice_groupmeanduration`
- **Active recent input<5minutes;Away locked/idle;Offline closure or heartbeat age>=90seconds** — `docs/FIREBASE-PRESENCE.md:L81-L83` · `assetdocs_status`
- **Controlled tests/build do not replace another-computer nonadmin roster-denial/live presence check** — `docs/FIREBASE-PRESENCE.md:L47` · `assetdocs_rollout`
- **Firebase GitHub Auth/Auth REST/Authenticated database REST official references** — `docs/FIREBASE-PRESENCE.md:L94` · `assetdocs_firebaseauthref`
- **Firebase Rules conditions/Rules Playground official references** — `docs/FIREBASE-PRESENCE.md:L94` · `assetdocs_firebaserulesref`
- **Firebase UID controls membership/auth; differs from GitHub login/numeric ID** — `docs/FIREBASE-PRESENCE.md:L18` · `assetdocs_uid`
- **Firebase integration uses Auth/Realtime Database REST without Cloud Functions/GitHub-role sync** — `docs/FIREBASE-PRESENCE.md:L92` · `assetdocs_rest`
- **First heartbeat creates own Firebase UID member record; admins elevated explicitly in Console** — `docs/FIREBASE-PRESENCE.md:L39-L43` · `assetdocs_registration`
- **Local presence.json/backups/temp files ignored while shared config tracked** — `docs/FIREBASE-PRESENCE.md:L49-L57` · `assetdocs_localfiles`
- **Main heartbeat30seconds/admin poll15seconds;REST has no onDisconnect hooks** — `docs/FIREBASE-PRESENCE.md:L84` · `assetdocs_heartbeat`
- **Rules do not independently verify repo membership; login/name are display labels and GitHub roles do not sync** — `docs/FIREBASE-PRESENCE.md:L43` · `assetdocs_authboundary`
- **Team owns Firebase; app accepts public web config only, no service-account/OAuth/database secret** — `docs/FIREBASE-PRESENCE.md:L3` · `assetdocs_publicconfig`
- **Verified diff distinguishes semantic edits, layout and comments; partial sides restrict claims** — `docs/BLUEPRINT_REVISION_VIEWER_IMPLEMENTATION_PLAN.md:L104-L111` · `assetdocs_diffcontract`
- **Workspace ID defaults normalized repo folder; preserve saved ID and share ID across repository clones** — `docs/FIREBASE-PRESENCE.md:L17` · `assetdocs_workspace`
- **extractAssetClass()** — `electron/services/DependencyService.ts:L87` · `dependencyservice_extractassetclass`
- **runMigrations()** — `electron/db/migrations.ts:L3` · `migrations_runmigrations`
- **scanBuffer()** — `electron/services/DependencyService.ts:L81` · `dependencyservice_scanbuffer`
- **Controlled HTTP tests do not prove deployed Firebase rules/OAuth; emulator tests rules locally** — `docs/FIREBASE-PRESENCE.md:L77` · `assetdocs_emulator`
- **Device sessions aggregate Active before Away before Offline; only status/server time sent** — `docs/FIREBASE-PRESENCE.md:L85` · `assetdocs_devices`
- **Disabled role/user blocks access; deleting member record permits auto-registration again** — `docs/FIREBASE-PRESENCE.md:L41` · `assetdocs_disabled`
- **Firebase GitHub provider retains OAuth client secret in Firebase only** — `docs/FIREBASE-PRESENCE.md:L9` · `assetdocs_githubauth`
- **Network failures report unavailable; quit final Offline bounded2seconds with expiry recovery** — `docs/FIREBASE-PRESENCE.md:L86` · `assetdocs_unavailable`
- **No Unreal state/window titles/files/branches/keystrokes sent; activity is recent input indication** — `docs/FIREBASE-PRESENCE.md:L89` · `assetdocs_privacy`
- **Test connection verifies admin reads/own publishing and briefly writes/removes Offline session** — `docs/FIREBASE-PRESENCE.md:L31` · `assetdocs_test`
- **Timeouts and account/project/workspace auth caching/deduplication keep tokens main-memory only** — `docs/FIREBASE-PRESENCE.md:L87` · `assetdocs_authcache`
- **presenceStatus()** — `src/lib/presence.ts:L3` · `presence_presencestatus`
