const { test, expect } = require('@playwright/test')
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path')
const { Arch } = require('builder-util')
const checkPackage = require('../scripts/check-blueprint-package.cjs')
const { BlueprintReaderWorker } = require('../dist-electron/services/BlueprintReaderWorker')

test('hidden Blueprint reader preserves Unicode across both pipes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-reader-unicode-'))
  const worker = new BlueprintReaderWorker()
  const helper = path.resolve(__dirname, '../tools/BlueprintExtractor/bin/Release/net10.0')
  const fixture = path.resolve(__dirname, '../third_party/UAssetAPI/UAssetAPI.Tests/TestAssets/TestEditorAssets/TestActorBP.uasset')
  const file = path.join(root, 'Blueprint “emissive”.uasset')
  try {
    await expect(worker.read(helper, file, false)).rejects.toThrow('Blueprint “emissive”.uasset')
    await fs.copyFile(fixture, file)
    const document = JSON.parse(await worker.read(helper, file, false))
    expect(document.graphs.length).toBeGreaterThan(0)
  } finally {
    worker.stop()
    await fs.rm(root, { recursive: true, force: true })
  }
})

for (const [platform, prefix, native] of [
  ['darwin', 'osx', ['BlueprintExtractor', 'libhostfxr.dylib', 'libcoreclr.dylib']],
  ['win32', 'win', ['BlueprintExtractor.exe', 'hostfxr.dll', 'coreclr.dll']],
  ['linux', 'linux', ['BlueprintExtractor', 'libhostfxr.so', 'libcoreclr.so']],
]) test(`packaging requires a nonempty self-contained reader for the target architecture: ${platform}`, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-reader-package-'))
  const context = { electronPlatformName: platform, arch: Arch.x64, packager: { projectDir: root } }
  try {
    await expect(checkPackage(context)).rejects.toThrow('Run npm run blueprint:publish')
    const directory = path.join(root, '.blueprint-build', 'publish', prefix + '-x64')
    await fs.mkdir(directory, { recursive: true })
    for (const name of [...native, 'BlueprintExtractor.dll', 'BlueprintExtractor.runtimeconfig.json', 'BlueprintExtractor.deps.json', 'UAssetAPI.dll']) await fs.writeFile(path.join(directory, name), 'fixture')
    await checkPackage(context)
    await expect(checkPackage({ ...context, arch: Arch.arm64 })).rejects.toThrow(prefix + '-arm64')
    if (platform === 'darwin') await expect(checkPackage({ ...context, arch: Arch.universal })).rejects.toThrow('osx-arm64')
    await fs.writeFile(path.join(directory, native[2]), '')
    await expect(checkPackage(context)).rejects.toThrow(native[2])
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
