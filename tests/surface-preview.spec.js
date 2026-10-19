const { test, expect } = require('@playwright/test')
const fs = require('node:fs'), path = require('node:path'), http = require('node:http')
const { execFileSync } = require('node:child_process')
const { tmpDir, cleanup } = require('./helpers')
const { component } = require('./renderer-harness')
const root = path.resolve(__dirname, '..')
test.afterAll(cleanup)

async function texturePayload(dir) {
  await require('sharp')({ create: { width: 4, height: 2, channels: 4, background: '#ff0000' } }).png().toFile(path.join(dir,'source.png'))
  const script = component('electron/services/TexturePreviewScript.ts').exports.TEXTURE_PREVIEW_SCRIPT
  const python = `import json, os, shutil, types\nbase=${JSON.stringify(dir)}\nresult={'diagnostics':[]}\nclass Texture2D:\n    def get_name(self): return 'TextureFixture'\ndef export(task):\n    shutil.copyfile(os.path.join(base,'source.png'),task.filename)\n    return True\nunreal=types.SimpleNamespace(Texture2D=Texture2D,AssetExportTask=types.SimpleNamespace,TextureExporterPNG=types.SimpleNamespace,Exporter=types.SimpleNamespace(run_asset_export_task=export))\n${script}\nexport_texture_preview(Texture2D())\n`
  const file = path.join(dir,'texture-test.py'); fs.writeFileSync(file,python)
  execFileSync('python',[file])
  return fs.readFileSync(path.join(dir,'scene.glb'))
}

test('Texture2D source exporter creates a bounded embedded unlit image with aspect ratio and alpha', async () => {
  const bytes = await texturePayload(tmpDir('lg-texture-payload-'))
  const { inspectSceneGlb } = require('../dist-electron/util/scene-glb')
  expect(inspectSceneGlb(bytes)).toMatchObject({ textures:1, meshes:1, vertices:4, triangles:2 })
  const json = JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString())
  expect(json.accessors[0]).toMatchObject({ min:[-1,-.5,0], max:[1,.5,0] })
  expect(json.materials[0]).toMatchObject({ alphaMode:'BLEND', extensions:{KHR_materials_unlit:{}} })
  expect(json.images[0].uri).toBeUndefined()
})

for (const [kind,assetClass] of [['texture','Texture2D'],['material','Material'],['material','MaterialInstanceConstant']]) test(`${assetClass} preview is explicit, renders, preserves tabs and caches revision switching`, async ({ page }, info) => {
  const dir = tmpDir('lg-surface-browser-'), bytes = await texturePayload(dir)
  const object = { id:'',name:'Surface',path:'Surface',outer:'',classPath:'/Script/Engine.'+assetClass,properties:{SRGB:true,ScalarParameterValues:[{ParameterValue:.4}]},decoded:true,opaqueBytes:0,opaqueHash:'',diagnostics:[] }
  const document = {readerVersion:17,engineVersion:'5.8.3',assetClass:object.classPath,assetReview:{family:kind==='texture'?'texture':'asset',objects:[object],coverage:[],cooked:false},graphs:[]}
  const scene = {status:'ready',key:'c'.repeat(64),engineVersion:'5.8.3',packages:[],diagnostics:[],complete:true}
  const side = {status:'ready',path:'Content/Surface.uasset',document}
  const comparison = {left:{...side,ref:'a'.repeat(40)},right:{...side,ref:'b'.repeat(40)}}
  await require('esbuild').build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {UnrealAssetReview} from './src/components/diff/UnrealAssetReview';import './src/index.css';createRoot(document.getElementById('root')).render(<UnrealAssetReview repoPath="test" request={{filePath:'Content/Surface.uasset',leftRef:'${'a'.repeat(40)}',rightRef:'${'b'.repeat(40)}'}}/>);`,resolveDir:root,loader:'tsx'},alias:{'@':path.join(root,'src')},outfile:path.join(dir,'app.js'),bundle:true,format:'esm'})
  const server = http.createServer((req,res) => {
    if(req.url==='/'){res.setHeader('Content-Type','text/html'); return res.end(`<html><link rel="stylesheet" href="/app.css"><div id="root"></div><script>window.calls=[];window.reads=0;window.lucidGit={logRendererEvent:async()=>{},blueprintCancel:async()=>{},blueprintCompare:async(_,r)=>{window.calls.push(r);const data=${JSON.stringify(comparison)};if(r.nativeScene){await new Promise(resolve=>setTimeout(resolve,150));data.left.scene=data.right.scene=${JSON.stringify(scene)}}return data},nativeSceneRead:async()=>{window.reads++;return new Uint8Array(${JSON.stringify([...bytes])})}}</script><script type="module" src="/app.js"></script></html>`) }
    res.setHeader('Content-Type',req.url.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(path.join(dir,req.url.slice(1))))
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const errors=[];page.on('pageerror',e=>errors.push(e.message))
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await expect(page.getByText('Reading saved asset revisions…',{exact:true})).toHaveCount(0)
    await expect(page.getByText('No differences in decoded objects/properties. Other package data may still differ.',{exact:true})).toBeVisible()
    await page.getByRole('button',{name:'Preview',exact:true}).click()
    await expect(page.getByRole('region',{name:kind==='texture'?'Texture preview':'Material preview',exact:true})).toBeVisible()
    expect(await page.evaluate(()=>window.calls.length)).toBe(1)
    await page.getByRole('button',{name:'Render '+kind,exact:true}).click()
    await expect(page.getByRole('button',{name:'Rendering scene…',exact:true})).toBeDisabled()
    await expect(page.getByRole('button',{name:'Fit scene',exact:true})).toBeEnabled()
    const viewport=page.getByRole('region',{name:'Engine scene viewport'})
    await expect(viewport).toBeVisible();await viewport.focus();await page.keyboard.press('+')
    if(kind==='texture'){await expect(page.getByRole('button',{name:'Wireframe',exact:true})).toHaveCount(0);await expect(page.getByText(/Texture2D source image · unlit/)).toBeVisible()}
    await page.getByRole('button',{name:'Contents',exact:true}).click();await page.getByRole('button',{name:'Preview',exact:true}).click()
    await expect(viewport).toBeVisible()
    await page.getByRole('button',{name:'Base',exact:true}).click();await expect(viewport).toBeVisible()
    expect(await page.evaluate(()=>window.calls.length)).toBe(2);expect(await page.evaluate(()=>window.reads)).toBe(1);expect(errors).toEqual([])
    await page.screenshot({path:info.outputPath('preview.png'),fullPage:true})
  } finally {await page.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
})
