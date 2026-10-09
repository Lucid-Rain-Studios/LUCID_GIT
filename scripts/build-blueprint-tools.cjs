const fs = require('node:fs'), path = require('node:path'), { execFileSync } = require('node:child_process')
const root = path.resolve(__dirname, '..'), out = path.join(root, 'public', 'blueprint')
const missing = ['third_party/klee/src/scene.ts', 'third_party/UAssetAPI/UAssetAPI/UAssetAPI.csproj'].filter(p => !fs.existsSync(path.join(root, p)))
if (missing.length) throw new Error('Clone UAssetAPI and Klee into third_party before building Blueprint tools: ' + missing.join(', '))
require('./setup-blueprint-deps.cjs')
async function main() {
  fs.mkdirSync(out, { recursive: true })
  await require('esbuild').build({ entryPoints: [path.join(root, 'tools/blueprint-klee-host.js')], outfile: path.join(out, 'klee.js'), bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true,
    plugins: [{ name: 'klee-production-controls', setup(build) {
      build.onLoad({ filter: /klee[\\/]src[\\/].*\.ts$/ }, args => {
        // Upstream uses webpack preprocessing for these blocks. Leaving them in
        // draws debug layout boxes over every control in an esbuild bundle.
        let contents = fs.readFileSync(args.path, 'utf8').replace(/\/\/\/ #if DEBUG_UI[\s\S]*?\/\/\/ #endif/g, '')
        if (args.path.endsWith('pin.control.ts')) contents = contents.replace("canvas.font('12px sans-serif')", 'canvas.font(Constants.NODE_FONT)').replace('.fillStyle("#eee")', '.fillStyle(Constants.NODE_TEXT_COLOR)')
        return { contents, loader: 'ts' }
      })
    }}] })
  fs.copyFileSync(path.join(root, 'third_party/klee/LICENSE'), path.join(out, 'KLEE-LICENSE.txt'))
  const project = path.join(root, 'tools/BlueprintExtractor/BlueprintExtractor.csproj')
  const publishing = process.argv.includes('--publish')
  // The app publishes both Intel and Apple Silicon DMGs from one macOS runner.
  const targets = publishing ? process.platform === 'darwin' ? ['osx-x64', 'osx-arm64'] : [process.platform === 'win32' ? 'win-x64' : 'linux-x64'] : [null]
  for (const rid of targets) {
    const notices = rid ? path.join(root, '.blueprint-build/publish', rid) : path.join(root, 'tools/BlueprintExtractor/bin/Release/net10.0')
    const args = rid ? ['publish', project, '-c', 'Release', '-r', rid, '--self-contained', 'true', '-p:GeneratePackageOnBuild=false', '-o', notices, '--verbosity', 'quiet'] : ['build', project, '-c', 'Release', '-p:GeneratePackageOnBuild=false', '--verbosity', 'quiet']
    execFileSync('dotnet', args, { cwd: root, stdio: 'inherit', windowsHide: true, env: { ...process.env, DOTNET_CLI_HOME: path.join(root, '.blueprint-build/dotnet'), DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1' } })
    for (const file of ['LICENSE', 'NOTICE.md']) fs.copyFileSync(path.join(root, 'third_party/UAssetAPI', file), path.join(notices, 'UASSETAPI-' + file + '.txt'))
    fs.copyFileSync(path.join(root, 'tools/BlueprintExtractor/THIRD-PARTY-NOTICES.md'), path.join(notices, 'THIRD-PARTY-NOTICES.md'))
    for (const file of ['NEWTONSOFT-LICENSE.txt', 'ZSTDSHARP-LICENSE.txt', 'DOTNET-LICENSE.txt', 'DOTNET-NOTICES.txt']) fs.copyFileSync(path.join(root, 'tools/BlueprintExtractor', file), path.join(notices, file))
  }
  console.log('Blueprint reader and read-only Klee host built.')
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
