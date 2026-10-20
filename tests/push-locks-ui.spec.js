const { test, expect, chromium } = require('@playwright/test')
const fs = require('fs'), path = require('path'), esbuild = require('esbuild')
const root = path.join(__dirname, '..')
let browser, bundle, css

test.beforeAll(async () => {
  const built = await esbuild.build({ absWorkingDir: root, bundle: true, write: false, jsx: 'automatic',
    stdin: { resolveDir: root, loader: 'jsx', contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {PushBlockedByLocksDialog} from './src/components/locks/PushBlockedByLocksDialog';createRoot(document.getElementById('root')).render(<PushBlockedByLocksDialog errorMessage="Cannot update locked files." onClose={()=>window.closedDialog=true} onPushed={()=>window.pushed=true}/>);` },
    plugins: [{ name: 'fixture', setup(build) {
      build.onResolve({ filter: /^@\/(ipc|stores\/(operationStore|repoStore|authStore))$/ }, args => ({ path: args.path, namespace: 'fixture' }))
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents:
        args.path === '@/ipc' ? `export const ipc={pushLockCheck:async()=>{if(window.failChecks)throw Error('offline');return {branch:'recovery',head:'abc',remoteUrl:'url',targetBranch:'recovery',files:window.paths,overrideReason:window.protectedBranch?'Lock verification stays enabled for pushes to the default branch.':null}},listLocks:async()=>window.paths.map((path,i)=>({id:String(i),path,owner:{login:'peer',name:'Peer'}})),push:async(...args)=>{window.pushes.push(args);await new Promise(r=>window.finishPush=r)}};`
        : args.path.endsWith('operationStore') ? `export const useOperationStore=s=>s({run:async(_,fn)=>fn()});`
        : args.path.endsWith('authStore') ? `export const useAuthStore=()=>({accounts:[{userId:'me',login:'me'}],currentAccountId:'me'});`
        : `export const useRepoStore=()=>({repoPath:'repo',refreshStatus:async()=>{}});` }))
      build.onResolve({ filter: /^@\// }, args => {
        const base = path.join(root, 'src', args.path.slice(2))
        return { path: ['.tsx', '.ts'].map(ext => base+ext).find(fs.existsSync) }
      })
    }}],
  })
  bundle = built.outputFiles[0].text
  css = (await require('postcss')([require('tailwindcss')(require('../tailwind.config'))]).process(fs.readFileSync(path.join(root, 'src/index.css'), 'utf8'), { from: path.join(root, 'src/index.css') })).css
  const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  browser = await chromium.launch({ headless: true, ...(fs.existsSync(chrome) ? { executablePath: chrome } : {}) })
})
test.afterAll(async () => { await browser?.close() })
async function mount(options = {}) {
  const page = await browser.newPage({ viewport: options.narrow ? { width: 390, height: 700 } : { width: 1000, height: 800 } })
  await page.setContent('<div id="root"></div>')
  await page.addStyleTag({ content: css })
  await page.evaluate(options => {
    window.failChecks = options.fail; window.protectedBranch = options.protected
    window.paths = ['Content/Inferius/Maps/02_Lust/Streaming_Levels/02_Lust_Sub_CarnalColosseum.umap', 'Content/Inferius/Mesh_Module/Architecture/Traversal/Stairs/SM_Steps_Curved_Group_04.uasset']
    window.pushes=[]
  }, options)
  await page.addScriptTag({ content: bundle })
  return page
}

test('rendered lock dialog shows exact files, requires confirmation and retains pending modal', async () => {
  const page = await mount()
  await expect(page.getByText('2 outgoing files locked by other users')).toBeVisible()
  await expect(page.getByText('Content/Inferius/Maps/02_Lust/Streaming_Levels/02_Lust_Sub_CarnalColosseum.umap', { exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: 'Push anyway' }).click()
  await expect(page.getByRole('group', { name: 'Confirm push with locks retained' })).toBeVisible()
  expect(await page.evaluate(() => window.pushes)).toEqual([])
  await page.screenshot({ path: 'test-results/push-locks-confirm.png' })
  await page.getByRole('button', { name: 'Publish branch with locks retained' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled()
  await page.keyboard.press('Escape')
  expect(await page.evaluate(() => !!window.closedDialog)).toBe(false)
  expect(await page.evaluate(() => window.pushes)).toEqual([['repo', false, { branch: 'recovery', head: 'abc', remoteUrl: 'url', targetBranch: 'recovery' }]])
  await page.evaluate(() => window.finishPush())
  await expect.poll(() => page.evaluate(() => window.pushed)).toBe(true)
  await page.close()
})

test('narrow rendered dialog wraps long paths and failure/default states never offer override', async () => {
  const page = await mount({ narrow: true })
  await page.getByRole('button', { name: 'Push anyway' }).click()
  const bounds = await page.getByRole('dialog').evaluate(node => ({ scroll: node.scrollWidth, width: node.clientWidth }))
  expect(bounds.scroll).toBeLessThanOrEqual(bounds.width)
  await page.screenshot({ path: 'test-results/push-locks-narrow.png' })
  await page.close()
  const failed = await mount({ fail: true })
  await expect(failed.getByRole('alert')).toContainText('determine blocking locks')
  await expect(failed.getByRole('button', { name: 'Push anyway' })).toHaveCount(0)
  await expect(failed.getByRole('button', { name: 'Retry push' })).toBeDisabled()
  await failed.evaluate(() => window.failChecks=false)
  await failed.getByRole('button', { name: 'Retry checks' }).click()
  await expect(failed.getByText('2 outgoing files locked by other users')).toBeVisible()
  await failed.close()
  const protectedPage = await mount({ protected: true })
  await expect(protectedPage.getByText('Lock verification stays enabled for pushes to the default branch.')).toBeVisible()
  await expect(protectedPage.getByRole('button', { name: 'Push anyway' })).toHaveCount(0)
  await protectedPage.close()
})
