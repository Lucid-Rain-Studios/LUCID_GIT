import type { Environment } from 'monaco-editor'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker&inline'

declare global {
  interface Window {
    MonacoEnvironment?: Environment
  }
}

// Monaco computes diffs and runs its language services in web workers. With no
// MonacoEnvironment configured it says so — "Could not create web worker(s).
// Falling back to loading web worker code in main thread, which might cause UI
// freezes" — and then does exactly that. On an Unreal repo the result was not a
// slowdown but a wedged renderer holding 2.2 GB and painting a stale frame,
// which is indistinguishable from the whole app having crashed.
//
// `?worker&inline` rather than the usual separate chunk, because the packaged
// renderer is started with `loadFile()` and so runs on file://, where Chromium
// refuses to construct a Worker from a fetched URL — the origin is null and the
// script counts as cross-origin. A blob URL has no such problem. That is why
// this costs bundle size instead of being free.
//
// Only the base editor worker is inlined, and it answers for every label. It is
// the one that computes diffs, which is the expensive work and the whole reason
// this file exists, and it adds 337 kB. Giving each language its own worker as
// Monaco intends would be more correct and costs 12.5 MB — ts.worker alone is
// 7 MB before base64 — which is not a reasonable price for IntelliSense and
// validation in a viewer that is read-only and never asks for either. Syntax
// highlighting is unaffected either way: that is Monarch, running in the editor.
//
// The proper fix is to stop serving the renderer from file:// at all — a custom
// protocol would let Vite's already-emitted worker chunks load by URL, making
// both the inlining and this compromise unnecessary.
window.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
}
