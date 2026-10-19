/** Explicit tagged vector/rotator fields only; omitted values have no defaults. */
export function savedVector(value: unknown, name: string, keys: string[]): [number,number,number] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const root = value as Record<string,unknown>, data = root[name] ?? root
  if (!data || typeof data !== 'object' || Array.isArray(data)) return
  const numbers = keys.map(key => {
    const entry = (data as Record<string,unknown>)[key]
    return typeof entry === 'number' || typeof entry === 'string' && entry.trim() !== '' ? Number(entry) : NaN
  })
  return numbers.length === 3 && numbers.every(Number.isFinite) ? numbers as [number,number,number] : undefined
}
