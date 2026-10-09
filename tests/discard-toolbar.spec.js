const { test, expect } = require('@playwright/test')
const fs = require('node:fs')
const path = require('node:path')
const { component, find, store } = require('./renderer-harness')
const { DIST, git, tmpDir, cleanup } = require('./helpers')
const { gitService } = require(path.join(DIST, 'services/GitService'))
const flush = () => new Promise(resolve => setImmediate(resolve))

function harness(files, ipc, options = {}) {
  const confirmations = [], unlocked = [], errors = []
  const c = component('src/components/changes/FileTree.tsx', {
    '@/ipc': { ipc: { mergeInProgress: async () => null, ...ipc } },
    '@/stores/operationStore': { useOperationStore: store({ run: (_, fn) => fn() }) },
    '@/stores/dialogStore': { useDialogStore: store({ confirm: async args => { confirmations.push(args); return options.confirm !== false } }) },
    '@/stores/authStore': { useAuthStore: store({ accounts: [{ userId: 'me', login: 'me' }], currentAccountId: 'me' }) },
    '@/stores/lockStore': { useLockStore: store({ unlockFile: async (_, file) => unlocked.push(file) }) },
    '@/stores/repoStore': { useRepoStore: store({ error: null }) },
  }, { alert: error => errors.push(error) })
  const props = { files, repoPath: options.repo || 'repo', locks: files.map(file => ({ path: file.path, owner: { login: 'me' } })), currentUserName: null, onRefresh() {} }
  const render = () => c.render('FileTree', props)
  return { c, render, confirmations, unlocked, errors }
}
const changed = { path: 'changed.txt', indexStatus: 'M', workingStatus: 'M', staged: true }
const staged = { path: 'staged.txt', indexStatus: 'A', workingStatus: ' ', staged: true }
const added = { path: 'added.txt', indexStatus: '?', workingStatus: '?', staged: false }
const files = [changed, staged, added]
const discardButton = tree => find(tree, node => node.props?.label === 'Discard')
const select = tree => {
  const dropdown = find(tree, node => node.type?.name === 'DiscardDropdown')
  return dropdown && { props: { ...dropdown.props, onChange: event => dropdown.props.onDiscard(event.target.value) } }
}

test.afterAll(cleanup)

test('default Discard restores tracked changes and deletes never-staged additions; locks release only after success', async () => {
  const calls = []
  const h = harness(files, { discardAll: async repo => calls.push(['all', repo]), discard: async (...args) => calls.push(['discard', ...args]) })
  discardButton(h.render()).props.onClick(); await flush()
  expect(calls).toEqual([['all', 'repo'], ['discard', 'repo', ['added.txt'], true]])
  expect(h.confirmations[0].detail).toContain('deleted from disk')
  expect(h.unlocked).toEqual(files.map(file => file.path))
})

test('dropdown Changed and Added keep the opposite group intact, and cancellation performs no mutation', async () => {
  for (const scope of ['changed', 'added']) {
    const calls = []
    const h = harness(files, { discard: async (...args) => calls.push(['discard', ...args]), unstage: async (...args) => calls.push(['unstage', ...args]) })
    select(h.render()).props.onChange({ target: { value: scope } }); await flush()
    expect(calls).toEqual(scope === 'changed'
      ? [['discard', 'repo', ['changed.txt'], false]]
      : [['unstage', 'repo', ['staged.txt']], ['discard', 'repo', ['staged.txt', 'added.txt'], true]])
    expect(h.unlocked).toEqual(scope === 'changed' ? ['changed.txt'] : ['staged.txt', 'added.txt'])
    const cancelled = harness(files, { discardAll: async () => { throw Error('must not run') } }, { confirm: false })
    discardButton(cancelled.render()).props.onClick(); await flush()
    expect(cancelled.errors).toEqual([]); expect(cancelled.unlocked).toEqual([])
  }
})

test('added-only changes enable Discard; empty groups disable their dropdown item; a failure keeps locks', async () => {
  const h = harness([added], { discardAll: async () => {}, discard: async () => { throw Error('file is open') } })
  expect(discardButton(h.render()).props.disabled).toBe(false)
  expect(select(h.render()).props.changedDisabled).toBe(true)
  discardButton(h.render()).props.onClick(); await flush()
  expect(h.errors).toContain('Error: file is open'); expect(h.unlocked).toEqual([])
  const failedReset = harness(files, { discardAll: async () => { throw Error('restore rejected') }, discard: async () => { throw Error('must not delete') } })
  discardButton(failedReset.render()).props.onClick(); await flush()
  expect(failedReset.errors).toEqual(['Error: restore rejected']); expect(failedReset.unlocked).toEqual([])
})

test('a merge retains Abort Merge and does not offer destructive Added/Changed options', async () => {
  const calls = []
  const h = harness(files, { mergeInProgress: async () => ({ mergedBranch: 'feature' }), discardAll: async () => calls.push('abort') })
  h.render(); h.c.effects.forEach(effect => effect()); await flush()
  const tree = h.render()
  expect(select(tree)).toBeNull()
  find(tree, node => node.props?.label === 'Abort Merge').props.onClick(); await flush()
  expect(calls).toEqual(['abort']); expect(h.unlocked).not.toContain('added.txt')
})

test('real Git toolbar scopes preserve exact staged/unstaged state for the group kept, including an unborn repository', async () => {
  for (const scope of ['all', 'changed', 'added', 'unborn-added']) {
    const repo = tmpDir('discard-toolbar-')
    git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'core.autocrlf', 'false')
    const unborn = scope === 'unborn-added'
    if (!unborn) {
      fs.writeFileSync(path.join(repo, 'changed.txt'), 'committed\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base')
      fs.writeFileSync(path.join(repo, 'changed.txt'), 'staged\n'); git(repo, 'add', 'changed.txt')
      fs.writeFileSync(path.join(repo, 'changed.txt'), 'unstaged\n')
    }
    fs.writeFileSync(path.join(repo, 'staged.txt'), 'staged addition\n'); git(repo, 'add', 'staged.txt')
    fs.writeFileSync(path.join(repo, 'staged.txt'), 'unstaged addition\n')
    fs.writeFileSync(path.join(repo, 'added.txt'), 'never staged\n')
    const h = harness(unborn ? [staged, added] : files, {
      discardAll: repo => gitService.discardAll(repo),
      discard: (...args) => gitService.discard(...args), unstage: (...args) => gitService.unstage(...args),
    }, { repo })
    if (scope === 'all') discardButton(h.render()).props.onClick()
    else select(h.render()).props.onChange({ target: { value: scope === 'unborn-added' ? 'added' : scope } })
    for (let i = 0; i < 500 && h.unlocked.length === 0 && h.errors.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10))
    expect(h.errors).toEqual([]); expect(h.unlocked.length).toBeGreaterThan(0)
    if (scope === 'changed') {
      expect(fs.readFileSync(path.join(repo, 'changed.txt'), 'utf8')).toBe('committed\n')
      expect(git(repo, 'show', ':staged.txt')).toBe('staged addition\n')
      expect(fs.readFileSync(path.join(repo, 'staged.txt'), 'utf8')).toBe('unstaged addition\n')
      expect(fs.existsSync(path.join(repo, 'added.txt'))).toBe(true)
    } else {
      expect(fs.existsSync(path.join(repo, 'staged.txt'))).toBe(false)
      expect(fs.existsSync(path.join(repo, 'added.txt'))).toBe(false)
      if (scope === 'all' || unborn) expect(git(repo, 'status', '--porcelain')).toBe('')
      else {
        expect(git(repo, 'show', ':changed.txt')).toBe('staged\n')
        expect(fs.readFileSync(path.join(repo, 'changed.txt'), 'utf8')).toBe('unstaged\n')
      }
    }
  }
})

test('Discard Changed restores a staged rename without discarding an unrelated staged addition', async () => {
  const repo = tmpDir('discard-rename-')
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.com')
  fs.writeFileSync(path.join(repo, 'original.txt'), 'original')
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base')
  git(repo, 'mv', 'original.txt', 'renamed.txt')
  fs.writeFileSync(path.join(repo, 'new.txt'), 'keep'); git(repo, 'add', 'new.txt')
  const statuses = await gitService.status(repo)
  expect(statuses.find(file => file.indexStatus === 'R').originalPath).toBe('original.txt')
  const h = harness(statuses, { discard: (...args) => gitService.discard(...args), unstage: (...args) => gitService.unstage(...args) }, { repo })
  select(h.render()).props.onChange({ target: { value: 'changed' } })
  for (let i = 0; i < 500 && h.unlocked.length === 0 && h.errors.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10))
  expect(h.errors).toEqual([]); expect(h.unlocked).toEqual(['renamed.txt'])
  expect(fs.readFileSync(path.join(repo, 'original.txt'), 'utf8')).toBe('original')
  expect(fs.existsSync(path.join(repo, 'renamed.txt'))).toBe(false)
  expect(git(repo, 'show', ':new.txt')).toBe('keep')
})
