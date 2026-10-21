const { test, expect, _electron: electron } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')
const { git, tmpDir, cleanup } = require('./helpers')

test.afterAll(cleanup)

function repository(conflict = false) {
  const dir = tmpDir('lg-merge-window-')
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.name', 'Merge Test')
  git(dir, 'config', 'user.email', 'merge@example.com')
  git(dir, 'config', 'core.autocrlf', 'false')
  fs.writeFileSync(path.join(dir, 'shared.txt'), 'base\n')
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'Base')
  git(dir, 'checkout', '-qb', 'feature')
  fs.writeFileSync(path.join(dir, conflict ? 'shared.txt' : 'incoming.txt'), 'feature\n')
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'Incoming work')
  git(dir, 'checkout', '-q', 'main')
  fs.writeFileSync(path.join(dir, conflict ? 'shared.txt' : 'ours.txt'), 'main\n')
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'Main work')
  return dir
}

async function launch() {
  const env = { ...process.env, LUCID_MERGE_TEST_USER_DATA: tmpDir('lg-merge-desktop-') }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({
    executablePath: path.join(__dirname, '../node_modules/electron/dist', fs.readFileSync(path.join(__dirname, '../node_modules/electron/path.txt'), 'utf8').trim()),
    args: ['-r', path.join(__dirname, '../node_modules/playwright-core/lib/server/electron/loader.js'), path.join(__dirname, 'fixtures/merge-window-app.cjs')],
    env,
  })
  const parent = await app.firstWindow()
  await parent.evaluate(() => {
    window.closedRepos = []
    window.lucidGit.onMergeWindowClosed(repo => window.closedRepos.push(repo))
  })
  return { app, parent }
}

async function open(app, parent, repoPath) {
  const next = app.waitForEvent('window')
  await parent.evaluate(context => window.lucidGit.openMergeWindow(context), {
    repoPath, currentBranch: 'main', targetBranch: 'feature',
  })
  const merge = await next
  await expect(merge.getByText('Analyzing conflicts…')).toHaveCount(0)
  await expect(merge.getByText('Merge preview', { exact: true })).toBeVisible()
  return merge
}

test('pending writes reject native close and duplicate actions; failures remain retryable', async () => {
  const dir = repository(), original = git(dir, 'rev-parse', 'HEAD')
  const { app, parent } = await launch()
  try {
    const merge = await open(app, parent, dir)
    await expect(merge.getByRole('button', { name: 'Merge', exact: true })).toBeVisible()
    await app.evaluate(() => {
      const service = global.mergeTestGitService
      const originalMerge = service.merge.bind(service)
      global.mergeAttempts = 0
      service.merge = async (...args) => {
        global.mergeAttempts++
        if (global.mergeAttempts === 1) await new Promise((_, reject) => { global.rejectMerge = () => reject(Error('Injected merge failure')) })
        return originalMerge(...args)
      }
    })
    await merge.getByRole('button', { name: 'Merge', exact: true }).click()
    await expect(merge.getByRole('button', { name: 'Merging…', exact: true })).toBeDisabled()
    await expect.poll(() => app.evaluate(() => global.mergeAttempts), { timeout: 15000 }).toBe(1)
    await expect(merge.getByRole('button', { name: 'Close Merge', exact: true })).toBeDisabled()
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find(w => w.getParentWindow()).close()
      BrowserWindow.getAllWindows().find(w => !w.getParentWindow()).close()
    })
    await merge.keyboard.press('Escape').catch(error => { if (!merge.isClosed()) throw error })
    await expect(merge.getByText('Close Merge window?', { exact: true })).toHaveCount(0)
    expect(app.windows()).toHaveLength(2)
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(original)
    expect(await app.evaluate(() => global.mergeAttempts)).toBe(1)
    await app.evaluate(() => global.rejectMerge())
    await expect(merge.getByText(/Injected merge failure/).first()).toBeVisible()
    await expect(merge.getByRole('button', { name: 'Merge', exact: true })).toBeEnabled()
    const closed = merge.waitForEvent('close')
    await merge.getByRole('button', { name: 'Merge', exact: true }).click()
    await closed
    expect(await app.evaluate(() => global.mergeAttempts)).toBe(2)
    expect(git(dir, 'show', 'HEAD:incoming.txt')).toBe('feature\n')
  } finally { await app.close() }
})

test('failed analysis cannot start a merge and Escape safely closes the window', async () => {
  const dir = repository(), original = git(dir, 'rev-parse', 'HEAD')
  const { app, parent } = await launch()
  try {
    await app.evaluate(() => {
      global.mergeTestGitService.mergePreview = async () => { throw Error('Injected analysis failure') }
    })
    const merge = await open(app, parent, dir)
    await expect(merge.getByText(/Injected analysis failure/).first()).toBeVisible()
    await expect(merge.getByRole('button', { name: 'Merge', exact: true })).toHaveCount(0)
    const closed = merge.waitForEvent('close')
    await merge.keyboard.press('Escape').catch(error => { if (!merge.isClosed()) throw error })
    await closed
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(original)
    await expect.poll(() => parent.evaluate(() => window.closedRepos)).toEqual([dir])
  } finally { await app.close() }
})

test('separate native window resizes/maximizes, deduplicates, preserves context and merges real Git', async () => {
  const dir = repository()
  const { app, parent } = await launch()
  try {
    const merge = await open(app, parent, dir)
    await expect(merge.getByText('This merge can be applied cleanly.')).toBeVisible()
    expect(await app.evaluate(({ BrowserWindow }) => {
      const child = BrowserWindow.getAllWindows().find(w => w.getParentWindow())
      return { modal: child.isModal(), resizable: child.isResizable(), maximizable: child.isMaximizable(), enabled: child.getParentWindow().isEnabled() }
    })).toEqual({ modal: true, resizable: true, maximizable: true, enabled: false })
    await parent.evaluate(context => window.lucidGit.openMergeWindow(context), { repoPath: dir, currentBranch: 'other', targetBranch: 'other' })
    expect(app.windows()).toHaveLength(2)
    expect(await merge.evaluate(() => window.lucidGit.mergeWindowContext())).toEqual({ repoPath: dir, currentBranch: 'main', targetBranch: 'feature' })
    await expect(parent.evaluate(() => window.lucidGit.mergeWindowContext())).rejects.toThrow('Merge window is unavailable')
    await expect(parent.evaluate(() => window.lucidGit.closeMergeWindow())).rejects.toThrow('Only Merge can close')
    await expect(merge.evaluate(() => window.lucidGit.openMergeWindow({ repoPath: 'other', currentBranch: 'main', targetBranch: 'feature' }))).rejects.toThrow('Only the main window')
    await app.evaluate(({ BrowserWindow }) => {
      const child = BrowserWindow.getAllWindows().find(w => w.getParentWindow())
      child.maximize()
    })
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(w => w.getParentWindow() && w.isMaximized()))).toBe(true)
    await app.evaluate(({ BrowserWindow }) => {
      const child = BrowserWindow.getAllWindows().find(w => w.getParentWindow())
      child.unmaximize(); child.setContentSize(640, 480)
    })
    await expect(merge.getByRole('button', { name: 'Merge', exact: true })).toBeInViewport()
    await merge.screenshot({ path: path.join(__dirname, '../test-results/merge-window-small.png') })
    const closed = merge.waitForEvent('close')
    await merge.getByRole('button', { name: 'Merge', exact: true }).click()
    await closed
    expect(git(dir, 'show', 'HEAD:incoming.txt')).toBe('feature\n')
    expect(git(dir, 'show', 'HEAD:ours.txt')).toBe('main\n')
    expect(git(dir, 'show', '-s', '--format=%P').trim().split(' ')).toHaveLength(2)
    await expect.poll(() => parent.evaluate(() => window.closedRepos)).toEqual([dir])
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isEnabled())).toBe(true)
  } finally { await app.close() }
})

test('native close preserves real conflicts, reopen resumes, choices finalize; abort is explicit', async () => {
  const dir = repository(true)
  const { app, parent } = await launch()
  try {
    let merge = await open(app, parent, dir)
    await merge.getByRole('button', { name: 'Merge', exact: true }).click()
    await expect(merge.getByRole('button', { name: 'Complete merge', exact: true })).toBeDisabled()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.getParentWindow()).close())
    await expect(merge.getByText('Close Merge window?', { exact: true })).toBeVisible()
    await merge.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(fs.existsSync(path.join(dir, '.git/MERGE_HEAD'))).toBe(true)
    await merge.getByRole('button', { name: 'Close Merge', exact: true }).click()
    const closed = merge.waitForEvent('close')
    await merge.getByRole('button', { name: 'Close window', exact: true }).click()
    await closed
    expect(fs.existsSync(path.join(dir, '.git/MERGE_HEAD'))).toBe(true)
    merge = await open(app, parent, dir)
    await expect(merge.getByRole('button', { name: 'Complete merge', exact: true })).toBeDisabled()
    await merge.getByRole('button', { name: 'Keep feature', exact: true }).click()
    const finalized = merge.waitForEvent('close')
    await merge.getByRole('button', { name: 'Complete merge', exact: true }).click()
    await finalized
    expect(git(dir, 'show', 'HEAD:shared.txt')).toBe('feature\n')
    expect(fs.existsSync(path.join(dir, '.git/MERGE_HEAD'))).toBe(false)

    const abortRepo = repository(true), original = git(abortRepo, 'rev-parse', 'HEAD')
    merge = await open(app, parent, abortRepo)
    await merge.getByRole('button', { name: 'Merge', exact: true }).click()
    await expect(merge.getByRole('button', { name: 'Abort merge', exact: true })).toBeVisible()
    const aborted = merge.waitForEvent('close')
    await merge.getByRole('button', { name: 'Abort merge', exact: true }).click()
    await aborted
    expect(git(abortRepo, 'rev-parse', 'HEAD')).toBe(original)
    expect(fs.readFileSync(path.join(abortRepo, 'shared.txt'), 'utf8')).toBe('main\n')
    expect(fs.existsSync(path.join(abortRepo, '.git/MERGE_HEAD'))).toBe(false)
  } finally { await app.close() }
})

test('the real app Branches action launches Merge separately and refreshes after completion', async () => {
  const dir = repository()
  const { app, parent } = await launch()
  try {
    await parent.goto(pathToFileURL(path.join(__dirname, '../dist-renderer/index.html')).href)
    await parent.evaluate(dir => localStorage.setItem('lucid-git:recent-repos', JSON.stringify([dir])), dir)
    await parent.reload()
    await parent.getByRole('button', { name: 'Branches', exact: true }).click()
    await parent.getByTitle('Preview "feature"', { exact: true }).hover()
    const next = app.waitForEvent('window')
    await parent.getByTitle('Merge "feature" into main', { exact: true }).click()
    const merge = await next
    await expect(merge.getByText('This merge can be applied cleanly.')).toBeVisible()
    await expect(parent.getByText('Merge preview', { exact: true })).toHaveCount(0)
    await parent.evaluate(() => {
      window.closedRepos = []
      window.lucidGit.onMergeWindowClosed(repo => window.closedRepos.push(repo))
    })
    const closed = merge.waitForEvent('close')
    await merge.getByRole('button', { name: 'Merge', exact: true }).click()
    await closed
    await expect.poll(() => parent.evaluate(() => window.closedRepos)).toEqual([dir])
    expect(git(dir, 'show', 'HEAD:incoming.txt')).toBe('feature\n')
    await expect(parent.getByTitle('Merge "feature" into main', { exact: true })).toBeEnabled()
    await parent.getByTitle('Preview "feature"', { exact: true }).hover()
    const reopened = app.waitForEvent('window')
    await parent.getByTitle('Merge "feature" into main', { exact: true }).click()
    const review = await reopened
    await expect(review.getByText('No changes to merge.', { exact: false })).toBeVisible()
    await review.getByRole('button', { name: 'Cancel', exact: true }).click()
  } finally { await app.close() }
})
