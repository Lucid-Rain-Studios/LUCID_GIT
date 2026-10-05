const { test, expect } = require('@playwright/test')
const { component, find } = require('./renderer-harness')

test('force push dropdown stays available beside a disabled Push and dismisses after selection', () => {
  let calls = 0
  const h = component('src/components/layout/TopBar.tsx', {}, { __privateExports: ['PushDropdown'] })
  const props = { children: { type: 'button', props: { disabled: true } }, disabled: false, contextKey: 'repo:main', onForcePush: () => calls++ }
  let tree = h.render('PushDropdown', props)
  const trigger = find(tree, n => n.props?.['aria-haspopup'] === 'menu')
  expect(trigger.props.disabled).toBe(false)
  trigger.props.onClick()
  tree = h.render('PushDropdown', props)
  find(tree, n => n.props?.role === 'menuitem').props.onClick()
  expect(calls).toBe(1)
  expect(find(h.render('PushDropdown', props), n => n.props?.role === 'menu')).toBeNull()
  expect(find(h.render('PushDropdown', { ...props, disabled: true }), n => n.props?.['aria-haspopup'] === 'menu').props.disabled).toBe(true)
})

test('force push uses lease protection for upstream and unpublished branches without changing normal pushes', async () => {
  const calls = []
  let upstream = true
  const h = component('electron/services/GitService.ts', {
    '../util/dugite-exec': {
      execSafe: async args => args[0] === 'rev-parse' ? { exitCode: upstream ? 0 : 1, stdout: upstream ? 'origin/topic' : '' } : { exitCode: 0, stdout: '' },
      execWithProgress: async args => calls.push(args),
      gitAuthArgs: () => [],
    },
    './AuthService': { authService: { getCurrentToken: async () => null } },
  })
  const service = h.exports.gitService
  service.getRemoteUrl = async () => 'https://example.com/repo.git'
  service.currentBranch = async () => 'topic'
  await service.push('repo')
  await service.push('repo', undefined, true)
  upstream = false
  await service.push('repo', undefined, true)
  expect(calls[0]).not.toContain('--force-with-lease')
  expect(calls[1]).toEqual(['push', '--progress', '--force-with-lease'])
  expect(calls[2]).toEqual(['push', '--progress', '--set-upstream', 'origin', 'topic', '--force-with-lease'])
  expect(calls.flat()).not.toContain('--force')
})
