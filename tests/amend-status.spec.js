const { test, expect } = require('@playwright/test')
const { component, find, store } = require('./renderer-harness')

const flush = () => new Promise(resolve => setImmediate(resolve))
function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

test('amend status stays visible during refresh, reserves badge space and clears on failure or repo switch', async () => {
  const checks = []
  const state = { repoPath: 'A', fileStatus: [], historyTick: 0, syncTick: 0 }
  const panel = component('src/components/changes/CommitBox.tsx', {
    '@/ipc': { ipc: {
      lastCommitMessage: async repo => `${repo} commit`,
      isHeadPushed: () => { const check = deferred(); checks.push(check); return check.promise },
    } },
    '@/stores/repoStore': { useRepoStore: store(state) },
    '@/stores/operationStore': { useOperationStore: store({}) },
    '@/stores/errorStore': { useErrorStore: store({}) },
    '@/stores/dialogStore': { useDialogStore: store({}) },
  })
  const render = () => panel.render('CommitBox')
  const badge = tree => find(tree, n => n.type === 'span' && n.props.children?.[0] === 'PUSHED')
  const checkbox = tree => find(tree, n => n.type === 'AppCheckbox')

  render()
  let cleanup = panel.effects[1]()
  checks[0].resolve(true)
  await flush()
  let tree = render()
  expect(badge(tree).props['aria-hidden']).toBe(false)
  expect(checkbox(tree).props.disabled).toBe(true)

  // Replacing the status array used to clear the badge until IPC completed.
  state.fileStatus = []
  cleanup()
  render()
  cleanup = panel.effects[1]()
  tree = render()
  expect(badge(tree).props['aria-hidden']).toBe(false)
  expect(badge(tree).props.className).not.toContain('invisible')
  expect(find(tree, n => n.type === 'label').props.title).toContain('already pushed')
  checks[1].resolve(false)
  await flush()
  tree = render()
  expect(checkbox(tree).props.disabled).toBe(false)
  expect(badge(tree).props.className).toContain('invisible')
  expect(badge(tree).props.className).not.toContain('hidden')
  expect(badge(tree).props['aria-hidden']).toBe(true)

  state.syncTick++
  cleanup()
  render()
  cleanup = panel.effects[1]()
  tree = render()
  expect(checkbox(tree).props.disabled).toBe(false)
  checks[2].reject(new Error('Unavailable'))
  await flush()
  tree = render()
  expect(checkbox(tree).props.disabled).toBe(true)
  expect(find(tree, n => n.type === 'label').props.title).toContain('Unable to verify')

  state.historyTick++
  cleanup()
  render()
  cleanup = panel.effects[1]()
  state.repoPath = 'B'
  cleanup()
  render()
  cleanup = panel.effects[1]()
  tree = render()
  expect(find(tree, n => n.type === 'label')).toBeNull()
  checks[3].resolve(false)
  await flush()
  expect(find(render(), n => n.type === 'label')).toBeNull()
  checks[4].resolve(true)
  await flush()
  tree = render()
  expect(find(tree, n => n.type === 'label').props.title).toContain('already pushed')
  expect(find(tree, n => n.type === 'span' && n.props.children?.[0] === 'B commit')).not.toBeNull()
  cleanup()
})
