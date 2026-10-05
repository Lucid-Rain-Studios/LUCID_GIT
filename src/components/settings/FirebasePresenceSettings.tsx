import React, { useEffect, useRef, useState } from 'react'
import { ipc, FirebasePresenceConfig, FirebasePresenceTest } from '@/ipc'
import { useAuthStore } from '@/stores/authStore'
import { parseFirebaseWebConfig } from '@/lib/firebasePresenceConfig'
import { firebasePresenceRules } from '@/lib/firebasePresenceRules'
import { ActionBtn } from '@/components/ui/ActionBtn'

const defaults: FirebasePresenceConfig = {
  enabled: false, apiKey: '', authDomain: '', projectId: '', databaseURL: '', workspaceId: '',
}
const inputClass = 'w-full bg-lg-bg-primary border border-lg-border rounded px-2 py-1.5 text-[12px] text-lg-text-primary focus:outline-none focus:border-lg-accent'

export function FirebasePresenceSettings({ repoPath }: { repoPath: string }) {
  const isAdmin = useAuthStore(s => s.isAdmin(repoPath))
  const accountId = useAuthStore(s => s.currentAccountId)
  const [config, setConfig] = useState<FirebasePresenceConfig>(defaults)
  const [paste, setPaste] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [result, setResult] = useState<FirebasePresenceTest | null>(null)
  const [retry, setRetry] = useState(0)
  const generation = useRef(0)

  useEffect(() => {
    const current = ++generation.current
    setLoaded(false); setBusy(false); setResult(null); setError(null); setSaved(false); setConfig(defaults); setPaste('')
    if (isAdmin) void ipc.presenceConfigLoad(repoPath).then(value => {
      if (generation.current === current) {
        const workspaceId = repoPath.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop()!.toLowerCase().replace(/\s+/g, '-')
        setConfig(value ?? { ...defaults, workspaceId })
        setLoaded(true)
      }
    }).catch(e => { if (generation.current === current) setError(String(e)) })
    return () => { generation.current = current + 1 }
  }, [repoPath, isAdmin, accountId, retry])

  const update = (patch: Partial<FirebasePresenceConfig>) => {
    setConfig(previous => ({ ...previous, ...patch })); setSaved(false); if (Object.keys(patch).some(key => key !== 'enabled')) setResult(null); setError(null)
  }
  const run = async (test: boolean) => {
    if (!loaded || !isAdmin || busy) return
    const current = generation.current
    setBusy(true); setError(null); setSaved(false)
    try {
      if (test) {
        const tested = await ipc.presenceConfigTest(repoPath, config)
        if (generation.current === current) setResult(tested)
      } else {
        await ipc.presenceConfigSave(repoPath, config)
        if (generation.current === current) setSaved(true)
      }
    } catch (e) { if (generation.current === current) setError(String(e)) }
    finally { if (generation.current === current) setBusy(false) }
  }

  if (!isAdmin) return <div role="alert" className="p-4">Admin access is required to configure team presence.</div>
  if (!loaded) return <div className="p-4">{error ? <div role="alert">{error} <button onClick={() => setRetry(n => n + 1)}>Retry</button></div> : 'Loading connection settings…'}</div>

  return (
    <div className="p-4 space-y-4 text-lg-text-primary" style={{ maxWidth: 760 }}>
      <h2 className="text-base font-semibold">Team Presence · Firebase</h2>
      <p className="text-xs text-lg-text-secondary">
        Connect your team's Firebase Realtime Database. Members publish their own Active/Away/Offline status
        while Lucid Git runs; only repository admins can view the Team page. Firebase rules must also restrict reads to approved admins.
      </p>
      <label className="block text-xs space-y-2">
        <span>Paste Firebase web configuration</span>
        <textarea rows={5} className={inputClass} value={paste} disabled={busy} onChange={e => setPaste(e.target.value)} placeholder={'const firebaseConfig = { apiKey: "…", authDomain: "…", projectId: "…", databaseURL: "…" };'} />
      </label>
      <ActionBtn size="sm" disabled={busy} onClick={() => {
        try {
          const imported = parseFirebaseWebConfig(paste)
          update({ ...imported, databaseURL: imported.databaseURL ?? '' })
        } catch (e) { setError(String(e)) }
      }}>Import fields</ActionBtn>
      {([
        ['apiKey', 'Web API key'], ['projectId', 'Project ID'], ['authDomain', 'Auth domain'],
        ['databaseURL', 'Realtime Database URL'], ['workspaceId', 'Workspace ID'],
      ] as const).map(([key, label]) => (
        <label key={key} className="block text-xs space-y-2">
          <span>{label}</span>
          <input className={inputClass} value={config[key]} disabled={busy} onChange={e => update({ [key]: e.target.value.trim() })}
            placeholder={key === 'workspaceId' ? 'your-studio-your-repository' : undefined} spellCheck={false} />
        </label>
      ))}
      <p className="text-xs text-lg-text-secondary">Use the same workspace ID on every clone of this repository. Each repository should use a distinct workspace.</p>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={config.enabled} disabled={busy} onChange={e => update({ enabled: e.target.checked })} />
        Enable shared team presence
      </label>
      <div className="flex gap-3">
        <ActionBtn size="sm" disabled={busy} onClick={() => run(true)}>Test connection</ActionBtn>
        <ActionBtn size="sm" disabled={busy || (config.enabled && !(result?.canRead && result?.canPublish))} onClick={() => run(false)}>
          {busy ? 'Working…' : 'Save connection'}
        </ActionBtn>
      </div>
      {error && <div role="alert" className="text-xs text-lg-danger">{error}</div>}
      {result && <div role="status" className="text-xs space-y-2">
        <p>{result.message}</p>
        <p>Your Firebase UID: <code className="select-all">{result.uid}</code></p>
        <p>Member record: <code className="select-all">lucidGit/{config.workspaceId}/members/{result.uid}</code></p>
        <p>Admin read access: {result.canRead ? 'verified' : 'not verified'} · Own-status publishing: {result.canPublish ? 'verified' : 'not verified'}</p>
      </div>}
      {saved && <p role="status" className="text-xs text-lg-success">Connection saved. Commit and share .lucid-git/firebase-presence.json in this project repository so teammates use the same connection.</p>}
      <ActionBtn size="sm" onClick={async () => {
        try { await navigator.clipboard.writeText(JSON.stringify(firebasePresenceRules, null, 2)) }
        catch { setError('Could not copy rules. Open docs/firebase-presence.rules.json instead.') }
      }}>Copy database rules</ActionBtn>
      <p className="text-xs text-lg-text-secondary">
        Test connection signs in to Firebase and creates then removes an Offline test session.
        To bootstrap access, test once to obtain your UID, add it as an admin in Firebase, then test again.
        Publish the rules in docs/firebase-presence.rules.json; full setup is in docs/FIREBASE-PRESENCE.md.
        Store only public web configuration here. GitHub client secrets and service-account keys stay outside Lucid Git.
      </p>
    </div>
  )
}
