import React, { useEffect, useState } from 'react'
import { ipc, UEProject, UESetupStatus, UEPluginStatus, UEConfigStatus, GitIdentity } from '@/ipc'
import { useRepoStore } from '@/stores/repoStore'
import { useAuthStore } from '@/stores/authStore'
import { cn } from '@/lib/utils'

const PAK_WARN_BYTES = 500 * 1024 * 1024

function formatBytes(b: number): string {
  if (b < 1024)          return `${b} B`
  if (b < 1_048_576)     return `${(b / 1024).toFixed(1)} KB`
  if (b < 1_073_741_824) return `${(b / 1_048_576).toFixed(1)} MB`
  return `${(b / 1_073_741_824).toFixed(2)} GB`
}

interface UnrealPanelProps {
  repoPath: string
}

export function UnrealPanel({ repoPath }: UnrealPanelProps) {
  const { fileStatus } = useRepoStore()
  const { accounts, currentAccountId } = useAuthStore()
  const currentAccount = accounts.find(a => a.userId === currentAccountId) ?? null

  const [project,      setProject]      = useState<UEProject | null | 'loading'>('loading')
  const [setupStatus,  setSetupStatus]  = useState<UESetupStatus | null>(null)
  const [pluginStatus, setPluginStatus] = useState<UEPluginStatus | null>(null)
  const [cfgStatus,    setCfgStatus]    = useState<UEConfigStatus | null>(null)
  const [identity,     setIdentity]     = useState<GitIdentity | null>(null)
  const [pakSize,      setPakSize]      = useState<number | null>(null)
  const [error,        setError]        = useState<string | null>(null)
  const [attrTemplate, setAttrTemplate] = useState('')
  const [ignoreTemplate, setIgnoreTemplate] = useState('')

  const [showAttrPreview,   setShowAttrPreview]   = useState(false)
  const [showIgnorePreview, setShowIgnorePreview] = useState(false)

  type BusyKey = 'gitattributes' | 'gitignore' | 'editorCfg' | 'engineCfg' | 'identity' | 'lockverify'
  const [busy,         setBusy]         = useState<BusyKey | null>(null)
  const [written,      setWritten]      = useState<Set<string>>(new Set())
  const [lockVerify,   setLockVerify]   = useState<boolean | null>(null)

  const load = async () => {
    setError(null)
    try {
      const [proj, status, templates, plugin, cfg, id, lvRaw] = await Promise.all([
        ipc.ueDetect(repoPath),
        ipc.ueSetupStatus(repoPath),
        ipc.ueTemplates(),
        ipc.uePluginStatus(repoPath),
        ipc.ueConfigStatus(repoPath),
        ipc.gitGetIdentity(repoPath),
        ipc.getGitConfig(repoPath, 'lfs.locksverify'),
      ])
      setProject(proj)
      setSetupStatus(status)
      setAttrTemplate(templates.gitattributes)
      setIgnoreTemplate(templates.gitignore)
      setPluginStatus(plugin)
      setCfgStatus(cfg)
      setIdentity(id)
      setLockVerify(lvRaw === 'true')
    } catch (e) {
      setError(String(e))
      setProject(null)
    }
  }

  const loadPakSize = async () => {
    const staged = fileStatus.filter(f => f.staged).map(f => f.path)
    if (staged.length === 0) { setPakSize(0); return }
    try { setPakSize(await ipc.uePakSize(repoPath, staged)) }
    catch { setPakSize(null) }
  }

  useEffect(() => { load() }, [repoPath])
  useEffect(() => { loadPakSize() }, [fileStatus])

  const run = async (key: BusyKey, fn: () => Promise<void>) => {
    setBusy(key); setError(null)
    try {
      await fn()
      setWritten(prev => new Set(prev).add(key))
      await load()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }

  const identityMismatch = identity && currentAccount &&
    identity.name !== currentAccount.login

  return (
    <div className="flex-1 flex flex-col overflow-hidden text-[11px] font-mono">

      {/* ── Project detection header ───────────────────────────────── */}
      <div className="px-3 py-2 border-b border-lg-border shrink-0">
        {project === 'loading' && (
          <span className="text-lg-text-secondary animate-pulse text-[10px]">Detecting UE project…</span>
        )}
        {project !== 'loading' && project && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-widest text-lg-accent font-semibold">UE5</span>
            <span className="text-lg-text-primary font-semibold">{project.name}</span>
            <span className="text-lg-text-secondary">v{project.engineVersion}</span>
          </div>
        )}
        {project !== 'loading' && !project && (
          <div className="flex items-center gap-2 text-lg-text-secondary">
            <span className="text-[10px] uppercase tracking-widest">No .uproject found</span>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">

        {error && (
          <div className="mx-3 mt-2 px-3 py-2 bg-lg-error/10 border border-lg-error/40 rounded text-lg-error text-[10px] whitespace-pre-wrap">
            {error}
          </div>
        )}

        {/* ── GitSourceControl plugin status ─────────────────────── */}
        <Section label="GitSourceControl Plugin (UEGitPlugin)">
          {!pluginStatus && (
            <div className="px-3 py-2 text-lg-text-secondary text-[10px] animate-pulse">Checking…</div>
          )}

          {/* ✓ Found in project Plugins/ — ideal, ships with repo */}
          {pluginStatus?.installed && pluginStatus.location === 'project' && (
            <div className="mx-3 my-2 px-3 py-2 bg-lg-success/10 border border-lg-success/40 rounded flex items-start gap-2">
              <span className="text-lg-success mt-0.5">✓</span>
              <div>
                <div className="text-lg-success text-[10px] font-semibold">Plugin found in project</div>
                <div className="text-lg-text-secondary text-[10px] mt-0.5">
                  <code className="text-lg-text-primary">Plugins/{pluginStatus.pluginFolder}/GitSourceControl.uplugin</code>
                  <br />
                  Committed to the repo — all teammates get it automatically on clone.
                </div>
              </div>
            </div>
          )}

          {/* ⚠ Found in engine — works but not in repo */}
          {pluginStatus?.installed && pluginStatus.location === 'engine' && (
            <div className="mx-3 my-2 px-3 py-2 bg-[#4a9eff]/10 border border-[#4a9eff]/40 rounded flex items-start gap-2">
              <span className="text-[#4a9eff] mt-0.5">ℹ</span>
              <div className="space-y-1">
                <div className="text-[#4a9eff] text-[10px] font-semibold">Plugin found in engine installation</div>
                <div className="text-lg-text-secondary text-[10px]">
                  Works for you, but each teammate needs to install it separately.
                </div>
                <div className="text-lg-text-secondary text-[10px]">
                  For a smoother team setup, ask your lead to add{' '}
                  <code className="text-lg-text-primary">Plugins/UEGitPlugin/</code> to the repo
                  so everyone gets it on clone.
                </div>
              </div>
            </div>
          )}

          {/* ✗ Not found — show three options */}
          {pluginStatus && !pluginStatus.installed && (
            <div className="mx-3 my-2 px-3 py-2 bg-lg-error/10 border border-lg-error/40 rounded space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-lg-error">✗</span>
                <span className="text-lg-error text-[10px] font-semibold">Plugin not found</span>
              </div>
              <div className="text-lg-text-secondary text-[10px]">
                Searched <code className="text-lg-text-primary">Plugins/UEGitPlugin/</code> and the engine installation.
                Choose how to get it:
              </div>
              <div className="space-y-1.5 text-[10px]">
                <div className="flex items-start gap-2">
                  <span className="text-lg-accent shrink-0 mt-px">1.</span>
                  <span className="text-lg-text-secondary">
                    <span className="text-lg-text-primary font-semibold">Get it from your team</span>
                    {' — '}ask them to commit{' '}
                    <code className="text-lg-text-primary">Plugins/UEGitPlugin/</code> to the repo.
                    Best option: everyone gets it automatically.
                  </span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="text-lg-accent shrink-0 mt-px">2.</span>
                  <span className="text-lg-text-secondary">
                    <span className="text-lg-text-primary font-semibold">Epic Marketplace</span>
                    {' — '}search <code className="text-lg-text-primary">GitSourceControl</code> in the
                    Epic Games Launcher → Library → Vault. Install to engine.
                  </span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="text-lg-accent shrink-0 mt-px">3.</span>
                  <span className="text-lg-text-secondary">
                    <span className="text-lg-text-primary font-semibold">GitHub</span>
                    {' — '}clone{' '}
                    <code className="text-lg-text-primary">ProjectBorealis/UEGitPlugin</code>{' '}
                    into your project's{' '}
                    <code className="text-lg-text-primary">Plugins/UEGitPlugin/</code> folder,
                    then commit it.
                  </span>
                </div>
              </div>
            </div>
          )}
        </Section>

        {/* ── Git identity linker ────────────────────────────────── */}
        <Section label="Git Identity & Lock Attribution">
          <div className="px-3 py-2 space-y-2">
            <p className="text-[10px] text-lg-text-secondary leading-relaxed">
              LFS lock owners are matched by <code className="text-lg-text-primary">git config user.name</code>.
              Linking your GitHub account sets it to your login so locks created in Lucid Git and
              the UE editor reconcile correctly.
            </p>

            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px]">
              <span className="text-lg-text-secondary">Current user.name</span>
              <span className={cn(
                'font-semibold',
                identity?.name ? 'text-lg-text-primary' : 'text-lg-text-secondary'
              )}>
                {identity?.name || '(not set)'}
              </span>

              <span className="text-lg-text-secondary">Current user.email</span>
              <span className={cn(
                identity?.email ? 'text-lg-text-primary' : 'text-lg-text-secondary'
              )}>
                {identity?.email || '(not set)'}
              </span>

              {currentAccount && (
                <>
                  <span className="text-lg-text-secondary">GitHub login</span>
                  <span className="text-lg-text-primary">{currentAccount.login}</span>
                </>
              )}
            </div>

            {identityMismatch && (
              <div className="flex items-start gap-2 px-2 py-1.5 bg-lg-warning/10 border border-lg-warning/40 rounded text-[10px]">
                <span className="text-lg-warning">⚠</span>
                <span className="text-lg-text-secondary">
                  user.name (<code className="text-lg-text-primary">{identity!.name}</code>) does not match
                  your GitHub login (<code className="text-lg-text-primary">{currentAccount!.login}</code>).
                  Locks may not reconcile in the UE editor.
                </span>
              </div>
            )}

            {identity && currentAccount && identity.name === currentAccount.login && (
              <div className="flex items-center gap-1.5 text-[10px] text-lg-success">
                <span>✓</span>
                <span>Identity linked — locks will reconcile with UE editor.</span>
              </div>
            )}
          </div>

          <div className="px-3 pb-2 flex items-center gap-2 flex-wrap">
            {currentAccount && (
              <Btn
                disabled={busy !== null}
                loading={busy === 'identity'}
                variant={identityMismatch ? 'accent' : 'secondary'}
                onClick={() => run('identity', () =>
                  ipc.gitLinkIdentity(repoPath, currentAccount.login, currentAccount.name)
                )}
              >
                {busy === 'identity' ? 'Linking…' : 'Link GitHub Identity'}
              </Btn>
            )}
            {!currentAccount && (
              <span className="text-[10px] text-lg-text-secondary">Sign in with GitHub first.</span>
            )}
            {written.has('identity') && (
              <span className="text-[10px] text-lg-success">✓ Identity linked</span>
            )}
          </div>

          {/* lfs.locksverify */}
          <div className="px-3 pb-3 border-t border-lg-border/50 pt-2 space-y-1.5">
            <div className="text-[10px] text-lg-text-primary font-semibold">LFS Lock Verification</div>
            <StatusRow
              label="lfs.locksverify = true (blocks pushing locked files)"
              ok={lockVerify === true}
            />
            <p className="text-[10px] text-lg-text-secondary leading-relaxed">
              When enabled, git refuses to push changes to any file locked by another user,
              enforcing the Perforce-style checkout workflow end-to-end.
            </p>
            <div className="flex items-center gap-2">
              <Btn
                disabled={busy !== null}
                loading={busy === 'lockverify'}
                variant={lockVerify ? 'secondary' : 'accent'}
                onClick={() => run('lockverify', () =>
                  ipc.setGitConfig(repoPath, 'lfs.locksverify', 'true')
                )}
              >
                {busy === 'lockverify' ? 'Enabling…'
                  : lockVerify ? 'Re-apply' : 'Enable lock verify'}
              </Btn>
              {written.has('lockverify') && (
                <span className="text-[10px] text-lg-success">✓ Enabled</span>
              )}
            </div>
          </div>
        </Section>

        {/* ── UE Git Configurations ─────────────────────────────── */}
        <Section label="UE Git Configurations (opt-in)">
          <div className="px-3 py-2 space-y-1">
            <p className="text-[10px] text-lg-text-secondary leading-relaxed">
              These settings configure the UE editor to work seamlessly with the GitSourceControl plugin and Lucid Git's
              LFS lock workflow. Files are created/updated non-destructively — existing content is preserved.
            </p>
          </div>

          {/* DefaultEditorPerProjectUserSettings.ini */}
          <div className="px-3 pb-2 space-y-1">
            <div className="text-[10px] text-lg-text-primary font-semibold">
              DefaultEditorPerProjectUserSettings.ini
            </div>
            <StatusRow
              label="bSCCAutoAddNewFiles=False (disable auto-staging in UE)"
              ok={cfgStatus?.editorConfigHasSccSettings ?? false}
            />
            <StatusRow
              label="bAutomaticallyCheckoutOnAssetModification=True"
              ok={cfgStatus?.editorConfigHasCheckoutSettings ?? false}
            />
            <div className="flex items-center gap-2 mt-1">
              <Btn
                disabled={busy !== null}
                loading={busy === 'editorCfg'}
                variant={cfgStatus?.editorConfigHasSccSettings && cfgStatus?.editorConfigHasCheckoutSettings
                  ? 'secondary' : 'accent'}
                onClick={() => run('editorCfg', () => ipc.ueWriteEditorConfig(repoPath))}
              >
                {busy === 'editorCfg' ? 'Writing…'
                  : cfgStatus?.editorConfigHasSccSettings && cfgStatus?.editorConfigHasCheckoutSettings
                  ? 'Update settings' : 'Apply settings'}
              </Btn>
              {written.has('editorCfg') && (
                <span className="text-[10px] text-lg-success">✓ Written</span>
              )}
            </div>
          </div>

          {/* DefaultEngine.ini */}
          <div className="px-3 pb-3 space-y-1 border-t border-lg-border/50 pt-2">
            <div className="text-[10px] text-lg-text-primary font-semibold">
              DefaultEngine.ini
            </div>
            <StatusRow
              label="r.Editor.SkipSourceControlCheckForEditablePackages=1"
              ok={cfgStatus?.engineConfigHasSkipCheck ?? false}
            />
            <div className="flex items-center gap-2 mt-1">
              <Btn
                disabled={busy !== null}
                loading={busy === 'engineCfg'}
                variant={cfgStatus?.engineConfigHasSkipCheck ? 'secondary' : 'accent'}
                onClick={() => run('engineCfg', () => ipc.ueWriteEngineConfig(repoPath))}
              >
                {busy === 'engineCfg' ? 'Writing…'
                  : cfgStatus?.engineConfigHasSkipCheck ? 'Update setting' : 'Apply setting'}
              </Btn>
              {written.has('engineCfg') && (
                <span className="text-[10px] text-lg-success">✓ Written</span>
              )}
            </div>
          </div>
        </Section>

        {/* ── .gitattributes ─────────────────────────────────────── */}
        <Section label=".gitattributes — LFS tracking">
          <StatusRow label="File exists"                  ok={setupStatus?.hasGitattributes ?? false} />
          <StatusRow label="UE5 LFS patterns present"     ok={setupStatus?.hasUeGitattributes ?? false} />
          {written.has('gitattributes') && (
            <div className="px-3 py-1 text-lg-success text-[10px]">✓ Written successfully</div>
          )}
          <div className="px-3 py-2 flex items-center gap-2">
            <Btn
              disabled={busy !== null}
              loading={busy === 'gitattributes'}
              variant={setupStatus?.hasUeGitattributes ? 'secondary' : 'accent'}
              onClick={() => run('gitattributes', () => ipc.ueWriteGitattributes(repoPath))}
            >
              {busy === 'gitattributes' ? 'Writing…'
                : setupStatus?.hasUeGitattributes ? 'Overwrite with template' : 'Write UE5 template'}
            </Btn>
            <button
              onClick={() => setShowAttrPreview(v => !v)}
              className="text-[10px] text-lg-text-secondary hover:text-lg-text-primary transition-colors"
            >
              {showAttrPreview ? 'Hide preview' : 'Preview'}
            </button>
          </div>
          {showAttrPreview && (
            <pre className="mx-3 mb-2 p-2 bg-lg-bg-primary border border-lg-border rounded text-[9px] overflow-x-auto max-h-48 text-lg-text-secondary whitespace-pre">
              {attrTemplate}
            </pre>
          )}
        </Section>

        {/* ── .gitignore ─────────────────────────────────────────── */}
        <Section label=".gitignore — build artifact exclusions">
          <StatusRow label="File exists"                  ok={setupStatus?.hasGitignore ?? false} />
          <StatusRow label="UE5 build dirs excluded"      ok={setupStatus?.hasUeGitignore ?? false} />
          {written.has('gitignore') && (
            <div className="px-3 py-1 text-lg-success text-[10px]">✓ Written successfully</div>
          )}
          <div className="px-3 py-2 flex items-center gap-2">
            <Btn
              disabled={busy !== null}
              loading={busy === 'gitignore'}
              variant={setupStatus?.hasUeGitignore ? 'secondary' : 'accent'}
              onClick={() => run('gitignore', () => ipc.ueWriteGitignore(repoPath))}
            >
              {busy === 'gitignore' ? 'Writing…'
                : setupStatus?.hasUeGitignore ? 'Overwrite with template' : 'Write UE5 template'}
            </Btn>
            <button
              onClick={() => setShowIgnorePreview(v => !v)}
              className="text-[10px] text-lg-text-secondary hover:text-lg-text-primary transition-colors"
            >
              {showIgnorePreview ? 'Hide preview' : 'Preview'}
            </button>
          </div>
          {showIgnorePreview && (
            <pre className="mx-3 mb-2 p-2 bg-lg-bg-primary border border-lg-border rounded text-[9px] overflow-x-auto max-h-48 text-lg-text-secondary whitespace-pre">
              {ignoreTemplate}
            </pre>
          )}
        </Section>

        {/* ── Staged asset size ──────────────────────────────────── */}
        <Section label="Staged asset size">
          {pakSize === null && (
            <div className="px-3 py-2 text-lg-text-secondary text-[10px]">Unable to compute size.</div>
          )}
          {pakSize !== null && pakSize === 0 && (
            <div className="px-3 py-2 text-lg-text-secondary text-[10px]">No binary assets in staged changes.</div>
          )}
          {pakSize !== null && pakSize > 0 && (
            <div className="px-3 py-2 space-y-1">
              <div className={cn('text-sm font-semibold', pakSize > PAK_WARN_BYTES ? 'text-lg-warning' : 'text-lg-text-primary')}>
                {formatBytes(pakSize)}
              </div>
              {pakSize > PAK_WARN_BYTES && (
                <div className="text-[10px] text-lg-warning">⚠ Staged assets exceed 500 MB. Consider LFS or splitting this commit.</div>
              )}
              <div className="text-[10px] text-lg-text-secondary">Total size of staged binary files matching LFS patterns</div>
            </div>
          )}
          <div className="px-3 py-2 border-t border-lg-border/50">
            <button onClick={loadPakSize} className="text-[10px] text-lg-text-secondary hover:text-lg-accent transition-colors">
              ↺ Recalculate
            </button>
          </div>
        </Section>

        {/* ── Perforce-style workflow ────────────────────────────── */}
        <Section label="Perforce-style workflow">
          <div className="px-3 py-2 space-y-2">
            <p className="text-[10px] text-lg-text-secondary leading-relaxed">
              Right-click any file in the Changes tab → <span className="text-lg-text-primary">Check Out for Edit</span> to
              lock it via LFS before modifying. Commit as normal to release the lock.
            </p>
            <p className="text-[10px] text-lg-text-secondary">
              Lock badges are shown in the file tree. Locks are shared between Lucid Git and the GitSourceControl plugin
              — no separate lock management needed.
            </p>
          </div>
        </Section>

      </div>

      {/* ── Footer ────────────────────────────────────────────────── */}
      <div className="px-3 py-2 border-t border-lg-border shrink-0">
        <button
          onClick={load}
          className="w-full h-7 rounded text-[10px] border border-lg-border text-lg-text-secondary hover:border-lg-accent hover:text-lg-accent transition-colors"
        >
          ↺ Refresh
        </button>
      </div>
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-lg-border">
      <div className="px-3 py-1.5 bg-lg-bg-secondary sticky top-0 z-10">
        <span className="text-[10px] uppercase tracking-widest text-lg-text-secondary">{label}</span>
      </div>
      {children}
    </div>
  )
}

function StatusRow({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1">
      <span className={cn('text-[10px]', ok ? 'text-lg-success' : 'text-lg-error')}>{ok ? '✓' : '✗'}</span>
      <span className="text-[10px] text-lg-text-secondary">{label}</span>
    </div>
  )
}

function Btn({ children, onClick, disabled, loading, variant = 'secondary' }: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
  loading?: boolean
  variant?: 'accent' | 'secondary' | 'warning'
}) {
  const colors = {
    accent:    'border-lg-accent text-lg-accent hover:bg-lg-accent/10',
    secondary: 'border-lg-border text-lg-text-secondary hover:border-lg-warning hover:text-lg-warning',
    warning:   'border-lg-warning text-lg-warning hover:bg-lg-warning/10',
  }
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      className={cn(
        'px-3 h-6 rounded text-[10px] border transition-colors disabled:opacity-40',
        colors[variant]
      )}
    >
      {children}
    </button>
  )
}
