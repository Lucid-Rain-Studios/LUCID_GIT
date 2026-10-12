import * as fs from 'fs'
import * as path from 'path'
import { execFile, execSync, spawn } from 'child_process'

export interface CommandletResult {
  success: boolean
  output: string
  outputPath: string | null
  error: string | null
}

export class UEHeadlessService {
  /**
   * Locate the UnrealEditor-Cmd binary for a given engine version.
   * Priority: user override → Windows registry → standard install paths → macOS paths.
   */
  async findEditorBinary(engineVersion: string, override?: string): Promise<string | null> {
    if (override?.trim() && fs.existsSync(override.trim())) return override.trim()
    if (!/^\d+\.\d+/.test(engineVersion)) return null

    const ueFolder = `UE_${engineVersion}`
    const candidates: string[] = []

    if (process.platform === 'win32') {
      // Registry first (custom / non-default install paths)
      try {
        const raw = execSync(
          `reg query "HKEY_LOCAL_MACHINE\\SOFTWARE\\EpicGames\\Unreal Engine\\${engineVersion}" /v InstalledDirectory`,
          { encoding: 'utf8', stdio: 'pipe' }
        )
        const m = raw.match(/InstalledDirectory\s+REG_SZ\s+(.+)/)
        if (m) {
          candidates.push(path.join(m[1].trim(), 'Engine', 'Binaries', 'Win64', 'UnrealEditor-Cmd.exe'))
        }
      } catch { /* registry key absent */ }

      for (const base of [
        process.env['PROGRAMFILES']     ?? 'C:\\Program Files',
        process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)',
      ]) {
        candidates.push(path.join(base, 'Epic Games', ueFolder, 'Engine', 'Binaries', 'Win64', 'UnrealEditor-Cmd.exe'))
      }
    } else if (process.platform === 'darwin') {
      candidates.push(
        path.join('/Users', 'Shared', 'Epic Games', ueFolder, 'Engine', 'Binaries', 'Mac', 'UnrealEditor-Cmd'),
        path.join('/Library', 'Application Support', 'Epic', 'UnrealEngine', ueFolder, 'Engine', 'Binaries', 'Mac', 'UnrealEditor-Cmd'),
      )
    }

    for (const c of candidates) {
      if (fs.existsSync(c)) return c
    }
    return null
  }

  /**
   * Returns true when the Unreal Editor has the project open.
   * UE writes a lock file to Saved/ while running; spawning a second instance corrupts the project.
   */
  isEditorRunning(projectPath: string): boolean {
    const dir = path.extname(projectPath) ? path.dirname(projectPath) : projectPath
    return fs.existsSync(path.join(dir, 'Saved', 'Lock'))
  }

  /** Invoke a UE commandlet. Times out after `timeoutMs` and kills the process. */
  async runCommandlet(args: {
    editorBin: string
    projectPath: string
    commandlet: 'DiffAssets' | 'DataTableCSVExporter' | 'ExportThumbnail' | 'DumpAssetRegistry' | 'pythonscript'
    params: string[]
    timeoutMs: number
    signal?: AbortSignal
    rendering?: boolean
  }): Promise<CommandletResult> {
    return new Promise((resolve) => {
      if (args.signal?.aborted) { resolve({ success: false, output: '', outputPath: null, error: 'Asset preview cancelled.' }); return }
      const argv = [
        args.projectPath,
        `-run=${args.commandlet}`,
        '-unattended', '-nopause', '-nosplash', '-NoCrashDialog', '-NoErrorDialogs', ...(args.rendering ? ['-RenderOffscreen', '-AllowCommandletRendering'] : ['-nullrhi']),
        ...args.params,
      ]

      let output = ''
      let settled = false

      const proc = spawn(args.editorBin, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' })
      // Engine startup is verbose. Retain a bounded diagnostic tail, never the full log.
      const append = (b: Buffer) => { output = (output + b.toString()).slice(-1024 * 1024) }
      proc.stdout?.on('data', append)
      proc.stderr?.on('data', append)
      let stopped: string | null = null
      const kill = () => {
        if (process.platform === 'win32' && proc.pid) execFile('taskkill.exe',['/PID',String(proc.pid),'/T','/F'],{windowsHide:true,timeout:5000},() => proc.kill())
        else if (proc.pid) { try { process.kill(-proc.pid,'SIGKILL') } catch { proc.kill() } }
        else proc.kill()
      }
      const cancel = () => { stopped = 'Asset preview cancelled.'; kill() }
      args.signal?.addEventListener('abort', cancel, { once: true })

      const timer = setTimeout(() => {
        if (settled) return
        stopped = `Timed out after ${args.timeoutMs}ms`
        kill()
      }, args.timeoutMs)

      proc.on('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        args.signal?.removeEventListener('abort', cancel)
        resolve({
          success: code === 0 && !stopped,
          output,
          outputPath: null,
          error: stopped ?? (code !== 0 ? `Exited with code ${code}` : null),
        })
      })

      proc.on('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        args.signal?.removeEventListener('abort', cancel)
        resolve({ success: false, output, outputPath: null, error: err.message })
      })
    })
  }
}

export const ueHeadlessService = new UEHeadlessService()
