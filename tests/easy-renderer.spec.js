const { test, expect } = require('@playwright/test')
const { component, find, store } = require('./renderer-harness')
const flush = () => new Promise(resolve => setImmediate(resolve))
function deferred() { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

test('LG-012 migration requires confirmation and cancels without IPC', async () => {
  const calls = [], confirmations = []
  let approved = false
  const panel = component('src/components/errors/ErrorPanel.tsx', {
    '@/ipc': { ipc: { lfsMigrate: async (...args) => calls.push(args) } },
    '@/stores/repoStore': { useRepoStore: store({ repoPath: 'project', currentBranch: 'main' }) },
    '@/stores/errorStore': { useErrorStore: store({ current: { repoPath: 'project', severity: 'error', causes: [], fixes: [{}] }, history: [] }) },
    '@/stores/dialogStore': { useDialogStore: store({ confirm: async opts => { confirmations.push(opts); return approved } }) },
  })
  const tree = panel.render('ErrorPanel', {})
  const dispatch = find(tree, node => node.props?.onDispatch)?.props.onDispatch
  await dispatch({ type: 'run-lfs-migrate', patterns: ['*.uasset'] })
  expect(calls).toHaveLength(0)
  expect(confirmations[0].danger).toBe(true)
  expect(confirmations[0].message).toContain('all branches and tags')
  approved = true
  await dispatch({ type: 'run-lfs-migrate', patterns: ['*.uasset'] })
  expect(calls).toEqual([['project', ['*.uasset']]])
})

test('LG-027 repeated shortcut starts only one native commit workflow', async () => {
  const hook = deferred(), calls = []
  const state = { repoPath: 'A', fileStatus: [{ staged: true, path: 'file' }], refreshStatus: async () => {}, bumpSyncTick() {} }
  const panel = component('src/components/changes/CommitBox.tsx', {
    '@/ipc': { ipc: { commit: () => { calls.push('commit'); return hook.promise }, fetch: async () => {} } },
    '@/stores/repoStore': { useRepoStore: store(state) },
    '@/stores/operationStore': { useOperationStore: store({ run: (_, fn) => fn() }) },
    '@/stores/errorStore': { useErrorStore: store({ pushRaw() {} }) },
    '@/stores/dialogStore': { useDialogStore: store({ confirm: async () => true }) },
    '@/lib/fetchState': { markFetchPerformed() {} },
  })
  let tree = panel.render('CommitBox')
  find(tree, n => n.type === 'input').props.onChange({ target: { value: 'commit title' } })
  tree = panel.render('CommitBox')
  const click = find(tree, n => n.props?.onClick?.name === 'handleCommit').props.onClick
  const first = click(), second = click()
  await flush()
  expect(calls).toEqual(['commit'])
  hook.resolve({ exists: false, exitCode: 0, durationMs: 1 })
  await Promise.all([first, second])
  expect(calls).toEqual(['commit'])
})

test('LG-028 drafts survive repository switches without carrying into another repo', () => {
  const state = { repoPath: 'draft-A', fileStatus: [], refreshStatus() {}, bumpSyncTick() {} }
  const panel = component('src/components/changes/CommitBox.tsx', {
    '@/stores/repoStore': { useRepoStore: store(state) },
    '@/stores/operationStore': { useOperationStore: store({}) },
    '@/stores/errorStore': { useErrorStore: store({}) },
    '@/stores/dialogStore': { useDialogStore: store({}) },
  })
  let tree = panel.render('CommitBox')
  let cleanup = panel.effects[0]()
  find(tree, n => n.type === 'input').props.onChange({ target: { value: 'A draft' } })
  panel.render('CommitBox')
  state.repoPath = 'draft-B'
  panel.render('CommitBox')
  cleanup()
  cleanup = panel.effects[0]()
  tree = panel.render('CommitBox')
  expect(find(tree, n => n.type === 'input').props.value).toBe('')
  find(tree, n => n.type === 'input').props.onChange({ target: { value: 'B draft' } })
  panel.render('CommitBox')
  state.repoPath = 'draft-A'
  panel.render('CommitBox')
  cleanup()
  panel.effects[0]()
  tree = panel.render('CommitBox')
  expect(find(tree, n => n.type === 'input').props.value).toBe('A draft')
})

test('LG-052 late preview success does not replace the selected asset', async () => {
  const a = deferred(), b = deferred()
  const panel = component('src/components/diff/AssetDiffViewer.tsx', {
    '@/ipc': { ipc: { assetDiffPreview: (_, file) => file === 'a.uasset' ? a.promise : b.promise } },
  })
  panel.render('AssetDiffViewer', { repoPath: 'repo', file: { path: 'a.uasset' }, staged: false })
  const cleanup = panel.effects[0]()
  panel.render('AssetDiffViewer', { repoPath: 'repo', file: { path: 'b.uasset' }, staged: false })
  cleanup()
  panel.effects[0]()
  b.resolve({ assetType: 'binary', marker: 'B' })
  await flush()
  a.resolve({ assetType: 'binary', marker: 'A' })
  await flush()
  expect(panel.slots[0].marker).toBe('B')
  expect(panel.slots[1]).toBe(false)
})

test('LG-058 PR typing and chosen base survive late defaults; all dismissals wait for submission', async () => {
  const diff = deferred(), base = deferred(), submit = deferred()
  let closed = 0, dismiss, escape
  const state = { open: true, repoPath: 'repo', headBranch: 'feature/test', remoteUrl: 'https://github.com/org/repo.git', closeDialog: () => closed++ }
  const panel = component('src/components/pr/PRDialog.tsx', {
    '@/ipc': { ipc: { gitDefaultBranch: () => base.promise, branchDiff: () => diff.promise, githubCreatePR: () => submit.promise, prMonitorRecord: async () => {} } },
    '@/stores/prStore': { usePRStore: store(state) },
    '@/stores/repoStore': { useRepoStore: store({ branches: [], bumpPrTick() {} }) },
    '@/stores/lockStore': { useLockStore: store({ locks: [] }) },
    '@/stores/authStore': { useAuthStore: store({ accounts: [] }) },
    '@/stores/statusToastStore': { useStatusToastStore: store({ show() {} }) },
    '@/lib/useDialogOverlayDismiss': { useDialogOverlayDismiss: callback => { dismiss = callback; return {} } },
  }, { window: { addEventListener: (_, callback) => { escape = callback }, removeEventListener() {} } })
  let tree = panel.render('PRDialog')
  panel.effects[0](); panel.effects[1](); panel.effects[2]()
  find(tree, n => n.type?.name === 'TextInput').props.onChange('Typed title')
  find(tree, n => n.type?.name === 'TextArea').props.onChange('Typed body')
  find(tree, n => n.type?.name === 'SelectInput').props.onChange('develop')
  base.resolve('main'); diff.resolve({ aheadCommits: [{ message: 'generated', hash: 'abcdef', author: 'Test' }] })
  await flush()
  tree = panel.render('PRDialog')
  expect(find(tree, n => n.type?.name === 'TextInput').props.value).toBe('Typed title')
  expect(find(tree, n => n.type?.name === 'TextArea').props.value).toBe('Typed body')
  expect(find(tree, n => n.type?.name === 'SelectInput').props.value).toBe('develop')
  const pending = find(tree, n => n.props?.onClick?.name === 'submit').props.onClick()
  dismiss(); escape({ key: 'Escape' })
  find(tree, n => n.type === 'button' && n.props.className === 'lg-compact-icon-button').props.onClick()
  expect(closed).toBe(0)
  submit.resolve({ number: 1, htmlUrl: 'url', title: 'Typed title' })
  await pending
  dismiss()
  expect(closed).toBe(1)
})

for (const name of ['AppearanceSettings', 'GeneralSettings', 'NotificationSettings', 'TeamConfigPanel', 'WebhookPanel']) {
  test(`LG-066 ${name} shows load and save failures and permits manual retry`, async () => {
    let fail = true, saves = 0
    const settings = { theme: 'dark', scheduledCleanup: {}, featureVisibility: {}, lfsPatterns: [], hookIds: [] }
    const ipc = new Proxy({}, { get: (_, key) => {
      if (['settingsGet', 'teamConfigLoad', 'webhookLoad'].includes(key)) return async () => { if (fail) throw Error('load failed'); return key === 'webhookLoad' ? null : settings }
      if (['settingsSave', 'teamConfigSave', 'webhookSave'].includes(key)) return async () => { saves++; throw Error('save failed') }
      if (key.startsWith('on')) return () => () => {}
      return async () => []
    } })
    const appearance = { THEMES: [], UI_FONTS: [], CODE_FONTS: [], FONT_WEIGHTS: [], BORDER_RADII: [], ACCENT_PRESETS: [], applyAppearanceSettings() {} }
    const panel = component(`src/components/settings/${name}.tsx`, { '@/ipc': { ipc }, '@/lib/appearance': appearance })
    panel.render(name, { repoPath: 'repo' })
    panel.effects[0]()
    await flush()
    let tree = panel.render(name, { repoPath: 'repo' })
    expect(tree.props.error).toContain('load failed')
    expect(saves).toBe(0)
    fail = false
    await tree.props.onRetry()
    tree = panel.render(name, { repoPath: 'repo' })
    await find(tree, n => n.props?.onClick?.name === 'handleSave').props.onClick()
    tree = panel.render(name, { repoPath: 'repo' })
    expect(find(tree, n => n.props?.error?.includes('save failed'))).not.toBeNull()
    expect(saves).toBe(1)
  })
}

test('LG-072 Timeline selects local branches when no remote exists', () => {
  const { timelineBranches } = component('src/lib/timelineBranches.ts').exports
  const main = { name: 'main', isRemote: false, current: true }, feature = { name: 'feature', isRemote: false }
  expect(timelineBranches([main, feature])).toEqual([main, feature])
  expect(timelineBranches([main, { name: 'origin/main', isRemote: true }]).map(b => b.name)).toEqual(['origin/main'])
})

test('LG-046 forecast view states its bounded coverage even for an empty result', () => {
  const panel = component('src/components/heatmap/ForecastPanel.tsx')
  const tree = panel.render('ForecastPanel', { conflicts: [], enabled: true, lastPolledAt: null })
  expect(JSON.stringify(tree)).toContain('first 10 remote branches')
})

test('LG-079 file actions send repository and relative path without platform conversion', () => {
  const calls = []
  const panel = component('src/components/changes/FileRow.tsx', {
    '@/ipc': { ipc: { showInFolder: (...args) => calls.push(args), openPath: (...args) => calls.push(args) } },
    '@/stores/forecastStore': { useForecastStore: store({ conflicts: [] }) },
    '@/stores/assetViewerStore': { useAssetViewerStore: store({}) },
    '@/stores/lockStore': { useLockStore: store({}) },
    '@/stores/authStore': { useAuthStore: store({ isAdmin: () => false }) },
    '@/stores/dialogStore': { useDialogStore: store({}) },
  })
  const props = { repoPath: '/home/project', file: { path: 'Content/file.txt', staged: false }, lock: null }
  let tree = panel.render('FileRow', props)
  find(tree, n => n.props?.onContextMenu).props.onContextMenu({ preventDefault() {}, clientX: 0, clientY: 0 })
  tree = panel.render('FileRow', props)
  find(tree, n => n.props?.onClick?.name === 'doShowInExplorer').props.onClick()
  find(tree, n => n.props?.onClick?.name === 'doOpenDefault').props.onClick()
  expect(calls).toEqual([['/home/project', 'Content/file.txt'], ['/home/project', 'Content/file.txt']])
})

test('LG-013 Unreal settings read and write the real locksverify key', async () => {
  const reads = [], writes = []
  const ipc = new Proxy({}, { get: (_, name) => async (...args) => {
    if (name === 'getGitConfig') { reads.push(args); return 'false' }
    if (name === 'setGitConfig') { writes.push(args); return }
    if (name === 'ueTemplates') return { gitattributes: '', gitignore: '' }
    return null
  } })
  const panel = component('src/components/unreal/UnrealPanel.tsx', {
    '@/ipc': { ipc },
    '@/stores/repoStore': { useRepoStore: store({ fileStatus: [] }) },
    '@/stores/authStore': { useAuthStore: store({ accounts: [] }) },
  })
  const tree = panel.render('UnrealPanel', { repoPath: 'project' })
  await panel.effects[0]()
  await find(tree, node => node.props?.onClick?.toString().includes("run('lockverify'" )).props.onClick()
  expect(reads.every(args => args[1] === 'lfs.locksverify')).toBe(true)
  expect(writes).toEqual([['project', 'lfs.locksverify', 'true']])
})
