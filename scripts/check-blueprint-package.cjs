const fs = require('node:fs/promises')
const path = require('node:path')
const { Arch } = require('builder-util')

// electron-builder otherwise silently skips a missing extraResources source.
module.exports = async function checkBlueprintPackage(context) {
  const platform = { darwin: 'osx', win32: 'win', linux: 'linux' }[context.electronPlatformName]
  const arch = Arch[context.arch]
  if (!platform || !arch) throw new Error('Unsupported Blueprint reader packaging target.')
  const architectures = arch === 'universal' ? ['x64', 'arm64'] : [arch]
  for (const target of architectures) {
    const rid = `${platform}-${target}`
    const directory = path.join(context.packager.projectDir, '.blueprint-build', 'publish', rid)
    const native = platform === 'win' ? ['BlueprintExtractor.exe', 'hostfxr.dll', 'coreclr.dll']
      : ['BlueprintExtractor', `libhostfxr.${platform === 'osx' ? 'dylib' : 'so'}`, `libcoreclr.${platform === 'osx' ? 'dylib' : 'so'}`]
    const required = [...native, 'BlueprintExtractor.dll', 'BlueprintExtractor.runtimeconfig.json', 'BlueprintExtractor.deps.json', 'UAssetAPI.dll']
    const missing = []
    for (const file of required) {
      const stat = await fs.stat(path.join(directory, file)).catch(() => null)
      if (!stat?.isFile() || !stat.size) missing.push(file)
    }
    if (missing.length) throw new Error(`Cannot package without the self-contained Blueprint reader for ${rid}. Run npm run blueprint:publish first. Missing in ${directory}: ${missing.join(', ')}`)
  }
}
