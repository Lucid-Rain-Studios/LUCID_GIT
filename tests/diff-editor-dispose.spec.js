// Unmounting the diff viewer must not make Monaco report a model disposed while still attached.
const { test, expect, chromium } = require('@playwright/test')
const fs = require('fs'), path = require('path'), esbuild = require('esbuild')

test('closing the diff viewer disposes its models without an uncaught Monaco error', async () => {
  const root = path.join(__dirname, '..')
  const built = await esbuild.build({
    bundle: true, write: false, jsx: 'automatic', absWorkingDir: root,
    loader: { '.css': 'empty', '.ttf': 'empty' },
    stdin: {
      resolveDir: root,
      contents: `
        import React from 'react'
        import { createRoot } from 'react-dom/client'
        import { loader } from '@monaco-editor/react'
        import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
        import { TextDiff } from './src/components/diff/TextDiff'
        loader.config({ monaco })
        window.monaco = monaco
        window.errors = []
        window.addEventListener('error', event => window.errors.push(event.message))
        const mount = createRoot(document.getElementById('mount'))
        const diff = { language: 'plaintext', oldContent: 'one two', newContent: 'one three' }
        window.show = () => mount.render(React.createElement(TextDiff, { diff }))
        window.hide = () => mount.render(null)
      `,
    },
    plugins: [{ name: 'mock-app', setup(build) {
      build.onResolve({ filter: /^@\/(ipc|stores\/appearanceStore|lib\/appearance)$/ }, args => ({ path: args.path, namespace: 'fixture' }))
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents:
        args.path === '@/ipc' ? 'export const logUiError = () => {}'
          : args.path === '@/stores/appearanceStore' ? 'export const useAppearanceStore = select => select({ settings: { theme: "t", fontSize: 13, codeFontFamily: "Consolas" } })'
          : 'export const THEMES = [{ id: "t", vars: { "--lg-bg-primary": "#101010", "--lg-text-primary": "#eeeeee", "--lg-text-secondary": "#999999" } }]' }))
    } }],
  })
  const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  const browser = await chromium.launch({ headless: true, ...(fs.existsSync(chrome) ? { executablePath: chrome } : {}) })
  try {
    const page = await browser.newPage()
    await page.setContent('<div id="mount" style="height:400px;width:800px"></div>')
    await page.addScriptTag({ content: built.outputFiles[0].text })
    await page.evaluate(() => window.show())
    await page.waitForFunction(() => window.monaco.editor.getModels().length === 2, null, { timeout: 30000 })

    await page.evaluate(() => window.hide())
    // Monaco reports through a timer, so give it a turn to land.
    await page.waitForTimeout(500)
    expect(await page.evaluate(() => window.errors)).toEqual([])
    expect(await page.evaluate(() => window.monaco.editor.getModels().length)).toBe(0)
  } finally { await browser.close() }
})
