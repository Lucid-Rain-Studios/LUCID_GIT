const { test, expect } = require('@playwright/test')
const fs = require('node:fs'), path = require('node:path')
const { git, tmpDir, cleanup, DIST } = require('./helpers')
const { prepareUnlockPermissions } = require(path.join(DIST, 'util/unlock-permissions'))
test.afterAll(cleanup)

function fixture() {
  const repo = tmpDir('unlock-permissions-')
  git(repo, 'init', '-q')
  fs.writeFileSync(path.join(repo, '.gitattributes'), '*.uasset lockable\n')
  fs.mkdirSync(path.join(repo, 'nested'))
  fs.writeFileSync(path.join(repo, 'nested/.gitattributes'), 'except.uasset -lockable\n')
  for (const file of ['chosen.uasset', 'untouched.uasset', 'nested/except.uasset', 'plain.txt', 'space ü.uasset']) fs.writeFileSync(path.join(repo, file), 'unchanged')
  return repo
}

test('batched attributes preserve nested overrides and apply read-only only to successful selected files', async () => {
  const repo = fixture(), chosen = ['chosen.uasset', 'nested/except.uasset', 'plain.txt', 'space ü.uasset', 'deleted.uasset']
  const permissions = await prepareUnlockPermissions(repo, chosen)
  expect(permissions.gitArgs).toEqual(['-c', 'lfs.setlockablereadonly=false'])
  for (const file of chosen) await permissions.apply(file)
  await permissions.apply('untouched.uasset')
  for (const file of ['chosen.uasset', 'space ü.uasset']) {
    expect(fs.statSync(path.join(repo, file)).mode & 0o222).toBe(0)
    expect(fs.readFileSync(path.join(repo, file), 'utf8')).toBe('unchanged')
  }
  for (const file of ['untouched.uasset', 'nested/except.uasset', 'plain.txt']) expect(fs.statSync(path.join(repo, file)).mode & 0o222).not.toBe(0)
})

test('repository and environment read-only opt-outs remain respected without persistent config writes', async () => {
  const repo = fixture()
  git(repo, 'config', 'lfs.setlockablereadonly', 'false')
  await (await prepareUnlockPermissions(repo, ['chosen.uasset'])).apply('chosen.uasset')
  expect(fs.statSync(path.join(repo, 'chosen.uasset')).mode & 0o222).not.toBe(0)
  expect(git(repo, 'config', '--get', 'lfs.setlockablereadonly').trim()).toBe('false')
  git(repo, 'config', '--unset', 'lfs.setlockablereadonly')
  const previous = process.env.GIT_LFS_SET_LOCKABLE_READONLY
  process.env.GIT_LFS_SET_LOCKABLE_READONLY = '0'
  try {
    await (await prepareUnlockPermissions(repo, ['chosen.uasset'])).apply('chosen.uasset')
    expect(fs.statSync(path.join(repo, 'chosen.uasset')).mode & 0o222).not.toBe(0)
  } finally {
    if (previous === undefined) delete process.env.GIT_LFS_SET_LOCKABLE_READONLY
    else process.env.GIT_LFS_SET_LOCKABLE_READONLY = previous
  }
})

test('outside paths are refused before any permission change', async () => {
  const repo = fixture()
  await expect(prepareUnlockPermissions(repo, ['../outside.uasset'])).rejects.toThrow('inside the repository')
})
