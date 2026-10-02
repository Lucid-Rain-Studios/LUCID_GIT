const { test, expect } = require('@playwright/test')
const fs = require('fs'), path = require('path')
const { component, find, store } = require('./renderer-harness')
const { DIST, tmpDir, cleanup } = require('./helpers')
const flush = () => new Promise(resolve => setImmediate(resolve))
test.afterAll(cleanup)

test('LG-042 push unlocks on the resolved default branch and still finishes other branches', async () => {
  const handlers = new Map(), unlocks = [], progress = [], slots = [], resets = []
  let branch = 'develop'
  const { CHANNELS } = require(path.join(DIST, 'ipc/channels'))
  const api = component('electron/ipc/handlers.ts', {
    path: require('path'),
    electron: { ipcMain: { handle: (name, fn) => handlers.set(name, fn) } },
    './channels': { CHANNELS },
    '../util/repo-gate': { withRepoSlot: (repo, mode, fn) => { slots.push([repo, mode]); return fn() } },
    '../services/GitService': { gitService: { push: async () => ({ branch, filesAhead: ['asset.uasset'] }), defaultBranch: async () => 'develop', resetTo: async (...args) => resets.push(args) } },
    '../services/UndoService': { undoService: { recordCheckpoint: async () => {}, markAvailable() {} } },
    '../services/AuthService': { authService: { listAccounts: () => ({ accounts: [{ userId: 1, login: 'test' }], currentAccountId: 1 }) } },
    '../services/LockService': { lockService: { listLocks: async () => [{ id: 'lock', path: 'asset.uasset', owner: { login: 'test' } }], unlockFiles: async (...args) => unlocks.push(args) } },
  })
  api.exports.registerHandlers()
  const event = { sender: { isDestroyed: () => false, send: (...args) => progress.push(args) } }
  await handlers.get(CHANNELS.GIT_PUSH)(event, 'repo')
  expect(unlocks).toHaveLength(1)
  branch = 'main'
  await handlers.get(CHANNELS.GIT_PUSH)(event, 'repo')
  expect(unlocks).toHaveLength(1)
  expect(progress.filter(p => p[1].id === 'push-complete')).toHaveLength(2)
  await handlers.get(CHANNELS.GIT_RESET_TO)(event, 'repo', 'parent', 'soft', 'reviewed-head')
  expect(slots).toEqual([['repo', 'write'], ['repo', 'write'], ['repo', 'write']])
  expect(resets).toEqual([['repo', 'parent', 'soft', 'reviewed-head']])
})

test('LG-068 notification cap/count and durable clear survive reloading service data', async () => {
  const directory = tmpDir('lg-notifications-')
  const loadService = () => component('electron/services/NotificationService.ts', {
    electron: { app: { getPath: () => directory } }, fs, path, crypto: require('crypto'),
  }).exports.notificationService
  const service = loadService()
  let fail = false
  const { useNotificationStore } = component('src/stores/notificationStore.ts', {
    zustand: { create: require('zustand').create },
    '@/ipc': { ipc: { notificationClearAll: async () => { if (fail) throw Error('disk failure'); service.clearAll() } } },
  }).exports
  for (let i = 0; i < 110; i++) useNotificationStore.getState().push(service.push('repo', 'test', `${i}`, 'body'))
  expect(useNotificationStore.getState().notifications).toHaveLength(100)
  expect(useNotificationStore.getState().unreadCount).toBe(100)
  fail = true
  await useNotificationStore.getState().clearAll()
  expect(useNotificationStore.getState().clearError).toContain('disk failure')
  expect(useNotificationStore.getState().notifications).toHaveLength(100)
  fail = false
  await useNotificationStore.getState().clearAll()
  expect(useNotificationStore.getState().unreadCount).toBe(0)
  expect(loadService().list('repo')).toEqual([])
})

test('LG-073 contributions deduplicate loads and invalidate cache on history updates', async () => {
  let calls = 0
  const { contributionData } = component('src/lib/contributionData.ts', {
    '@/ipc': { ipc: { log: async () => { calls++; return [{ hash: `${calls}` }] }, gitGetIdentity: async () => ({ name: 'Test', email: 'test@example.com' }) } },
  }).exports
  const [a, b] = await Promise.all([contributionData('repo', 0), contributionData('repo', 0)])
  expect(a).toEqual(b)
  expect(calls).toBe(1)
  await contributionData('repo', 0)
  expect(calls).toBe(1)
  expect((await contributionData('repo', 1)).commits[0].hash).toBe('2')
})

test('LG-073 graph refreshes after history ticks, debounces and labels bounded coverage', async () => {
  const state = { historyTick: 0 }, requested = []
  const utils = component('src/lib/activityUtils.ts').exports
  let timer
  const graph = component('src/components/dashboard/ContributionGraph.tsx', {
    '@/stores/repoStore': { useRepoStore: store(state) },
    '@/lib/contributionData': { contributionData: async (_, tick) => { requested.push(tick); return { commits: [], identity: { name: '', email: '' } } } },
    '@/lib/activityUtils': utils,
  }, { setTimeout: callback => { timer = callback; return 1 }, clearTimeout() {} })
  graph.render('ContributionGraph', { repoPath: 'repo' })
  graph.effects[0](); await timer(); await flush()
  let tree = graph.render('ContributionGraph', { repoPath: 'repo' })
  expect(JSON.stringify(tree)).toContain('Coverage: ')
  state.historyTick = 1
  graph.render('ContributionGraph', { repoPath: 'repo' })
  graph.effects[0]()
  expect(requested).toEqual([0])
  await timer(); await flush()
  expect(requested).toEqual([0, 1])
  tree = graph.render('ContributionGraph', { repoPath: 'repo' })
  const previous = find(tree, n => n.type?.name === 'NavButton' && n.props.children[0] === '‹').props.onClick
  for (let i = 0; i < 20; i++) previous()
  const year = graph.slots[4]
  expect(year).toBeGreaterThanOrEqual(new Date().getFullYear() - 5)
})

test('LG-080 diff options and theme follow live appearance settings without remounting', () => {
  const state = { settings: { theme: 'dark', fontSize: 18, codeFontFamily: 'Fira Code' } }
  const themes = ['dark', 'nord'].map((id, i) => ({ id, vars: { '--lg-bg-primary': i ? '#111111' : '#222222', '--lg-text-primary': '#eeeeee', '--lg-text-secondary': '#999999' } }))
  const panel = component('src/components/diff/TextDiff.tsx', {
    '@/stores/appearanceStore': { useAppearanceStore: store(state) },
    '@/lib/appearance': { THEMES: themes },
  })
  const props = { diff: { oldContent: 'A', newContent: 'B', language: 'text' } }
  let tree = panel.render('TextDiff', props)
  let editor = find(tree, n => n.props?.beforeMount)
  expect(editor.props.options.fontSize).toBe(18)
  expect(editor.props.options.fontFamily).toContain('Fira Code')
  const definitions = []
  editor.props.beforeMount({ editor: { defineTheme: (_, definition) => definitions.push(definition), setTheme() {} } })
  state.settings = { theme: 'nord', fontSize: 20, codeFontFamily: 'Consolas' }
  tree = panel.render('TextDiff', props)
  panel.effects[0]()
  editor = find(tree, n => n.props?.beforeMount)
  expect(editor.props.options.fontSize).toBe(20)
  expect(editor.props.key).toBeUndefined()
  expect(definitions[1].colors['editor.background']).toBe('#111111')
})
