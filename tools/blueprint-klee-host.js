import { Scene } from '../third_party/klee/src/scene'
import { Canvas2D } from '../third_party/klee/src/canvas'
import { BlueprintParser } from '../third_party/klee/src/parser/blueprint-parser'
import { Constants } from '../third_party/klee/src/constants'
import { NodeParserRegistry } from '../third_party/klee/src/parser/node-parser-registry'
import { NodeConnectionControl } from '../third_party/klee/src/controls/node-connection.control'
import { wireId } from '../src/lib/blueprintGraph'

// The pinned upstream discovery uses webpack require.context. Only reviewed core
// parsers are bundled here; unknown classes keep Klee's generic node rendering.
NodeParserRegistry.prototype.loadPlugins = () => {}

// Own the camera/input lifecycle; upstream's editable Controller and Application
// are never constructed. Only Klee's parser, node controls, and wires are used.
export function createKleeCanvas(element, text, options = {}) {
  const canvas = new Canvas2D(element), context = canvas.getContext()
  function applyTheme() {
    const style = getComputedStyle(element), token = (name, fallback) => style.getPropertyValue(name).trim() || fallback
    Constants.NODE_FONT = `${token('--lg-font-size', '13px')} ${token('--lg-font-ui', 'system-ui')}`
    Constants.NODE_HEADER_FONT = `600 ${Constants.NODE_FONT}`
    Constants.NODE_TEXT_COLOR = token('--lg-text-primary', '#e2e6f4')
    Constants.NODE_SUBTITLE_COLOR = token('--lg-text-secondary', '#7b8499')
    Constants.NODE_BACKGROUND_COLOR = token('--lg-bg-elevated', '#161a27')
    Constants.NODE_MATHFUNC_TITLE_FONT = `600 20px ${token('--lg-font-ui', 'system-ui')}`
    Constants.NODE_MATHFUNC_SUBTITLE_FONT = Constants.NODE_FONT
  }
  applyTheme()
  const host = { canvas, refresh: () => draw() }
  const scene = new Scene(canvas, host); host.scene = scene
  scene.createBackground = () => {} // App theme grid replaces Klee's stock image.
  const nodes = new BlueprintParser().parseBlueprint(text)
  scene.load(nodes); scene.updateLayout()
  let camera = options.camera ?? { x: 0, y: 0, zoom: 1 }, disposed = false, drag = null
  let selected = '', changes = options.changes ?? {}, wireChanges = options.wireChanges ?? {}, frame = 0
  const originalRefresh = scene.refresh.bind(scene)
  scene.refresh = () => draw()
  scene.camera.prepareViewport = () => {
    const rect = element.getBoundingClientRect(), dpr = window.devicePixelRatio || 1
    const style = getComputedStyle(element)
    const token = (name, fallback) => style.getPropertyValue(name).trim() || fallback
    Constants.NODE_FONT = `${token('--lg-font-size', '13px')} ${token('--lg-font-ui', 'system-ui')}`
    Constants.NODE_HEADER_FONT = `600 ${Constants.NODE_FONT}`
    Constants.NODE_TEXT_COLOR = token('--lg-text-primary', '#e2e6f4')
    Constants.NODE_BACKGROUND_COLOR = token('--lg-bg-elevated', '#161a27')
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.fillStyle = token('--lg-bg-primary', '#0b0d13'); context.fillRect(0, 0, rect.width, rect.height)
    const spacing = Math.max(8, 32 * camera.zoom), ox = rect.width / 2 - camera.x * camera.zoom, oy = rect.height / 2 - camera.y * camera.zoom
    context.beginPath(); context.strokeStyle = token('--lg-border', '#1d2535'); context.lineWidth = .5
    for (let x = ((ox % spacing) + spacing) % spacing; x < rect.width; x += spacing) { context.moveTo(x, 0); context.lineTo(x, rect.height) }
    for (let y = ((oy % spacing) + spacing) % spacing; y < rect.height; y += spacing) { context.moveTo(0, y); context.lineTo(rect.width, y) }
    context.stroke(); context.setTransform(dpr * camera.zoom, 0, 0, dpr * camera.zoom, dpr * ox, dpr * oy)
  }
  const nodeId = node => /NodeGuid=([^\r\n]+)/.exec(node.sourceText)?.[1]?.trim() ?? ''
  const identities = new Map(nodes.map(node => [/Name="([^"\r\n]+)"/.exec(node.sourceText)?.[1], nodeId(node)]))
  // Pinned Klee exposes these TypeScript-private fields in its JS controls.
  // Adapt each instance; leave the upstream checkout and other canvases intact.
  for (const connection of scene._controls) {
    if (!(connection instanceof NodeConnectionControl)) continue
    const originalDraw = connection.onDraw.bind(connection)
    const start = connection.pinStart.pinProperty, end = connection.pinEnd.pinProperty
    const id = wireId(identities.get(start.nodeName), start.id, identities.get(end.nodeName), end.id)
    connection.onDraw = canvas => {
      const change = wireChanges[id]
      if (!change) { originalDraw(canvas); return }
      const from = connection.pinStart.getPinAbsolutePosition(), to = connection.pinEnd.getPinAbsolutePosition()
      const curve = (Math.hypot(to.x - from.x, to.y - from.y) - 12) * .4
      const style = getComputedStyle(element)
      const color = style.getPropertyValue(({ added: '--lg-success', removed: '--lg-error', modified: '--lg-warning' })[change]).trim() || ({ added: '#2dbd6e', removed: '#e84040', modified: '#f5a623' })[change]
      canvas.save().strokeStyle(color).lineWidth(start.category === 'exec' ? 2.5 : 1.5)
        .setLineDash(change === 'removed' ? [6 / camera.zoom, 4 / camera.zoom] : [])
        .beginPath().moveTo(from.x, from.y).lineTo(from.x + 6, from.y)
        .bezierCurveTo(from.x + curve + 6, from.y, to.x - curve - 6, to.y, to.x - 6, to.y)
        .lineTo(to.x, to.y).stroke()
      canvas.fillStyle(color).font(Constants.NODE_FONT).fillText(({ added: '+ Wire', removed: '− Wire', modified: '~ Wire' })[change], (from.x + to.x) / 2, (from.y + to.y) / 2 - 6).restore()
    }
  }
  function draw() {
    if (disposed) return
    originalRefresh()
    for (const node of nodes) {
      const id = nodeId(node), change = changes[id]
      if (!change && selected !== id) continue
      context.save(); context.strokeStyle = selected === id ? getComputedStyle(element).getPropertyValue('--lg-accent').trim() || '#4a9eff' : ({ added: '#2dbd6e', removed: '#e84040', modified: '#f5a623', moved: '#9c8de3', commented: '#f5a623' })[change]
      context.lineWidth = 2 / camera.zoom; if (change === 'removed') context.setLineDash([6 / camera.zoom, 4 / camera.zoom])
      context.strokeRect(node.position.x - 3, node.position.y - 3, node.size.x + 6, node.size.y + 6)
      if (change) { context.fillStyle = context.strokeStyle; context.font = Constants.NODE_FONT; context.fillText(({added:'+ Added',removed:'− Removed',modified:'~ Modified',moved:'↔ Layout',commented:'✎ Comment'})[change], node.position.x, node.position.y - 10) }
      context.restore()
    }
  }
  function renderSoon() { if (!frame) frame = requestAnimationFrame(() => { frame = 0; draw() }) }
  function resize() {
    const rect = element.getBoundingClientRect(), dpr = window.devicePixelRatio || 1
    element.width = Math.max(1, Math.round(rect.width * dpr)); element.height = Math.max(1, Math.round(rect.height * dpr)); renderSoon()
  }
  function bounds() {
    if (!nodes.length) return { x: 0, y: 0, width: 500, height: 300 }
    const minX = Math.min(...nodes.map(n => n.position.x)), minY = Math.min(...nodes.map(n => n.position.y))
    return { x: minX, y: minY, width: Math.max(...nodes.map(n => n.position.x + n.size.x)) - minX, height: Math.max(...nodes.map(n => n.position.y + n.size.y)) - minY }
  }
  function setCamera(next, notify = false) { camera = { ...next }; renderSoon(); if (notify) options.onCamera?.(camera) }
  function fit() { const b = bounds(), rect = element.getBoundingClientRect(); setCamera({ x: b.x + b.width / 2, y: b.y + b.height / 2, zoom: Math.max(.05, Math.min(1, (rect.width - 60) / Math.max(1, b.width), (rect.height - 60) / Math.max(1, b.height))) }, true) }
  function point(event) { const r = element.getBoundingClientRect(); return { x: camera.x + (event.clientX - r.left - r.width / 2) / camera.zoom, y: camera.y + (event.clientY - r.top - r.height / 2) / camera.zoom } }
  function down(e) { if (e.button > 1) return; element.focus(); drag = { x: e.clientX, y: e.clientY, camera: { ...camera }, moved: false }; element.setPointerCapture(e.pointerId) }
  function move(e) { if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true; setCamera({ ...camera, x: drag.camera.x - dx / camera.zoom, y: drag.camera.y - dy / camera.zoom }, true) }
  function up(e) { if (drag && !drag.moved) { const p = point(e), node = [...nodes].reverse().find(n => p.x >= n.position.x && p.x <= n.position.x + n.size.x && p.y >= n.position.y && p.y <= n.position.y + n.size.y); selected = node ? nodeId(node) : ''; options.onSelect?.(selected); renderSoon() } drag = null }
  function wheel(e) { e.preventDefault(); const p = point(e), zoom = Math.max(.05, Math.min(3, camera.zoom * Math.exp(-e.deltaY * .001))); setCamera({ x: p.x + (camera.x - p.x) * camera.zoom / zoom, y: p.y + (camera.y - p.y) * camera.zoom / zoom, zoom }, true) }
  function key(e) { if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','+','-','='].includes(e.key)) { e.preventDefault(); if(e.key==='Home')fit(); else if(['+','-','='].includes(e.key))setCamera({...camera,zoom:Math.max(.05,Math.min(3,camera.zoom*(e.key==='-'?.85:1.15)))},true); else setCamera({...camera,x:camera.x+(e.key==='ArrowLeft'?-60:e.key==='ArrowRight'?60:0)/camera.zoom,y:camera.y+(e.key==='ArrowUp'?-60:e.key==='ArrowDown'?60:0)/camera.zoom},true) } }
  const events = { pointerdown: down, pointermove: move, pointerup: up, pointercancel: () => { drag = null }, wheel, keydown: key }
  for (const [name, fn] of Object.entries(events)) element.addEventListener(name, fn, { passive: false })
  const observer = new ResizeObserver(resize); observer.observe(element); resize()
  const appearance = new MutationObserver(() => { scene.updateLayout(); resize() }); appearance.observe(document.documentElement, { attributes: true, attributeFilter: ['style','class'] })
  if (!options.camera) fit()
  return { setCamera, getCamera: () => ({ ...camera }), fit, bounds, setChanges: next => { changes = next; renderSoon() }, setWireChanges: next => { wireChanges = next; renderSoon() }, select: (id, focus = false) => { selected = id; if(focus){const n=nodes.find(n=>nodeId(n)===id);if(n)setCamera({...camera,x:n.position.x+n.size.x/2,y:n.position.y+n.size.y/2},true)}renderSoon() }, destroy: () => { disposed = true; cancelAnimationFrame(frame); observer.disconnect(); appearance.disconnect(); for(const [name,fn]of Object.entries(events))element.removeEventListener(name,fn);scene.unload();element.width=1;element.height=1 } }
}
