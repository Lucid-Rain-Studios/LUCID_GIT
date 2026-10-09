const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const { tmpDir, cleanup, DIST } = require('./helpers')
const { component, store } = require('./renderer-harness')
const { unrealService } = require(path.join(DIST, 'services/UnrealService'))
const flush = () => new Promise(resolve => setImmediate(resolve))
function manifest(dir, file, association) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
  fs.writeFileSync(path.join(dir, file), JSON.stringify({ EngineAssociation: association }))
}
test.afterAll(cleanup)

test('Unreal discovery handles root, nested, refresh and excluded directories', async () => {
  const dir = tmpDir('lg-ue-detect-')
  manifest(dir, 'Intermediate/Fake.uproject', '9.9')
  expect(await unrealService.detect(dir)).toBeNull()
  manifest(dir, 'Games/Sample/Game.UPROJECT', '5.6')
  expect(await unrealService.detect(dir)).toMatchObject({ name: 'Game', engineVersion: '5.6', uprojectPath: path.join(dir, 'Games/Sample/Game.UPROJECT') })
  manifest(dir, 'Root.uproject', '5.7.1')
  expect(await unrealService.detect(dir)).toMatchObject({ name: 'Root', engineVersion: '5.7.1' })
  manifest(dir, 'Root.uproject', '5.6')
  expect(await unrealService.detect(dir)).toMatchObject({ engineVersion: '5.6' })
  fs.unlinkSync(path.join(dir, 'Root.uproject'))
  fs.unlinkSync(path.join(dir, 'Games/Sample/Game.UPROJECT'))
  expect(await unrealService.detect(dir)).toBeNull()
})

test('Unreal discovery keeps custom associations distinct from version and tolerates malformed manifests', async () => {
  const dir = tmpDir('lg-ue-custom-'), association = '{CUSTOM-BUILD-ID}'
  manifest(dir, 'Game.uproject', association)
  const first = unrealService.detect(dir)
  expect(unrealService.detect(dir)).toBe(first)
  expect(await first).toMatchObject({ engineAssociation: association, engineVersion: 'Unknown' })
  fs.writeFileSync(path.join(dir, 'Game.uproject'), 'invalid json')
  expect(await unrealService.detect(dir)).toMatchObject({ name: 'Game', engineVersion: 'Unknown' })
})

test('Repository open and refresh detect Unreal metadata; late responses cannot cross repository sessions', async () => {
  const pending = [], calls = []
  const api = {
    isRepo: async () => true, status: async () => [], currentBranch: async () => 'main', branchList: async () => [], checkout: async () => {},
    ueDetect: repo => { calls.push(repo); return new Promise(resolve => pending.push(resolve)) },
  }
  const { useRepoStore: state } = component('src/stores/repoStore.ts', {
    zustand: require('zustand'), './operationStore': { useOperationStore: store({ run: (_, fn) => fn() }) },
  }, { window: { lucidGit: api } }).exports
  await state.getState().openRepo('A')
  await state.getState().openRepo('B')
  pending[1]({ name: 'B', engineVersion: '5.6', uprojectPath: 'B/Game.uproject' }); await flush()
  pending[0]({ name: 'A', engineVersion: '4.27' }); await flush()
  expect(state.getState().unrealProject.name).toBe('B')
  await state.getState().refreshStatus()
  pending[2]({ name: 'B', engineVersion: '5.7' }); await flush()
  expect(state.getState().unrealProject.engineVersion).toBe('5.7')
  await state.getState().silentRefresh()
  pending[3](null); await flush()
  expect(state.getState().unrealProject).toBeNull()
  await state.getState().checkout('other')
  state.getState().clearRepo()
  pending[4]({ name: 'B', engineVersion: '5.6' }); await flush()
  expect(state.getState()).toMatchObject({ unrealProject: null, unrealDetecting: false })
  expect(calls).toEqual(['A', 'B', 'B', 'B', 'B'])
})


test('Nested project setup uses the discovered project directory and preserves existing configuration', async () => {
  const dir = tmpDir('lg-ue-config-')
  manifest(dir, 'Game/Game.uproject', '5.6')
  const config = path.join(dir, 'Game/Config')
  fs.mkdirSync(config)
  fs.writeFileSync(path.join(config, 'DefaultEngine.ini'), '[Existing]\nValue=Keep\n')
  const plugin = path.join(dir, 'Game/Plugins/UEGitPlugin')
  fs.mkdirSync(plugin, { recursive: true })
  fs.writeFileSync(path.join(plugin, 'GitSourceControl.uplugin'), '{}')
  expect(await unrealService.pluginStatus(dir)).toMatchObject({ installed: true, location: 'project' })
  await unrealService.writeEditorConfig(dir)
  await unrealService.writeEngineConfig(dir)
  expect(await unrealService.ueConfigStatus(dir)).toMatchObject({ editorConfigHasSccSettings: true, editorConfigHasCheckoutSettings: true, engineConfigHasSkipCheck: true })
  expect(fs.readFileSync(path.join(config, 'DefaultEngine.ini'), 'utf8')).toContain('Value=Keep')
  expect(fs.existsSync(path.join(dir, 'Config'))).toBe(false)
})
