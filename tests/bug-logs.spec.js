const { test, expect, chromium } = require('@playwright/test')
const fs = require('fs'), os = require('os'), path = require('path'), esbuild = require('esbuild')

test('Clear persists empty history, retains new entries and survives reload', async () => {
  const { logService } = require('../dist-electron/services/LogService')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucid-log-clear-'))
  logService.init(dir)
  logService.error('test', 'old authentication failed')
  const clearing = logService.clear()
  logService.info('test', 'new entry')
  await clearing
  expect(logService.getFormattedText()).not.toContain('old authentication failed')
  expect(logService.getFormattedText()).toContain('new entry')
  expect(logService.getSuggestion()).toBeNull()
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'lucid-git-logs.json'), 'utf8')).sessions[0].entries).toEqual([])
  logService.endSession()
  logService.init(dir)
  expect(logService.getFormattedText()).not.toContain('old authentication failed')
  expect(logService.getFormattedText()).toContain('new entry')
  logService.endSession()
})

test('Copy and Clear show confirmed outcomes and retain logs on failure', async () => {
  const root = path.join(__dirname, '..')
  const built = await esbuild.build({ bundle: true, write: false, jsx: 'automatic',
    stdin: { contents: "import React from 'react'; import {createRoot} from 'react-dom/client'; import {BugLogsPanel} from './src/components/logs/BugLogsPanel'; createRoot(document.getElementById('mount')).render(<BugLogsPanel/>);", resolveDir: root, loader: 'jsx' },
    plugins: [{ name: 'mock-ipc', setup(build) {
      build.onResolve({ filter: /^@\/ipc$/ }, () => ({ path: 'ipc', namespace: 'fixture' }))
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const ipc={logGetText:async()=>window.logs,logGetSuggestion:async()=>null,logClear:async()=>{if(window.failClear)throw Error('disk unavailable');window.logs=''},logSaveDialog:async()=>null};`, loader: 'js' }))
    } }],
  })
  const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  const browser = await chromium.launch({ headless: true, ...(fs.existsSync(chrome) ? { executablePath: chrome } : {}) })
  try {
    const page = await browser.newPage()
    await page.setContent('<div id="mount" style="height:600px"></div>')
    await page.evaluate(() => {
      window.logs = 'first line\nsecond line'
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { if(window.failCopy) throw Error('denied'); window.copied = text } }, configurable: true })
    })
    await page.addScriptTag({ content: built.outputFiles[0].text })
    await page.getByRole('button', { name: 'Copy logs', exact: true }).click()
    await expect(page.getByRole('status')).toHaveText('Logs copied.')
    expect(await page.evaluate(() => window.copied)).toBe('first line\nsecond line')
    await page.evaluate(() => { window.failCopy = true; window.failClear = true })
    await page.getByRole('button', { name: 'Copy logs', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('Could not copy logs')
    await page.getByRole('button', { name: 'Clear logs', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('Could not clear logs')
    await expect(page.locator('pre')).toHaveText('first line\nsecond line')
    await page.evaluate(() => { window.failClear = false })
    await page.getByRole('button', { name: 'Clear logs', exact: true }).click()
    await expect(page.getByRole('status')).toHaveText('Logs cleared.')
    await expect(page.locator('pre')).toHaveText('(no log entries yet)')
  } finally { await browser.close() }
})
