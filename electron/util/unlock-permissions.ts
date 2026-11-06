import fs from 'node:fs'
import path from 'node:path'
import { execSafe, execWithStdin } from './dugite-exec'

/** Replace LFS's per-process repository-wide attribute discovery with one
 * literal selected-path query. Keep the user's read-only policy and apply it
 * only after the server accepts each unlock. No persistent Git config changes. */
export async function prepareUnlockPermissions(repoPath: string, paths: string[]): Promise<{
  gitArgs: string[]
  hasLockableFiles: boolean
  apply: (filePath: string, writable?: boolean) => Promise<void>
}> {
  const gitArgs = ['-c', 'lfs.setlockablereadonly=false']
  const disabledByEnv = /^(0|false|no|off)$/i.test(process.env.GIT_LFS_SET_LOCKABLE_READONLY ?? '')
  const config = await execSafe(['config', '--bool', '--get', 'lfs.setlockablereadonly'], repoPath)
  if (config.exitCode !== 0 && config.exitCode !== 1) throw new Error(config.stderr || 'Cannot read LFS permission policy')
  if (disabledByEnv || config.stdout.trim() === 'false') return { gitArgs, hasLockableFiles: false, apply: async () => {} }

  const root = path.resolve(repoPath)
  const selected = new Set(paths.map(p => p.replace(/\\/g, '/')))
  for (const p of selected) {
    const relative = path.relative(root, path.resolve(root, p))
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || p.includes('\0')) {
      throw new Error('Unlock path must be a file inside the repository')
    }
  }
  const { stdout } = await execWithStdin(['check-attr', '-z', '--stdin', 'lockable'], repoPath, [...selected].join('\0') + '\0')
  const fields = stdout.split('\0'), lockable = new Set<string>()
  for (let i = 0; i + 2 < fields.length; i += 3) {
    if (fields[i + 1] === 'lockable' && fields[i + 2] === 'set') lockable.add(fields[i])
  }
  return {
    gitArgs,
    hasLockableFiles: lockable.size > 0,
    apply: async (filePath, writable = false) => {
      const normalized = filePath.replace(/\\/g, '/')
      if (!selected.has(normalized) || !lockable.has(normalized)) return
      const fullPath = path.join(root, normalized)
      try {
        const stat = await fs.promises.lstat(fullPath)
        // Deleted files and symlinks must not turn successful unlocks into a
        // cache-repair loop, or change a symlink target's permissions.
        if (!stat.isFile()) return
        const real = await fs.promises.realpath(fullPath)
        const relative = path.relative(root, real)
        if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Unlock path resolves outside the repository')
        const mode = writable ? stat.mode | 0o200 : stat.mode & ~0o222
        if (mode !== stat.mode) await fs.promises.chmod(fullPath, mode)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    },
  }
}
