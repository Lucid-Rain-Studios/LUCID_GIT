const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const DIST = path.join(__dirname, '..', 'dist-electron')

/** Run git in `cwd`, returning stdout. Throws on a non-zero exit. */
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, stdio: 'pipe' }).toString()
}

/** A throwaway directory, registered for removal by `cleanup`. */
const created = []
function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  created.push(dir)
  return dir
}

function cleanup() {
  while (created.length) {
    try { fs.rmSync(created.pop(), { recursive: true, force: true, maxRetries: 3 }) } catch { /* best effort */ }
  }
}

/**
 * A repository with `files` committed through Git LFS.
 *
 * `lfs install --local` rather than plain `install`: the tests must not touch
 * the developer's own ~/.gitconfig, which is the same reason the app itself
 * passes --local.
 */
function lfsRepo(files, size = 200_000) {
  const repo = tmpDir('lg-lfs-')
  git(repo, 'init', '-q', '.')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'lfs', 'install', '--local')
  git(repo, 'lfs', 'track', '*.uasset')
  for (const name of files) {
    fs.writeFileSync(path.join(repo, name + '.uasset'), Buffer.alloc(size, name[0]))
  }
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'assets')
  return repo
}

/** Replace a working file with the LFS pointer git holds for it. */
function breakToPointer(repo, name) {
  fs.writeFileSync(path.join(repo, name + '.uasset'), git(repo, 'cat-file', '-p', 'HEAD:' + name + '.uasset'))
}

const sizeOf = (repo, name) => fs.statSync(path.join(repo, name + '.uasset')).size

/**
 * Run `fn` while sampling a 10ms timer, and report how many ticks it got.
 * Zero ticks over a measurable span means the event loop was blocked
 * throughout — the failure mode most of this suite exists to catch.
 */
async function measureLoopTicks(fn) {
  let ticks = 0
  const iv = setInterval(() => { ticks++ }, 10)
  const startedAt = Date.now()
  try {
    await fn()
  } finally {
    clearInterval(iv)
  }
  return { ticks, elapsed: Date.now() - startedAt }
}

/** Count git processes spawned while `fn` runs, to prove request de-duplication. */
async function countGitSpawns(fn) {
  const dugite = require(path.join(__dirname, '..', 'node_modules', 'dugite'))
  const real = dugite.GitProcess.exec.bind(dugite.GitProcess)
  let spawns = 0
  dugite.GitProcess.exec = (...args) => { spawns++; return real(...args) }
  try {
    const value = await fn()
    return { spawns, value }
  } finally {
    dugite.GitProcess.exec = real
  }
}

module.exports = {
  DIST, git, tmpDir, cleanup, lfsRepo, breakToPointer, sizeOf,
  measureLoopTicks, countGitSpawns,
}
