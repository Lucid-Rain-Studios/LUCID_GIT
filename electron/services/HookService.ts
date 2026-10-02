import fs   from 'fs'
import path from 'path'
import { spawn } from 'child_process'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface HookInfo {
  name: string        // e.g. 'pre-commit'
  enabled: boolean    // false when the .disabled file exists
  isBuiltin: boolean  // one of our bundled scripts
  scriptPreview: string // first 3 non-comment lines
}

export interface HookRunResult {
  exists: boolean
  exitCode: number
  output: string
  durationMs: number
}

export interface BuiltinDef {
  id: string
  hookName: string
  description: string
  script: string
}

// ── Built-in hook scripts ─────────────────────────────────────────────────────

const BUILTIN_MARKER = '# lucid-git-builtin:'

const BUILTINS: BuiltinDef[] = [
  {
    id: 'file-size-guard',
    hookName: 'pre-commit',
    description: 'Block commits with files larger than 50 MB (prompt to use LFS instead)',
    script: `#!/bin/sh
${BUILTIN_MARKER} file-size-guard
LIMIT=52428800
FAILED=0
for FILE in $(git diff --cached --name-only); do
  if [ -f "$FILE" ]; then
    BYTES=$(wc -c < "$FILE" | tr -d ' ')
    if [ "$BYTES" -gt "$LIMIT" ]; then
      MB=$(( BYTES / 1048576 ))
      echo "LARGE FILE: $FILE ($MB MB) — add to LFS before committing"
      FAILED=1
    fi
  fi
done
[ "$FAILED" -eq 1 ] && exit 1
exit 0
`,
  },
  {
    id: 'uasset-lfs-check',
    hookName: 'pre-commit',
    description: 'Block UE asset commits when LFS is not configured for those file types',
    script: `#!/bin/sh
${BUILTIN_MARKER} uasset-lfs-check
FAILED=0
for FILE in $(git diff --cached --name-only | grep -E '\\.(uasset|umap|ubulk|uexp|ucas)$'); do
  FILTER=$(git check-attr filter -- "$FILE" | awk '{print $3}')
  if [ "$FILTER" != "lfs" ]; then
    echo "NOT IN LFS: $FILE"
    FAILED=1
  fi
done
[ "$FAILED" -eq 1 ] && echo "\\nGo to the LFS tab in Lucid Git to track UE asset types." && exit 1
exit 0
`,
  },
  {
    id: 'lint-check',
    hookName: 'pre-commit',
    description: 'Run ESLint (max-warnings=0) on staged TypeScript/JavaScript files',
    script: `#!/bin/sh
${BUILTIN_MARKER} lint-check
STAGED=$(git diff --cached --name-only | grep -E '\\.(ts|tsx|js|jsx)$')
[ -z "$STAGED" ] && exit 0
if command -v npx >/dev/null 2>&1; then
  echo "$STAGED" | xargs npx eslint --max-warnings=0 2>&1
  exit $?
fi
echo "npx not found — skipping lint"
exit 0
`,
  },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

const KNOWN_HOOKS = [
  'pre-commit', 'commit-msg', 'pre-push',
  'post-commit', 'pre-merge-commit', 'prepare-commit-msg',
]

function hooksDir(repoPath: string): string {
  let gitDir = path.join(repoPath, '.git')
  if (fs.statSync(gitDir).isFile()) {
    const link = fs.readFileSync(gitDir, 'utf8').match(/^gitdir: (.+)\r?$/m)
    if (!link) throw new Error('Invalid worktree Git directory')
    gitDir = path.resolve(repoPath, link[1].trim())
    const common = path.join(gitDir, 'commondir')
    if (fs.existsSync(common)) gitDir = path.resolve(gitDir, fs.readFileSync(common, 'utf8').trim())
  }
  return path.join(gitDir, 'hooks')
}

function scriptPreview(content: string): string {
  return content
    .split('\n')
    .filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('#!/'))
    .slice(0, 3)
    .join('\n')
}

/** Resolve sh.exe — uses dugite's bundled Git on Windows */
function getShell(): string {
  if (process.platform !== 'win32') return 'sh'
  try {
    const dugiteMain = require.resolve('dugite')
    const dugiteDir  = path.dirname(dugiteMain)
    const candidates = [
      path.join(dugiteDir, 'git', 'usr', 'bin', 'sh.exe'),
      path.join(dugiteDir, 'git', 'bin', 'sh.exe'),
      path.join(dugiteDir, '..', 'git', 'usr', 'bin', 'sh.exe'),
    ]
    for (const c of candidates) {
      if (fs.existsSync(c)) return c
    }
  } catch {}
  return 'sh'
}

// ── Service ───────────────────────────────────────────────────────────────────

class HookService {
  listHooks(repoPath: string): HookInfo[] {
    const dir = hooksDir(repoPath)
    const result: HookInfo[] = []

    for (const name of KNOWN_HOOKS) {
      const activePath   = path.join(dir, name)
      const disabledPath = path.join(dir, `${name}.disabled`)

      const activeExists   = fs.existsSync(activePath)
      const disabledExists = fs.existsSync(disabledPath)

      if (!activeExists && !disabledExists) continue

      const filePath = activeExists ? activePath : disabledPath
      let content = ''
      try { content = fs.readFileSync(filePath, 'utf-8') } catch {}

      const isBuiltin = content.includes(BUILTIN_MARKER)

      result.push({
        name,
        enabled: activeExists,
        isBuiltin,
        scriptPreview: scriptPreview(content),
      })
    }

    return result
  }

  enableHook(repoPath: string, name: string): void {
    const dir = hooksDir(repoPath)
    const disabledPath = path.join(dir, `${name}.disabled`)
    const activePath   = path.join(dir, name)
    if (fs.existsSync(disabledPath)) {
      fs.renameSync(disabledPath, activePath)
      this._makeExecutable(activePath)
    }
  }

  disableHook(repoPath: string, name: string): void {
    const dir = hooksDir(repoPath)
    const activePath   = path.join(dir, name)
    const disabledPath = path.join(dir, `${name}.disabled`)
    if (fs.existsSync(activePath)) {
      fs.renameSync(activePath, disabledPath)
    }
  }

  builtins(): BuiltinDef[] {
    return BUILTINS
  }

  installBuiltin(repoPath: string, id: string): void {
    const def = BUILTINS.find(b => b.id === id)
    if (!def) throw new Error(`Unknown builtin hook: ${id}`)

    const dir = hooksDir(repoPath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

    const hookPath = path.join(dir, def.hookName)
    const managed = path.join(dir, 'lucid-git')
    fs.mkdirSync(managed, { recursive: true })
    const userHook = hookPath + '.lucid-user'
    if (fs.existsSync(hookPath)) {
      const content = fs.readFileSync(hookPath, 'utf8')
      if (!content.includes('# lucid-git-dispatcher')) {
        const existingBuiltin = BUILTINS.find(item => content.includes(BUILTIN_MARKER + ' ' + item.id))
        if (existingBuiltin) fs.writeFileSync(path.join(managed, existingBuiltin.id), content, { mode: 0o755 })
        else {
          if (fs.existsSync(userHook)) throw new Error('Preserved user hook already exists. Review hooks before installing.')
          fs.renameSync(hookPath, userHook)
        }
      }
    }
    fs.writeFileSync(path.join(managed, def.id), def.script, { mode: 0o755 })
    const commands = BUILTINS.filter(item => item.hookName === def.hookName).map(item =>
      'if [ -f "$HOOK_DIR/lucid-git/' + item.id + '" ]; then sh "$HOOK_DIR/lucid-git/' + item.id + '" "$@" || exit $?; fi').join('\n')
    const dispatcher = '#!/bin/sh\n# lucid-git-dispatcher\n' + BUILTIN_MARKER + ' dispatcher\nHOOK_DIR=$(dirname "$0")\n' +
      'if [ -f "$HOOK_DIR/' + def.hookName + '.lucid-user" ]; then "$HOOK_DIR/' + def.hookName + '.lucid-user" "$@" || exit $?; fi\n' + commands + '\n'
    fs.writeFileSync(hookPath, dispatcher, { mode: 0o755 })
    this._makeExecutable(hookPath)
  }

  async runPreCommit(repoPath: string): Promise<HookRunResult> {
    const hookPath = path.join(hooksDir(repoPath), 'pre-commit')

    if (!fs.existsSync(hookPath)) {
      return { exists: false, exitCode: 0, output: '', durationMs: 0 }
    }

    const shell = getShell()
    const start = Date.now()

    return new Promise(resolve => {
      const proc = spawn(shell, [hookPath], {
        cwd: repoPath,
        env: { ...process.env },
      })

      let output = ''
      proc.stdout.on('data', (b: Buffer) => { output += b.toString() })
      proc.stderr.on('data', (b: Buffer) => { output += b.toString() })

      proc.on('error', (err) => {
        resolve({
          exists: true,
          exitCode: 1,
          output: `Failed to run hook: ${err.message}`,
          durationMs: Date.now() - start,
        })
      })

      proc.on('close', (code) => {
        resolve({
          exists: true,
          exitCode: code ?? 1,
          output: output.trim(),
          durationMs: Date.now() - start,
        })
      })
    })
  }

  private _makeExecutable(filePath: string): void {
    if (process.platform !== 'win32') {
      try { fs.chmodSync(filePath, 0o755) } catch {}
    }
  }
}

export const hookService = new HookService()
