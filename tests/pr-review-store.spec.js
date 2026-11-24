const { test, expect } = require('@playwright/test')
const { component, find } = require('./renderer-harness')

const previous = { repoPath: 'inferius', ghSlug: 'studio/inferius', pr: { number: 766, headBranch: 'dev_previous' } }
const nextPR = { ...previous, pr: { number: 767, headBranch: 'dev_AudioTeam' } }

function createReviewStore() {
  return component('src/stores/prReviewStore.ts', { zustand: require('zustand') }).exports.usePRReviewStore
}

for (const [target, request] of [
  ['another PR', nextPR],
  ['the same PR number in another checkout', { ...previous, repoPath: 'inferius-other' }],
  ['the same PR number on another remote', { ...previous, ghSlug: 'studio/other' }],
]) {
  test(`opening ${target} replaces a retained completed review`, () => {
    const store = createReviewStore()
    store.getState().open(previous)
    store.setState({ minimized: true })
    store.getState().complete(previous.repoPath, previous.pr.number, 'accept')

    store.getState().open(request)

    expect(store.getState().request).toBe(request)
    expect(store.getState().minimized).toBe(false)
    expect(store.getState().completed[previous.repoPath][previous.pr.number]).toBe('accept')
  })
}

test('opening another PR leaves a running review in the background', () => {
  const store = createReviewStore()
  store.getState().open(previous)
  store.setState({ busy: true, minimized: true })

  store.getState().open(nextPR)
  expect(store.getState().request).toBe(previous)
  expect(store.getState().minimized).toBe(true)

  store.getState().open({ ...previous, pr: { ...previous.pr } })
  expect(store.getState().request).toBe(previous)
  expect(store.getState().minimized).toBe(false)
  expect(store.getState().busy).toBe(true)
})

test('closing the active review during a merge only minimizes it', () => {
  const store = createReviewStore()
  store.getState().open(previous)
  store.setState({ busy: true })
  store.getState().close()
  expect(store.getState()).toMatchObject({ request: previous, minimized: true, busy: true })

  store.setState({ busy: false })
  store.getState().close()
  expect(store.getState()).toMatchObject({ request: null, minimized: false })
})

test('completed PRs stay hidden while upstream still lists them and reconciliation is repository scoped', () => {
  const store = createReviewStore()
  store.getState().complete(previous.repoPath, previous.pr.number, 'accept')
  store.getState().complete(previous.repoPath, nextPR.pr.number, 'decline')
  store.getState().complete('other', previous.pr.number, 'decline')
  store.getState().reconcile(previous.repoPath, [nextPR.pr])
  expect(store.getState().completed).toEqual({ inferius: { 767: 'decline' }, other: { 766: 'decline' } })

  store.getState().reconcile(previous.repoPath, [])
  expect(store.getState().completed).toEqual({ inferius: {}, other: { 766: 'decline' } })
})

test('the Overview Resolve button opens the remaining PR while a completed review is retained', () => {
  const store = createReviewStore()
  store.getState().open(previous)
  store.setState({ minimized: true })
  store.getState().complete(previous.repoPath, previous.pr.number, 'accept')
  const card = component('src/components/overview/OverviewPanel.tsx', {
    '@/stores/prReviewStore': {
      usePRReviewStore: Object.assign(selector => selector(store.getState()), { getState: store.getState }),
    },
  }, { __privateExports: ['AdminPRsCard'] })
  const props = { prs: [previous.pr, nextPR.pr], repoPath: previous.repoPath, ghSlug: previous.ghSlug }
  const resolve = () => find(card.render('AdminPRsCard', props), node => node.props?.label === 'Resolve')

  store.setState({ busy: true })
  expect(resolve().props).toMatchObject({ disabled: true, disabledReason: 'Wait for PR #766 to finish.' })
  store.setState({ busy: false })
  const button = resolve()
  expect(button.props.disabled).toBe(false)
  button.props.onClick()
  expect(store.getState()).toMatchObject({ request: nextPR, minimized: false })
})
