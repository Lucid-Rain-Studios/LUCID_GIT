const { test, expect } = require('@playwright/test')
const fs = require('node:fs'), path = require('node:path')
const { DIST, git, tmpDir, cleanup } = require('./helpers')
const { component } = require('./renderer-harness')
const { BlueprintRevisionService } = require(path.join(DIST, 'services/BlueprintRevisionService'))
const { discoverExternalActors, confirmsMapOwnership } = require(path.join(DIST, 'services/ExternalActorReview'))
const { owningMapCandidate, externalActorPrefix } = require(path.join(DIST, 'util/external-actors'))
const { assetChanges, reviewObjects } = component('src/lib/unrealAssetReview.ts').exports
const { createBlueprintClient } = component('src/lib/blueprintClient.ts').exports
const map = 'Content/Maps/Test.umap', prefix = externalActorPrefix(map)
const actor = prefix + 'A/BC/' + '1'.repeat(22) + '.uasset'
const other = prefix + 'A/BC/' + '2'.repeat(22) + '.uasset'
const saved = (value = 1, owner = '/Game/Maps/Test') => ({ schemaVersion: 1, readerVersion: 10, status: 'unsupported', assetClass: '', graphs: [], diagnostics: [], engineVersion: '5.6.0', assetReview: { family: 'asset', cooked: false, coverage: ['Controlled tagged-property fixture'], objects: [{ id: 'A'.repeat(32), name: 'TestActor', path: owner + '.Test.PersistentLevel.TestActor', outer: owner + '.Test.PersistentLevel', classPath: '/Script/Engine.StaticMeshActor', properties: { ActorGuid: { ActorGuid: 'A'.repeat(32) }, Value: value, DataLayerAssets: ['/Game/Layers/Gameplay'] }, decoded: true, opaqueBytes: 0, opaqueHash: '', diagnostics: [] }] } })
const world = { ...saved(), assetClass: '/Script/Engine.World', assetReview: { ...saved().assetReview, family: 'map', objects: [] } }
function write(repo, file, doc) { fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); fs.writeFileSync(path.join(repo, file), JSON.stringify(doc)) }
function setup() {
  const repo = tmpDir('lg-external-actor-')
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.com')
  write(repo, map, world); write(repo, actor, saved()); write(repo, other, { ...saved(5), assetReview: { ...saved().assetReview, objects: [{ ...saved(5).assetReview.objects[0], id: 'B'.repeat(32) }] } })
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base')
  const service = new BlueprintRevisionService(undefined, tmpDir('lg-external-actor-cache-'))
  // Manifest/capture tests use controlled documents; the separate local fixture
  // test below exercises the actual UAssetAPI reader and real binary edit.
  service.extract = async (_, file) => JSON.parse(fs.readFileSync(file, 'utf8'))
  const compare = (leftRef, rightRef, filePath = map, oldPath) => service.compare(repo, { filePath, oldPath, leftRef, rightRef, externalActors: filePath.endsWith('.umap') })
  return { repo, service, compare }
}
test.afterAll(cleanup)

test('ownership requires a saved actor GUID and PersistentLevel reference, not the hashed filename', () => {
  expect(owningMapCandidate(actor)).toBe(map)
  expect(owningMapCandidate('Content/Maps/BP_Actor.uasset')).toBeUndefined()
  expect(confirmsMapOwnership({ status: 'ready', document: saved() }, map)).toBe(true)
  expect(confirmsMapOwnership({ status: 'ready', document: saved(1, '/Game/Other') }, map)).toBe(false)
  expect(confirmsMapOwnership({ status: 'unavailable' }, map)).toBe(false)
})

test('unchanged map groups only changed actors with exact staged and working properties', async () => {
  const { repo, compare } = setup(), rootBytes = fs.readFileSync(path.join(repo, map))
  write(repo, actor, saved(2)); git(repo, 'add', actor); write(repo, actor, saved(3))
  const status = git(repo, 'status', '--porcelain'), index = fs.readFileSync(path.join(repo, '.git/index'))
  const staged = await compare('HEAD', 'INDEX'), working = await compare('INDEX', 'WORKING')
  expect(staged.left.contentHash).toBe(staged.right.contentHash)
  expect(staged.externalActors.total).toBe(1); expect(staged.externalActors.packages).toHaveLength(1)
  expect(assetChanges(staged)[0].properties.find(p => p.path === 'Value')).toMatchObject({ before: 1, after: 2 })
  expect(assetChanges(working)[0].properties.find(p => p.path === 'Value')).toMatchObject({ before: 2, after: 3 })
  expect(reviewObjects(working, 'right')[0].sourcePackage).toBe(actor)
  expect(reviewObjects(working, 'right')[0].properties.DataLayerAssets).toEqual(['/Game/Layers/Gameplay'])
  const direct = await compare('INDEX', 'WORKING', actor)
  expect(direct.owningMaps).toEqual({ left: map, right: map })
  expect(fs.readFileSync(path.join(repo, map))).toEqual(rootBytes)
  expect(fs.readFileSync(path.join(repo, '.git/index'))).toEqual(index)
  expect(git(repo, 'status', '--porcelain')).toBe(status)
})

test('untracked additions, deletions and companion-only changes are discovered without decoding unchanged packages', async () => {
  const { repo, compare } = setup()
  fs.unlinkSync(path.join(repo, actor)); write(repo, prefix + 'D/EF/' + '3'.repeat(22) + '.uasset', saved(4))
  fs.writeFileSync(path.join(repo, other.replace('.uasset', '.uexp')), 'companion')
  const result = await compare('HEAD', 'WORKING')
  expect(result.externalActors.total).toBe(3)
  expect(result.externalActors.packages.find(p => p.left.path === actor).right.status).toBe('absent')
  expect(assetChanges(result).map(item => item.kind).sort()).toEqual(['added', 'removed'])
})

test('map rename preserves paired package paths; unresolved owners and missing maps cannot become confirmed removals', async () => {
  const { repo, compare } = setup(), renamed = 'Content/Maps/New.umap', newPrefix = externalActorPrefix(renamed)
  const base = git(repo, 'rev-parse', 'HEAD').trim()
  git(repo, 'mv', map, renamed); git(repo, 'mv', prefix.replace(/\/$/, ''), newPrefix.replace(/\/$/, ''))
  for (const file of [actor, other]) write(repo, file.replace(prefix, newPrefix), saved(2, '/Game/Maps/New'))
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'rename map')
  const result = await compare(base, 'HEAD', renamed, map)
  expect(result.externalActors.total).toBe(2)
  expect(result.externalActors.packages.every(p => p.left.status === 'ready' && p.right.status === 'ready')).toBe(true)
  write(repo, actor.replace(prefix, newPrefix), saved(3, '/Game/Wrong'))
  const unresolved = await compare('HEAD', 'WORKING', renamed)
  expect(unresolved.externalActors.packages[0].right.status).toBe('unavailable')
  expect(assetChanges(unresolved)).toEqual([])
  fs.unlinkSync(path.join(repo, renamed))
  const deleted = await compare('HEAD', 'WORKING', renamed)
  expect(deleted.externalActors.packages[0].right.reason).toContain('owning map is absent')
})

test('actor moved between maps retains both verified owners and is compared in the selected map scope', async () => {
  const { repo, service } = setup(), destination = 'Content/Maps/Other.umap'
  const newActor = actor.replace(prefix, externalActorPrefix(destination))
  write(repo, destination, world); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'second map')
  fs.mkdirSync(path.dirname(path.join(repo, newActor)), { recursive: true })
  git(repo, 'mv', actor, newActor); write(repo, newActor, saved(2, '/Game/Maps/Other'))
  const direct = await service.compare(repo, { filePath: newActor, oldPath: actor, leftRef: 'HEAD', rightRef: 'WORKING' })
  expect(direct.owningMaps).toEqual({ left: map, right: destination })
  const result = await service.compare(repo, { filePath: destination, oldPath: map, leftRef: 'HEAD', rightRef: 'WORKING', externalActors: true })
  expect(result.externalActors.total).toBe(1)
  expect(result.externalActors.packages[0]).toMatchObject({ left: { path: actor, status: 'ready' }, right: { path: newActor, status: 'ready' } })
  expect(assetChanges(result)[0].kind).toBe('modified')
})

test('package count limit and capture changes produce explicit partial coverage', async () => {
  const { repo, service, compare } = setup()
  for (let i = 10; i < 30; i++) write(repo, prefix + 'G/HI/' + String(i).repeat(11) + '.uasset', saved(i))
  const result = await compare('INDEX', 'WORKING')
  expect(result.externalActors.total).toBe(20); expect(result.externalActors.packages).toHaveLength(16); expect(result.externalActors.omitted).toBe(4)
  const extract = service.extract.bind(service)
  service.extract = async (...args) => { const doc = await extract(...args); write(repo, actor, saved(99)); return doc }
  const changed = await service.compare(repo, { filePath: map, leftRef: 'INDEX', rightRef: 'WORKING', externalActors: true, force: true })
  expect(changed.externalActors.packages).toEqual([])
  expect(changed.externalActors.diagnostics.join(' ')).toContain('changed during capture')
})

test('compact client hydrates actor documents across side deduplication and bounded cache eviction', async () => {
  const doc = saved(), key = 'a'.repeat(64), actorKey = 'b'.repeat(64)
  const client = createBlueprintClient(async (_, request) => {
    const side = { status: 'ready', documentKey: key, document: request.knownDocuments.includes(key) ? undefined : world }
    return { left: side, right: { ...side, document: undefined }, owningMaps: { right: map }, externalActors: { scope: 'changed-packages', total: 1, omitted: 0, diagnostics: [], packages: [{ left: { status: 'ready', documentKey: actorKey, document: request.knownDocuments.includes(actorKey) ? undefined : doc }, right: { status: 'ready', documentKey: actorKey } }] } }
  })
  const first = await client('repo', {}), cached = await client('repo', {})
  expect(first.externalActors.packages[0].right.document).toBe(doc)
  expect(cached.externalActors.packages[0].left.document).toBe(doc)
  expect(cached.owningMaps.right).toBe(map)
})

test('oversized LFS actor is skipped before retrieval and never reported as absent', async () => {
  const { repo, compare } = setup()
  fs.writeFileSync(path.join(repo, actor), 'version https://git-lfs.github.com/spec/v1\noid sha256:' + 'a'.repeat(64) + '\nsize 70000000\n')
  const result = await compare('HEAD', 'WORKING')
  expect(result.externalActors.packages[0].right.status).toBe('unavailable')
  expect(result.externalActors.packages[0].right.reason).toContain('capture budget')
  expect(assetChanges(result)).toEqual([])
})

test('browser groups external changes under an unchanged owning map and preserves selected refs', async ({ page }, testInfo) => {
  const http = require('node:http'), dir = tmpDir('lg-ofpa-browser-')
  const pair = { left: { status: 'ready', ref: 'INDEX', path: actor, document: saved() }, right: { status: 'ready', ref: 'WORKING', path: actor, document: saved(2) } }
  const rootSides = { left: { status: 'ready', ref: 'INDEX', path: map, document: world }, right: { status: 'ready', ref: 'WORKING', path: map, document: world } }
  await require('esbuild').build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {UnrealAssetReview} from './src/components/diff/UnrealAssetReview';import './src/index.css';createRoot(document.getElementById('root')).render(<UnrealAssetReview repoPath="test" request={{filePath:${JSON.stringify(actor)},leftRef:'INDEX',rightRef:'WORKING'}} onFallback={()=>{}}/>);`, resolveDir: path.resolve(__dirname, '..'), loader: 'tsx' }, alias: { '@': path.join(__dirname, '../src') }, outfile: path.join(dir, 'app.js'), bundle: true, format: 'esm' })
  const server = http.createServer((req, res) => {
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end(`<html><link rel="stylesheet" href="/app.css"><style>html,body,#root{margin:0;width:100%;height:100%;display:flex}</style><div id="root"></div><script>window.calls=[];window.lucidGit={blueprintCancel:async()=>{},blueprintCompare:async(_,r)=>{window.calls.push(r);return r.filePath.endsWith('.umap')?${JSON.stringify({ ...rootSides, externalActors: { scope: 'changed-packages', total: 4, omitted: 3, packages: [pair], diagnostics: ['Changed packages only.'] } })}:${JSON.stringify({ ...pair, owningMaps: { left: map, right: map } })}}}</script><script type="module" src="/app.js"></script></html>`); return }
    res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(fs.readFileSync(path.join(dir, req.url.slice(1))))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.getByRole('button', { name: 'Review owning map', exact: true }).click()
    await expect(page.getByLabel('Changed external actor packages')).toContainText('1 of 4 changed actor packages reviewed · 3 omitted')
    await expect(page.locator('.uar-heading')).toContainText(map)
    await expect(page.getByText('~ 1 modified')).toBeVisible()
    await page.locator('.uar-row').click()
    await expect(page.locator('.uar-before')).toHaveText('1'); await expect(page.locator('.uar-after')).toHaveText('2')
    await expect(page.getByRole('region', { name: 'Saved object details' })).toContainText('Source package: ' + actor)
    expect(await page.evaluate(() => window.calls[1])).toMatchObject({ filePath: map, oldPath: map, leftRef: 'INDEX', rightRef: 'WORKING', externalActors: true })
    await page.getByRole('button', { name: 'Contents', exact: true }).click()
    await page.getByRole('button', { name: 'Base', exact: true }).click()
    await page.locator('.uar-row').click()
    expect(await page.evaluate(() => window.calls.length)).toBe(2)
    await page.setViewportSize({ width: 480, height: 640 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('ofpa-map-review.png') })
    await page.getByRole('button', { name: 'Back to actor package', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Review owning map', exact: true })).toBeVisible()
    expect(errors).toEqual([])
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})

test('real OFPA transform edit is visible with identical root map bytes', async () => {
  test.skip(!process.env.EXTERNAL_ACTOR_FIXTURE || !process.env.EXTERNAL_ACTOR_MAP, 'Set target UE source map and external actor fixtures.')
  const repo = tmpDir('lg-ofpa-real-'), source = fs.readFileSync(process.env.EXTERNAL_ACTOR_FIXTURE)
  const mapPath = 'Content/Variant_Shooter/Lvl_ArenaShooter.umap', actorPath = 'Content/__ExternalActors__/Variant_Shooter/Lvl_ArenaShooter/E/U6/02V6M9C5U71IQYCXQMIPPI.uasset'
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.com')
  fs.mkdirSync(path.dirname(path.join(repo, mapPath)), { recursive: true }); fs.copyFileSync(process.env.EXTERNAL_ACTOR_MAP, path.join(repo, mapPath))
  fs.mkdirSync(path.dirname(path.join(repo, actorPath)), { recursive: true }); fs.writeFileSync(path.join(repo, actorPath), source)
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'real source fixtures')
  // Target fixture's explicitly saved FVector (300, 1000, 0), UE5 doubles.
  // Only the disposable copy is edited; require one unambiguous byte sequence.
  const vector = Buffer.alloc(24); vector.writeDoubleLE(300, 0); vector.writeDoubleLE(1000, 8); vector.writeDoubleLE(0, 16)
  const offset = source.indexOf(vector)
  expect(offset).toBeGreaterThan(-1); expect(source.indexOf(vector, offset + 1)).toBe(-1)
  const changed = Buffer.from(source); changed.writeDoubleLE(350, offset); fs.writeFileSync(path.join(repo, actorPath), changed)
  const reader = new BlueprintRevisionService(path.join(__dirname, '../tools/BlueprintExtractor/bin/Release/net10.0'), tmpDir('lg-ofpa-real-cache-'))
  const result = await reader.compare(repo, { filePath: mapPath, leftRef: 'HEAD', rightRef: 'WORKING', externalActors: true })
  expect(result.left.contentHash).toBe(result.right.contentHash)
  expect(result.externalActors.total).toBe(1)
  expect(result.externalActors.packages[0].right.status, result.externalActors.packages[0].right.reason).toBe('ready')
  expect(assetChanges(result).flatMap(item => item.properties).find(p => p.path === 'RelativeLocation.RelativeLocation.X')).toMatchObject({ before: 300, after: 350 })
  expect(fs.readFileSync(process.env.EXTERNAL_ACTOR_FIXTURE)).toEqual(source)
})
