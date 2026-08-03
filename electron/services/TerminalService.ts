import { execFile, spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { logService } from './LogService'
import type { TerminalProfile } from '../types'

interface LaunchSpec {
  file: string
  args: string[]
  cwd?: string
  /** Pass the command line through untouched — required for `cmd /c start`. */
  verbatim?: boolean
}

/**
 * A terminal Lucid Git knows how to launch. `resolve` returns the executable
 * (or .app bundle on macOS) backing it, or null when it isn't installed —
 * that doubles as the availability check shown in the picker.
 */
interface TerminalDef {
  id: string
  label: string
  resolve: () => Promise<string | null>
  command: (exe: string, dir: string) => LaunchSpec
}

const LOG_SOURCE = 'shell.openTerminal'
const DETECT_TTL_MS = 60_000

function lookupOnPath(command: string): Promise<string | null> {
  return new Promise(resolve => {
    const finder = process.platform === 'win32' ? 'where' : 'which'
    execFile(finder, [command], { timeout: 4000, windowsHide: true }, (error, stdout) => {
      if (error) return resolve(null)
      const first = stdout.split(/\r?\n/).map(line => line.trim()).find(Boolean)
      resolve(first ?? null)
    })
  })
}

function firstExisting(candidates: (string | undefined | null)[]): string | null {
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch { /* unreadable path — treat as missing */ }
  }
  return null
}

/** Git Bash ships with Git for Windows and is not on PATH, so probe install roots. */
async function resolveGitBash(): Promise<string | null> {
  const direct = firstExisting([
    process.env.ProgramFiles       && path.join(process.env.ProgramFiles, 'Git', 'git-bash.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)']!, 'Git', 'git-bash.exe'),
    process.env.LOCALAPPDATA       && path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'git-bash.exe'),
  ])
  if (direct) return direct

  // Fall back to deriving the install root from git.exe (…\Git\cmd\git.exe).
  const gitExe = await lookupOnPath('git.exe')
  if (!gitExe) return null
  return firstExisting([
    path.resolve(path.dirname(gitExe), '..', 'git-bash.exe'),
    path.resolve(path.dirname(gitExe), '..', '..', 'git-bash.exe'),
  ])
}

function macApp(...names: string[]): () => Promise<string | null> {
  return async () => firstExisting(
    names.flatMap(name => [
      `/Applications/${name}.app`,
      `/Applications/Utilities/${name}.app`,
      `/System/Applications/Utilities/${name}.app`,
      process.env.HOME ? `${process.env.HOME}/Applications/${name}.app` : null,
    ]),
  )
}

function onPath(command: string): () => Promise<string | null> {
  return () => lookupOnPath(command)
}

/**
 * Console shells (powershell, cmd) spawned directly get no console: their stdio
 * is /dev/null, so they read EOF and exit instantly. Routing them through
 * `cmd /c start` makes Windows create a real console window, with `/D` setting
 * the working directory. The command line is hand-quoted and passed verbatim,
 * because cmd.exe does not understand the backslash-escaping Node would apply.
 */
function winConsole(shellArgs: string[] = []): (exe: string, dir: string) => LaunchSpec {
  return (exe, dir) => ({
    file: 'cmd.exe',
    args: ['/d', '/s', '/c', ['start', '""', '/D', `"${dir}"`, `"${exe}"`, ...shellArgs].join(' ')],
    verbatim: true,
  })
}

/** Ordered by preference — the first available entry is what "Auto" picks. */
const WINDOWS_TERMINALS: TerminalDef[] = [
  {
    id: 'windows-terminal',
    label: 'Windows Terminal',
    resolve: onPath('wt.exe'),
    command: (_exe, dir) => ({ file: 'wt.exe', args: ['-d', dir] }),
  },
  {
    id: 'powershell',
    label: 'Windows PowerShell',
    resolve: onPath('powershell.exe'),
    command: winConsole(['-NoLogo', '-NoExit']),
  },
  {
    id: 'pwsh',
    label: 'PowerShell 7',
    resolve: onPath('pwsh.exe'),
    command: winConsole(['-NoLogo', '-NoExit']),
  },
  {
    id: 'git-bash',
    label: 'Git Bash',
    resolve: resolveGitBash,
    command: (exe, dir) => ({ file: exe, args: [`--cd=${dir}`] }),
  },
  {
    id: 'cmd',
    label: 'Command Prompt',
    resolve: onPath('cmd.exe'),
    command: winConsole(),
  },
]

const MAC_TERMINALS: TerminalDef[] = [
  {
    id: 'terminal-app',
    label: 'Terminal',
    resolve: macApp('Terminal'),
    command: (exe, dir) => ({ file: 'open', args: ['-a', exe, dir] }),
  },
  {
    id: 'iterm',
    label: 'iTerm2',
    resolve: macApp('iTerm', 'iTerm2'),
    command: (exe, dir) => ({ file: 'open', args: ['-a', exe, dir] }),
  },
  {
    id: 'warp',
    label: 'Warp',
    resolve: macApp('Warp'),
    command: (exe, dir) => ({ file: 'open', args: ['-a', exe, dir] }),
  },
  {
    id: 'hyper',
    label: 'Hyper',
    resolve: macApp('Hyper'),
    command: (exe, dir) => ({ file: 'open', args: ['-a', exe, dir] }),
  },
  {
    id: 'kitty',
    label: 'kitty',
    resolve: macApp('kitty'),
    command: (exe, dir) => ({ file: 'open', args: ['-a', exe, dir] }),
  },
  {
    id: 'alacritty',
    label: 'Alacritty',
    resolve: macApp('Alacritty'),
    command: (exe, dir) => ({ file: 'open', args: ['-a', exe, dir] }),
  },
]

const LINUX_TERMINALS: TerminalDef[] = [
  {
    id: 'gnome-terminal',
    label: 'GNOME Terminal',
    resolve: onPath('gnome-terminal'),
    command: (exe, dir) => ({ file: exe, args: [`--working-directory=${dir}`] }),
  },
  {
    id: 'konsole',
    label: 'Konsole',
    resolve: onPath('konsole'),
    command: (exe, dir) => ({ file: exe, args: ['--workdir', dir] }),
  },
  {
    id: 'xfce4-terminal',
    label: 'Xfce Terminal',
    resolve: onPath('xfce4-terminal'),
    command: (exe, dir) => ({ file: exe, args: [`--working-directory=${dir}`] }),
  },
  {
    id: 'tilix',
    label: 'Tilix',
    resolve: onPath('tilix'),
    command: (exe, dir) => ({ file: exe, args: [`--working-directory=${dir}`] }),
  },
  {
    id: 'alacritty',
    label: 'Alacritty',
    resolve: onPath('alacritty'),
    command: (exe, dir) => ({ file: exe, args: ['--working-directory', dir] }),
  },
  {
    id: 'kitty',
    label: 'kitty',
    resolve: onPath('kitty'),
    command: (exe, dir) => ({ file: exe, args: ['--directory', dir] }),
  },
  {
    id: 'xterm',
    label: 'xterm',
    resolve: onPath('xterm'),
    command: (exe, dir) => ({ file: exe, args: [], cwd: dir }),
  },
]

function definitions(): TerminalDef[] {
  if (process.platform === 'win32')  return WINDOWS_TERMINALS
  if (process.platform === 'darwin') return MAC_TERMINALS
  return LINUX_TERMINALS
}

function spawnDetached({ file, args, cwd, verbatim }: LaunchSpec): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      detached: true,
      stdio: 'ignore',
      cwd,
      windowsVerbatimArguments: verbatim,
    })
    child.once('error', (error) => {
      logService.error(
        LOG_SOURCE,
        `Failed to launch ${file}\nCwd: ${cwd ?? process.cwd()}\nArgs: ${JSON.stringify(args)}\nMessage: ${error.message}\nStack:\n${error.stack ?? ''}`,
      )
      reject(error)
    })
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

class TerminalService {
  private cache: { at: number; resolved: Map<string, string | null> } | null = null

  private async resolveAll(): Promise<Map<string, string | null>> {
    if (this.cache && Date.now() - this.cache.at < DETECT_TTL_MS) return this.cache.resolved

    const defs = definitions()
    const entries = await Promise.all(defs.map(async (def): Promise<[string, string | null]> => {
      try {
        return [def.id, await def.resolve()]
      } catch {
        return [def.id, null]
      }
    }))
    const resolved = new Map(entries)
    this.cache = { at: Date.now(), resolved }
    return resolved
  }

  /** Every terminal known for this platform, flagged with whether it's installed. */
  async list(): Promise<TerminalProfile[]> {
    const resolved = await this.resolveAll()
    return definitions().map(def => ({
      id: def.id,
      label: def.label,
      available: Boolean(resolved.get(def.id)),
      path: resolved.get(def.id) ?? undefined,
    }))
  }

  /**
   * Open `dir` in the requested terminal. Falls back to the next available
   * terminal when the requested one is missing or refuses to launch, so an
   * uninstalled preference never leaves the button dead.
   */
  async open(dir: string, terminalId?: string): Promise<void> {
    const resolved = await this.resolveAll()
    const defs = definitions()

    const preferred = terminalId && terminalId !== 'auto'
      ? defs.find(def => def.id === terminalId)
      : undefined
    if (terminalId && terminalId !== 'auto' && !preferred) {
      logService.warn(LOG_SOURCE, `Unknown terminal id "${terminalId}" — falling back to auto-detect`)
    }

    const ordered = preferred
      ? [preferred, ...defs.filter(def => def.id !== preferred.id)]
      : defs

    let lastError: unknown = null
    for (const def of ordered) {
      const exe = resolved.get(def.id)
      if (!exe) continue
      try {
        await spawnDetached(def.command(exe, dir))
        return
      } catch (error) {
        lastError = error
        // A launch failure means our cached detection was stale.
        this.cache = null
      }
    }

    if (lastError instanceof Error) throw lastError
    throw new Error(`No supported terminal could be launched for ${dir}`)
  }
}

export const terminalService = new TerminalService()
