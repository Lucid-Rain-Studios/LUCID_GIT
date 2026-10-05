const { test, expect } = require('@playwright/test')
const { component, find, store } = require('./renderer-harness')
const { tmpDir, cleanup, DIST } = require('./helpers')
const fs = require('fs'), path = require('path')
const flush = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve, reject; const promise = new Promise((r,j) => { resolve = r; reject = j }); return { promise, resolve, reject } }
const noop = () => {}
test.afterAll(cleanup)

test('LG-032 unsigned users can open local repositories and clone without clearing the active checkout', async () => {
  const opened = [], repo = { repoPath: null, recentRepos: [], openRepo: async p => opened.push(p), error: null }
  const harness = component('src/components/layout/AppShell.tsx', {
    '@/stores/repoStore': { useRepoStore: store(repo) }, '@/stores/authStore': { useAuthStore: store({ accounts: [], currentAccountId: null, isAdmin: () => false }) },
    '@/stores/operationStore': { useOperationStore: store({}) }, '@/stores/conflictStore': { useConflictStore: store({}) }, '@/stores/lockStore': { useLockStore: store({}) },
    '@/stores/notificationStore': { useNotificationStore: store({ notifications: [] }) }, '@/stores/statusToastStore': { useStatusToastStore: store({}) },
    '@/stores/forecastStore': { useForecastStore: store({ conflicts: [] }) }, '@/lib/useAutoFetch': { useAutoFetch: noop },
    '@/ipc': { ipc: { openDirectory: async () => 'local-repo' } },
  })
  let tree = harness.render('AppShell'); const top = find(tree, n => n.type === 'TopBar')
  await top.props.onOpen(); expect(opened).toEqual(['local-repo'])
  top.props.onClone(); tree = harness.render('AppShell'); expect(find(tree,n=>n.type === 'CloneDialog')).toBeTruthy()
  repo.repoPath = 'local-repo'; tree = harness.render('AppShell'); expect(find(tree,n=>n.type === 'Sidebar')).toBeTruthy()
})

test('LG-059/061 PR acceptance waits for verified previews and push failure restores the original branch and refreshes', async () => {
  const fetch = deferred(), calls = [], errors = [], toasts = []; let refreshed = 0, tick = 0
  const pr = { number:1, title:'PR', headBranch:'feature', baseBranch:'main', headSha:'a'.repeat(40), baseSha:'b'.repeat(40), author:'me' }
  const api = {
    fetch: async () => fetch.promise, mergePreview: async () => [{ path:'asset', isBinary:true }], branchDiff: async () => ({ files:[], aheadCommits:[], behindCommits:[], totalAdditions:0,totalDeletions:0 }),
    checkout: async (_, branch) => calls.push(branch), log: async () => [{ hash:pr.headSha }], merge: async () => {}, push: async () => { throw Error('push offline') }, mergeInProgress: async () => null,
    githubMergePR: async () => { throw Error('should not merge after failed push') },
  }
  const h = component('src/components/overview/OverviewPanel.tsx', {
    '@/ipc': { ipc: api }, '@/stores/operationStore': { useOperationStore: store({ run: (_,fn)=>fn() }) },
    '@/lib/useDialogOverlayDismiss': { useDialogOverlayDismiss: () => ({}) },
    '@/stores/repoStore': { useRepoStore: store({ currentBranch:'original',refreshStatus:async()=>refreshed++,bumpSyncTick:()=>tick++,bumpHistoryTick:noop,bumpPrTick:noop }) },
    '@/stores/statusToastStore': { useStatusToastStore: store({ show:m=>toasts.push(m) }) }, '@/stores/errorStore': { useErrorStore: store({ pushRaw:m=>errors.push(m) }) }, '@/lib/fetchState': { markFetchPerformed:noop },
  }, { __privateExports:['ResolveDialog'] })
  const props = { pr, ghSlug:'o/r',repoPath:'repo',onClose:noop,onDone:noop }
  const confirm = tree => find(tree,n=>n.type==='button' && /^(Merge PR|Resolve & Merge)$/.test(n.props.children.flat().join('')))
  let tree = h.render('ResolveDialog', props); expect(confirm(tree).props.disabled).toBe(true)
  h.effects[0](); fetch.resolve(); await flush(); h.render('ResolveDialog', props); h.effects[1](); h.effects[2](); await flush()
  h.slots[2] = { asset:'head' }; tree = h.render('ResolveDialog', props); expect(confirm(tree).props.disabled).toBe(false)
  await confirm(tree).props.onClick(); expect(calls).toEqual(['feature','original']); expect(refreshed).toBe(1); expect(tick).toBe(1); expect(errors).toContainEqual(expect.stringContaining('push offline'))
})

test('LG-069 modal focus traps Tab, isolates background, chooses Cancel, contains Escape and restores focus', async () => {
  const handlers = new Map(), document = { activeElement:null, addEventListener:noop, removeEventListener:noop }
  class Element {
    constructor(name) { this.name=name; this.children=[]; this.parentElement=null; this.inert=false; this.tabIndex=0; this.isConnected=true; this.style={zIndex:''} }
    add(child) { child.parentElement=this; this.children.push(child); return child }
    focus() { document.activeElement=this }
    contains(target) { return target===this || this.children.some(c=>c.contains(target)) }
    closest() { return this.inert ? this : this.parentElement?.closest() ?? null }
    hasAttribute() { return false }
    getClientRects() { return [1] }
    querySelectorAll() { return this.children }
    querySelector() { return this.children.find(c=>c.name==='cancel') }
  }
  const body = new Element('body'), background=body.add(new Element('background')), before=background.add(new Element('before')), root=body.add(new Element('modal'))
  const cancel=root.add(new Element('cancel')), confirm=root.add(new Element('confirm')); before.focus(); let closed=0
  const h = component('src/lib/useDialogOverlayDismiss.ts', {}, { HTMLElement:Element, document, window: { addEventListener:(n,fn)=>handlers.set(n,fn),removeEventListener: n=>handlers.delete(n) } })
  const modal = h.render('useDialogOverlayDismiss',()=>closed++); modal.ref.current=root; const dispose=h.effects[0](); await new Promise(r=>setTimeout(r,5))
  expect(modal).toMatchObject({ role:'dialog','aria-modal':true }); expect(background.inert).toBe(true); expect(document.activeElement).toBe(cancel)
  const key = (key,shiftKey=false) => handlers.get('keydown')({ key,shiftKey,preventDefault:noop,stopImmediatePropagation:noop })
  key('Tab'); expect(document.activeElement).toBe(confirm); key('Tab'); expect(document.activeElement).toBe(cancel); key('Tab',true); expect(document.activeElement).toBe(confirm)
  key('Escape'); expect(closed).toBe(1); dispose(); expect(document.activeElement).toBe(before); expect(background.inert).toBe(false); expect(h.exports.isModalOpen()).toBe(false)
  const dialog = component('src/components/ui/GlobalDialogs.tsx',{}, { __privateExports:['ConfirmModal'] })
  const tree = dialog.render('ConfirmModal',{opts:{title:'Delete',danger:true},onConfirm:noop,onCancel:noop})
  expect(find(tree,n=>n.type.name==='ConfirmBtn').props.autoFocus).toBe(false)
})

test('LG-071 late history requests cannot replace newer results and failures show a retry alert', async () => {
  const requests = [], h = component('src/components/history/HistoryPanel.tsx', {
    '@/ipc': { ipc:{ log:()=>{const p=deferred(); requests.push(p); return p.promise} } },
    '@/stores/operationStore': { useOperationStore: store({ run:(_,fn)=>fn() }) }, '@/stores/dialogStore': { useDialogStore: store({}) },
    '@/stores/repoStore': { useRepoStore: store({ fileStatus:[],currentBranch:'main',historyTick:0 }) },
    './graphLayout': { computeGraph: list=>list.map(commit=>({commit,topLines:[],bottomLines:[],lane:0,color:'#fff'})),LANE_W:20,ROW_H:34,DOT_R:4,GRAPH_PAD:4 },
  })
  const refresh = tree=>find(tree,n=>n.props.title==='Refresh history')
  let tree=h.render('HistoryPanel',{repoPath:'repo'}); let button=refresh(tree)
  if (!button) button=find(tree,n=>n.props.onClick && n.props.children?.flat().includes('↻'))
  expect(button).toBeTruthy(); button.props.onClick(); button.props.onClick()
  requests[1].resolve([{hash:'new',message:'new',parentHashes:[],timestamp:1,author:'test'}]); await flush(); requests[0].resolve([{hash:'old'}]); await flush()
  tree=h.render('HistoryPanel',{repoPath:'repo'}); expect(h.slots[1][0].commit.hash).toBe('new')
  refresh(tree).props.onClick(); requests[2].reject(Error('history offline')); await flush(); tree=h.render('HistoryPanel',{repoPath:'repo'})
  const alert=find(tree,n=>n.props.role==='alert'); expect(JSON.stringify(alert)).toContain('history offline'); expect(find(alert,n=>n.type==='button')).toBeTruthy()
})

test('LG-041 post-push unlock keeps dirty paths and reports partial failures', async () => {
  const handlers=new Map(), events=[], targets=[]; const {CHANNELS}=require(path.join(DIST,'ipc/channels'))
  component('electron/ipc/handlers.ts', {
    electron:{ipcMain:{handle:(channel,fn)=>handlers.set(channel,fn)}}, './channels':{CHANNELS}, '../util/repo-gate':{withRepoSlot:(_,__,fn)=>fn()},
    '../services/GitService':{gitService:{push:async()=>({branch:'main',filesAhead:['dirty','clean']}),defaultBranch:async()=> 'main',status:async()=>[{path:'dirty'}]}},
    '../services/AuthService':{authService:{listAccounts:()=>({currentAccountId:'1',accounts:[{userId:'1',login:'me'}]})}},
    '../services/LockService':{lockService:{listLocks:async()=>['dirty','clean'].map(p=>({id:p,path:p,owner:{login:'me'}})),unlockFiles:async(_,list)=>{targets.push(...list);return {unlocked:[],failed:[{filePath:'clean',error:'offline'}]}}}},
    '../services/LogService':{logService:{error:noop}},
    '../services/NotificationService':{notificationService:{push:(_,type,title,body)=>({type,title,body})}},
  }).exports.registerHandlers()
  await handlers.get(CHANNELS.GIT_PUSH)({sender:{isDestroyed:()=>false,send:(...args)=>events.push(args)}},'repo')
  expect(targets).toEqual([{filePath:'clean',lockId:'clean'}]); expect(events.some(e=>e[1]?.id==='push-unlock'&&e[1].status==='error')).toBe(true)
  expect(events.some(e=>e[0]===CHANNELS.EVT_NOTIFICATION&&e[1].type==='locks-retained')).toBe(true)
})

test('LG-065 settings saves touch global Git only for branch changes and roll back on disk failures', async () => {
  const handlers = new Map(), writes = [], saves = []; let failSave = false, failRead = false
  const { CHANNELS } = require(path.join(DIST, 'ipc/channels'))
  component('electron/ipc/handlers.ts', {
    electron: { ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) }, app: { getPath: () => 'home' } }, './channels': { CHANNELS },
    '../services/SettingsService': { settingsService: { getAll: () => ({ defaultBranchName: 'main' }), save: async patch => { saves.push(patch); if (failSave) throw Error('disk full') } } },
    '../services/LogService': { logService: { error: noop } },
    '../util/dugite-exec': { withGitTimeout: (_, fn) => fn(), execSafe: async args => args[0] === 'check-ref-format' ? { exitCode: 0 } : { exitCode: failRead ? 3 : 0, stdout: 'legacy\n', stderr: failRead ? 'config unreadable' : '' }, exec: async args => { writes.push(args) } },
  }).exports.registerHandlers()
  const save = patch => handlers.get(CHANNELS.SETTINGS_SAVE)({}, patch)
  await save({ theme: 'dark' }); expect(writes).toEqual([])
  failSave = true; await expect(save({ defaultBranchName: 'feature' })).rejects.toThrow('disk full')
  expect(writes).toEqual([['config','--global','init.defaultBranch','feature'], ['config','--global','init.defaultBranch','legacy']])
  failRead = true; await expect(save({ defaultBranchName: 'feature' })).rejects.toThrow('config unreadable'); expect(writes.length).toBe(2)
  failSave = false; await save({ theme: 'light' }); expect(saves.at(-1)).toEqual({ theme: 'light' })
})

test('LG-076 recovery provides reload and log-folder links without a preload or renderer scripts', async () => {
  const windows=[], opened=[]; let reloads=0
  function Window(options) { this.options=options; this.events={}; this.webContents={setWindowOpenHandler:noop,on:(name,fn)=>this.events[name]=fn}; this.on=noop; this.isDestroyed=()=>false; this.focus=noop; this.close=noop; this.loadURL=async url=>{this.url=url}; windows.push(this) }
  const {showRecovery}=component('electron/services/RecoveryService.ts',{electron:{app:{getPath:()=> 'log-folder'},BrowserWindow:Window,shell:{openPath:async p=>opened.push(p)}}}).exports
  showRecovery('<script>failure</script>',()=>reloads++); expect(windows[0].options.webPreferences).toMatchObject({nodeIntegration:false,sandbox:true}); expect(windows[0].options.webPreferences.preload).toBeUndefined()
  const html=decodeURIComponent(windows[0].url.split(',').slice(1).join(',')); expect(html).toContain('&lt;script&gt;failure'); expect(html).not.toContain('<script>')
  windows[0].events['will-navigate']({preventDefault:noop},'lucid-recovery://logs'); expect(opened).toEqual(['log-folder'])
  windows[0].events['will-navigate']({preventDefault:noop},'lucid-recovery://reload'); expect(reloads).toBe(1)
})

test('LG-077 renderer type errors fail validation without emitting JavaScript', () => {
  const dir=tmpDir('lg-typecheck-'); fs.writeFileSync(path.join(dir,'renderer.tsx'),'const text: string = 123;\nexport { text };')
  const result=require('child_process').spawnSync(process.execPath,[path.join(__dirname,'../node_modules/typescript/bin/tsc'),'--noEmit','--strict','--skipLibCheck',path.join(dir,'renderer.tsx')],{encoding:'utf8'})
  expect(result.status).not.toBe(0); expect(result.stdout).toContain('TS2322'); expect(fs.existsSync(path.join(dir,'renderer.js'))).toBe(false)
})
