const { test, expect } = require('@playwright/test')
const fs = require('node:fs'), path = require('node:path'), http = require('node:http')
const { tmpDir, cleanup } = require('./helpers')
const root = path.resolve(__dirname, '..')
test.afterAll(cleanup)

test('large source mesh draws on the GPU with bounded DOM, camera controls, wireframe and view cleanup', async ({ page }, testInfo) => {
  const dir = tmpDir('lg-large-mesh-')
  await require('esbuild').build({ stdin: { contents: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
    import {MeshPreview} from './src/components/diff/MeshPreview';import './src/index.css';import './src/components/diff/UnrealAssetReview.css';
    const mesh={path:'Mesh',name:'Mesh',classPath:'/Script/Engine.StaticMesh'};
    const vertices=[],indices=[],n=160;
    for(let y=0;y<n;y++)for(let x=0;x<n;x++)vertices.push([x,y,12*Math.sin(x/15)*Math.cos(y/15)]);
    for(let y=0;y<n-1;y++)for(let x=0;x<n-1;x++){const a=y*n+x;indices.push(a,a+1,a+n,a+1,a+n+1,a+n)}
    const large={status:'ready',provider:'unreal-source-mesh-v1',totalLods:1,diagnostics:[],lods:[{index:0,vertices,indices,vertexCount:vertices.length,triangleCount:indices.length/3}]};
    const small={...large,lods:[{index:0,vertices:[[0,0,0],[10,0,0],[0,10,0]],indices:[0,1,2],vertexCount:3,triangleCount:1}]};
    const objects=[mesh],allObjects=[objects];
    function App(){const[camera,setCamera]=useState({yaw:-.7,pitch:.5,zoom:1,wireframe:false}),[big,setBig]=useState(true),[shown,setShown]=useState(true);
      const sides=React.useMemo(()=>[big?large:small],[big]);
      return <><button onClick={()=>setBig(!big)}>Switch LOD</button><button onClick={()=>setShown(!shown)}>Toggle view</button>
      <output>{JSON.stringify(camera)}</output>{shown&&<MeshPreview objects={objects} allObjects={allObjects} nativeSides={sides} camera={camera} onCamera={setCamera} onSelect={()=>{}}/>}</>}
    createRoot(document.getElementById('root')).render(<App/>);`, resolveDir: root, loader: 'tsx' }, outfile: path.join(dir, 'app.js'), bundle: true, format: 'esm' })
  const server = http.createServer((req, res) => {
    if(req.url === '/') {res.setHeader('Content-Type','text/html');return res.end('<html><link rel="stylesheet" href="/app.css"><style>body{margin:0}#root{height:100vh;overflow:auto}.uar-mesh{max-width:760px}</style><div id="root"></div><script type="module" src="/app.js"></script></html>')}
    res.setHeader('Content-Type',req.url.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(path.join(dir,req.url.slice(1))))
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const errors=[];page.on('pageerror',error=>errors.push(error.message))
  await page.addInitScript(()=>{
    window.gpuDraws=0;window.gpuDisposals=0
    const draw=WebGL2RenderingContext.prototype.drawElements
    WebGL2RenderingContext.prototype.drawElements=function(...args){window.gpuDraws++;return draw.apply(this,args)}
    const get=HTMLCanvasElement.prototype.getContext,seen=new WeakSet()
    HTMLCanvasElement.prototype.getContext=function(...args){const context=get.apply(this,args);if(args[0]==='webgl2'&&context&&!seen.has(context)){seen.add(context);const extension=context.getExtension('WEBGL_lose_context');if(extension){const lose=extension.loseContext.bind(extension);extension.loseContext=()=>{window.gpuDisposals++;lose()}}}return context}
  })
  try {
    await page.setViewportSize({width:1000,height:900});await page.goto(`http://127.0.0.1:${server.address().port}`)
    const field=page.getByRole('region',{name:'Unreal source mesh preview'}),canvas=page.getByLabel('GPU source geometry')
    await expect(canvas).toBeVisible();await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(page.locator('.uar-mesh')).toContainText('25600 source vertices · 50562 source triangles')
    await expect(field.locator('polygon,line,circle')).toHaveCount(0)
    await expect.poll(()=>page.evaluate(()=>window.gpuDraws)).toBeGreaterThan(0)
    const pixels=()=>canvas.evaluate(element=>{const gl=element.getContext('webgl2'),data=new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4);gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,data);return data.filter((_,i)=>i%4===3&&data[i]>0).length})
    expect(await pixels()).toBeGreaterThan(1000)
    const before=await canvas.evaluate(element=>element.toDataURL())
    await field.focus();await page.keyboard.press('ArrowRight');await page.keyboard.press('+')
    expect(await canvas.evaluate(element=>element.toDataURL())).not.toBe(before)
    const bounds=await field.boundingBox();await page.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2);await page.mouse.down();await page.mouse.move(bounds.x+bounds.width/2+40,bounds.y+bounds.height/2+20);await page.mouse.up()
    expect(JSON.parse(await page.locator('output').innerText()).yaw).not.toBe(-.55)
    await page.mouse.wheel(0,-50);await expect(page.locator('output')).not.toContainText('"zoom":1.5,')
    await page.getByRole('button',{name:'Wireframe',exact:true}).click();expect(await pixels()).toBeGreaterThan(1000)
    await page.getByRole('button',{name:'Fit source mesh',exact:true}).click();await field.focus();await page.keyboard.press('Home')
    await expect(page.locator('output')).toHaveText('{"yaw":-0.7,"pitch":0.5,"zoom":1,"wireframe":true}')
    await page.screenshot({path:testInfo.outputPath('large-wireframe.png')})
    await page.getByRole('button',{name:'Wireframe',exact:true}).click();await page.screenshot({path:testInfo.outputPath('large-solid.png')})
    const draws=await page.evaluate(()=>window.gpuDraws);await page.waitForTimeout(150);expect(await page.evaluate(()=>window.gpuDraws)).toBe(draws)
    await page.getByRole('button',{name:'Switch LOD'}).click();await expect(canvas).toHaveCount(0);await expect(field.locator('polygon')).toHaveCount(1)
    await expect.poll(()=>page.evaluate(()=>window.gpuDisposals)).toBe(1)
    await page.getByRole('button',{name:'Switch LOD'}).click();await expect(canvas).toBeVisible();expect(await pixels()).toBeGreaterThan(1000)
    await page.setViewportSize({width:480,height:640});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
    await page.getByRole('button',{name:'Toggle view'}).click();await expect(canvas).toHaveCount(0);await expect.poll(()=>page.evaluate(()=>window.gpuDisposals)).toBe(2)
    expect(errors).toEqual([])
  } finally {await page.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
})
