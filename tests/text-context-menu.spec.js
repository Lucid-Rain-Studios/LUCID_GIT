const { test, expect, _electron: electron } = require('@playwright/test')
const fs = require('node:fs'), path = require('node:path')
const electronPackage = path.dirname(require.resolve('electron'))
const electronExecutable = path.join(electronPackage, 'dist', fs.readFileSync(path.join(electronPackage, 'path.txt'), 'utf8').trim())
const { DIST, tmpDir, cleanup } = require('./helpers')
test.afterAll(cleanup)

test('Electron edit menu handles search/text fields and selection without replacing file menus', async () => {
  const dir = tmpDir('lg-edit-menu-')
  const entry = path.join(dir, 'main.cjs')
  fs.writeFileSync(entry, `
    const {app,BrowserWindow,Menu}=require('electron');
    const {attachTextContextMenu}=require(${JSON.stringify(path.join(DIST,'util/text-context-menu.js'))});
    app.setPath('userData',${JSON.stringify(path.join(dir,'profile'))});
    global.menus=[];global.contexts=[];
    const build=Menu.buildFromTemplate.bind(Menu);
    Menu.buildFromTemplate=template=>{
      const menu=build(template);
      menu.popup=()=>{global.lastMenu=menu;global.menus.push(menu.items.map(item=>({role:item.role,type:item.type,enabled:item.enabled})))};
      return menu;
    };
    app.whenReady().then(async()=>{
      const win=new BrowserWindow({width:700,height:500,show:false});global.win=win;
      attachTextContextMenu(win);
      win.webContents.on('context-menu',(_,params)=>global.contexts.push({editable:params.isEditable,flags:params.editFlags}));
      await win.loadURL('data:text/html,'+encodeURIComponent('<input type="search" aria-label="Search files" value="search sample"><input type="text" aria-label="Filter files"><div id="file" style="margin-top:30px">File row</div>'));
    });
  `)
  const app = await electron.launch({executablePath:electronExecutable,args:[entry]})
  try {
    const page = await app.firstWindow()
    const search = page.getByRole('searchbox',{name:'Search files'})
    await search.evaluate(el=>{el.focus();el.select()})
    await search.click({button:'right',position:{x:20,y:10}})
    await expect.poll(()=>app.evaluate(()=>global.menus.length)).toBe(1)
    const items = await app.evaluate(()=>global.menus[0])
    expect(items.map(item=>item.role||item.type)).toEqual(['cut','copy','paste','separator','selectall'])
    expect(items[0].enabled).toBe(true); expect(items[1].enabled).toBe(true)
    expect(items[2].enabled).toBe(await app.evaluate(()=>global.contexts[0].flags.canPaste))
    const filter = page.getByRole('textbox',{name:'Filter files'})
    await filter.click({button:'right'})
    await expect.poll(()=>app.evaluate(()=>global.menus.length)).toBe(2)
    expect(await app.evaluate(()=>global.menus[1].slice(0,2).map(item=>item.enabled))).toEqual([false,false])
    await filter.fill('select me')
    await filter.evaluate(el=>el.setSelectionRange(0,0))
    await filter.click({button:'right'})
    await expect.poll(()=>app.evaluate(()=>global.menus.length)).toBe(3)
    await app.evaluate(()=>global.lastMenu.items.find(item=>item.role==='selectall').click({},global.win,global.win.webContents))
    await expect.poll(()=>filter.evaluate(el=>el.value.slice(el.selectionStart,el.selectionEnd))).toBe('select me')
    await page.locator('#file').click({button:'right'})
    await expect.poll(()=>app.evaluate(()=>global.contexts.length)).toBe(4)
    expect(await app.evaluate(()=>global.menus.length)).toBe(3)
  } finally { await app.close() }
})
