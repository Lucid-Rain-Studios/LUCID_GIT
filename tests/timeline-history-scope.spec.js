const { test, expect } = require('@playwright/test')
const path = require('node:path')
const http = require('node:http')
const { DIST, git, tmpDir, cleanup } = require('./helpers')
const { gitService } = require(path.join(DIST, 'services/GitService'))

test.afterAll(cleanup)

test('Timeline switches between HEAD history and fetched branches without mixing late results', async ({ page }) => {
  const remote = tmpDir('lg-timeline-remote-')
  const peer = tmpDir('lg-timeline-peer-')
  const repo = tmpDir('lg-timeline-local-')
  git(remote, 'init', '--bare', '-b', 'main')
  git(peer, 'clone', remote, '.')
  git(peer, 'config', 'user.email', 'peer@example.com')
  git(peer, 'config', 'user.name', 'Peer')
  git(peer, 'commit', '--allow-empty', '-m', 'Shared base')
  git(peer, 'push', 'origin', 'main')
  git(peer, 'push', 'origin', 'main:shared-tip')
  git(repo, 'clone', remote, '.')
  git(repo, 'config', 'user.email', 'local@example.com')
  git(repo, 'config', 'user.name', 'Local author')
  git(repo, 'commit', '--allow-empty', '-m', 'Local unpublished change')
  git(peer, 'switch', '-c', 'side')
  git(peer, 'commit', '--allow-empty', '-m', 'Merged side change')
  git(peer, 'switch', '-c', 'team', 'main')
  git(peer, 'merge', '--no-ff', 'side', '-m', 'Team integration')
  git(peer, 'push', 'origin', 'team')

  const root = path.resolve(__dirname, '..')
  const bundle = await require('esbuild').build({
    stdin: {
      contents: `import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { TimelinePanel } from './src/components/timeline/TimelinePanel';
        import { useRepoStore } from './src/stores/repoStore';
        import './src/index.css';
        window.historyChanged = useRepoStore.getState().bumpHistoryTick;
        createRoot(document.getElementById('root')).render(<TimelinePanel repoPath="repo" />);`,
      resolveDir: root,
      loader: 'tsx',
    },
    alias: { '@': path.join(root, 'src') },
    outfile: 'app.js',
    bundle: true,
    format: 'esm',
    write: false,
  })
  let blockGlobal
  let globalStarted
  const logReads = []
  await page.exposeFunction('listFixtureBranches', () => gitService.branchList(repo))
  await page.exposeFunction('readFixtureLog', async args => {
    logReads.push(args)
    if (args.limit === 30) return [] // Ready for PR is outside the graph scope.
    const commits = await gitService.log(repo, args)
    if (blockGlobal && args.refs?.includes('origin/team')) {
      globalStarted()
      await blockGlobal
    }
    return commits
  })
  await page.addInitScript(() => {
    window.lucidGit = {
      branchList: () => window.listFixtureBranches(),
      gitDefaultBranch: async () => 'main',
      getRemoteUrl: async () => null,
      getSyncStatus: async () => ({ ahead: 0, behind: 0, hasUpstream: false }),
      log: async (_, args) => {
        const commits = await window.readFixtureLog(args)
        if (args.refs?.includes('origin/team')) window.globalHistoryResponses = (window.globalHistoryResponses ?? 0) + 1
        return commits
      },
      mergeInProgress: async () => null,
      forecastPause: async () => {},
      forecastResume: async () => {},
      logRendererEvent: async () => {},
    }
  })
  const server = http.createServer((req, res) => {
    const asset = bundle.outputFiles.find(file => `/${path.basename(file.path)}` === req.url)
    if (asset) {
      res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css' : 'text/javascript')
      return res.end(asset.contents)
    }
    res.setHeader('Content-Type', 'text/html')
    res.end('<link rel="stylesheet" href="/app.css"><div id="root" style="display:flex;height:95vh"></div><script type="module" src="/app.js"></script>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

  const message = text => page.getByText(text, { exact: true })
  const sharedTip = page.getByText('•shared-tip', { exact: true })
  const branchFilter = page.getByRole('button', { name: /^\d+ branches?$/ })
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  const refresh = async () => {
    const previousReads = logReads.filter(args => args.limit === 150).length
    await page.evaluate(() => window.historyChanged())
    await expect.poll(() => logReads.filter(args => args.limit === 150).length).toBeGreaterThan(previousReads)
    await expect(page.getByTitle('Refresh history')).toBeEnabled()
  }
  let releaseGlobal
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await expect(page.getByRole('button', { name: 'Global', exact: true })).toBeVisible()
    await expect(message('Local unpublished change')).toBeVisible()
    await expect(sharedTip).toBeVisible()
    await expect(branchFilter).toBeVisible()
    await expect(page.getByTitle('Show only commits ready to push', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Global', exact: true }).press('Enter')
    await expect(page.getByRole('button', { name: 'Local', exact: true })).toBeVisible()
    await expect(message('Local unpublished change')).toBeVisible()
    await expect(sharedTip).toHaveCount(0)
    await expect(branchFilter).toHaveCount(0)

    git(repo, 'fetch', 'origin')
    await refresh()
    await expect(message('Team integration')).toHaveCount(0)
    const started = new Promise(resolve => { globalStarted = resolve })
    blockGlobal = new Promise(resolve => { releaseGlobal = resolve })
    await page.getByRole('button', { name: 'Local', exact: true }).click()
    await started
    await page.getByRole('button', { name: 'Global', exact: true }).click()
    await expect(message('Local unpublished change')).toBeVisible()
    releaseGlobal()
    await expect.poll(() => page.evaluate(() => window.globalHistoryResponses)).toBe(1)
    blockGlobal = null
    await expect(message('2 Commits')).toBeVisible()
    await expect(message('Team integration')).toHaveCount(0)

    await page.getByRole('button', { name: 'Local', exact: true }).click()
    await expect(message('Team integration')).toBeVisible()
    await expect(message('Merged side change')).toBeVisible()
    await page.getByRole('button', { name: 'Global', exact: true }).click()
    await expect(message('Local unpublished change')).toBeVisible()
    await expect(message('Team integration')).toHaveCount(0)

    git(repo, 'pull', '--no-rebase', 'origin', 'team')
    await refresh()
    await expect(message('Team integration')).toBeVisible()
    await expect(message('Merged side change')).toBeVisible()
    await expect(message('Local unpublished change')).toBeVisible()
    await expect(page.getByText('•team', { exact: true })).toHaveCount(0)
    expect(logReads.filter(args => args.limit === 150 && !args.refs).length).toBeGreaterThan(1)
    expect(logReads.every(args => args.limit <= 150 && !args.all)).toBe(true)

    git(repo, 'switch', '--detach', 'origin/team')
    await refresh()
    await expect(message('Team integration')).toBeVisible()
    await expect(message('Local unpublished change')).toHaveCount(0)

    git(repo, 'switch', 'main')
    git(repo, 'remote', 'remove', 'origin')
    await page.reload()
    await expect(message('Local unpublished change')).toBeVisible()
    await page.getByRole('button', { name: 'Global', exact: true }).click()
    await expect(message('Local unpublished change')).toBeVisible()
    expect(pageErrors).toEqual([])
  } catch (error) {
    error.message += `\nRenderer errors: ${pageErrors.join(' | ')}\nPage: ${await page.locator('body').innerText()}`
    throw error
  } finally {
    releaseGlobal?.()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})
