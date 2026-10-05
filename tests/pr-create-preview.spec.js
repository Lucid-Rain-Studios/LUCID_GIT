const { test, expect } = require('@playwright/test')
const fs = require('fs'), path = require('path')
const { component, find, store } = require('./renderer-harness')
const { git, tmpDir, cleanup, DIST } = require('./helpers')
const { gitService } = require(path.join(DIST, 'services/GitService'))
const flush = () => new Promise(resolve => setImmediate(resolve))
const sha = n => n.toString(16).padStart(40, '0')
const entry = n => ({ sha: sha(n), commit: { message: `commit ${n}\nDetails`, author: { name: n % 2 ? 'Elijah' : 'Other member', date: '2026-10-02T12:00:00Z' } } })
const args = { owner: 'org', repo: 'repo', base: 'main', head: 'dev_Elijah' }
function service(fetch) {
  return component('electron/services/GitHubService.ts', {
    '../util/network': { boundedFetch: async (url, options) => ({ ok: true, json: async () => fetch(url, options) }) },
  }, { AbortController }).exports.gitHubService
}
test.afterAll(cleanup)

test('published comparison excludes shared history even when local main is stale', async () => {
  const repo = tmpDir('lg-pr-base-')
  git(repo, 'init', '-qb', 'main'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.com')
  const commit = message => { fs.writeFileSync(path.join(repo, 'file.txt'), message); git(repo, 'add', '.'); git(repo, 'commit', '-qm', message); return git(repo, 'rev-parse', 'HEAD').trim() }
  commit('old local main'); git(repo, 'checkout', '-qb', 'remote-main')
  commit('Other member shared commit'); const base = commit('Shared merged PR')
  git(repo, 'update-ref', 'refs/remotes/origin/main', base)
  git(repo, 'checkout', '-qb', 'dev_Elijah'); const head = commit('Elijah feature')
  expect((await gitService.branchDiff(repo, 'main', 'dev_Elijah')).aheadCommits).toHaveLength(3)
  const calls = []
  const api = service(url => {
    calls.push(url)
    if (url.includes('/commits/')) return { sha: url.endsWith('/main') ? base : head }
    expect(url).toContain(`/compare/${base}...${head}?`)
    const hashes = git(repo, 'rev-list', '--reverse', `${base}..${head}`).trim().split('\n')
    return { total_commits: hashes.length, commits: hashes.map(hash => ({ sha: hash, commit: { message: git(repo, 'show', '-s', '--format=%s', hash).trim(), author: { name: 'Elijah', date: '2026-10-02' } } })) }
  })
  expect(await api.comparePRCommits('token', args)).toEqual([{ hash: head, message: 'Elijah feature', author: 'Elijah', date: '2026-10-02' }])
  expect(calls).toHaveLength(3)
})

test('all 1323 genuine incoming commits paginate on pinned tips and concurrent requests deduplicate', async () => {
  const calls = []
  const api = service(url => {
    calls.push(url)
    if (url.includes('/commits/')) return { sha: url.endsWith('/main') ? sha(2000) : sha(3000) }
    expect(url).toContain(`/compare/${sha(2000)}...${sha(3000)}?`)
    const page = Number(new URL(url).searchParams.get('page'))
    return { total_commits: 1323, commits: Array.from({ length: Math.min(100, 1323 - (page - 1) * 100) }, (_, i) => entry((page - 1) * 100 + i + 1)) }
  })
  const [a, b] = await Promise.all([api.comparePRCommits('token', args), api.comparePRCommits('token', args)])
  expect(a).toBe(b); expect(a).toHaveLength(1323); expect(a[0].message).toBe('commit 1323')
  expect(a.some(c => c.author === 'Other member')).toBe(true)
  expect(calls).toHaveLength(16)
  await api.comparePRCommits('another account', args)
  expect(calls).toHaveLength(32)
})

test('incomplete comparisons reject instead of silently showing a partial list; failures can retry', async () => {
  let incomplete = true
  const api = service(url => url.includes('/commits/') ? { sha: sha(1) } : { total_commits: incomplete ? 2 : 1, commits: [entry(2)] })
  await expect(api.comparePRCommits('token', args)).rejects.toThrow('incomplete commit comparison')
  incomplete = false
  expect(await api.comparePRCommits('token', args)).toHaveLength(1)
})

function dialog() {
  const pending = [], created = [], published = []
  const h = component('src/components/pr/PRDialog.tsx', {
    '@/ipc': { ipc: {
      gitDefaultBranch: async () => 'main',
      branchDiff: () => { throw Error('local comparison must not be used') },
      githubComparePR: input => new Promise((resolve, reject) => pending.push({ input, resolve, reject })),
      githubCreatePR: async input => { created.push(input); return { number: 1, htmlUrl: 'url', title: input.title } }, prMonitorRecord: async () => {},
      publishPRBranch: (...input) => new Promise((resolve, reject) => published.push({ input, resolve, reject })),
    } },
    '@/stores/prStore': { usePRStore: store({ open: true, repoPath: 'repo', headBranch: 'origin/dev_Elijah', remoteUrl: 'https://github.com/org/repo.git', closeDialog() {} }) },
    '@/stores/repoStore': { useRepoStore: store({ branches: [], bumpPrTick() {} }) },
    '@/stores/lockStore': { useLockStore: store({ locks: [] }) },
    '@/stores/authStore': { useAuthStore: store({ accounts: [], currentAccountId: 1 }) },
    '@/stores/statusToastStore': { useStatusToastStore: store({ show() {} }) },
    '@/lib/useDialogOverlayDismiss': { useDialogOverlayDismiss: () => ({}) },
  })
  return { h, pending, created, published, render: () => h.render('PRDialog'), button: tree => find(tree, n => n.type?.name === 'Btn' && n.props.label === 'Create Pull Request') }
}

test('a missing published source offers an explicit push, then retries without losing typed fields', async () => {
  const d = dialog(); let tree = d.render(); d.h.effects[0](); d.h.effects[1]()
  find(tree, n => n.type?.name === 'TextInput').props.onChange('My title')
  find(tree, n => n.type?.name === 'TextArea').props.onChange('My description')
  d.pending[0].reject(Error('PR_HEAD_NOT_PUBLISHED: Source branch is missing')); await flush()
  tree = d.render()
  const publish = find(tree, n => n.type?.name === 'Btn' && n.props.label === 'Push branch and retry')
  expect(publish).toBeTruthy(); expect(d.published).toEqual([])
  const pushing = publish.props.onClick(); publish.props.onClick()
  expect(d.published).toHaveLength(1)
  expect(d.published[0].input).toEqual(['repo', 'dev_Elijah', 'https://github.com/org/repo.git'])
  tree = d.render()
  expect(find(tree, n => n.type?.name === 'Btn' && n.props.label === 'Pushing branch…').props.disabled).toBe(true)
  d.published[0].resolve(); await pushing
  d.render(); d.h.effects[1]()
  d.pending[1].resolve([{ hash: sha(1), message: 'generated', author: 'me', date: '' }]); await flush()
  tree = d.render()
  expect(find(tree, n => n.type?.name === 'TextInput').props.value).toBe('My title')
  expect(find(tree, n => n.type?.name === 'TextArea').props.value).toBe('My description')
  expect(d.button(tree).props.disabled).toBe(false)
})

test('GitHub missing source and missing target have distinct guidance and no automatic publication', async () => {
  for (const missing of ['main', 'dev_Elijah']) {
    const api = component('electron/services/GitHubService.ts', {
      '../util/network': { boundedFetch: async url => ({ ok: !url.endsWith('/' + missing), status: 404,
        json: async () => url.endsWith('/' + missing) ? { message: 'No commit found for SHA: ' + missing } : { sha: sha(1) } }) },
    }, { AbortController }).exports.gitHubService
    await expect(api.comparePRCommits('token', args)).rejects.toThrow(missing === 'main' ? 'Target branch' : 'PR_HEAD_NOT_PUBLISHED:')
  }
})

test('publishing a selected branch preserves a different checkout and local edits and refuses a changed destination', async () => {
  const repo = tmpDir('lg-pr-publish-'), remote = tmpDir('lg-pr-remote-')
  git(remote, 'init', '--bare', '-q'); git(repo, 'init', '-qb', 'main')
  git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.com')
  fs.writeFileSync(path.join(repo, 'file.txt'), 'base'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base')
  const selected = git(repo, 'rev-parse', 'HEAD').trim()
  git(repo, 'branch', 'selected'); git(repo, 'remote', 'add', 'origin', remote)
  fs.writeFileSync(path.join(repo, 'file.txt'), 'main commit'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'main only')
  fs.writeFileSync(path.join(repo, 'file.txt'), 'uncommitted')
  const before = fs.readFileSync(path.join(repo, '.git/index'))
  await gitService.publishPRBranch(repo, 'selected', remote)
  expect(git(remote, 'rev-parse', 'refs/heads/selected').trim()).toBe(selected)
  expect(git(repo, 'branch', '--show-current').trim()).toBe('main')
  expect(fs.readFileSync(path.join(repo, 'file.txt'), 'utf8')).toBe('uncommitted')
  expect(fs.readFileSync(path.join(repo, '.git/index'))).toEqual(before)
  expect(git(remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/').trim()).toBe('refs/heads/selected')
  git(repo, 'config', 'remote.origin.pushurl', remote + '-changed')
  await expect(gitService.publishPRBranch(repo, 'selected', remote)).rejects.toThrow('push destination differs')
  await expect(gitService.publishPRBranch(repo, 'missing', remote)).rejects.toThrow('does not exist locally')
})

test('PR creation waits for its published preview, clears generated defaults on target change and rejects old responses', async () => {
  const d = dialog(); let tree = d.render()
  d.h.effects[0](); const cancelFirst = d.h.effects[1]()
  expect(d.button(tree).props.disabled).toBe(true)
  expect(d.pending[0].input).toEqual(args)
  d.pending[0].resolve([{ hash: sha(1), message: 'Feature only', author: 'Elijah', date: '' }]); await flush()
  tree = d.render(); expect(d.button(tree).props.disabled).toBe(false)
  expect(find(tree, n => n.type?.name === 'TextArea').props.value).toBe('- Feature only')
  find(tree, n => n.type?.name === 'SelectInput').props.onChange('develop')
  tree = d.render(); expect(d.button(tree).props.disabled).toBe(true)
  cancelFirst(); const cancelSecond = d.h.effects[1](); await flush()
  expect(find(d.render(), n => n.type?.name === 'TextArea').props.value).toBe('')
  cancelSecond(); d.h.effects[1]()
  d.pending[1].resolve([{ hash: sha(9), message: 'stale', author: 'Other', date: '' }]); await flush()
  expect(d.button(d.render()).props.disabled).toBe(true)
  d.pending[2].reject(Error('branch not published')); await flush()
  tree = d.render(); expect(find(tree, n => n.props.role === 'alert')).toBeTruthy()
  expect(d.button(tree).props.disabled).toBe(true)
  find(tree, n => n.type?.name === 'Btn' && n.props.label === 'Retry preview').props.onClick()
  d.render(); d.h.effects[1]()
  d.pending[3].resolve([]); await flush()
  expect(d.button(d.render()).props.disabled).toBe(true)
  expect(d.created).toEqual([])
})
