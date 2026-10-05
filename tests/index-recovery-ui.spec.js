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
        ? `export const ipc={diagnoseIndex:async()=>window.fixture.waitDiagnosis?new Promise(()=>{}):window.fixture.diagnosis,
          checkIndexBlockers:async()=>{window.fixture.calls.push('check');return structuredClone(window.fixture.blockers)},
          stopIndexTasks:async(_,tasks,confirmed)=>{if(!confirmed)throw Error('Confirm');window.fixture.calls.push('stop:'+tasks.map(t=>t.pid).join(','));window.fixture.blockers.tasks=window.fixture.blockers.tasks.filter(t=>!tasks.some(s=>s.pid===t.pid));window.fixture.blockers.pendingGitCommands=window.fixture.blockers.tasks.length;return tasks.length},
          recoverIndexLock:async(_,token,confirmed)=>{if(!confirmed||token!=='lock-token')throw Error('Confirm reviewed lock');window.fixture.calls.push('remove');window.fixture.blockers.lock=null;window.fixture.diagnosis={...window.fixture.diagnosis,issue:'healthy',summary:'Healthy after lock recovery',canRepair:false};return {backupPath:'E:/Unreal Projects/INFERIUS/.git/lucid-index-recovery/lock-backup',summary:'Lock backed up and removed',blockers:structuredClone(window.fixture.blockers)}},
          repairIndex:async()=>{window.fixture.calls.push('repair');return window.fixture.result},undoIndexRepair:async()=>{window.fixture.calls.push('undo')},showInFolder:async()=>{window.fixture.calls.push('show')}};`
        : args.path.endsWith('repoStore') ? `export const useRepoStore={getState:()=>({repoPath:window.fixture.repoPath,bumpSyncTick:()=>{}})};`
        : args.path.endsWith('operationStore') ? `export const useOperationStore={getState:()=>({run:async(label,fn)=>{window.fixture.operationCalls.push(label);return fn()}})};`
        : args.path.endsWith('dialogStore') ? `export const useDialogStore={getState:()=>({confirm:async opts=>{window.fixture.confirmations.push(opts);return true}})};`
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
    window.fixture = { repoPath: 'E:\\Unreal Projects\\INFERIUS', calls: [], confirmations: [], operationCalls: [], diagnosis,
      blockers: { repoPath: 'E:\\Unreal Projects\\INFERIUS', tasks: [], pendingGitCommands: 0, lock: null },
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

test('Task and lock recovery is usable at narrow width, requires attestation and retains its backup', async ({}, info) => {
  const page = await mount({ width: 620, height: 900 }, { ...healthy, issue: 'blocked', summary: 'Index lock present', detail: 'Lock ownership is unknown.' }, 17)
  try {
    await page.evaluate(() => {
      window.fixture.blockers = { repoPath: window.fixture.repoPath, tasks: [
        { pid: 100, startedAt: 1, command: 'git status', ageSeconds: 60, readOnly: true },
        { pid: 101, startedAt: 2, command: 'git checkout', ageSeconds: 65, readOnly: false },
      ], pendingGitCommands: 2, lock: { path: 'E:/Unreal Projects/INFERIUS/.git/index.lock', token: 'lock-token', size: 0, ageSeconds: 300 } }
    })
    await page.getByRole('button', { name: 'Check tasks and lock', exact: true }).click()
    await expect(page.getByText(/PID 100/)).toBeVisible()
    await expect(page.getByText(/Ownership is unknown; age/)).toBeVisible()
    expect(await page.locator('.lg-index-recovery').evaluate(n => n.scrollWidth <= n.clientWidth)).toBe(true)
    await page.locator('.ir-unblock').screenshot({ path: info.outputPath('tasks-lock-narrow.png') })
    await page.getByRole('button', { name: 'Stop background tasks', exact: true }).click()
    await expect(page.getByText(/PID 100/)).toHaveCount(0)
    await expect(page.getByText(/PID 101/)).toBeVisible()
    await page.getByRole('button', { name: 'Stop listed Git tasks', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Back up and remove lock', exact: true })).toBeDisabled()
    const checkbox = page.getByRole('checkbox', { name: /I have closed other Git clients/ })
    await checkbox.focus(); await page.keyboard.press('Space')
    await expect(page.getByRole('button', { name: 'Back up and remove lock', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'Back up and remove lock', exact: true }).click()
    await expect(page.getByText('Retained lock backup', { exact: true })).toBeVisible()
    await expect(page.getByText('No index lock was found at the last check.', { exact: true })).toHaveCount(1)
    await page.getByRole('button', { name: 'Show lock backup', exact: true }).click()
    const fixture = await page.evaluate(() => ({ calls: window.fixture.calls, confirmations: window.fixture.confirmations, operationCalls: window.fixture.operationCalls }))
    expect(fixture.calls).toEqual(['check', 'stop:100', 'check', 'stop:101', 'check', 'remove', 'show'])
    expect(fixture.confirmations[1].danger).toBe(true)
    expect(fixture.confirmations[2].message).toContain('all other Git clients and writers have stopped')
    expect(fixture.operationCalls).toEqual([])
    await page.locator('.ir-unblock').screenshot({ path: info.outputPath('lock-recovered-narrow.png') })
  } finally { await page.close() }
})

test('Task checks remain enabled while diagnosis is waiting', async () => {
  const page = await mount({ width: 1186, height: 850 }, healthy)
  try {
    await page.evaluate(() => { window.fixture.waitDiagnosis = true })
    await page.getByRole('button', { name: 'Diagnose', exact: true }).click()
    await expect(page.getByText('Check in progress', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Check tasks and lock', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'Check tasks and lock', exact: true }).click()
    await expect(page.getByText(/Lucid Git tasks in this repository: 0/)).toBeVisible()
  } finally { await page.close() }
})
