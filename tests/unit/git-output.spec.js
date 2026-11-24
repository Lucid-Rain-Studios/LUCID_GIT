const { test, expect } = require('@playwright/test')
const { component } = require('../renderer-harness')

const { parseGitLog } = component('electron/util/git-log-parse.ts').exports
const { parseNameStatus, parseNumstat } = component('electron/util/git-paths.ts').exports

test('history keeps both merge parents in Git order and handles root commits', () => {
  const sep = '\x1f'
  const merge = ['', 'merge', 'first second', 'Renée', 'renee@example.test', '1700000000', 'Merge audio changes'].join(sep)
  const root = ['', 'root', '', 'Renée', 'renee@example.test', '1690000000', 'Initial commit'].join(sep)

  expect(parseGitLog(`${merge}\x1e\r\n${root}\x1e\r\n`)).toEqual([
    { hash: 'merge', parentHashes: ['first', 'second'], author: 'Renée', email: 'renee@example.test', timestamp: 1700000000000, message: 'Merge audio changes' },
    { hash: 'root', parentHashes: [], author: 'Renée', email: 'renee@example.test', timestamp: 1690000000000, message: 'Initial commit' },
  ])
  expect(parseGitLog('\r\n')).toEqual([])
})

test('change summaries keep binary numstat and copy destinations aligned with following paths', () => {
  const source = 'Content/Source.uasset'
  const copy = 'Content/ Copied 音.uasset '
  const next = 'Source/next\tline\n.cpp'
  expect(parseNameStatus(`C075\0${source}\0${copy}\0M\0${next}\0`)).toEqual([
    { status: 'C', oldPath: source, path: copy }, { status: 'M', path: next },
  ])
  expect(parseNumstat(['-\t-\t', source, copy, `2\t3\t${next}`, ''].join('\0'))).toEqual([
    { path: copy, additions: 0, deletions: 0 }, { path: next, additions: 2, deletions: 3 },
  ])
})

test('malformed Git records reject instead of silently returning a partial file list', () => {
  expect(() => parseNameStatus('M\0file\0D\0')).toThrow('Incomplete Git filename record')
  expect(() => parseNameStatus('R100\0source\0')).toThrow('Incomplete Git rename record')
  expect(() => parseNumstat('1\t2\t\0source\0')).toThrow('Incomplete Git numstat rename')
  expect(() => parseNumstat('unexpected output\0')).toThrow('Invalid Git numstat record')
})
