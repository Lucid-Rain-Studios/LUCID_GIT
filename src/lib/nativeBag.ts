/** Split engine-exported bag fields without interpreting native types or nested values. */
export function nativeBagFields(text: string): Array<{ name: string; value: string }> | null {
  if (text === '(Value=None)') return []
  if (text.length > 65536 || !text.startsWith('(Value=')) return null
  const start = text.indexOf('(', 7)
  if (start < 0) return null
  const fields: Array<{ name: string; value: string }> = [], seen = new Set<string>()
  let depth = 0, quoted = false, escaped = false, begin = start + 1, end = -1
  const field = (value: string) => {
    if (!value.trim()) return true
    const separator = value.indexOf('='), name = value.slice(0, separator).trim()
    if (separator < 1 || !/^[\p{L}\p{N}_]+$/u.test(name) || seen.has(name) || fields.length >= 256) return false
    seen.add(name); fields.push({ name, value: value.slice(separator + 1).trim() }); return true
  }
  for (let index = begin; index < text.length; index++) {
    const character = text[index]
    if (quoted) { if (escaped) escaped = false; else if (character === '\\') escaped = true; else if (character === '"') quoted = false; continue }
    if (character === '"') quoted = true
    else if (character === '(') { if (++depth > 32) return null }
    else if (character === ')') {
      if (depth === 0) { if (!field(text.slice(begin,index))) return null; end = index; break }
      depth--
    } else if (character === ',' && depth === 0) { if (!field(text.slice(begin,index))) return null; begin = index + 1 }
  }
  return end >= 0 && text.slice(end) === '))' ? fields : null
}
