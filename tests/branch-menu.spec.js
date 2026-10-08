const { test, expect } = require('@playwright/test')
const fs = require('fs'), path = require('path')
const { component, find, store } = require('./renderer-harness')
const { DIST, git, tmpDir, cleanup } = require('./helpers')
const { gitService } = require(path.join(DIST, 'services/GitService'))
const flush = () => new Promise(resolve => setImmediate(resolve))

test.afterAll(cleanup)

for (const hasLocal of [false, true]) {
  test(`LG-020 branch menu preserves remote identity with local counterpart ${hasLocal}`, async () => {
    const repo = tmpDir('branch-menu-')
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'user.name', 'Test')
    git(repo, 'config', 'user.email', 'test@example.com')
    fs.writeFileSync(path.join(repo, 'base.txt'), 'base')
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', 'base')
    git(repo, 'checkout', '-qb', 'dev_Jake')
    fs.writeFileSync(path.join(repo, 'remote.txt'), 'remote')
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', 'remote tip')
    const remoteTip = git(repo, 'rev-parse', 'HEAD').trim()
    git(repo, 'update-ref', 'refs/remotes/origin/dev_Jake', remoteTip)
    if (hasLocal) {
      fs.writeFileSync(path.join(repo, 'local.txt'), 'local')
      git(repo, 'add', '.')
      git(repo, 'commit', '-qm', 'unpushed local tip')
    }
    git(repo, 'checkout', '-q', 'main')
    if (!hasLocal) git(repo, 'branch', '-D', 'dev_Jake')
    const branches = await gitService.branchList(repo)
    const comparisons = [], previews = []
    const h = component('src/components/branches/BranchPanel.tsx', {
      '@/stores/repoStore': { useRepoStore: store({ repoPath: repo, branches, currentBranch: 'main', fileStatus: [] }) },
      '@/stores/operationStore': { useOperationStore: store({ run: (_, fn) => fn() }) },
      '@/stores/dialogStore': { useDialogStore: store({}) },
      '@/stores/prStore': { usePRStore: store({ openPRDialog() {} }) },
      '@/ipc': { ipc: {
        getRemoteUrl: async () => null, gitDefaultBranch: async () => 'main',
        gitBranchActivity: async () => [], listLocks: async () => [],
        branchDiff: (...args) => { const work = gitService.branchDiff(...args); comparisons.push({ args, work }); return work },
      } },
    })
    const props = { onMergePreview: ref => { previews.push(ref) }, onRefresh() {} }
    const remoteRow = tree => find(tree, n => n.props.onContextMenu && n.props.children?.some(c => c?.props?.children?.includes('⇡')))
    const menuAction = (tree, label) => find(tree, n => n.type === 'button' && n.props.children.includes(label))
    let tree = h.render('BranchPanel', props)
    remoteRow(tree).props.onContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: 0, clientY: 0 })
    tree = h.render('BranchPanel', props)
    menuAction(tree, 'Merge into current branch…').props.onClick()
    expect(previews).toEqual(['origin/dev_Jake'])
    expect(await gitService.mergePreview(repo, previews[0])).toEqual([])
    menuAction(tree, 'Compare to branch').props.onClick()
    tree = h.render('BranchPanel', props)
    h.effects.forEach(effect => effect())
    await flush()
    expect(comparisons[0].args).toEqual([repo, 'main', 'origin/dev_Jake'])
    expect((await comparisons[0].work).aheadCommits.map(c => c.message)).toEqual(['remote tip'])

    // Clicking the remote row must use the same identity as its menu.
    remoteRow(tree).props.onClick()
    tree = h.render('BranchPanel', props)
    expect(find(tree, n => n.props.branch?.name === 'origin/dev_Jake').props.branch.name).toBe('origin/dev_Jake')
    if (hasLocal) {
      const localRow = find(tree, n => n.props.onContextMenu && find(n, c => c.props.title === 'Preview "dev_Jake"'))
      localRow.props.onContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: 0, clientY: 0 })
      tree = h.render('BranchPanel', props)
      menuAction(tree, 'Merge into current branch…').props.onClick()
      expect(previews.at(-1)).toBe('dev_Jake')
      expect((await gitService.branchDiff(repo, 'main', previews.at(-1))).aheadCommits.map(c => c.message)).toContain('unpushed local tip')
    }
    await gitService.merge(repo, previews[0])
    expect(git(repo, 'rev-parse', 'HEAD^2').trim()).toBe(remoteTip)
    expect(fs.readFileSync(path.join(repo, 'remote.txt'), 'utf8')).toBe('remote')
    expect(fs.existsSync(path.join(repo, 'local.txt'))).toBe(false)
    expect(await gitService.status(repo)).toEqual([])
  })
}
