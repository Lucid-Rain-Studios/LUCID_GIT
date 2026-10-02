import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const recovered = new Set<string>()

class InvalidJsonSchema extends Error {}

export class JsonStoreReadError extends Error {
  readonly corrupt: boolean

  constructor(file: string, failures: unknown[]) {
    super(`Unable to read ${path.basename(file)}. Data was preserved for recovery. ${String(failures[0])}`)
    this.corrupt = failures.every(error => error instanceof SyntaxError || error instanceof InvalidJsonSchema
      || (error as NodeJS.ErrnoException)?.code === 'ENOENT')
  }
}

export function readJson<T>(file: string, validate: (value: unknown) => value is T, initial: T): T {
  const failures: unknown[] = []
  for (const candidate of [file, file + '.bak']) {
    try {
      const value: unknown = JSON.parse(fs.readFileSync(candidate, 'utf8'))
      if (!validate(value)) throw new InvalidJsonSchema('Invalid stored data schema')
      if (candidate !== file) { recovered.add(file); console.warn('Recovered JSON store from backup:', file) }
      return value
    } catch (error) { failures.push(error) }
  }
  if (failures.every(error => (error as NodeJS.ErrnoException)?.code === 'ENOENT')) return initial
  throw new JsonStoreReadError(file, failures)
}

/** Small metadata writes are atomic; never replace a good backup with corrupt data. */
export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = file + '.' + randomUUID() + '.tmp'
  try {
    const fd = fs.openSync(temp, 'wx')
    try { fs.writeFileSync(fd, JSON.stringify(value, null, 2), 'utf8'); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    if (fs.existsSync(file) && !recovered.has(file)) {
      const previous = fs.readFileSync(file, 'utf8')
      try {
        JSON.parse(previous)
        const backup = file + '.' + randomUUID() + '.bak.tmp'
        try { fs.writeFileSync(backup, previous); fs.renameSync(backup, file + '.bak') }
        finally { if (fs.existsSync(backup)) fs.unlinkSync(backup) }
      } catch (error) { if (!(error instanceof SyntaxError)) throw error }
    }
    fs.renameSync(temp, file)
    recovered.delete(file)
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp) }
}

export const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

export async function writeJsonAsync(file: string, value: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  const temp = file + '.' + randomUUID() + '.tmp'
  try {
    const handle = await fs.promises.open(temp, 'wx')
    try { await handle.writeFile(JSON.stringify(value, null, 2), 'utf8'); await handle.sync() } finally { await handle.close() }
    try {
      const previous = await fs.promises.readFile(file, 'utf8')
      JSON.parse(previous)
      if (!recovered.has(file)) {
        const backup = file + '.' + randomUUID() + '.bak.tmp'
        try { await fs.promises.writeFile(backup, previous, 'utf8'); await fs.promises.rename(backup, file + '.bak') }
        finally { await fs.promises.unlink(backup).catch(() => {}) }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
    await fs.promises.rename(temp, file)
    recovered.delete(file)
  } finally { await fs.promises.unlink(temp).catch(() => {}) }
}
