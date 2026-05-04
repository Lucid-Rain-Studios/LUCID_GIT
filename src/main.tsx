import React from 'react'
import { createRoot } from 'react-dom/client'
import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import './index.css'

// Point the @monaco-editor/react loader at the locally installed monaco-editor
// package. Without this it uses a slow runtime AMD loader; this makes Vite
// bundle Monaco statically so the DiffEditor renders immediately.
loader.config({ monaco })

const maybeRootEl = document.getElementById('root')
if (!maybeRootEl) throw new Error('#root element not found in index.html')
const rootEl = maybeRootEl

type RendererLogger = {
  logRendererEvent?: (source: string, message: string, detail?: unknown) => Promise<void>
}

function getRendererLogger(): RendererLogger | null {
  return (window as unknown as { lucidGit?: RendererLogger }).lucidGit ?? null
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function reportBootstrapError(error: unknown): void {
  const message = describeError(error)
  console.error('[Bootstrap error]', error)
  getRendererLogger()?.logRendererEvent?.('renderer.bootstrap', message, {
    stack: error instanceof Error ? error.stack : undefined,
  }).catch(() => {})

  rootEl.innerHTML = ''
  const errorBox = document.createElement('main')
  errorBox.className = 'min-h-screen bg-[#0d0f14] p-8 text-slate-100'
  errorBox.innerHTML = `
    <section class="mx-auto max-w-3xl rounded border border-red-500/40 bg-red-950/20 p-5">
      <h1 class="text-lg font-semibold text-red-100">Lucid Git could not start</h1>
      <p class="mt-3 text-sm text-red-100/80">A renderer bootstrap error occurred. Open Bug Logs for details, or check the terminal running npm run dev.</p>
      <pre class="mt-4 overflow-auto rounded bg-black/40 p-3 text-xs text-red-50"></pre>
    </section>
  `
  errorBox.querySelector('pre')!.textContent = message
  rootEl.appendChild(errorBox)
}

async function bootstrap(): Promise<void> {
  try {
    const { App } = await import('./App')
    createRoot(rootEl).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    )
  } catch (error) {
    reportBootstrapError(error)
  }
}

void bootstrap()
