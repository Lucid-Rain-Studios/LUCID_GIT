const { test, expect, chromium } = require('@playwright/test')
const fs = require('node:fs')
const path = require('node:path')
const esbuild = require('esbuild')

test('folder checkboxes update commit selection recursively, including collapsed files', async () => {
  const root = path.join(__dirname, '..')
  const { outputFiles } = await esbuild.build({
    absWorkingDir: root,
    bundle: true,
    write: false,
    outfile: 'folder-selection.js',
    stdin: {
      resolveDir: root,
      loader: 'jsx',
      contents: `
        import React, {useState} from 'react'
        import {createRoot} from 'react-dom/client'
        import {FileTree} from './src/components/changes/FileTree'

        const paths = ['Tools/direct.txt', 'Tools\\\\nested\\\\deep.txt', 'Tools/nested/locked.txt',
          'Tools-old/keep.txt', 'Locked/only.txt']
        const files = paths.map((path, i) => ({
          path, staged: i === 1, indexStatus: i === 1 ? 'A' : ' ', workingStatus: i === 1 ? ' ' : 'M',
        }))
        const locks = [paths[2], paths[4]].map(path => ({ path, owner: { login: 'other' } }))

        function Fixture() {
          const [selected, setSelected] = useState(new Set([paths[0], paths[3]]))
          return <>
            <FileTree files={files} repoPath="repo" selectedPath={null} locks={locks}
              currentUserName={null} isLoading={false} onSelect={() => {}} onRefresh={() => {}}
              deferredStagePaths={selected} onSetDeferredStagePaths={paths => setSelected(new Set(paths))}
              onToggleDeferredStagePath={path => setSelected(prev => {
                const next = new Set(prev)
                if (next.has(path)) next.delete(path)
                else next.add(path)
                return next
              })} />
            <output aria-label="Commit selection">{JSON.stringify([...selected].sort())}</output>
          </>
        }

        createRoot(document.getElementById('root')).render(<Fixture />)
      `,
    },
  })
  const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  const browser = await chromium.launch(fs.existsSync(chrome) ? { executablePath: chrome } : {})
  try {
    const page = await browser.newPage()
    await page.setContent('<div id="root"></div>')
    await page.evaluate(() => {
      window.gitWrites = []
      window.lucidGit = {
        mergeInProgress: async () => null,
        stage: async () => window.gitWrites.push('stage'),
        unstage: async () => window.gitWrites.push('unstage'),
      }
    })
    await page.addScriptTag({ content: outputFiles.find(file => file.path.endsWith('.js')).text })
    await page.getByTitle('Content Browser', { exact: true }).click()

    const tools = page.getByRole('checkbox', { name: 'Select changed files in Tools', exact: true })
    const nested = page.getByRole('checkbox', { name: 'Select changed files in Tools/nested', exact: true })
    const selection = page.locator('output')
    await expect(tools).toHaveAttribute('aria-checked', 'mixed')
    await expect(page.getByRole('checkbox', { name: 'Select changed files in Locked' })).toBeDisabled()
    await page.getByText('Tools', { exact: true }).click()
    await expect(nested).toHaveCount(0)

    await tools.focus()
    await page.keyboard.press('Space')
    await expect(tools).toBeChecked()
    await expect(nested).toHaveCount(0)
    await expect(selection).toHaveText(JSON.stringify(['Tools-old/keep.txt', 'Tools/direct.txt', 'Tools\\nested\\deep.txt']))

    await page.getByText('Tools', { exact: true }).click()
    await expect(nested).toBeChecked()
    await nested.click()
    await expect(tools).toHaveAttribute('aria-checked', 'mixed')
    await expect(selection).toHaveText(JSON.stringify(['Tools-old/keep.txt', 'Tools/direct.txt']))
    await nested.click()
    await expect(tools).toBeChecked()

    await tools.click()
    await expect(tools).toHaveAttribute('aria-checked', 'false')
    await expect(nested).toHaveAttribute('aria-checked', 'false')
    await expect(selection).toHaveText(JSON.stringify(['Tools-old/keep.txt']))
    await expect(page.evaluate(() => window.gitWrites)).resolves.toEqual([])
  } finally {
    await browser.close()
  }
})
