const { test, expect } = require('@playwright/test')
const { component } = require('../renderer-harness')

function setup({ focused = true, pauseFails = false } = {}) {
  let now = 100
  const ipcCalls = []
  const timers = new Map()
  const { useOperationStore: store } = component('src/stores/operationStore.ts', {
    zustand: require('zustand'),
    '@/ipc': { ipc: {
      forecastPause: async () => {
        ipcCalls.push('pause')
        if (pauseFails) throw Error('forecast unavailable')
      },
      forecastResume: async () => { ipcCalls.push('resume') },
      notifyDesktop: async notice => { ipcCalls.push(notice) },
    } },
  }, {
    Date: { now: () => now },
    Error,
    document: { hasFocus: () => focused },
    setTimeout: (fn, delay) => {
      const id = Symbol()
      timers.set(id, { fn, delay })
      return id
    },
    clearTimeout: id => timers.delete(id),
  }).exports
  return { state: store.getState, ipcCalls, timers, advance: ms => { now += ms } }
}

test('operation progress never moves backwards across overlapping Git and LFS phases', () => {
  const { state } = setup()
  state().start('Push')
  state().updateStep({ id: 'lfs-up', progress: 100, status: 'done' })
  state().updateStep({ id: 'write', progress: 40, status: 'running' })
  expect(state().latestStep).toMatchObject({ id: 'write', overallProgress: 93 })
  state().updateStep({ id: 'write', progress: 100, status: 'done' })
  expect(state().steps.map(step => step.id)).toEqual(['lfs-up', 'write'])
  state().updateStep({ id: 'unlock-batch', progress: 150, status: 'done' })
  expect(state().maxProgress).toBe(100)
  state().start('Pull')
  expect(state()).toMatchObject({ maxProgress: 0, steps: [], latestStep: null })
})

test('starting a foreground operation cancels auto-finish from a prior lock action', () => {
  const { state, timers } = setup()
  state().updateStep({ id: 'lock', label: 'Lock file', status: 'done' })
  expect(state()).toMatchObject({ isRunning: true, autoStarted: true })
  expect([...timers.values()].map(timer => timer.delay)).toEqual([650])

  state().start('Push')
  expect(timers.size).toBe(0)
  expect(state()).toMatchObject({ label: 'Push', isRunning: true, autoStarted: false, steps: [] })
})

test('an implicit operation surfaces terminal failure and expires its feedback', () => {
  const { state, timers } = setup()
  state().updateStep({ id: 'unlock', label: 'Unlock', status: 'error', detail: 'Access denied' })
  const [autoFinish] = timers.values()
  autoFinish.fn()
  expect(state()).toMatchObject({ isRunning: false, feedback: { kind: 'error', details: 'Access denied' } })
  const [feedback] = timers.values()
  expect(feedback.delay).toBe(10000)
  feedback.fn()
  expect(state().feedback).toBeNull()
})

test('foreground work completes and resumes polling even if pausing it fails', async () => {
  const { state, ipcCalls, advance } = setup({ pauseFails: true })
  const result = await state().run('Fetch…', async () => {
    expect(state()).toMatchObject({ isRunning: true, label: 'Fetch…' })
    advance(6000)
    return 'fetched'
  })
  expect(result).toBe('fetched')
  expect(ipcCalls).toEqual(['pause', 'resume'])
  expect(state()).toMatchObject({ isRunning: false, feedback: { kind: 'success', text: 'Fetch complete' } })
})

test('foreground failure preserves the error, resumes polling and notifies an unfocused window', async () => {
  const { state, ipcCalls, advance } = setup({ focused: false })
  const error = Error('Remote rejected the push')
  await expect(state().run('Push', async () => {
    advance(5000)
    throw error
  })).rejects.toBe(error)
  expect(ipcCalls).toEqual(['pause', {
    event: 'operationComplete', title: 'Push failed', body: error.message, urgent: true,
  }, 'resume'])
  expect(state()).toMatchObject({ isRunning: false, feedback: { kind: 'error', details: error.message } })
})
