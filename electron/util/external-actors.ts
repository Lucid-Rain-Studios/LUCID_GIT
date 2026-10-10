// Standard Unreal OFPA layout. Ownership still requires a decoded PersistentLevel
// reference; hashed filenames and the folder convention alone are not evidence.
export function owningMapCandidate(file: string): string | undefined {
  const match = /^(.*\/Content)\/__ExternalActors__\/(.+)\/([a-z0-9]{1,2})\/([a-z0-9]{1,2})\/([a-z0-9]{20,32})\.uasset$/i.exec('/' + file.replace(/\\/g, '/'))
  return match ? (match[1] + '/' + match[2] + '.umap').slice(1) : undefined
}
export function externalActorPrefix(map: string): string | undefined {
  const match = /^(.*\/Content)\/(.+)\.umap$/i.exec('/' + map.replace(/\\/g, '/'))
  return match ? (match[1] + '/__ExternalActors__/' + match[2] + '/').slice(1) : undefined
}
export function mapPackagePath(map: string): string | undefined {
  const match = /^(.*)Content\/(.+)\.umap$/i.exec(map.replace(/\\/g, '/'))
  if (!match) return undefined
  const parent = match[1].replace(/\/$/, '').split('/').pop()
  // Custom plugin mount names are not guessed beyond the standard plugin layout.
  const mount = /(?:^|\/)Plugins\//i.test(match[1]) ? parent : 'Game'
  return mount ? '/' + mount + '/' + match[2] : undefined
}
