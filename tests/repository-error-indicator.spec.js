const { test, expect, chromium } = require('@playwright/test')
const fs = require('node:fs'), path = require('node:path'), esbuild = require('esbuild')
const root = path.join(__dirname, '..')
let browser, bundle, css
test.beforeAll(async () => {
  bundle = (await esbuild.build({
    absWorkingDir: root, bundle: true, write: false, jsx: 'automatic',
    stdin: { resolveDir: root, loader: 'jsx', contents: `
      import React from 'react';import {createRoot} from 'react-dom/client';
      import {RepositoryRefreshWarning} from './src/components/layout/RepositoryRefreshWarning';
      import {RepositoryErrorIndicator} from './src/components/layout/RepositoryErrorIndicator';
      import {ClearLockCacheButton} from './src/components/locks/ClearLockCacheButton';
      import {ErrorPanel} from './src/components/errors/ErrorPanel';
      import {useRepoStore} from './src/stores/repoStore';
      import {useErrorStore} from './src/stores/errorStore';
      import {useRepositoryIssueStore} from './src/stores/repositoryIssueStore';
      import {ipc} from './src/ipc';
      window.store=useRepoStore;window.errors=useErrorStore;window.issues=useRepositoryIssueStore;window.api=ipc;
      createRoot(document.getElementById('root')).render(<><nav style={{display:'flex',gap:6,padding:16}}>
        <RepositoryRefreshWarning/><RepositoryErrorIndicator/><button className="lg-toolbar-control" style={{height:28,borderRadius:5,padding:'0 10px'}}>Fetch</button>
        <ClearLockCacheButton repoPath="C:/repo"/></nav>
        <ErrorPanel onReauth={()=>{}} onNavigateTab={()=>{}} onOpenMergeResolver={()=>{}}/></>);` },
    plugins: [{ name: 'fixture', setup(build) {
      build.onResolve({ filter: /(^|\/)operationStore$/ }, () => ({ path: 'operations', namespace: 'fixture' }))
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'js', contents: `const state={run:async(_,fn)=>fn()};export const useOperationStore=selector=>selector?selector(state):state;useOperationStore.getState=()=>state;` }))
      build.onResolve({ filter: /^@\// }, args => {
        const base = path.join(root, 'src', args.path.slice(2))
        return { path: ['.tsx', '.ts'].map(ext => base + ext).find(fs.existsSync) }
      })
    } }],
  })).outputFiles[0].text
  css = (await require('postcss')([require('tailwindcss')(require('../tailwind.config'))]).process(fs.readFileSync(path.join(root, 'src/index.css'), 'utf8'), { from: path.join(root, 'src/index.css') })).css
  const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  browser = await chromium.launch({ headless: true, ...(fs.existsSync(chrome) ? { executablePath: chrome } : {}) })
})
test.afterAll(async () => { await browser?.close() })

async function mount(width = 1000) {
  const page = await browser.newPage({ viewport: { width, height: 700 } })
  await page.setContent('<div id="root"></div>')
  await page.addStyleTag({ content: css })
  await page.evaluate(() => {
    window.calls = []
    const call = key => async repo => { window.calls.push([key, repo]); if (window.fail) throw Error(window.fail); return window.result }
    window.lucidGit = { logRendererEvent: async () => {}, ueDetect: async () => null,
      status: call('status'), currentBranch: async () => 'main', branchList: async () => [],
      lfsLocksCheck: call('check'), lfsLocksRepair: call('repair'), clearLockCache: call('clear'),
      diagnoseIndex: call('diagnose'), repairIndex: call('index-repair'),
      listLocks: call('list'),
    }
  })
  await page.addScriptTag({ content: bundle })
  await page.evaluate(() => window.store.setState({ repoPath: 'C:/repo' }))
  return page
}

const healthy = { lockCacheFiles: [{ path: 'C:/repo/.git/lfs/lockcache.db', integrity: 'ok' }], hasErrors: false, summary: 'Locks verified.', verifyError: '' }
const damaged = { ...healthy, hasErrors: true, summary: '1 lock cache file needs attention.', lockCacheFiles: [{ path: 'C:/repo/.git/lfs/lockcache.db', integrity: 'corrupt', error: 'unexpected EOF' }] }

test('cache detection shows red error between warning and Fetch, opens recovery details and clears after repair', async () => {
  const page = await mount(650), error = page.getByRole('button', { name: 'View repository error', exact: true })
  await expect(error).toHaveCount(0)
  await page.evaluate(() => window.store.setState({ error: 'Timed out waiting for repository read access.' }))
  await expect(page.getByRole('button', { name: 'Refresh repository data', exact: true })).toBeVisible()
  await expect(error).toHaveCount(0)
  await page.evaluate(async damaged => {
    window.result = damaged; await window.api.lfsLocksCheck('C:/repo')
  }, damaged)
  await expect(error).toBeVisible(); await expect(error).toHaveCSS('color', 'rgb(232, 64, 64)')
  const [warningBox, errorBox, fetchBox] = await Promise.all([
    page.getByRole('button', { name: 'Refresh repository data', exact: true }).boundingBox(), error.boundingBox(), page.getByRole('button', { name: 'Fetch', exact: true }).boundingBox(),
  ])
  expect(warningBox.x + warningBox.width).toBeLessThan(errorBox.x)
  expect(errorBox.x + errorBox.width).toBeLessThan(fetchBox.x)
  await error.focus(); await expect(page.getByRole('tooltip')).toContainText('unexpected EOF')
  const tip = await page.getByRole('tooltip').boundingBox()
  expect(tip.x).toBeGreaterThanOrEqual(0); expect(tip.x + tip.width).toBeLessThanOrEqual(650)
  await page.screenshot({ path: test.info().outputPath('repository-error-indicator.png') })
  await page.keyboard.press('Escape'); await expect(page.getByRole('tooltip')).toHaveCount(0)
  await page.keyboard.press('Enter')
  await expect(page.getByText('Git LFS lock cache problem', { exact: true })).toBeVisible()
  await expect(page.getByText('Clear the lock cache and refresh from the server', { exact: true })).toBeVisible()
  await page.getByTitle('Dismiss', { exact: true }).click()
  await expect(error).toBeVisible()
  expect(await page.evaluate(() => window.calls)).toEqual([['check', 'C:/repo']])
  await page.evaluate(async healthy => { window.result = healthy; await window.api.lfsLocksRepair('C:/repo') }, healthy)
  await expect(error).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Refresh repository data', exact: true })).toBeVisible()
  await page.close()
})

test('index diagnoses and native errors are repository scoped and clear only after relevant verification', async () => {
  const page = await mount(), error = page.getByRole('button', { name: 'View repository error', exact: true })
  await page.evaluate(async () => {
    window.result = { repoPath: 'C:/repo', issue: 'corrupt', summary: 'Damaged staging index', detail: 'The index checksum is invalid.' }
    await window.api.diagnoseIndex('C:/repo')
  })
  await expect(error).toHaveAccessibleDescription(/Damaged staging index/)
  await page.evaluate(() => window.store.setState({ repoPath: 'C:/other' }))
  await expect(error).toHaveCount(0)
  await page.evaluate(() => window.store.setState({ repoPath: 'C:/repo' }))
  await expect(error).toBeVisible()
  await page.evaluate(async () => { window.result = []; await window.api.listLocks('C:/repo') })
  await expect(error).toBeVisible()
  await page.evaluate(async () => {
    window.result = { diagnosis: { repoPath: 'C:/repo', issue: 'healthy' } }
    await window.api.repairIndex('C:/repo', 'reviewed-token')
  })
  await expect(error).toHaveCount(0)
  await page.evaluate(() => window.store.setState({ error: 'fatal: index file corrupt' }))
  await expect(error).toHaveAccessibleDescription(/repository index/)
  await page.evaluate(() => window.store.setState({ error: null }))
  await expect(error).toHaveCount(0)
  await page.evaluate(async () => { window.fail = 'lockcache.db: problem checking version of key/value data: unexpected EOF'; await window.api.listLocks('C:/repo').catch(() => {}); window.fail = null })
  await expect(error).toBeVisible()
  await page.evaluate(async () => { window.result = []; await window.api.clearLockCache('C:/repo') })
  await expect(error).toHaveCount(0)
  await page.evaluate(() => window.store.getState().clearRepo())
  await expect(error).toHaveCount(0)
  await page.close()
})

test('late checks cannot restore an error after a newer repair and unknown diagnostics do not claim corruption', async () => {
  const page = await mount(), error = page.getByRole('button', { name: 'View repository error', exact: true })
  await page.evaluate(async healthy => {
    // Replace the already-captured API promise by temporarily making the check
    // result a pending promise; async native calls adopt it.
    window.result = new Promise(resolve => { window.finish = resolve })
    window.pending = window.api.lfsLocksCheck('C:/repo')
    window.result = healthy; await window.api.lfsLocksRepair('C:/repo')
  }, healthy)
  await page.evaluate(async damaged => { window.finish(damaged); await window.pending }, damaged)
  await expect(error).toHaveCount(0)
  await page.evaluate(async healthy => {
    window.result = new Promise((resolve, reject) => { window.rejectCheck = reject })
    window.pending = window.api.lfsLocksCheck('C:/repo').catch(() => {})
    window.result = healthy; await window.api.lfsLocksRepair('C:/repo')
    window.rejectCheck(Error('lockcache.db: unexpected EOF')); await window.pending
  }, healthy)
  await expect(error).toHaveCount(0)
  await page.evaluate(async () => {
    window.result = new Promise(resolve => { window.finishIndex = resolve })
    window.pending = window.api.diagnoseIndex('C:/repo')
    window.result = { diagnosis: { repoPath: 'C:/repo', issue: 'healthy' } }
    await window.api.repairIndex('C:/repo', 'reviewed-token')
    window.finishIndex({ repoPath: 'C:/repo', issue: 'corrupt', summary: 'Old diagnosis', detail: 'Old bytes' }); await window.pending
  })
  await expect(error).toHaveCount(0)
  await page.evaluate(async healthy => {
    window.result = { ...healthy, hasErrors: true, summary: 'Could not check cache.', lockCacheFiles: [{ path: 'C:/repo/.git/lfs/lockcache.db', integrity: 'unknown', error: 'permission denied' }] }
    await window.api.lfsLocksCheck('C:/repo')
  }, healthy)
  await expect(error).toHaveAccessibleDescription(/LFS lock check failed.*permission denied/s)
  await error.click()
  await expect(page.getByText('The lock check could not verify the current state. Open Locked Files and retry Check Locks for details.', { exact: true })).toBeVisible()
  await expect(page.getByText('Clear the lock cache and refresh from the server', { exact: true })).toHaveCount(0)
  await page.close()
})

test('ordinary displayed errors use the red icon while warning-only and other-repository messages do not', async () => {
  const page = await mount(), error = page.getByRole('button', { name: 'View repository error', exact: true, includeHidden: true })
  await page.evaluate(() => window.errors.getState().pushRaw('A Git operation failed.', 'C:/other'))
  await expect(error).toHaveCount(0)
  await page.evaluate(() => window.errors.setState({ current: { ...window.errors.getState().current, repoPath: 'C:/repo', severity: 'warning', title: 'Warning', gitMessage: 'A warning only' } }))
  await expect(error).toHaveCount(0)
  await page.evaluate(() => window.errors.getState().pushRaw('A Git operation failed.', 'C:/repo'))
  await expect(error).toBeVisible()
  await page.evaluate(() => window.errors.getState().dismiss())
  await expect(error).toHaveCount(0)
  await page.close()
})

test('indicator sizing matches navbar icon controls across appearance settings and cleared states leave no gaps', async () => {
  const page = await mount(650)
  const warning = page.getByRole('button', { name: 'Refresh repository data', exact: true })
  const error = page.getByRole('button', { name: 'View repository error', exact: true })
  const fetch = page.getByRole('button', { name: 'Fetch', exact: true })
  const clear = page.getByTitle('Clear lock cache', { exact: true })
  const originalX = (await fetch.boundingBox()).x
  await expect(warning).toHaveCount(0); await expect(error).toHaveCount(0)
  await page.evaluate(async damaged => {
    window.store.setState({ error: 'Read access is temporarily unavailable.' })
    window.result = damaged; await window.api.lfsLocksCheck('C:/repo')
  }, damaged)
  for (const appearance of [false, true]) {
    await page.evaluate(appearance => {
      document.documentElement.classList.toggle('lg-appearance-applied', appearance)
      document.documentElement.style.setProperty('--lg-row-height', '48px')
      document.documentElement.style.setProperty('--lg-control-pad-x', '24px')
      document.documentElement.style.setProperty('--lg-radius', '16px')
    }, appearance)
    const fetchBox = await fetch.boundingBox()
    for (const control of [warning, error]) {
      const box = await control.boundingBox()
      expect(box.width).toBe(32); expect(box.height).toBe(28)
      expect(box.y + box.height / 2).toBe(fetchBox.y + fetchBox.height / 2)
      await expect(control).toHaveCSS('padding', '0px')
      await expect(control).toHaveCSS('border-radius', '5px')
      await expect(control.locator('svg')).toHaveAttribute('width', '14')
      if (appearance) {
        const other = await clear.boundingBox()
        expect(box.width).toBe(other.width); expect(box.height).toBe(other.height)
      }
    }
  }
  await warning.hover(); await expect(page.getByRole('tooltip')).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('navbar-indicator-sizing.png') })
  await page.evaluate(() => window.store.setState({ error: null }))
  await expect(warning).toHaveCount(0); await expect(error).toBeVisible()
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  await error.hover(); await expect(page.getByRole('tooltip')).toBeVisible()
  await page.evaluate(async healthy => { window.result = healthy; await window.api.lfsLocksCheck('C:/repo') }, healthy)
  await expect(error).toHaveCount(0); await expect(warning).toHaveCount(0)
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  expect((await fetch.boundingBox()).x).toBe(originalX)
  expect(await page.evaluate(() => window.calls)).toEqual([['check', 'C:/repo'], ['check', 'C:/repo']])
  await page.close()
})
