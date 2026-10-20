const { test, expect, chromium } = require('@playwright/test')
const fs = require('fs'), path = require('path'), esbuild = require('esbuild')
const root = path.join(__dirname, '..')
let browser, bundle, css

test.beforeAll(async () => {
  bundle = (await esbuild.build({ absWorkingDir: root, bundle: true, write: false, jsx: 'automatic',
    stdin: { resolveDir: root, loader: 'jsx', contents: `
      import React from 'react';import {createRoot} from 'react-dom/client';
      import {RepositoryRefreshWarning} from './src/components/layout/RepositoryRefreshWarning';
      import {useRepoStore} from './src/stores/repoStore';
      window.store=useRepoStore;
      createRoot(document.getElementById('root')).render(<nav style={{display:'flex',gap:6,padding:16}}><RepositoryRefreshWarning/><button>Fetch</button></nav>);` },
    plugins: [{ name: 'fixture', setup(build) {
      build.onResolve({ filter: /(^|\/)operationStore$/ }, () => ({ path: 'operations', namespace: 'fixture' }))
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'js', contents: `export const useOperationStore={getState:()=>({run:async(_,fn)=>fn()})};` }))
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
  const page = await browser.newPage({ viewport: { width, height: 650 } })
  await page.setContent('<div id="root"></div>')
  await page.addStyleTag({ content: css })
  await page.evaluate(() => {
    window.reads = []
    window.lucidGit = {
      ueDetect: async () => null,
      status: repo => { window.reads.push(repo); return new Promise((resolve, reject) => { window.finish = fail => fail ? reject(Error('Still waiting for repository read access.')) : resolve([]) }) },
      currentBranch: async () => 'main', branchList: async () => [],
    }
  })
  await page.addScriptTag({ content: bundle })
  return page
}

test('warning is conditional, sits before Fetch, preserves the error on failure and disappears after successful retry', async () => {
  const page = await mount()
  const retry = page.getByRole('button', { name: 'Refresh repository data', exact: true })
  await expect(retry).toHaveCount(0)
  const message = 'Error invoking remote method git:status: Timed out waiting for repository read access. Retry after the current operation finishes.'
  await page.evaluate(message => window.store.setState({ repoPath: 'C:/repo', error: message }), message)
  await expect(retry).toBeVisible()
  await expect(retry).toHaveAccessibleDescription('Repository data may be incomplete or stale: ' + message)
  await expect(retry.locator('span[aria-hidden]')).toHaveText('!')
  const [refreshBox, fetchBox] = await Promise.all([retry.boundingBox(), page.getByRole('button', { name: 'Fetch', exact: true }).boundingBox()])
  expect(refreshBox.x + refreshBox.width).toBeLessThan(fetchBox.x)
  await retry.hover()
  await expect(page.getByRole('tooltip')).toContainText(message)
  const tooltipBox = await page.getByRole('tooltip').boundingBox()
  expect(tooltipBox.x).toBeGreaterThanOrEqual(0)
  expect(tooltipBox.x + tooltipBox.width).toBeLessThanOrEqual(1000)
  await expect(page.getByText('Click to refresh repository data.')).toBeVisible()
  await page.screenshot({ path: 'test-results/repository-refresh-warning.png' })
  await retry.click()
  await expect(retry).toBeDisabled()
  await retry.evaluate(button => button.click())
  expect(await page.evaluate(() => window.reads)).toEqual(['C:/repo'])
  await page.evaluate(() => window.finish(true))
  await expect(retry).toBeEnabled()
  await expect(retry).toHaveAccessibleDescription(/Still waiting/)
  await retry.focus()
  await expect(page.getByRole('tooltip')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  await page.keyboard.press('Enter')
  await expect(retry).toBeDisabled()
  await page.evaluate(() => window.finish(false))
  await expect(retry).toHaveCount(0)
  expect(await page.evaluate(() => window.reads)).toEqual(['C:/repo', 'C:/repo'])
  await page.close()
})

test('closing the repository hides the warning and pending animation honors reduced motion', async () => {
  const page = await mount(650)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.evaluate(() => window.store.setState({ repoPath: 'C:/repo', error: 'Read failed' }))
  const retry = page.getByRole('button', { name: 'Refresh repository data', exact: true })
  await retry.click()
  await expect(retry).toBeDisabled()
  expect(await retry.locator('svg').evaluate(node => getComputedStyle(node).animationName)).toBe('none')
  await page.evaluate(() => window.store.getState().clearRepo())
  await expect(retry).toHaveCount(0)
  await page.evaluate(() => window.finish(false))
  await expect(retry).toHaveCount(0)
  await page.close()
})
