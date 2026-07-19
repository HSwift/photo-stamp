import './style.css'
import { ART_H, ART_W, SCREEN_H, SCREEN_W, constrainPhotoTransform, renderPoster } from './canvas'
import { fillLocation, readPhotoMeta } from './exif'
import { icon } from './icons'
import type { EditorMode, Point, PosterState } from './types'

const app = document.querySelector<HTMLElement>('#app')!

const DEFAULT_STATE: PosterState = {
  tone: { colorBrightness: 0, colorContrast: 0, colorSaturation: 0, monoBrightness: 8, monoContrast: -5 },
  stamp: { x: 270, y: 660, w: 540, h: 720 },
  photo: { panX: 0, panY: 0, zoom: 1 },
  date: new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replaceAll('/', '.'),
  title: 'MEMORY',
  location: '在此刻 · 在这里',
}

let state: PosterState = structuredClone(DEFAULT_STATE)
let originalState: PosterState = structuredClone(DEFAULT_STATE)
let image: HTMLImageElement | null = null
let imageUrl = ''
let activeTool = 'colorBrightness'
let renderQueued = false
let sliderPointerActive = false
let posterFontsPromise: Promise<unknown> | null = null
const pointers = new Map<number, Point>()
let gesture: {
  mode: EditorMode
  start: Point
  photo: PosterState['photo']
  stamp: PosterState['stamp']
  corner?: string
  pinchDistance?: number
  pinchMid?: Point
} | null = null

app.innerHTML = `
  <section class="editor" id="editor">
    <header class="editor-header">
      <button class="top-action" id="replace-photo" aria-label="换照片">${icon('image', 21)}<span>换照片</span></button>
      <div class="editor-title"><span>POSTMARK</span><small id="save-state">已自动保存</small></div>
      <div class="header-actions">
        <button class="icon-button" id="reset" aria-label="重置">${icon('rotate', 20)}</button>
        <button class="download-button" id="download" aria-label="下载">${icon('download', 19)}<span>保存</span></button>
      </div>
    </header>

    <div class="stage-wrap" id="stage-wrap">
      <canvas id="poster" width="${SCREEN_W}" height="${SCREEN_H}" aria-label="9:16 邮票海报预览"></canvas>
      <div class="empty-state" id="empty-state">
        <div class="empty-icon">${icon('image', 25)}</div>
        <strong>选择照片开始编辑</strong>
        <p>画面将自动裁切为竖版 9:16</p>
        <button id="empty-upload">${icon('upload', 17)}上传照片</button>
      </div>
      <div class="hint" id="gesture-hint"><span>${icon('spark', 14)}</span>框外单指移照片 · 框内单指移邮票 · 双指缩放</div>
      <div class="loading" id="loading" hidden><span class="spinner"></span><b>正在读取照片信息</b></div>
    </div>

    <div class="controls">
      <div class="panel" id="slider-panel">
        <div class="panel-row"><span id="slider-name">彩色亮度</span><output id="slider-value">0</output></div>
        <input id="adjustment" type="range" min="-50" max="50" value="0" aria-label="调整数值" />
        <div class="range-labels"><span>−</span><i></i><span>+</span></div>
      </div>
      <div class="panel text-panel" id="text-panel" hidden>
        <label><span>日期</span><input id="date-input" maxlength="18"></label>
        <label><span>主标题</span><input id="title-input" maxlength="18"></label>
        <label><span>地点</span><input id="location-input" maxlength="28"></label>
      </div>
      <nav class="toolbar" aria-label="编辑工具">
        <button data-tool="colorBrightness" class="active">${icon('sun', 22)}<span>彩色亮度</span></button>
        <button data-tool="colorContrast">${icon('contrast', 22)}<span>彩色对比</span></button>
        <button data-tool="colorSaturation">${icon('palette', 22)}<span>饱和度</span></button>
        <button data-tool="monoBrightness">${icon('mono', 22)}<span>黑白亮度</span></button>
        <button data-tool="monoContrast">${icon('contrast', 22)}<span>黑白对比</span></button>
        <button data-tool="text">${icon('type', 22)}<span>文字</span></button>
      </nav>
    </div>
  </section>
  <input type="file" id="file-input" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" hidden>
  <div class="toast" id="toast" role="status"></div>
`

const fileInput = document.querySelector<HTMLInputElement>('#file-input')!
const editor = document.querySelector<HTMLElement>('#editor')!
const stageWrap = document.querySelector<HTMLElement>('#stage-wrap')!
const canvas = document.querySelector<HTMLCanvasElement>('#poster')!
const emptyState = document.querySelector<HTMLElement>('#empty-state')!
const slider = document.querySelector<HTMLInputElement>('#adjustment')!
const sliderName = document.querySelector<HTMLElement>('#slider-name')!
const sliderValue = document.querySelector<HTMLOutputElement>('#slider-value')!
const sliderPanel = document.querySelector<HTMLElement>('#slider-panel')!
const textPanel = document.querySelector<HTMLElement>('#text-panel')!
const loading = document.querySelector<HTMLElement>('#loading')!
const toast = document.querySelector<HTMLElement>('#toast')!
const dateInput = document.querySelector<HTMLInputElement>('#date-input')!
const titleInput = document.querySelector<HTMLInputElement>('#title-input')!
const locationInput = document.querySelector<HTMLInputElement>('#location-input')!

const tools: Record<string, { label: string; key: keyof PosterState['tone'] }> = {
  colorBrightness: { label: '彩色区域 · 亮度', key: 'colorBrightness' },
  colorContrast: { label: '彩色区域 · 对比度', key: 'colorContrast' },
  colorSaturation: { label: '彩色区域 · 饱和度', key: 'colorSaturation' },
  monoBrightness: { label: '黑白背景 · 亮度', key: 'monoBrightness' },
  monoContrast: { label: '黑白背景 · 对比度', key: 'monoContrast' },
}

function showToast(message: string) {
  toast.textContent = message
  toast.classList.add('show')
  window.setTimeout(() => toast.classList.remove('show'), 2200)
}

function queueRender() {
  if (!image || renderQueued) return
  renderQueued = true
  requestAnimationFrame(() => {
    renderQueued = false
    if (image) renderPoster(canvas, image, state, SCREEN_W, SCREEN_H, { editing: true, draftTone: sliderPointerActive })
  })
}

function sizePreviewCanvas() {
  const availableWidth = stageWrap.clientWidth
  const availableHeight = stageWrap.clientHeight
  if (!availableWidth || !availableHeight) return
  const width = Math.min(availableWidth, availableHeight * SCREEN_W / SCREEN_H)
  const height = width * SCREEN_H / SCREEN_W
  canvas.style.width = `${Math.floor(width)}px`
  canvas.style.height = `${Math.floor(height)}px`
}

const stageResizeObserver = new ResizeObserver(() => requestAnimationFrame(sizePreviewCanvas))
stageResizeObserver.observe(stageWrap)
requestAnimationFrame(sizePreviewCanvas)

function ensurePosterFonts() {
  posterFontsPromise ??= Promise.allSettled([
    document.fonts.load('700 72px "Fraunces Poster"', 'MEMORY TOKYO 2026'),
    document.fonts.load('400 72px "Smiley Sans Poster"', '中国北京东京此刻'),
  ])
  return posterFontsPromise
}

function updateInputs() {
  dateInput.value = state.date
  titleInput.value = state.title
  locationInput.value = state.location
}

type WebkitFullscreenElement = HTMLElement & { webkitRequestFullscreen?: () => void | Promise<void> }
type WebkitFullscreenDocument = Document & { webkitFullscreenElement?: Element | null }

function isEditorFullscreen() {
  const fullscreenElement = document.fullscreenElement
    ?? (document as WebkitFullscreenDocument).webkitFullscreenElement
  return fullscreenElement === editor
}

async function enterFullscreenMode() {
  if (isEditorFullscreen()) return true
  try {
    if (editor.requestFullscreen) {
      await editor.requestFullscreen({ navigationUI: 'hide' })
    } else {
      const request = (editor as WebkitFullscreenElement).webkitRequestFullscreen
      if (!request) return false
      await request.call(editor)
    }
    return isEditorFullscreen()
  } catch {
    // Fullscreen requires a user activation and is not available in every iOS
    // WebKit host. The fixed small-viewport layout below remains the fallback.
    return false
  }
}

function openFilePicker() {
  fileInput.value = ''
  fileInput.click()
}

document.querySelector('#empty-upload')?.addEventListener('click', openFilePicker)
document.querySelector('#replace-photo')?.addEventListener('click', openFilePicker)

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0]
  if (!file) return
  if (!file.type.startsWith('image/') && !/\.(heic|heif)$/i.test(file.name)) {
    showToast('请选择照片文件')
    return
  }

  // Request while handling the trusted file-selection event. Waiting for image
  // decoding would lose the browser's transient user activation.
  void enterFullscreenMode()

  const nextUrl = URL.createObjectURL(file)
  const nextImage = new Image()
  nextImage.decoding = 'async'
  nextImage.onload = async () => {
    if (imageUrl) URL.revokeObjectURL(imageUrl)
    imageUrl = nextUrl
    image = nextImage
    state = structuredClone(DEFAULT_STATE)
    constrainPhotoTransform(nextImage, state.photo)
    originalState = structuredClone(DEFAULT_STATE)
    emptyState.hidden = true
    loading.hidden = false
    updateInputs()
    queueRender()
    void ensurePosterFonts().then(queueRender)
    const meta = await readPhotoMeta(file)
    state.date = meta.date
    state.title = meta.title
    state.location = meta.location
    originalState = structuredClone(state)
    updateInputs()
    loading.hidden = true
    queueRender()
    fillLocation(meta, (place) => {
      state.title = place.title
      state.location = place.location
      originalState.title = place.title
      originalState.location = place.location
      updateInputs()
      queueRender()
    })
  }
  nextImage.onerror = () => {
    URL.revokeObjectURL(nextUrl)
    showToast('暂时无法读取这张照片，请换一张 JPG 或 PNG')
  }
  nextImage.src = nextUrl
})

document.querySelector('#reset')?.addEventListener('click', () => {
  state = structuredClone(originalState)
  if (image) constrainPhotoTransform(image, state.photo)
  updateInputs()
  syncTool()
  queueRender()
  showToast('已恢复初始效果')
})

document.querySelector('#download')?.addEventListener('click', async () => {
  if (!image) return
  const button = document.querySelector<HTMLButtonElement>('#download')!
  button.disabled = true
  button.querySelector('span')!.textContent = '生成中'
  await ensurePosterFonts()
  await new Promise((resolve) => requestAnimationFrame(resolve))
  const output = document.createElement('canvas')
  renderPoster(output, image, state, 1440, 2560)
  output.toBlob((blob) => {
    if (!blob) {
      showToast('生成失败，请重试')
    } else {
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `postmark-${Date.now()}.jpg`
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 2000)
      showToast('高清海报已生成')
    }
    button.disabled = false
    button.querySelector('span')!.textContent = '保存'
  }, 'image/jpeg', 0.94)
})

function syncTool() {
  if (activeTool === 'text') return
  const tool = tools[activeTool]
  sliderName.textContent = tool.label
  slider.value = String(state.tone[tool.key])
  sliderValue.value = Number(slider.value) > 0 ? `+${slider.value}` : slider.value
}

document.querySelectorAll<HTMLButtonElement>('.toolbar button').forEach((button) => {
  button.addEventListener('click', () => {
    activeTool = button.dataset.tool!
    document.querySelectorAll('.toolbar button').forEach((item) => item.classList.toggle('active', item === button))
    const isText = activeTool === 'text'
    sliderPanel.hidden = isText
    textPanel.hidden = !isText
    if (!isText) syncTool()
  })
})

slider.addEventListener('pointerdown', () => {
  sliderPointerActive = true
})

slider.addEventListener('input', () => {
  const tool = tools[activeTool]
  state.tone[tool.key] = Number(slider.value)
  sliderValue.value = Number(slider.value) > 0 ? `+${slider.value}` : slider.value
  queueRender()
})

function finishSliderAdjustment() {
  if (!sliderPointerActive) return
  sliderPointerActive = false
  queueRender()
}

slider.addEventListener('change', finishSliderAdjustment)
slider.addEventListener('pointerup', finishSliderAdjustment)
slider.addEventListener('pointercancel', finishSliderAdjustment)

for (const [input, key] of [
  [dateInput, 'date'], [titleInput, 'title'], [locationInput, 'location'],
] as const) {
  input.addEventListener('input', () => {
    state[key] = input.value
    queueRender()
  })
}

function canvasPoint(event: PointerEvent | WheelEvent): Point {
  const rect = canvas.getBoundingClientRect()
  return { x: (event.clientX - rect.left) * ART_W / rect.width, y: (event.clientY - rect.top) * ART_H / rect.height }
}

function cornerAt(point: Point) {
  const s = state.stamp
  const threshold = 45
  const corners: Array<[string, number, number]> = [
    ['nw', s.x, s.y], ['ne', s.x + s.w, s.y], ['sw', s.x, s.y + s.h], ['se', s.x + s.w, s.y + s.h],
  ]
  return corners.find(([, x, y]) => Math.hypot(point.x - x, point.y - y) <= threshold)?.[0]
}

function isInsideStamp(point: Point) {
  const s = state.stamp
  return point.x >= s.x && point.x <= s.x + s.w && point.y >= s.y && point.y <= s.y + s.h
}

function zoomPhotoAt(
  point: Point,
  requestedZoom: number,
  startingPhoto: PosterState['photo'],
  startingPoint = point,
) {
  if (!image) return
  const zoom = Math.max(1, Math.min(5, requestedZoom))
  const ratio = zoom / startingPhoto.zoom
  state.photo.zoom = zoom
  state.photo.panX = point.x - ART_W / 2 - (startingPoint.x - ART_W / 2 - startingPhoto.panX) * ratio
  state.photo.panY = point.y - ART_H / 2 - (startingPoint.y - ART_H / 2 - startingPhoto.panY) * ratio
  constrainPhotoTransform(image, state.photo)
}

function startPinch() {
  const pts = [...pointers.values()]
  if (pts.length < 2) return
  const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }
  gesture = {
    mode: 'pinch', start: mid, photo: { ...state.photo }, stamp: { ...state.stamp },
    pinchDistance: Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y), pinchMid: mid,
  }
}

canvas.addEventListener('pointerdown', (event) => {
  event.preventDefault()
  canvas.setPointerCapture(event.pointerId)
  const point = canvasPoint(event)
  pointers.set(event.pointerId, point)
  if (pointers.size === 2) return startPinch()
  const corner = cornerAt(point)
  const mode: EditorMode = corner ? 'stamp-resize' : isInsideStamp(point) ? 'stamp-move' : 'photo'
  gesture = { mode, start: point, photo: { ...state.photo }, stamp: { ...state.stamp }, corner }
  document.querySelector('#gesture-hint')?.classList.add('fade')
})

canvas.addEventListener('pointermove', (event) => {
  if (!pointers.has(event.pointerId) || !gesture) return
  event.preventDefault()
  const point = canvasPoint(event)
  pointers.set(event.pointerId, point)

  if (pointers.size >= 2 && gesture.mode === 'pinch') {
    const pts = [...pointers.values()]
    const distance = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y)
    const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }
    const ratio = distance / (gesture.pinchDistance || distance)
    // A two-finger gesture only changes scale. Keeping the initial midpoint as
    // the anchor prevents two fingers moving together from panning the photo.
    zoomPhotoAt(gesture.pinchMid ?? mid, gesture.photo.zoom * ratio, gesture.photo)
  } else {
    const dx = point.x - gesture.start.x
    const dy = point.y - gesture.start.y
    if (gesture.mode === 'photo') {
      state.photo.panX = gesture.photo.panX + dx
      state.photo.panY = gesture.photo.panY + dy
      if (image) constrainPhotoTransform(image, state.photo)
    } else if (gesture.mode === 'stamp-move') {
      state.stamp.x = Math.max(10, Math.min(ART_W - gesture.stamp.w - 10, gesture.stamp.x + dx))
      state.stamp.y = Math.max(10, Math.min(ART_H - gesture.stamp.h - 10, gesture.stamp.y + dy))
    } else if (gesture.mode === 'stamp-resize') {
      const s = gesture.stamp
      const east = gesture.corner?.includes('e') ?? false
      const south = gesture.corner?.includes('s') ?? false
      const signX = east ? 1 : -1
      const signY = south ? 1 : -1
      const anchorX = east ? s.x : s.x + s.w
      const anchorY = south ? s.y : s.y + s.h
      const baseX = signX * s.w
      const baseY = signY * s.h
      const currentX = point.x - anchorX
      const currentY = point.y - anchorY
      const projectedScale = (currentX * baseX + currentY * baseY) / (baseX * baseX + baseY * baseY)
      const minScale = 300 / s.w
      const maxScaleX = east ? (ART_W - 10 - anchorX) / s.w : (anchorX - 10) / s.w
      const maxScaleY = south ? (ART_H - 10 - anchorY) / s.h : (anchorY - 10) / s.h
      const scale = Math.max(minScale, Math.min(maxScaleX, maxScaleY, projectedScale))
      const width = s.w * scale
      const height = s.h * scale
      state.stamp.w = width
      state.stamp.h = height
      state.stamp.x = east ? anchorX : anchorX - width
      state.stamp.y = south ? anchorY : anchorY - height
    }
  }
  queueRender()
})

canvas.addEventListener('wheel', (event) => {
  if (!image) return
  event.preventDefault()
  const startingPhoto = { ...state.photo }
  const delta = event.deltaY * (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? canvas.clientHeight : 1)
  const scale = Math.exp(-delta * 0.0015)
  zoomPhotoAt(canvasPoint(event), startingPhoto.zoom * scale, startingPhoto)
  document.querySelector('#gesture-hint')?.classList.add('fade')
  queueRender()
}, { passive: false })

function endPointer(event: PointerEvent) {
  const endedPinch = gesture?.mode === 'pinch'
  pointers.delete(event.pointerId)
  if (endedPinch) {
    // Do not turn the remaining finger into an implicit drag. Requiring a new
    // pointerdown keeps photo/stamp target selection deterministic.
    gesture = null
  } else if (pointers.size === 1) {
    const [point] = pointers.values()
    const corner = cornerAt(point)
    const mode: EditorMode = corner ? 'stamp-resize' : isInsideStamp(point) ? 'stamp-move' : 'photo'
    gesture = { mode, start: point, photo: { ...state.photo }, stamp: { ...state.stamp }, corner }
  } else if (pointers.size === 0) {
    gesture = null
  }
}

canvas.addEventListener('pointerup', endPointer)
canvas.addEventListener('pointercancel', endPointer)

function handleFullscreenChange() {
  // Let the viewport settle before recalculating the canvas's CSS presentation.
  requestAnimationFrame(() => {
    sizePreviewCanvas()
    queueRender()
  })
}

document.addEventListener('fullscreenchange', handleFullscreenChange)
document.addEventListener('webkitfullscreenchange', handleFullscreenChange)

window.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && !editor.hidden) {
    event.preventDefault()
    document.querySelector<HTMLButtonElement>('#download')?.click()
  }
})
