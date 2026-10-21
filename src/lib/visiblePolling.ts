/**
 * Run `run` every `intervalMs` while the window is visible. Ticks that fall
 * while it is hidden or minimized are skipped, and one runs as soon as it
 * returns if a tick was missed, so the display is current when someone looks.
 */
export function pollWhileVisible(run: () => void, intervalMs: number): () => void {
  let last = Date.now()
  const tick = () => {
    if (document.hidden) return
    last = Date.now()
    run()
  }
  const timer = setInterval(tick, intervalMs)
  const onVisible = () => { if (!document.hidden && Date.now() - last >= intervalMs) tick() }
  document.addEventListener('visibilitychange', onVisible)
  return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
}
