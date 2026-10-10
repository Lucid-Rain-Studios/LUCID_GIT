const { test, expect } = require('@playwright/test')
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), crypto = require('node:crypto')
const { DIST, git, tmpDir, cleanup } = require('./helpers')
const { component } = require('./renderer-harness')
const runner = require(path.join(DIST, 'util/dugite-exec'))
const { BlueprintRevisionService } = require(path.join(DIST, 'services/BlueprintRevisionService'))
const root = path.resolve(__dirname, '..')
const fixture = path.join(root, 'third_party/UAssetAPI/UAssetAPI.Tests/TestAssets/TestEditorAssets/TestActorBP.uasset')
const helper = path.join(root, 'tools/BlueprintExtractor/bin/Release/net10.0')
test.afterAll(cleanup)

function controlledAsset(execBinary, remote, token = 'synthetic-test-token') {
  return component('electron/services/AssetDiffService.ts', {
    fs, path, os: require('node:os'), crypto,
    '../util/dugite-exec': { ...runner, execBinary },
    './AuthService': { authService: { getCurrentToken: async () => typeof token === 'function' ? token() : token } },
    './GitService': { gitService: { getRemoteUrl: async () => remote } },
  }, { Buffer }).exports.assetDiffService
}

test('LFS retrieval scopes app credentials, validates historical bytes, deduplicates failures and allows explicit retry', async () => {
  const bytes = fs.readFileSync(fixture), oid = crypto.createHash('sha256').update(bytes).digest('hex')
  const pointer = Buffer.from(`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${bytes.length}\n`)
  for (const remote of ['https://github.com/example/repo.git', 'https://foreign.example/repo.git']) {
    const commands = []
    const asset = controlledAsset(async args => { commands.push(args); return bytes }, remote)
    expect((await asset.resolveLfsPointer('repo', 'BP.uasset', pointer)).equals(bytes)).toBe(true)
    expect(commands[0].some(arg => arg.includes('AUTHORIZATION'))).toBe(remote.startsWith('https://github.com/'))
    expect(commands[0].filter(arg => arg.includes('AUTHORIZATION')).every(arg => arg.startsWith('http.https://github.com/.extraheader='))).toBe(true)
  }
  let smudges = 0, available = false
  const asset = controlledAsset(async args => {
    if (args.includes('cat-file')) return pointer
    smudges++
    if (!available) throw new Error('Remote LFS object missing (404)')
    return bytes
  }, 'https://github.com/example/repo.git')
  const dest = tmpDir('lg-lfs-validation-')
  const failed = await asset.extractBlob('repo', 'BP.uasset', 'HEAD', dest, 'left')
  expect(failed.blobPath).toBeNull(); expect(failed.reason).toContain('404')
  await expect(asset.resolveLfsPointer('repo', 'BP.uasset', pointer)).rejects.toThrow('404')
  expect(smudges).toBe(1)
  available = true
  const retry = new Set()
  expect((await asset.resolveLfsPointer('repo', 'BP.uasset', pointer, retry)).equals(bytes)).toBe(true)
  expect(smudges).toBe(2)
  const corrupt = controlledAsset(async args => args.includes('cat-file') ? pointer : Buffer.alloc(bytes.length), null)
  expect((await corrupt.extractBlob('repo', 'BP.uasset', 'HEAD', dest, 'left')).reason).toContain('does not match')
  const sharing = controlledAsset(async () => { await new Promise(resolve => setTimeout(resolve, 30)); smudges++; return bytes }, null)
  const before = smudges
  await Promise.all(Array.from({length:6}, () => sharing.resolveLfsPointer('repo','BP.uasset',pointer)))
  expect(smudges - before).toBe(1)
  let account = 'old-synthetic-account', authAttempts = 0
  const rotating = controlledAsset(async () => { authAttempts++; if (account.startsWith('old')) throw new Error('Authentication failed (401)'); return bytes }, 'https://github.com/example/repo.git', () => account)
  await expect(rotating.resolveLfsPointer('repo','BP.uasset',pointer)).rejects.toThrow('401')
  account = 'new-synthetic-account'
  expect((await rotating.resolveLfsPointer('repo','BP.uasset',pointer)).equals(bytes)).toBe(true)
  expect(authAttempts).toBe(2) // Switching accounts does not reuse the old failure.
})

test('real authenticated LFS download, missing remote object, offline cache and Retry preserve repository state', async () => {
  const bytes = fs.readFileSync(fixture), oid = crypto.createHash('sha256').update(bytes).digest('hex')
  const authorization = 'Basic ' + Buffer.from('test-user:synthetic-local-secret').toString('base64')
  let mode = 'ready', batches = 0, downloads = 0, denied = 0, base
  const server = http.createServer((req, res) => {
    if (mode === 'denied' || req.headers.authorization !== authorization) { denied++; res.writeHead(401, {'WWW-Authenticate':'Basic realm="test-lfs"'}); res.end(); return }
    if (req.url === '/repo.git/info/lfs/objects/batch') {
      batches++
      let body = ''; req.on('data', data => { body += data }); req.on('end', () => {
        const request = JSON.parse(body)
        expect(request.operation).toBe('download')
        expect(request.objects).toEqual([{oid,size:bytes.length}])
        res.setHeader('Content-Type','application/vnd.git-lfs+json')
        res.end(JSON.stringify({transfer:'basic',objects:[mode === 'missing'
          ? {oid,size:bytes.length,error:{code:404,message:'Test LFS object does not exist'}}
          : {oid,size:bytes.length,actions:{download:{href:base+'/object/'+oid,header:{Authorization:authorization}}}}]}))
      }); return
    }
    if (req.url === '/object/'+oid) { downloads++; res.setHeader('Content-Length',bytes.length); res.end(bytes); return }
    res.writeHead(404); res.end()
  })
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
  base = `http://127.0.0.1:${server.address().port}`
  const repo = tmpDir('lg-blueprint-lfs-remote-')
  git(repo,'init','-q'); git(repo,'config','user.name','Test'); git(repo,'config','user.email','test@example.com')
  git(repo,'config','credential.helper',''); git(repo,'config','lfs.transfer.maxretries','1')
  git(repo,'lfs','install','--local'); git(repo,'lfs','track','*.uasset')
  fs.copyFileSync(fixture,path.join(repo,'BP_Test.uasset')); git(repo,'add','.'); git(repo,'commit','-qm','asset')
  git(repo,'remote','add','origin',base+'/repo.git')
  git(repo,'config',`http.${base}/.extraheader`,'Authorization: '+authorization)
  const pointer = git(repo,'show','HEAD:BP_Test.uasset')
  fs.writeFileSync(path.join(repo,'BP_Test.uasset'),pointer)
  const before = git(repo,'status','--porcelain'), index = git(repo,'write-tree'), head = git(repo,'rev-parse','HEAD')
  const object = path.join(repo,'.git','lfs','objects',oid.slice(0,2),oid.slice(2,4),oid)
  const removeObject = () => { if (fs.existsSync(object)) fs.unlinkSync(object) } // Exact disposable object; never remove a real repo cache.
  const reader = () => new BlueprintRevisionService(helper,tmpDir('lg-blueprint-remote-cache-'))
  const request = force => ({filePath:'BP_Test.uasset',leftRef:'HEAD',rightRef:'WORKING',requestId:'remote',force})
  try {
    removeObject()
    const service = reader(), retrieved = await service.compare(repo,request(false))
    expect(retrieved.left.document?.status).toBe('complete'); expect(retrieved.right.document?.status).toBe('complete')
    expect(batches).toBe(1); expect(downloads).toBe(1)
    expect(fs.readFileSync(object).equals(bytes)).toBe(true)
    removeObject(); mode = 'denied'
    const unauthorized = await service.compare(repo,request(true))
    expect(unauthorized.left.status).toBe('unavailable'); expect(unauthorized.right.status).toBe('unavailable')
    expect(unauthorized.left.reason).toMatch(/auth|401|credential/i)
    expect(denied).toBeGreaterThan(0); expect(denied).toBeLessThanOrEqual(3)
    removeObject(); mode = 'missing'
    const missing = await service.compare(repo,request(true))
    expect(missing.left.status).toBe('unavailable'); expect(missing.right.status).toBe('unavailable')
    expect(missing.left.reason).toMatch(/404|does not exist/)
    const attempts = batches
    expect(attempts).toBe(2) // Both sides share the failed attempt.
    await service.compare(repo,request(false)); expect(batches).toBe(attempts)
    mode = 'ready'
    const retry = await service.compare(repo,request(true))
    expect(retry.left.document?.status).toBe('complete'); expect(retry.right.document?.status).toBe('complete')
    expect(batches).toBe(attempts+1)
    await new Promise(resolve => server.close(resolve))
    const offlineLocal = await reader().compare(repo,request(false))
    expect(offlineLocal.left.document?.status).toBe('complete'); expect(offlineLocal.right.document?.status).toBe('complete')
    removeObject()
    const offlineReader = reader(), { GitProcess } = require('dugite'), originalSpawn = GitProcess.spawn
    let offlineSmudges = 0
    GitProcess.spawn = function(args, ...rest) { if (args.includes('lfs') && args.includes('smudge')) offlineSmudges++; return originalSpawn.call(this,args,...rest) }
    try {
      const offline = await offlineReader.compare(repo,request(true))
      expect(offline.left.status).toBe('unavailable'); expect(offline.right.status).toBe('unavailable')
      expect(offline.left.reason).toMatch(/connect|refused|unavailable/i)
      expect(offlineSmudges).toBe(1)
      await expect(offlineReader.compare(repo,{...request(false),requestId:'offline-again'})).resolves.toMatchObject({left:{status:'unavailable'},right:{status:'unavailable'}})
      expect(offlineSmudges).toBe(1)
    } finally { GitProcess.spawn = originalSpawn }
    expect(fs.readFileSync(path.join(repo,'BP_Test.uasset'),'utf8')).toBe(pointer)
    expect(git(repo,'status','--porcelain')).toBe(before); expect(git(repo,'write-tree')).toBe(index); expect(git(repo,'rev-parse','HEAD')).toBe(head)
  } finally { if (server.listening) await new Promise(resolve => server.close(resolve)) }
})
