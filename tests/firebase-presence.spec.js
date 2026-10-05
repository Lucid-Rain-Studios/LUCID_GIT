const { test, expect } = require('@playwright/test')
const fs = require('fs'), path = require('path')
const { component, find, store } = require('./renderer-harness')
const { DIST, tmpDir, cleanup } = require('./helpers')
const { FirebasePresenceService, validateFirebaseConfig } = require(path.join(DIST, 'services/FirebasePresenceService'))
const { firebasePresenceRules } = component('src/lib/firebasePresenceRules.ts').exports
const flush = () => new Promise(resolve => setImmediate(resolve))
const config = { enabled: true, apiKey: 'public-web-key', projectId: 'lucid-test', authDomain: 'lucid-test.firebaseapp.com', databaseURL: 'https://lucid-test-default-rtdb.firebaseio.com', workspaceId: 'studio-repo' }
const entry = (who, status = 'active') => ({ login: who, name: who, status, lastSeen: new Date().toISOString(), branch: '', modifiedCount: 0, modifiedFiles: [] })
test.afterAll(cleanup)

test('authentication failures explain Firebase codes without exposing provider credentials', async () => {
 for (const [message, expected] of [
  ['OPERATION_NOT_ALLOWED', 'Enable GitHub'],
  ['INVALID_IDP_RESPONSE: access_token=private-token', 'Sign out of GitHub'],
  ['API_KEY_INVALID', 'Copy the Web API key'],
  ['unexpected private-token', 'HTTP 400'],
 ]) {
  const service = new FirebasePresenceService(() => ({ userId: 'admin', login: 'admin', name: 'Admin' }), async () => 'private-token',
   async () => new Response(JSON.stringify({ error: { message } }), { status: 400 }))
  await expect(service.test(config)).rejects.toThrow(expected)
  try { await service.test(config) } catch (error) { expect(error.message).not.toContain('private-token') }
 }
})

// Controlled Firebase-shaped transport, including a distinct Firebase UID per GitHub account.
// This is not a substitute for the actual Firebase rules emulator or deployed OAuth testing.
function database() {
 const roles = { 'uid-admin': { role: 'admin', login: 'admin', name: 'Admin' }, 'uid-member': { role: 'member', login: 'member', name: 'Member' } }
 const sessions = {}, calls = []
 let now = Date.now(), deny = false
 const response = (data, code = 200) => new Response(JSON.stringify(data), { status: code, headers: { date: new Date(now).toUTCString() } })
 const request = async (url, options = {}) => {
  const u = new URL(url), method = options.method || 'GET'
  calls.push({ url, method, body: options.body })
  if (u.hostname === 'identitytoolkit.googleapis.com') {
    const token = new URLSearchParams(JSON.parse(options.body).postBody).get('access_token')
    const uid = 'uid-' + token.replace('github-', '')
    return response({ localId: uid, idToken: 'firebase-' + uid, expiresIn: '3600' })
  }
  const uid = (u.searchParams.get('auth') || '').replace('firebase-', '')
  const parts = u.pathname.replace(/\.json$/, '').split('/').filter(Boolean)
  const [root, workspace, category, owner, device] = parts
  if (deny || root !== 'lucidGit' || workspace !== 'studio-repo') return response({ error: 'Permission denied' }, 401)
  if (method === 'GET') {
    if (category === 'members' && owner === uid) return response(roles[uid] || null)
    if (roles[uid]?.role !== 'admin') return response({ error: 'Permission denied' }, 401)
    return response(category === 'members' ? roles : sessions)
  }
  if (category === 'members' && owner === uid && method === 'PUT') {
    const data = JSON.parse(options.body)
    if (roles[uid] || data.role !== 'member') return response({ error: 'Permission denied' }, 401)
    roles[uid] = data
    return response(data)
  }
  if (!roles[uid] || owner !== uid || category !== 'presence') return response({ error: 'Permission denied' }, 401)
  sessions[uid] ||= {}
  if (method === 'DELETE') { delete sessions[uid][device]; return response(null) }
  const data = JSON.parse(options.body)
  sessions[uid][device] = { ...data, lastSeen: now }
  return response(sessions[uid][device])
 }
 return { roles, sessions, calls, request, setNow: value => { now = value }, setDeny: value => { deny = value } }
}
function client(db, login, device) {
 let current = { userId: login, login, name: login }
 const service = new FirebasePresenceService(() => current, async id => 'github-' + id, db.request, () => device)
 const repo = tmpDir('lg-firebase-')
 service.save(repo, config)
 return { service, repo, switchAccount: login => { current = { userId: login, login, name: login } } }
}

test('two clones publish and admin reads one shared roster; members cannot read it', async () => {
 const db = database(), admin = client(db, 'admin', 'desktop-a'), member = client(db, 'member', 'desktop-b')
 await Promise.all([admin.service.publish(admin.repo, entry('admin')), member.service.publish(member.repo, entry('member', 'away'))])
 const shared = await admin.service.read(config)
 expect(shared.source).toBe('firebase'); expect(shared.entries['uid-admin'].status).toBe('active'); expect(shared.entries['uid-member'].status).toBe('away')
 await expect(member.service.read(config)).rejects.toThrow('denied access')
 expect(fs.existsSync(path.join(member.repo, '.lucid-git', 'lucid-presence.json'))).toBe(false)
 const saved = fs.readFileSync(path.join(member.repo, '.lucid-git', 'firebase-presence.json'), 'utf8')
 expect(saved).not.toContain('firebase-uid'); expect(saved).not.toContain('github-member')
 for (const call of db.calls.filter(c => c.method === 'PUT')) expect(Object.keys(JSON.parse(call.body))).toEqual(['status','lastSeen'])
})

test('bootstrap test returns Firebase UID while locked, then verifies read/write/delete', async () => {
 const db = database(), admin = client(db, 'admin', 'desktop')
 db.setDeny(true)
 const first = await admin.service.test(config)
 expect(first.uid).toBe('uid-admin'); expect(first.canRead).toBe(false); expect(first.canPublish).toBe(false)
 db.setDeny(false)
 const second = await admin.service.test(config)
 expect(second.canRead).toBe(true); expect(second.canPublish).toBe(true)
 expect(Object.keys(db.sessions['uid-admin'])).toHaveLength(0)
 expect(db.calls.filter(c => c.url.includes('identitytoolkit'))).toHaveLength(1)
})

test('first heartbeat registers a member automatically and preserves existing admin roles', async () => {
 const db = database(), newcomer = client(db, 'newcomer', 'desktop'), admin = client(db, 'admin', 'admin-desktop')
 await newcomer.service.publish(newcomer.repo, entry('newcomer'))
 expect(db.roles['uid-newcomer']).toEqual({ role: 'member', login: 'newcomer', name: 'newcomer' })
 expect(db.sessions['uid-newcomer'].desktop.status).toBe('active')
 await newcomer.service.publish(newcomer.repo, entry('newcomer', 'away'))
 expect(db.calls.filter(c => c.url.includes('/members/uid-newcomer.json') && c.method === 'PUT')).toHaveLength(1)
 await expect(newcomer.service.read(config)).rejects.toThrow('denied access')
 await admin.service.publish(admin.repo, entry('admin'))
 expect(db.roles['uid-admin'].role).toBe('admin')
 expect(db.calls.filter(c => c.url.includes('/members/uid-admin.json') && c.method === 'PUT')).toHaveLength(0)
})

test('concurrent devices register once and disabled membership cannot be overwritten', async () => {
 const db = database(), first = client(db, 'newcomer', 'a'), second = client(db, 'newcomer', 'b')
 await Promise.all([first.service.publish(first.repo, entry('newcomer')), second.service.publish(second.repo, entry('newcomer'))])
 expect(Object.keys(db.sessions['uid-newcomer'])).toEqual(['a', 'b'])
 db.roles['uid-blocked'] = { role: 'disabled', login: 'blocked', name: 'Blocked' }
 const blocked = client(db, 'blocked', 'desktop')
 await expect(blocked.service.publish(blocked.repo, entry('blocked'))).rejects.toThrow('membership is disabled')
 expect(db.roles['uid-blocked'].role).toBe('disabled')
})

test('same-user devices aggregate Active > Away > Offline and expire using Firebase time', async () => {
 const db = database(), admin = client(db, 'admin', 'desktop-a')
 const serverNow = Math.floor(Date.now() / 1000) * 1000 + 86400000
 db.setNow(serverNow)
 db.sessions['uid-admin'] = { a: { status: 'away', lastSeen: serverNow }, b: { status: 'active', lastSeen: serverNow - 1000 }, old: { status: 'active', lastSeen: serverNow - 180000 } }
 db.sessions['uid-member'] = { a: { status: 'active', lastSeen: serverNow - 180000 }, invalid: { status: 'active', lastSeen: 'bad' } }
 const result = await admin.service.read(config)
 expect(result.entries['uid-admin'].status).toBe('active')
 expect(Math.abs(Date.parse(result.entries['uid-admin'].lastSeen) - Date.now())).toBeLessThan(2500)
 expect(result.entries['uid-member'].status).toBe('offline')
})

test('minute heartbeats remain active between samples and expire after three missed updates', async () => {
 const db = database(), serverNow = Math.floor(Date.now() / 1000) * 1000
 db.setNow(serverNow)
 db.sessions['uid-admin'] = { desktop: { status: 'active', lastSeen: serverNow - 179999 } }
 db.sessions['uid-member'] = { desktop: { status: 'away', lastSeen: serverNow - 60000 } }
 const first = await client(db, 'admin', 'reader-a').service.read(config)
 expect(first.entries['uid-admin'].status).toBe('active')
 expect(first.entries['uid-member'].status).toBe('away')
 db.sessions['uid-admin'].desktop.lastSeen = serverNow - 180000
 db.sessions['uid-member'].desktop = { status: 'offline', lastSeen: serverNow }
 const next = await client(db, 'admin', 'reader-b').service.read(config)
 expect(next.entries['uid-admin'].status).toBe('offline')
 expect(next.entries['uid-member'].status).toBe('offline')
})

test('authentication/read requests deduplicate; writes serialize and failed access does not fall back', async () => {
 const db = database(), admin = client(db, 'admin', 'desktop')
 await Promise.all([admin.service.read(config), admin.service.read(config)])
 expect(db.calls.filter(c => c.url.includes('identitytoolkit'))).toHaveLength(1)
 expect(db.calls.filter(c => c.url.includes('/presence.json'))).toHaveLength(1)
 await Promise.all([admin.service.publish(admin.repo, entry('admin')), admin.service.publish(admin.repo, entry('admin', 'offline'))])
 expect(db.sessions['uid-admin'].desktop.status).toBe('offline')
 db.setDeny(true); await expect(admin.service.read(config)).rejects.toThrow('denied access')
})

test('account switches isolate cached credentials and reject an older pending identity before publishing', async () => {
 const db = database(), admin = client(db, 'admin', 'desktop')
 await admin.service.read(config)
 admin.switchAccount('member')
 await expect(admin.service.read(config)).rejects.toThrow('denied access')
 expect(db.calls.filter(c => c.url.includes('identitytoolkit'))).toHaveLength(2)
 const other = client(db, 'admin', 'other')
 const work = other.service.publish(other.repo, entry('admin'))
 other.switchAccount('member')
 await expect(work).rejects.toThrow('Account changed')
 expect(db.sessions['uid-admin']).toBeUndefined()
})

test('connection validation rejects private keys, non-Firebase hosts, redirects and path injection', () => {
 for (const patch of [
  { databaseURL: 'http://localhost:8080' }, { databaseURL: 'https://evil.test' },
  { databaseURL: config.databaseURL + '/other' }, { databaseURL: config.databaseURL + '?auth=secret' },
  { databaseURL: 'https://user:password@lucid-test.firebaseio.com' }, { authDomain: 'evil.test' },
  { workspaceId: '../other' }, { private_key: 'secret' },
 ]) expect(() => validateFirebaseConfig({ ...config, ...patch })).toThrow()
 expect(validateFirebaseConfig({ ...config, databaseURL: 'https://lucid-test.europe-west1.firebasedatabase.app/' }).databaseURL).toContain('firebasedatabase.app')
})

test('Firebase web config imports the console snippet as data and rejects credentials or executable expressions', () => {
 const parse = component('src/lib/firebasePresenceConfig.ts').exports.parseFirebaseWebConfig
 expect(parse('const firebaseConfig = { apiKey: "key", projectId: "lucid-test", authDomain: "lucid-test.firebaseapp.com", appId: "public-app", };')).toEqual({ apiKey: 'key', projectId: 'lucid-test', authDomain: 'lucid-test.firebaseapp.com' })
 expect(() => parse('{ "private_key": "secret" }')).toThrow('public web configuration')
 expect(() => parse('{ apiKey: (() => "secret")() }')).toThrow()
})

test('Firebase connection config load/save/test IPC are admin-only', async () => {
 const { CHANNELS } = require(path.join(DIST,'ipc/channels'))
 const handlers = new Map(), actions = []
 let permission = 'write'
 const h = component('electron/ipc/handlers.ts', {
  path, electron: { ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) } }, './channels': { CHANNELS },
  '../services/PermissionService': { permissionService: { getCachedPermission: () => permission, fetchPermission: async () => 'read' } },
  '../services/FirebasePresenceService': { validateFirebaseConfig, firebasePresenceService: { load: () => { actions.push('load'); return null }, save: () => actions.push('save'), drain: async () => {}, test: async () => { actions.push('test'); return { uid: 'uid-admin' } } } },
  '../services/AuthService': { authService: { listAccounts: () => ({ currentAccountId: 'admin' }) } },
  '../services/LogService': { logService: { error() {} } },
 })
 h.exports.registerHandlers(); const event={sender:{isDestroyed:()=>true}}
 for(const channel of [CHANNELS.PRESENCE_CONFIG_LOAD, CHANNELS.PRESENCE_CONFIG_SAVE, CHANNELS.PRESENCE_CONFIG_TEST]) await expect(handlers.get(channel)(event,'repo',config)).rejects.toThrow('Admin access')
 expect(actions).toEqual([])
 permission='admin'
 for(const channel of [CHANNELS.PRESENCE_CONFIG_LOAD, CHANNELS.PRESENCE_CONFIG_SAVE, CHANNELS.PRESENCE_CONFIG_TEST]) await handlers.get(channel)(event,'repo',config)
 expect(actions).toEqual(['load','save','test'])
})

test('settings keep connection private and stale responses cannot restore old account results', async () => {
 const auth={isAdmin:()=>false,currentAccountId:'a'}, reads=[]; let resolve
 const h=component('src/components/settings/FirebasePresenceSettings.tsx', {
  '@/stores/authStore':{useAuthStore:store(auth)},
  '@/ipc':{ipc:{presenceConfigLoad:()=>{reads.push('read');return new Promise(r=>{resolve=r})}}},
 })
 expect(JSON.stringify(h.render('FirebasePresenceSettings',{repoPath:'repo'}))).toContain('Admin access is required')
 h.effects[0]();expect(reads).toEqual([])
 auth.isAdmin=()=>true;h.render('FirebasePresenceSettings',{repoPath:'repo'});const cancel=h.effects[0]()
 cancel();resolve(config);await flush()
 expect(JSON.stringify(h.render('FirebasePresenceSettings',{repoPath:'repo'}))).not.toContain('public-web-key')
})

test('published rules match the settings Copy rules template and protect role edits and extra presence fields', () => {
 expect(JSON.parse(fs.readFileSync(path.join(__dirname,'../docs/firebase-presence.rules.json'),'utf8'))).toEqual(firebasePresenceRules)
 expect(firebasePresenceRules.rules['.read']).toBe(false);expect(firebasePresenceRules.rules['.write']).toBe(false)
 const workspace=firebasePresenceRules.rules.lucidGit.$workspace
 expect(workspace.members['.write']).toBeUndefined()
 expect(workspace.members.$uid['.write']).toContain('auth.uid === $uid')
 expect(workspace.members.$uid['.write']).toContain('!data.exists() && newData.exists()')
 expect(workspace.members.$uid['.write']).toContain("=== 'github.com'")
 expect(workspace.members.$uid.role['.validate']).toBe("newData.val() === 'member'")
 expect(workspace.members.$uid.$other['.validate']).toBe(false)
 expect(workspace.presence['.read']).toContain("=== 'admin'")
 expect(workspace.presence.$uid.$device['.write']).toContain('auth.uid === $uid')
 expect(workspace.presence.$uid.$device.$other['.validate']).toBe(false)
})

test('slow writes coalesce heartbeat bursts and preserve the final Offline status', async () => {
 const db=database(), gate={};let writes=0
 const delayed=async(url,options)=>{
   if(options?.method==='PUT' && writes++ === 0) await new Promise(resolve=>{gate.release=resolve})
   return db.request(url,options)
 }
 const s=new FirebasePresenceService(()=>({userId:'admin',login:'admin',name:'Admin'}),async()=> 'github-admin',delayed,()=> 'desktop')
 const repo=tmpDir('lg-firebase-coalesce-');s.save(repo,config)
 const first=s.publish(repo,entry('admin'));await flush()
 const burst=Array.from({length:100},()=>s.publish(repo,entry('admin','away')))
 const last=s.publish(repo,entry('admin','offline'))
 gate.release();await Promise.all([first,...burst,last]);await s.drain()
 expect(writes).toBe(2);expect(db.sessions['uid-admin'].desktop.status).toBe('offline')
})

test('invalid connection saves preserve the running session; disk failures restart it; account changes abort saves', async () => {
 const { CHANNELS }=require(path.join(DIST,'ipc/channels'))
 const handlers=new Map(),events=[];let account='admin', fail=false, wait=null
 class Session { start(){events.push('start')} stop(){events.push('stop')} tick(){} setLocked(){} }
 const h=component('electron/ipc/handlers.ts',{
  path, electron:{ipcMain:{handle:(c,fn)=>handlers.set(c,fn)},powerMonitor:{on(){}},app:{on(){},quit(){}}}, './channels':{CHANNELS},
  '../services/PresenceSession':{PresenceSession:Session},
  '../services/PermissionService':{permissionService:{getCachedPermission:()=>account==='admin'?'admin':'read'}},
  '../services/AuthService':{authService:{listAccounts:()=>({currentAccountId:account})}},
  '../services/FirebasePresenceService':{validateFirebaseConfig,firebasePresenceService:{drain:async()=>{if(wait)await wait.promise},save:()=>{if(fail)throw Error('disk full');events.push('save')}}},
  '../services/LogService':{logService:{error(){}}},
 },{setInterval:()=>0})
 h.exports.registerHandlers();const event={sender:{isDestroyed:()=>true}}
 await handlers.get(CHANNELS.PRESENCE_UPDATE)(event,'repo')
 await expect(handlers.get(CHANNELS.PRESENCE_CONFIG_SAVE)(event,'repo',{...config,databaseURL:'https://evil.test'})).rejects.toThrow('Firebase Realtime Database')
 expect(events).toEqual(['start'])
 fail=true;await expect(handlers.get(CHANNELS.PRESENCE_CONFIG_SAVE)(event,'repo',config)).rejects.toThrow('disk full')
 expect(events).toEqual(['start','stop','start'])
 fail=false;wait={};wait.promise=new Promise(r=>{wait.resolve=r})
 const save=handlers.get(CHANNELS.PRESENCE_CONFIG_SAVE)(event,'repo',config);await flush();account='member';wait.resolve()
 await expect(save).rejects.toThrow('Account changed');expect(events).not.toContain('save')
})

test('successful test survives enabling, saves public settings, and editing connection fields requires retesting', async () => {
 const saves=[],auth={isAdmin:()=>true,currentAccountId:'admin'}
 const h=component('src/components/settings/FirebasePresenceSettings.tsx',{
  '@/stores/authStore':{useAuthStore:store(auth)},
  '@/ipc':{ipc:{presenceConfigLoad:async()=>({...config,enabled:false}),presenceConfigTest:async()=>({uid:'uid-admin',canRead:true,canPublish:true,message:'verified'}),presenceConfigSave:async(_,v)=>saves.push(v)}},
 })
 const render=()=>h.render('FirebasePresenceSettings',{repoPath:'repo'})
 render();h.effects[0]();await flush()
 await find(render(),n=>n.props?.children?.includes('Test connection')).props.onClick()
 find(render(),n=>n.props?.type==='checkbox').props.onChange({target:{checked:true}})
 const save=find(render(),n=>n.props?.children?.includes('Save connection'))
 expect(save.props.disabled).toBe(false);await save.props.onClick();expect(saves[0].enabled).toBe(true)
 find(render(),n=>n.props?.placeholder==='your-studio-your-repository').props.onChange({target:{value:'different-workspace'}})
 expect(find(render(),n=>n.props?.children?.includes('Save connection')).props.disabled).toBe(true)
})

test('presence settings tab is hidden for members and appears only for admins', () => {
 const auth={isAdmin:()=>false}
 const h=component('src/components/settings/SettingsPage.tsx',{'@/stores/authStore':{useAuthStore:store(auth)}})
 expect(find(h.render('SettingsPage',{repoPath:'repo'}),n=>n.props?.label==='Team presence')).toBeNull()
 auth.isAdmin=()=>true
 expect(find(h.render('SettingsPage',{repoPath:'repo'}),n=>n.props?.label==='Team presence')).toBeTruthy()
})
