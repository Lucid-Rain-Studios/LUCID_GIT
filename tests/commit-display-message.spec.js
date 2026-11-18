const { test, expect } = require('@playwright/test')
const fs = require('node:fs')
const path = require('node:path')
const { transformSync } = require('esbuild')
const compiled = transformSync(fs.readFileSync(path.join(__dirname, '../src/lib/commitDisplayMessage.ts'), 'utf8'), { loader: 'ts', format: 'cjs' })
const loaded = { exports: {} }
new Function('module', 'exports', compiled.code)(loaded, loaded.exports)
const { commitDisplayMessage } = loaded.exports

test('merge labels preserve direction, branch casing and remote branch paths', () => {
  const cases = [
    ["Merge branch 'Main' into dev_Jake", '[MERGE] Main -> dev_Jake'],
    ["Merge branch 'dev_Jake' into Main", '[MERGE] dev_Jake -> Main'],
    ["Merge remote-tracking branch 'origin/main' into dev_Jake", '[MERGE] main (Remote) -> dev_Jake'],
    ["Merge remote-tracking branch 'upstream/feature/ui' into Main", '[MERGE] feature/ui (Remote) -> Main'],
    ["Merge branch 'Main' of https://github.com/team/repo into Main", '[MERGE] Main (Remote) -> Main'],
    ['Merge pull request #123 from team/dev_Jake into Main', '[MERGE] PR #123 from dev_Jake -> Main'],
    ['Merge pull request #751 from Lucid-Rain-Studios/feature/ui', '[MERGE] PR #751 from feature/ui'],
    ["Merge branch 'main' of https://github.com/team/repo", '[MERGE] main (Remote)'],
    ["Merge branch 'feature/ui'", '[MERGE] feature/ui'],
  ]
  for (const [message, expected] of cases) {
    const commit = Object.freeze({ message, parentHashes: ['a', 'b'] })
    expect(commitDisplayMessage(commit)).toBe(expected)
    expect(commit.message).toBe(message)
  }
})

test('ordinary commits, custom merge subjects and unsupported merge formats stay verbatim', () => {
  for (const message of ['Fix lighting', 'Merge custom work after review', "Merge branches 'one' and 'two' into main", '[MERGE] main -> dev_Jake']) {
    expect(commitDisplayMessage({ message, parentHashes: ['a', 'b'] })).toBe(message)
  }
  const message = "Merge branch 'main' into dev_Jake"
  expect(commitDisplayMessage({ message, parentHashes: ['a'] })).toBe(message)
})
