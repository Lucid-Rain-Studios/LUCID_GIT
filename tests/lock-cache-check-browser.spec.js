const { test, expect, chromium } = require('@playwright/test')
const fs = require('node:fs'), path = require('node:path'), esbuild = require('esbuild')
const root = path.join(__dirname, '..')
let browser, bundle

test.beforeAll(async () => {
  const built = await esbuild.build({
    absWorkingDir: root, bundle: true, write: false, jsx: 'automatic',
    stdin: { resolveDir: root, loader: 'jsx', contents: `
      import React from 'react';import {createRoot} from 'react-dom/client';
      import {LfsMaintenanceSection} from './src/components/locks/LockedFilesPanel';
      createRoot(document.getElementById('root')).render(<LfsMaintenanceSection repoPath="G:/repo" onLocksRefreshed={()=>{}}/>);` },
    plugins: [{ name: 'maintenance-fixture', setup(build) {
      build.onLoad({ filter: /LockedFilesPanel\.tsx$/ }, args => ({ loader: 'tsx', resolveDir: path.dirname(args.path), contents: fs.readFileSync(args.path, 'utf8') + '\nexport { LfsMaintenanceSection };' }))
      build.onResolve({ filter: /^@\/(ipc|stores\/operationStore|stores\/dialogStore)$/ }, args => ({ path: args.path, namespace: 'fixture' }))
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents:
        args.path === '@/ipc' ? `export const ipc={lfsLocksCheck:async()=>window.result};`
        : args.path.endsWith('operationStore') ? `export const useOperationStore=()=>({run:async(_,fn)=>fn()});`
        : `export const useDialogStore=()=>({confirm:async()=>false});` }))
      build.onResolve({ filter: /^@\// }, args => {
        const base = path.join(root, 'src', args.path.slice(2))
        return { path: ['.tsx', '.ts'].map(ext => base + ext).find(fs.existsSync) }
      })
    } }],
  })
  bundle = built.outputFiles[0].text
  const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  browser = await chromium.launch({ headless: true, ...(fs.existsSync(chrome) ? { executablePath: chrome } : {}) })
})
test.afterAll(async () => { await browser?.close() })

test('healthy, corrupt and unknown cache rows show accurate status and readable diagnostics', async () => {
  for (const width of [1186, 520]) {
    const page = await browser.newPage({ viewport: { width, height: 700 } })
    await page.setContent('<div id="root"></div>')
    await page.addStyleTag({ content: ':root{--lg-font-ui:Arial;--lg-font-mono:monospace}body{background:#0c0f15;color:#c8d0e8;margin:0}*{box-sizing:border-box}' })
    await page.addScriptTag({ content: bundle })
    for (const integrity of ['ok', 'corrupt', 'unknown']) {
      const error = integrity === 'corrupt'
        ? 'lock cache initialization: problem reading updated key/value data from G:/repo/.git/lfs/lockcache.db: unexpected EOF'
        : integrity === 'unknown' ? 'Git LFS could not be started: permission denied' : undefined
      await page.evaluate(({ integrity, error }) => { window.result = {
        lockCacheFiles: [{ path: 'G:/repo/.git/lfs/lockcache.db', sizeBytes: 31744, integrity, error }],
        deletedLockCacheFiles: [], hasErrors: integrity !== 'ok', summary: integrity === 'ok' ? 'Git LFS locks verified (1 lock).' : 'Cache needs attention.',
        usedVerify: true, lockCount: 1, verifyError: '',
      } }, { integrity, error })
      await page.getByRole('button', { name: 'Check Locks', exact: true }).click()
      const label = page.getByText(integrity, { exact: true })
      await expect(label).toBeVisible()
      await expect(label).toHaveCSS('color', integrity === 'ok' ? 'rgb(46, 197, 115)' : integrity === 'corrupt' ? 'rgb(232, 69, 69)' : 'rgb(245, 168, 50)')
      if (error) await expect(page.getByText(error, { exact: true })).toBeVisible()
      else await expect(page.locator('pre')).toHaveCount(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: test.info().outputPath(`cache-${integrity}-${width}.png`), fullPage: true })
    }
    await page.close()
  }
})
