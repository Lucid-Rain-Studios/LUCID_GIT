// Fetch reviewed build-time dependencies. Never run from the installed app.
const fs = require('node:fs'), path = require('node:path'), { execFileSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const deps = [
  ['UAssetAPI', 'https://github.com/atenfyr/UAssetAPI.git', '3228c1e86261aa08131f7ec0ff1a395f5d0b2a84'],
  ['klee', 'https://github.com/Joined-Forces/klee.git', '3c694f280ea1702624f81e7b0d20b9292d635cc5'],
]
fs.mkdirSync(path.join(root, 'third_party'), { recursive: true })
for (const [name, url, commit] of deps) {
  const dir = path.join(root, 'third_party', name)
  if (!fs.existsSync(dir)) {
    execFileSync('git', ['clone', url, dir], { stdio: 'inherit', windowsHide: true })
    execFileSync('git', ['checkout', '--detach', commit], { cwd: dir, stdio: 'inherit', windowsHide: true })
  }
  const actual = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8', windowsHide: true }).trim()
  if (actual !== commit) throw new Error(`${name} must be at ${commit}; current checkout was preserved.`)
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: dir, encoding: 'utf8', windowsHide: true }).trim()
  if (dirty) throw new Error(`${name} has local changes; preserve them and restore the pinned dependency before building.`)
}
