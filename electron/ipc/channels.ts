export const CHANNELS = {
  // Auth
  AUTH_START_DEVICE_FLOW:  'auth:start-device-flow',
  AUTH_POLL_DEVICE_FLOW:   'auth:poll-device-flow',
  AUTH_LIST_ACCOUNTS:          'auth:list-accounts',
  AUTH_LOGOUT:                 'auth:logout',
  AUTH_SET_CURRENT_ACCOUNT:    'auth:set-current-account',

  // Git core
  GIT_IS_REPO:       'git:is-repo',
  GIT_CLONE:         'git:clone',
  GIT_STATUS:        'git:status',
  GIT_CURRENT_BRANCH:'git:current-branch',
  GIT_STAGE:         'git:stage',
  GIT_UNSTAGE:       'git:unstage',
  GIT_COMMIT:        'git:commit',
  GIT_PUSH:          'git:push',
  GIT_PULL:          'git:pull',
  GIT_FETCH:         'git:fetch',
  GIT_LOG:           'git:log',
  GIT_CHANGELOG:     'git:changelog',
  GIT_BRANCH_LIST:   'git:branch-list',
  GIT_BRANCH_CREATE: 'git:branch-create',
  GIT_BRANCH_RENAME: 'git:branch-rename',
  GIT_BRANCH_DELETE:        'git:branch-delete',
  GIT_BRANCH_DELETE_REMOTE: 'git:branch-delete-remote',
  GIT_CHECKOUT:      'git:checkout',
  GIT_MERGE_PREVIEW: 'git:merge-preview',
  GIT_POTENTIAL_MERGE_CONFLICTS: 'git:potential-merge-conflicts',
  GIT_MERGE:         'git:merge',
  GIT_MERGE_GET_CONFLICT_TEXT: 'git:merge-get-conflict-text',
  GIT_MERGE_RESOLVE_TEXT: 'git:merge-resolve-text',
  GIT_MERGE_CONTINUE: 'git:merge-continue',
  GIT_MERGE_ABORT: 'git:merge-abort',
  GIT_MERGE_IN_PROGRESS: 'git:merge-in-progress',
  GIT_REMOTE_URL:    'git:remote-url',
  GIT_SYNC_STATUS:   'git:sync-status',
  GIT_UPDATE_FROM_MAIN: 'git:update-from-main',
  GIT_UPDATE_FROM_MAIN_CONFLICTS: 'git:update-from-main-conflicts',
  GIT_MERGE_OVERLAP:    'git:merge-overlap',
  GIT_DIFF:             'git:diff',
  GIT_DISCARD:          'git:discard',
  GIT_DISCARD_ALL:      'git:discard-all',
  GIT_COMMIT_FILES:     'git:commit-files',
  GIT_ADD_GITIGNORE:    'git:add-gitignore',
  GIT_STASH_LIST:       'git:stash-list',
  GIT_STASH_SAVE:       'git:stash-save',
  GIT_STASH_POP:        'git:stash-pop',
  GIT_STASH_APPLY:      'git:stash-apply',
  GIT_STASH_DROP:       'git:stash-drop',
  GIT_STASH_SHOW_FILES: 'git:stash-show-files',
  GIT_STASH_FILE_DIFF:  'git:stash-file-diff',
  GIT_COMMIT_AMEND:     'git:commit-amend',
  GIT_LAST_COMMIT_MESSAGE: 'git:last-commit-message',
  GIT_COMMIT_MESSAGE:      'git:commit-message',
  GIT_IS_HEAD_PUSHED:   'git:is-head-pushed',
  GIT_DIFF_RAW:         'git:diff-raw',
  GIT_APPLY_PATCH:      'git:apply-patch',

  // Locks
  LOCK_FILE:          'lock:file',
  LOCK_UNLOCK:        'lock:unlock',
  LOCK_UNLOCK_BATCH:  'lock:unlock-batch',
  LOCK_LIST:          'lock:list',
  LOCK_WATCH:         'lock:watch',
  LOCK_START_POLLING: 'lock:start-polling',
  LOCK_STOP_POLLING:  'lock:stop-polling',
  LOCK_CLEAR_CACHE:   'lock:clear-cache',
  LOCK_FOLDER:        'lock:folder',
  UNLOCK_FOLDER_MINE: 'lock:unlock-folder-mine',

  // LFS
  LFS_STATUS:     'lfs:status',
  LFS_TRACK:      'lfs:track',
  LFS_UNTRACK:    'lfs:untrack',
  LFS_MIGRATE:    'lfs:migrate',
  LFS_AUTODETECT: 'lfs:autodetect',
  LFS_LOCKS_CHECK:  'lfs:locks-check',
  LFS_LOCKS_REPAIR: 'lfs:locks-repair',

  // Cleanup
  CLEANUP_SIZE:      'cleanup:size',
  CLEANUP_GC:        'cleanup:gc',
  CLEANUP_PRUNE_LFS: 'cleanup:prune-lfs',
  CLEANUP_SHALLOW:   'cleanup:shallow',
  CLEANUP_UNSHALLOW: 'cleanup:unshallow',

  // Notifications + webhooks
  NOTIFICATION_LIST:           'notification:list',
  NOTIFICATION_MARK_READ:      'notification:mark-read',
  NOTIFICATION_DESKTOP_NOTIFY: 'notification:desktop-notify',
  WEBHOOK_TEST:           'webhook:test',
  WEBHOOK_LOAD:           'webhook:load',
  WEBHOOK_SAVE:           'webhook:save',

  // Auto-updater
  UPDATE_CHECK:    'update:check',
  UPDATE_DOWNLOAD: 'update:download',
  UPDATE_INSTALL:  'update:install',
  EVT_UPDATE_READY: 'evt:update-ready',

  // Auto-fix helpers
  GIT_REBASE_ABORT:  'git:rebase-abort',
  GIT_SET_UPSTREAM:  'git:set-upstream',
  GIT_SET_CONFIG:    'git:set-config',
  GIT_GET_CONFIG:    'git:get-config',

  // Hooks
  HOOK_LIST:            'hook:list',
  HOOK_ENABLE:          'hook:enable',
  HOOK_DISABLE:         'hook:disable',
  HOOK_BUILTINS:        'hook:builtins',
  HOOK_INSTALL_BUILTIN: 'hook:install-builtin',
  HOOK_RUN_PRECOMMIT:   'hook:run-precommit',

  // Unreal
  UE_DETECT:               'ue:detect',
  UE_SETUP_STATUS:         'ue:setup-status',
  UE_TEMPLATES:            'ue:templates',
  UE_WRITE_GITATTRIBUTES:  'ue:write-gitattributes',
  UE_WRITE_GITIGNORE:      'ue:write-gitignore',
  UE_PAK_SIZE:             'ue:pak-size',
  UE_PLUGIN_STATUS:        'ue:plugin-status',
  UE_CONFIG_STATUS:        'ue:config-status',
  UE_WRITE_EDITOR_CONFIG:  'ue:write-editor-config',
  UE_WRITE_ENGINE_CONFIG:  'ue:write-engine-config',

  // Git identity + locking config
  GIT_GET_IDENTITY:        'git:get-identity',
  GIT_LINK_IDENTITY:       'git:link-identity',
  GIT_GET_GLOBAL_IDENTITY: 'git:get-global-identity',
  GIT_SET_GLOBAL_IDENTITY: 'git:set-global-identity',
  GIT_OPEN_GLOBAL_CONFIG:  'git:open-global-config',

  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SAVE: 'settings:save',

  // Team config
  TEAM_CONFIG_LOAD: 'team-config:load',
  TEAM_CONFIG_SAVE: 'team-config:save',

  // Git tools
  GIT_LS_FILES:        'git:ls-files',
  GIT_RESTORE_FILE:    'git:restore-file',
  GIT_REVERT:          'git:revert',
  GIT_CHERRY_PICK:             'git:cherry-pick',
  GIT_CHERRY_PICK_IN_PROGRESS: 'git:cherry-pick-in-progress',
  GIT_CHERRY_PICK_CONTINUE:    'git:cherry-pick-continue',
  GIT_CHERRY_PICK_ABORT:       'git:cherry-pick-abort',
  GIT_INDEX_LOCK_INFO:         'git:index-lock-info',
  GIT_INDEX_LOCK_REMOVE:       'git:index-lock-remove',
  GIT_AHEAD_FILE_PATHS:        'git:ahead-file-paths',
  GIT_RESET_TO:        'git:reset-to',
  GIT_FILE_LOG:        'git:file-log',
  GIT_BRANCH_ACTIVITY: 'git:branch-activity',
  GIT_BRANCH_DIFF:     'git:branch-diff',
  GIT_DEFAULT_BRANCH:  'git:default-branch',
  GIT_BLAME:           'git:blame',
  GIT_DIFF_COMMIT:     'git:diff-commit',

  // Asset diff previews (Phase 17)
  ASSET_DIFF_PREVIEW:      'asset:diff-preview',
  ASSET_RENDER_THUMBNAIL:  'asset:render-thumbnail',
  ASSET_EXTRACT_METADATA:  'asset:extract-metadata',

  // Presence
  PRESENCE_READ:   'presence:read',
  PRESENCE_UPDATE: 'presence:update',

  // Lock Heatmap & Conflict Forecasting — Phase 19
  HEATMAP_COMPUTE:        'heatmap:compute',
  HEATMAP_TIMELINE:       'heatmap:timeline',
  HEATMAP_TOP:            'heatmap:top',
  FORECAST_START:         'forecast:start',
  FORECAST_STOP:          'forecast:stop',
  FORECAST_STATUS:        'forecast:status',
  FORECAST_PAUSE:         'forecast:pause',
  FORECAST_RESUME:        'forecast:resume',
  EVT_FORECAST_CONFLICT:  'evt:forecast-conflict',

  // Dependency-Aware Blame — Phase 18
  DEP_BUILD_GRAPH:       'dep:build-graph',
  DEP_GRAPH_STATUS:      'dep:graph-status',
  DEP_BLAME_ASSET:       'dep:blame-asset',
  DEP_LOOKUP_REFERENCES: 'dep:lookup-references',
  DEP_REFRESH_CACHE:     'dep:refresh-cache',

  // GitHub API
  GITHUB_CREATE_PR: 'github:create-pr',
  GITHUB_LIST_PRS:  'github:list-prs',
  GITHUB_PR_FILES:  'github:pr-files',
  GITHUB_MERGE_PR:  'github:merge-pr',
  GITHUB_CLOSE_PR:  'github:close-pr',

  // PR Monitor — tracks open PRs and notifies on merge/close
  PR_MONITOR_START:  'pr-monitor:start',
  PR_MONITOR_STOP:   'pr-monitor:stop',
  PR_MONITOR_RECORD: 'pr-monitor:record',
  PR_MONITOR_CHECK:  'pr-monitor:check',
  PR_MONITOR_STATUS: 'pr-monitor:status',
  PR_MONITOR_RESOLVE:'pr-monitor:resolve',

  // Undo / checkpoint
  UNDO_GET:           'undo:get',
  UNDO_LAST:          'undo:last',

  // Global search
  SEARCH_REPO:        'search:repo',

  // OS dialogs + shell
  DIALOG_OPEN_DIRECTORY: 'dialog:open-directory',
  DIALOG_OPEN_FILE:      'dialog:open-file',
  SHELL_OPEN_EXTERNAL:   'shell:open-external',
  SHELL_SHOW_IN_FOLDER:  'shell:show-in-folder',
  SHELL_OPEN_PATH:       'shell:open-path',
  SHELL_OPEN_TERMINAL:   'shell:open-terminal',

  // File-system watcher
  GIT_WATCH_STATUS:   'git:watch-status',
  GIT_UNWATCH_STATUS: 'git:unwatch-status',

  // Permissions — Phase 20
  AUTH_FETCH_REPO_PERMISSION: 'auth:fetch-repo-permission',
  AUTH_GET_REPO_PERMISSION:   'auth:get-repo-permission',

  // Bug logs
  LOG_GET_TEXT:      'log:get-text',
  LOG_GET_SUGGESTION:'log:get-suggestion',
  LOG_SAVE_DIALOG:   'log:save-dialog',
  LOG_RENDERER_EVENT:'log:renderer-event',

  // Events: main → renderer (one-way via ipcRenderer.on)
  EVT_OPERATION_PROGRESS: 'evt:operation-progress',
  EVT_LOCK_CHANGED:       'evt:lock-changed',
  EVT_NOTIFICATION:       'evt:notification',
  EVT_UPDATE_AVAILABLE:   'evt:update-available',
  EVT_STATUS_CHANGED:     'evt:status-changed',
  EVT_UNDO_AVAILABLE:     'evt:undo-available',

  // Window controls (frameless)
  WIN_MINIMIZE:          'win:minimize',
  WIN_MAXIMIZE_TOGGLE:   'win:maximize-toggle',
  WIN_CLOSE:             'win:close',
  WIN_IS_MAXIMIZED:      'win:is-maximized',
} as const

export type Channel = typeof CHANNELS[keyof typeof CHANNELS]
