/** Machine-readable Git output: never trim or unquote filenames. */
export const nulPaths = (output: string): string[] => output.split('\0').filter(Boolean)

export function parseNameStatus(output: string): Array<{ status: string; path: string; oldPath?: string }> {
  const fields = nulPaths(output)
  const result: Array<{ status: string; path: string; oldPath?: string }> = []
  for (let i = 0; i < fields.length;) {
    const status = fields[i++].charAt(0)
    const first = fields[i++]
    if (first === undefined) throw new Error('Incomplete Git filename record')
    if (status === 'R' || status === 'C') {
      const destination = fields[i++]
      if (destination === undefined) throw new Error('Incomplete Git rename record')
      result.push({ status, path: destination, oldPath: first })
    } else result.push({ status, path: first })
  }
  return result
}

export function parseNumstat(output: string): Array<{ path: string; additions: number; deletions: number }> {
  const fields = nulPaths(output)
  const result = []
  for (let i = 0; i < fields.length; i++) {
    const match = fields[i].match(/^([^\t]+)\t([^\t]+)\t([\s\S]*)$/)
    if (!match) throw new Error('Invalid Git numstat record')
    let path = match[3]
    if (!path) { i++; path = fields[++i] }
    if (path === undefined) throw new Error('Incomplete Git numstat rename')
    result.push({ path, additions: parseInt(match[1], 10) || 0, deletions: parseInt(match[2], 10) || 0 })
  }
  return result
}
