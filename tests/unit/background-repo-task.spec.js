const { test, expect } = require('@playwright/test')
const { component, store } = require('../renderer-harness')

function setup() {
  const { useBackgroundRepoTaskStore: background } = component('src/stores/backgroundRepoTaskStore.ts', {
    zustand: require('zustand'),
  }).exports
  const merge = { task: null }
  const pr = { busy: false }
  const mount = repo => {
    const hook = component('src/lib/useBackgroundRepoTask.ts', {
      '@/stores/backgroundRepoTaskStore': {
        useBackgroundRepoTaskStore: Object.assign(selector => selector(background.getState()), {
          getState: background.getState, setState: background.setState,
        }),
      },
      '@/stores/mergeWindowStore': { useMergeWindowStore: store(merge) },
      '@/stores/prReviewStore': { usePRReviewStore: store(pr) },
    })
    return () => hook.render('useBackgroundRepoTask', repo)
  }
  return { mount, background, merge, pr }
}

test('two confirmations before a rerender can start only one repository task', () => {
  const { mount, background } = setup()
  const push = mount('repo')
  const cherryPick = mount('repo')
  const secondConfirm = cherryPick().begin
  expect(push().begin('Pushing')).toBe(true)
  expect(secondConfirm('Finishing cherry-pick')).toBe(false)
  expect(push()).toMatchObject({ running: true, hidden: true, stage: 'Pushing' })
  expect(cherryPick()).toMatchObject({ running: false, blocked: true })
  expect(background.getState().repoPath).toBe('repo')
})

test('PR operations and unresolved local merges block background task confirmation', () => {
  const { mount, merge, pr } = setup()
  const task = mount('repo')
  const confirm = task().begin
  pr.busy = true
  expect(confirm('Pushing')).toBe(false)
  pr.busy = false
  for (const phase of ['running', 'attention']) {
    merge.task = { phase }
    expect(confirm('Pushing')).toBe(false)
  }
  merge.task = { phase: 'complete' }
  expect(confirm('Pushing')).toBe(true)
})

test('failed tasks release the repository and a retry clears the prior failure', () => {
  const { mount, background } = setup()
  const task = mount('repo')
  expect(mount(null)().begin('Pushing')).toBe(false)
  expect(task().begin('Pushing')).toBe(true)
  task().finish('Remote rejected push')
  expect(task()).toMatchObject({ running: false, stage: 'Needs attention', failure: 'Remote rejected push' })
  expect(background.getState().repoPath).toBeNull()
  expect(task().begin('Retrying push')).toBe(true)
  expect(task()).toMatchObject({ running: true, stage: 'Retrying push', failure: null })
  task().finish()
  expect(background.getState().repoPath).toBeNull()
})
