const { test, expect, chromium } = require('@playwright/test')
const fs = require('fs'), path = require('path'), esbuild = require('esbuild')
const root = path.join(__dirname, '..')
let browser, bundle

test.beforeAll(async () => {
  const built = await esbuild.build({
    absWorkingDir: root, bundle: true, write: false, jsx: 'automatic',
    stdin: { resolveDir: root, loader: 'jsx', contents: `
      import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
      import {ClearLockCacheButton} from './src/components/locks/ClearLockCacheButton';
      import {GlobalDialogs} from './src/components/ui/GlobalDialogs';
      import {ToolsPanel} from './src/components/tools/ToolsPanel';
      function Fixture(){const [request,setRequest]=useState(0);return <>
        <ClearLockCacheButton repoPath="C:/repo" onOpenIndexRecovery={()=>setRequest(n=>n+1)}/>
        {request>0&&<ToolsPanel repoPath="C:/repo" onRefresh={()=>{}} indexRecoveryRequest={request}/>}
        <GlobalDialogs/></>};createRoot(document.getElementById('root')).render(<Fixture/>);` },
    plugins: [{ name: 'fixture', setup(build) {
      build.onResolve({ filter: /^@\/(ipc|stores\/(operationStore|statusToastStore|repoStore))$/ }, args => ({ path: args.path, namespace: 'fixture' }))
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents:
        args.path === '@/ipc' ? `export const ipc=new Proxy({clearLockCache:async()=>{window.clears++;return []}},{get:(t,k)=>t[k]||(()=>Promise.resolve([]))});`
        : args.path.endsWith('operationStore') ? `export const useOperationStore=s=>s({run:async(_,fn)=>fn()});`
        : args.path.endsWith('statusToastStore') ? `export const useStatusToastStore=s=>s({show:()=>{}});`
        : `export const useRepoStore=s=>s({bumpSyncTick:()=>{}});` }))
      build.onResolve({ filter: /\.\/IndexRecoveryTool$/ }, () => ({ path: 'recovery', namespace: 'recovery' }))
      build.onLoad({ filter: /.*/, namespace: 'recovery' }, () => ({ resolveDir: root, loader: 'jsx', contents: `import React from 'react';export function IndexRecoveryTool(){return <section aria-label="Git index recovery">Recovery fixture</section>}` }))
      build.onResolve({ filter: /^@\// }, args => {
        const base = path.join(root, 'src', args.path.slice(2))
        return { path: ['.tsx','.ts'].map(ext => base+ext).find(fs.existsSync) }
      })
    } }],
  })
  bundle = built.outputFiles[0].text
  const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  browser = await chromium.launch({ headless: true, ...(fs.existsSync(chrome) ? { executablePath: chrome } : {}) })
})
test.afterAll(async () => { await browser?.close() })

async function mount() {
  const page = await browser.newPage({ viewport: { width: 900, height: 650 } })
  await page.setContent('<div id="root"></div>')
  await page.addStyleTag({ content: `:root{--lg-bg-elevated:#161b27;--lg-border:#252d42;--lg-text-primary:#dde1f0;--lg-text-secondary:#8b94b0;--lg-font-ui:Arial;--lg-font-mono:Consolas}body{background:#10141f;color:#dde1f0}button{box-sizing:border-box}` })
  await page.evaluate(() => { window.clears = 0 })
  await page.addScriptTag({ content: bundle })
  return page
}

test('middle button opens Index Recovery, closes confirmation, and never clears LFS cache', async () => {
  const page = await mount()
  await page.getByTitle('Clear lock cache').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('button')).toHaveText(['Cancel', 'Index Recovery', 'Clear & Refresh'])
  const buttons = await dialog.getByRole('button').all()
  const boxes = await Promise.all(buttons.map(b => b.boundingBox()))
  expect(boxes.every(b => b.y === boxes[0].y)).toBe(true)
  expect(boxes[1].x).toBeGreaterThan(boxes[0].x + boxes[0].width)
  expect(boxes[2].x).toBeGreaterThan(boxes[1].x + boxes[1].width)
  await page.screenshot({ path: path.join(root, 'test-results/lock-cache-recovery-dialog.png') })
  await dialog.getByRole('button', { name: 'Index Recovery' }).focus()
  await page.keyboard.press('Enter')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Git index recovery' })).toBeVisible()
  expect(await page.evaluate(() => window.clears)).toBe(0)
  // Reopening while Tools is already showing another tool must select recovery again.
  await page.getByRole('button', { name: /Restore File/ }).click()
  await page.getByTitle('Clear lock cache').click()
  await page.getByRole('button', { name: 'Index Recovery', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Git index recovery' })).toBeVisible()
  await page.close()
})

test('Cancel and Clear & Refresh retain their original behavior', async () => {
  const page = await mount()
  await page.getByTitle('Clear lock cache').click()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(await page.evaluate(() => window.clears)).toBe(0)
  await expect(page.getByRole('region', { name: 'Git index recovery' })).toHaveCount(0)
  await page.getByTitle('Clear lock cache').click()
  await page.getByRole('button', { name: 'Clear & Refresh', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.clears)).toBe(1)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.close()
})
