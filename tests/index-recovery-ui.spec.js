const { test, expect, chromium } = require('@playwright/test')
const fs = require('fs'), path = require('path'), esbuild = require('esbuild')
const root = path.join(__dirname, '..')
let browser, bundle, styles
test.beforeAll(async () => {
  const built = await esbuild.build({
    absWorkingDir: root, bundle: true, write: false, outfile: 'preview.js', jsx: 'automatic',
    stdin: { contents: "import React from 'react'; import {createRoot} from 'react-dom/client'; import {IndexRecoveryTool} from './src/components/tools/IndexRecoveryTool'; createRoot(document.getElementById('mount')).render(<IndexRecoveryTool repoPath={window.fixture.repoPath} onRefresh={()=>{}}/>);", resolveDir: root, loader: 'jsx' },
    plugins: [{ name: 'isolated-recovery', setup(build) {
      build.onResolve({ filter: /^@\/(ipc|stores\/)/ }, args => ({ path: args.path, namespace: 'fixture' }))
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === '@/ipc'
        ? `export const ipc={diagnoseIndex:async()=>window.fixture.diagnosis,repairIndex:async()=>{window.fixture.calls.push('repair');return window.fixture.result},undoIndexRepair:async()=>{window.fixture.calls.push('undo')},showInFolder:async()=>{window.fixture.calls.push('show')}};`
        : args.path.endsWith('repoStore') ? `export const useRepoStore={getState:()=>({repoPath:window.fixture.repoPath,bumpSyncTick:()=>{}})};`
        : args.path.endsWith('operationStore') ? `export const useOperationStore={getState:()=>({run:async(_,fn)=>fn()})};`
        : args.path.endsWith('dialogStore') ? `export const useDialogStore={getState:()=>({confirm:async()=>true})};`
        : `export const useErrorStore={getState:()=>({current:null,dismiss:()=>{}})};`, loader: 'js' }))
      build.onResolve({ filter: /^@\// }, args => ({ path: path.join(root, 'src', args.path.slice(2)) + '.tsx' }))
    } }],
  })
  bundle = built.outputFiles.find(f => f.path.endsWith('.js')).text
  styles = fs.readFileSync(path.join(root, 'src/index.css'), 'utf8') + built.outputFiles.find(f => f.path.endsWith('.css')).text
  const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  browser = await chromium.launch({ headless: true, ...(fs.existsSync(chrome) ? { executablePath: chrome } : {}) })
})
test.afterAll(async () => { await browser?.close() })

async function mount(viewport, diagnosis, fontSize = 13) {
  const page = await browser.newPage({ viewport })
  await page.setContent('<html class="lg-appearance-applied"><body><div id="root" style="padding-left:177px"><div id="mount" style="height:100%;display:flex;flex-direction:column"></div></div></body></html>')
  await page.addStyleTag({ content: styles })
  await page.evaluate(({ diagnosis, fontSize }) => {
    document.documentElement.style.setProperty('--lg-font-size', fontSize + 'px')
    document.documentElement.style.setProperty('--lg-font-weight', '700')
    window.fixture = { repoPath: 'E:\\Unreal Projects\\INFERIUS', calls: [], diagnosis,
      result: { summary: 'Index rebuilt and verified. Changes are now unstaged.', backupPath: 'E:\\Unreal Projects\\INFERIUS\\.git\\lucid-index-recovery\\backup', diagnosis: { ...diagnosis, issue: 'healthy', summary: 'Repair verified', canRepair: false, canUndo: true, backupId: 'backup' } } }
  }, { diagnosis, fontSize })
  await page.addScriptTag({ content: bundle })
  await expect(page.getByRole('heading', { name: 'Git index recovery', exact: true })).toBeVisible()
  return page
}
const healthy = { issue: 'healthy', summary: 'The staging index is readable and healthy', detail: 'No staging-index repair is needed. Retain the full operation error if the problem continues.', gitVersion: 'git version 2.43.4.windows.1', canRepair: false, canUndo: false }

test('Healthy layout retains title hierarchy despite appearance overrides and explains disabled actions', async ({}, info) => {
  const page = await mount({ width: 1186, height: 741 }, healthy)
  try {
    await page.getByRole('button', { name: 'Diagnose', exact: true }).click()
    await expect(page.getByText('Healthy index', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Back up and repair' })).toBeDisabled()
    await expect(page.getByText('The index is healthy. No repair is needed.', { exact: true })).toBeVisible()
    const sizes = await page.evaluate(() => [parseFloat(getComputedStyle(document.querySelector('.ir-title')).fontSize), parseFloat(getComputedStyle(document.querySelector('.ir-lead')).fontSize)])
    expect(sizes[0]).toBeGreaterThan(sizes[1] + 5)
    await page.getByText('Diagnostic details', { exact: true }).click()
    await expect(page.locator('.ir-details pre')).toBeVisible()
    await page.getByText('Diagnostic details', { exact: true }).click()
    await page.screenshot({ path: info.outputPath('healthy-desktop.png') })
  } finally { await page.close() }
})

test('Blocked diagnostics stay readable at narrow widths and large font settings without horizontal overflow', async ({}, info) => {
  const page = await mount({ width: 620, height: 800 }, { ...healthy, issue: 'blocked', summary: 'Recovery stopped safely', detail: 'Another Git writer may own index.lock. Recovery never deletes an existing lock. Close other Git clients, then Diagnose again.' }, 17)
  try {
    await page.getByRole('button', { name: 'Diagnose', exact: true }).click()
    await expect(page.getByText('Needs attention', { exact: true })).toBeVisible()
    await expect(page.getByText(/Another Git writer/)).toBeVisible()
    expect(await page.locator('.lg-index-recovery').evaluate(n => n.scrollWidth <= n.clientWidth)).toBe(true)
    await page.screenshot({ path: info.outputPath('blocked-narrow.png') })
  } finally { await page.close() }
})

test('Repair and backup actions remain available with keyboard focus and a verified result', async ({}, info) => {
  const page = await mount({ width: 1186, height: 850 }, { ...healthy, issue: 'corrupt', summary: 'Git cannot read the staging index', canRepair: true, token: 'token' })
  try {
    await page.getByRole('button', { name: 'Diagnose', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByText('Repair available', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Back up and repair' }).focus()
    await expect(page.getByRole('button', { name: 'Back up and repair' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByText('Repair verified', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Undo repair' })).toBeEnabled()
    await page.getByRole('button', { name: 'Show backup' }).click()
    expect(await page.evaluate(() => window.fixture.calls)).toEqual(['repair', 'show'])
    await page.screenshot({ path: info.outputPath('repaired-desktop.png') })
  } finally { await page.close() }
})
