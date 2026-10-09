export interface BlueprintCamera { x: number; y: number; zoom: number }
export interface KleeCanvas {
  setCamera(camera: BlueprintCamera, notify?: boolean): void
  getCamera(): BlueprintCamera
  fit(): void
  bounds(): { x: number; y: number; width: number; height: number }
  select(id: string, focus?: boolean): void
  setChanges(changes: Record<string, string>): void
  destroy(): void
}
interface KleeModule {
  createKleeCanvas(canvas: HTMLCanvasElement, text: string, options: { camera?: BlueprintCamera; changes: Record<string, string>; onCamera(camera: BlueprintCamera): void; onSelect(id: string): void }): KleeCanvas
}
let loading: Promise<KleeModule> | undefined
export function loadKlee(): Promise<KleeModule> {
  if (!loading) {
    const url = new URL('blueprint/klee.js', document.baseURI).href
    loading = import(/* @vite-ignore */ url).catch(() => { loading = undefined; throw new Error('Graph renderer is unavailable. Build the Blueprint tools and restart the app.') })
  }
  return loading
}
