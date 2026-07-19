import type { PhotoTransform, PosterState, StampRect } from './types'
import { renderWebGLPhotoLayers } from './webgl-filter'

export const ART_W = 1080
export const ART_H = 1920
export const SCREEN_W = 540
export const SCREEN_H = 960

type RenderOptions = { editing?: boolean; draftTone?: boolean }

type PhotoRect = { x: number; y: number; w: number; h: number }
type FilteredPhotoLayer = { canvas: HTMLCanvasElement; space: 'photo' | 'poster' }
type FilteredPhotoLayers = { color: FilteredPhotoLayer; mono: FilteredPhotoLayer }
type PreviewLayerState = {
  width: number
  height: number
  colorTone: string
  monoTone: string
  layers: FilteredPhotoLayers
}
type PreviewLayerStates = { draft?: PreviewLayerState; final?: PreviewLayerState }

let canvasFilterSupported: boolean | undefined
const filteredPhotoCache = new WeakMap<HTMLImageElement, Map<string, FilteredPhotoLayers>>()
const latestPreviewLayers = new WeakMap<HTMLImageElement, PreviewLayerStates>()

/** Keep a cover-fitted photo over the whole poster after every transform. */
export function constrainPhotoTransform(image: HTMLImageElement, photo: PhotoTransform) {
  photo.zoom = Math.max(1, Math.min(5, photo.zoom))
  const base = Math.max(ART_W / image.naturalWidth, ART_H / image.naturalHeight)
  const width = image.naturalWidth * base * photo.zoom
  const height = image.naturalHeight * base * photo.zoom
  const maxPanX = Math.max(0, (width - ART_W) / 2)
  const maxPanY = Math.max(0, (height - ART_H) / 2)
  photo.panX = Math.max(-maxPanX, Math.min(maxPanX, photo.panX))
  photo.panY = Math.max(-maxPanY, Math.min(maxPanY, photo.panY))
}

function photoRect(image: HTMLImageElement, state: PosterState): PhotoRect {
  const base = Math.max(ART_W / image.naturalWidth, ART_H / image.naturalHeight)
  const scale = base * state.photo.zoom
  const w = image.naturalWidth * scale
  const h = image.naturalHeight * scale
  return {
    x: (ART_W - w) / 2 + state.photo.panX,
    y: (ART_H - h) / 2 + state.photo.panY,
    w,
    h,
  }
}

/**
 * Do not rely on feature detection via `"filter" in ctx`: some WebKit builds
 * expose the property while keeping the implementation behind a flag. Verify
 * the rendered pixel instead.
 */
function supportsCanvasFilter() {
  if (canvasFilterSupported !== undefined) return canvasFilterSupported

  try {
    const source = document.createElement('canvas')
    source.width = 1
    source.height = 1
    const sourceContext = source.getContext('2d')
    const target = document.createElement('canvas')
    target.width = 1
    target.height = 1
    const targetContext = target.getContext('2d', { willReadFrequently: true })
    if (!sourceContext || !targetContext) return (canvasFilterSupported = false)

    sourceContext.fillStyle = '#fff'
    sourceContext.fillRect(0, 0, 1, 1)
    targetContext.filter = 'brightness(0%)'
    targetContext.drawImage(source, 0, 0)
    canvasFilterSupported = targetContext.getImageData(0, 0, 1, 1).data[0] === 0
  } catch {
    canvasFilterSupported = false
  }

  return canvasFilterSupported
}

function createCanvas(width: number, height: number) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function applyColorTone(data: Uint8ClampedArray, brightness: number, contrast: number, saturation: number) {
  // Filter Effects Level 1 applies these functions from left to right.
  const brightnessFactor = Math.max(0, 100 + brightness) / 100
  const contrastFactor = Math.max(0, 100 + contrast) / 100
  const saturationFactor = Math.max(0, 100 + saturation) / 100

  const rr = 0.213 + 0.787 * saturationFactor
  const rg = 0.715 - 0.715 * saturationFactor
  const rb = 0.072 - 0.072 * saturationFactor
  const gr = 0.213 - 0.213 * saturationFactor
  const gg = 0.715 + 0.285 * saturationFactor
  const gb = 0.072 - 0.072 * saturationFactor
  const br = 0.213 - 0.213 * saturationFactor
  const bg = 0.715 - 0.715 * saturationFactor
  const bb = 0.072 + 0.928 * saturationFactor

  // Combine brightness and contrast, then precompute each matrix contribution.
  // Slider updates process hundreds of thousands of pixels, so table lookups
  // are substantially cheaper on iOS than repeating floating-point math.
  const gain = brightnessFactor * contrastFactor
  const offset = 127.5 * (1 - contrastFactor)
  const rFromR = new Float32Array(256)
  const rFromG = new Float32Array(256)
  const rFromB = new Float32Array(256)
  const gFromR = new Float32Array(256)
  const gFromG = new Float32Array(256)
  const gFromB = new Float32Array(256)
  const bFromR = new Float32Array(256)
  const bFromG = new Float32Array(256)
  const bFromB = new Float32Array(256)
  for (let value = 0; value < 256; value += 1) {
    const adjusted = value * gain
    rFromR[value] = adjusted * rr
    rFromG[value] = adjusted * rg
    rFromB[value] = adjusted * rb
    gFromR[value] = adjusted * gr
    gFromG[value] = adjusted * gg
    gFromB[value] = adjusted * gb
    bFromR[value] = adjusted * br
    bFromG[value] = adjusted * bg
    bFromB[value] = adjusted * bb
  }

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    data[i] = rFromR[r] + rFromG[g] + rFromB[b] + offset
    data[i + 1] = gFromR[r] + gFromG[g] + gFromB[b] + offset
    data[i + 2] = bFromR[r] + bFromG[g] + bFromB[b] + offset
  }
}

function applyMonoTone(data: Uint8ClampedArray, brightness: number, contrast: number) {
  const brightnessFactor = Math.max(0, 100 + brightness) / 100
  const contrastFactor = Math.max(0, 100 + contrast) / 100
  const gain = brightnessFactor * contrastFactor
  const offset = 127.5 * (1 - contrastFactor)
  const fromR = new Float32Array(256)
  const fromG = new Float32Array(256)
  const fromB = new Float32Array(256)
  for (let value = 0; value < 256; value += 1) {
    fromR[value] = value * gain * 0.2126
    fromG[value] = value * gain * 0.7152
    fromB[value] = value * gain * 0.0722
  }

  for (let i = 0; i < data.length; i += 4) {
    const adjusted = fromR[data[i]] + fromG[data[i + 1]] + fromB[data[i + 2]] + offset
    data[i] = adjusted
    data[i + 1] = adjusted
    data[i + 2] = adjusted
  }
}

function acceleratedCopy(source: HTMLCanvasElement) {
  const display = createCanvas(source.width, source.height)
  const displayContext = display.getContext('2d', { alpha: false })
  if (!displayContext) return undefined
  displayContext.drawImage(source, 0, 0)
  source.width = source.height = 1
  return display
}

function applyTones(
  base: HTMLCanvasElement,
  baseContext: CanvasRenderingContext2D,
  state: PosterState,
  space: FilteredPhotoLayer['space'],
) {
  const { tone } = state
  const color = createCanvas(base.width, base.height)
  const colorContext = color.getContext('2d', { alpha: false, willReadFrequently: true })
  if (!colorContext) return undefined

  colorContext.drawImage(base, 0, 0)
  {
    const pixels = colorContext.getImageData(0, 0, color.width, color.height)
    applyColorTone(pixels.data, tone.colorBrightness, tone.colorContrast, tone.colorSaturation)
    colorContext.putImageData(pixels, 0, 0)
  }

  // Reuse the unfiltered base canvas as the monochrome layer. Keeping a third
  // full-resolution canvas here noticeably raises Safari's peak memory usage.
  {
    const pixels = baseContext.getImageData(0, 0, base.width, base.height)
    applyMonoTone(pixels.data, tone.monoBrightness, tone.monoContrast)
    baseContext.putImageData(pixels, 0, 0)
  }

  if (space === 'photo') {
    // `willReadFrequently` may force a software-backed canvas in WebKit. Copy
    // the finished preview layers to normal canvases so repeated transforms can
    // use the accelerated drawing path, then release the processing buffers.
    const displayColor = acceleratedCopy(color)
    const displayMono = acceleratedCopy(base)
    if (!displayColor || !displayMono) return undefined
    return {
      color: { canvas: displayColor, space },
      mono: { canvas: displayMono, space },
    } satisfies FilteredPhotoLayers
  }

  return {
    color: { canvas: color, space },
    mono: { canvas: base, space },
  } satisfies FilteredPhotoLayers
}

function filteredSourceLayer(
  image: HTMLImageElement,
  state: PosterState,
  width: number,
  height: number,
  kind: 'color' | 'mono',
) {
  const processing = createCanvas(width, height)
  const context = processing.getContext('2d', { alpha: false, willReadFrequently: true })
  if (!context) return undefined
  context.drawImage(image, 0, 0, width, height)
  const pixels = context.getImageData(0, 0, width, height)
  const { tone } = state
  if (kind === 'color') {
    applyColorTone(pixels.data, tone.colorBrightness, tone.colorContrast, tone.colorSaturation)
  } else {
    applyMonoTone(pixels.data, tone.monoBrightness, tone.monoContrast)
  }
  context.putImageData(pixels, 0, 0)
  const canvas = acceleratedCopy(processing)
  return canvas ? { canvas, space: 'photo' as const } : undefined
}

function cacheLayers(
  imageCache: Map<string, FilteredPhotoLayers>,
  key: string,
  layers: FilteredPhotoLayers,
) {
  // Keep the current preview plus a possible export-size render. Slider input
  // can otherwise retain a full canvas for every intermediate value.
  if (imageCache.size >= 2) imageCache.delete(imageCache.keys().next().value!)
  imageCache.set(key, layers)
  return layers
}

function filteredPhotoLayers(
  image: HTMLImageElement,
  state: PosterState,
  outputWidth: number,
  outputHeight: number,
  draftTone = false,
) {
  const { photo, tone } = state
  let imageCache = filteredPhotoCache.get(image)
  if (!imageCache) {
    imageCache = new Map()
    filteredPhotoCache.set(image, imageCache)
  }

  // The preview filters the photo once in photo coordinates. Panning and
  // zooming can then reuse these canvases and only issue cheap drawImage calls.
  if (outputWidth === SCREEN_W && outputHeight === SCREEN_H) {
    const maxPixels = draftTone ? 300_000 : 2_000_000
    const maxDimension = draftTone ? 1024 : 3072
    const sourceScale = Math.min(
      1,
      maxDimension / image.naturalWidth,
      maxDimension / image.naturalHeight,
      Math.sqrt(maxPixels / (image.naturalWidth * image.naturalHeight)),
    )
    const sourceWidth = Math.max(1, Math.round(image.naturalWidth * sourceScale))
    const sourceHeight = Math.max(1, Math.round(image.naturalHeight * sourceScale))
    const colorTone = [tone.colorBrightness, tone.colorContrast, tone.colorSaturation].join(':')
    const monoTone = [tone.monoBrightness, tone.monoContrast].join(':')
    const quality = draftTone ? 'draft' : 'final'
    let previewStates = latestPreviewLayers.get(image)
    if (!previewStates) {
      previewStates = {}
      latestPreviewLayers.set(image, previewStates)
    }
    const remember = (layers: FilteredPhotoLayers) => {
      previewStates[quality] = { width: sourceWidth, height: sourceHeight, colorTone, monoTone, layers }
      return layers
    }
    const key = ['photo', sourceWidth, sourceHeight, colorTone, monoTone].join(':')
    const cached = imageCache.get(key)
    if (cached) {
      return remember(cached)
    }

    const previous = previewStates[quality]
    if (previous?.width === sourceWidth && previous.height === sourceHeight) {
      if (previous.colorTone === colorTone && previous.monoTone === monoTone) return previous.layers

      if (previous.monoTone === monoTone) {
        const color = filteredSourceLayer(image, state, sourceWidth, sourceHeight, 'color')
        if (color) {
          const layers = { color, mono: previous.layers.mono }
          remember(layers)
          return cacheLayers(imageCache, key, layers)
        }
      } else if (previous.colorTone === colorTone) {
        const mono = filteredSourceLayer(image, state, sourceWidth, sourceHeight, 'mono')
        if (mono) {
          const layers = { color: previous.layers.color, mono }
          remember(layers)
          return cacheLayers(imageCache, key, layers)
        }
      }
    }

    const base = createCanvas(sourceWidth, sourceHeight)
    const baseContext = base.getContext('2d', { alpha: false, willReadFrequently: true })
    if (!baseContext) return undefined
    baseContext.drawImage(image, 0, 0, sourceWidth, sourceHeight)
    const layers = applyTones(base, baseContext, state, 'photo')
    if (!layers) return undefined
    remember(layers)
    return cacheLayers(imageCache, key, layers)
  }

  // Export filtering remains in poster coordinates so the saved JPEG uses the
  // exact requested resolution without retaining a full original-size copy.
  const key = [
    'poster', outputWidth, outputHeight,
    photo.panX, photo.panY, photo.zoom,
    tone.colorBrightness, tone.colorContrast, tone.colorSaturation,
    tone.monoBrightness, tone.monoContrast,
  ].join(':')
  const cached = imageCache.get(key)
  if (cached) return cached

  const base = createCanvas(outputWidth, outputHeight)
  const baseContext = base.getContext('2d', { alpha: false, willReadFrequently: true })
  if (!baseContext) return undefined
  const ratio = outputWidth / ART_W
  const rect = photoRect(image, state)
  baseContext.setTransform(ratio, 0, 0, ratio, 0, 0)
  baseContext.drawImage(image, rect.x, rect.y, rect.w, rect.h)
  const layers = applyTones(base, baseContext, state, 'poster')
  return layers ? cacheLayers(imageCache, key, layers) : undefined
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
}

function drawPhoto(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  state: PosterState,
  filter: string,
  clip?: { x: number; y: number; w: number; h: number },
  filteredPhoto?: FilteredPhotoLayer,
) {
  ctx.save()
  if (clip) {
    roundedRect(ctx, clip.x, clip.y, clip.w, clip.h, 2)
    ctx.clip()
  }
  if (filteredPhoto) {
    if (filteredPhoto.space === 'poster') {
      ctx.drawImage(filteredPhoto.canvas, 0, 0, ART_W, ART_H)
    } else {
      const rect = photoRect(image, state)
      ctx.drawImage(filteredPhoto.canvas, rect.x, rect.y, rect.w, rect.h)
    }
  } else {
    const rect = photoRect(image, state)
    ctx.filter = filter
    ctx.drawImage(image, rect.x, rect.y, rect.w, rect.h)
  }
  ctx.restore()
}

function filters(state: PosterState) {
  const pct = (value: number) => `${Math.max(0, 100 + value)}%`
  return {
    mono: `grayscale(1) brightness(${pct(state.tone.monoBrightness)}) contrast(${pct(state.tone.monoContrast)})`,
    color: `brightness(${pct(state.tone.colorBrightness)}) contrast(${pct(state.tone.colorContrast)}) saturate(${pct(state.tone.colorSaturation)})`,
  }
}

function perforations(rect: StampRect, gap: number, radius: number) {
  const holes: Array<[number, number]> = []
  for (let x = rect.x + gap / 2; x < rect.x + rect.w; x += gap) {
    holes.push([x, rect.y], [x, rect.y + rect.h])
  }
  for (let y = rect.y + gap / 2; y < rect.y + rect.h; y += gap) {
    holes.push([rect.x, y], [rect.x + rect.w, y])
  }
  return { holes, radius }
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, start: number, min = 18) {
  let size = start
  while (size > min && ctx.measureText(text).width > maxWidth) {
    size -= 1
    ctx.font = ctx.font.replace(/\d+(?:\.\d+)?px/, `${size}px`)
  }
  return size
}

function posterFont(text: string) {
  return /[\u3400-\u9fff\uf900-\ufaff]/.test(text) ? '"Smiley Sans Poster"' : '"Fraunces Poster"'
}

function drawStamp(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  state: PosterState,
  editing: boolean,
  filteredPhotos?: FilteredPhotoLayers,
) {
  const { stamp } = state
  const frame = Math.max(17, Math.min(stamp.w, stamp.h) * 0.038)
  const inner = { x: stamp.x + frame, y: stamp.y + frame, w: stamp.w - frame * 2, h: stamp.h - frame * 2 }
  const f = filters(state)

  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,.48)'
  ctx.shadowBlur = 34
  ctx.shadowOffsetY = 14
  const paper = ctx.createLinearGradient(stamp.x, stamp.y, stamp.x + stamp.w, stamp.y + stamp.h)
  paper.addColorStop(0, '#fffdf7')
  paper.addColorStop(.52, '#f4f0e6')
  paper.addColorStop(1, '#ded8cc')
  ctx.fillStyle = paper
  ctx.fillRect(stamp.x, stamp.y, stamp.w, stamp.h)
  ctx.restore()

  // 稳定的细微纸张颗粒，不使用随机数，拖动时纹理不会闪烁。
  ctx.save()
  for (let i = 0; i < 90; i += 1) {
    const x = stamp.x + ((i * 73) % 997) / 997 * stamp.w
    const y = stamp.y + ((i * 151) % 991) / 991 * stamp.h
    ctx.fillStyle = i % 3 === 0 ? 'rgba(62,52,39,.08)' : 'rgba(255,255,255,.2)'
    ctx.fillRect(x, y, 1.4, 1.4)
  }
  ctx.strokeStyle = 'rgba(255,255,255,.65)'
  ctx.lineWidth = 2
  ctx.strokeRect(stamp.x + 2, stamp.y + 2, stamp.w - 4, stamp.h - 4)
  ctx.restore()

  drawPhoto(ctx, image, state, f.color, inner, filteredPhotos?.color)

  const { holes, radius } = perforations(stamp, Math.max(20, frame * 1.32), Math.max(6, frame * 0.35))
  ctx.save()
  ctx.fillStyle = 'rgba(22,18,13,.16)'
  ctx.shadowColor = 'rgba(0,0,0,.5)'
  ctx.shadowBlur = 7
  for (const [x, y] of holes) {
    ctx.beginPath()
    ctx.arc(x, y, radius, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()

  ctx.save()
  ctx.beginPath()
  for (const [x, y] of holes) {
    ctx.moveTo(x + radius, y)
    ctx.arc(x, y, radius, 0, Math.PI * 2)
  }
  ctx.clip()
  drawPhoto(ctx, image, state, f.mono, undefined, filteredPhotos?.mono)
  ctx.restore()

  // 彩色画面边缘的压痕与投影，让纸框看起来有厚度。
  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,.55)'
  ctx.shadowBlur = 11
  ctx.shadowOffsetY = 3
  ctx.strokeStyle = 'rgba(30,24,18,.3)'
  ctx.lineWidth = 3
  ctx.strokeRect(inner.x, inner.y, inner.w, inner.h)
  ctx.shadowColor = 'transparent'
  ctx.strokeStyle = 'rgba(255,255,255,.58)'
  ctx.lineWidth = 1.5
  ctx.strokeRect(inner.x + 2, inner.y + 2, inner.w - 4, inner.h - 4)
  ctx.restore()

  const pad = Math.max(18, inner.w * 0.032)
  ctx.save()
  ctx.fillStyle = '#fff'
  ctx.shadowColor = 'rgba(0,0,0,.62)'
  ctx.shadowBlur = 9
  ctx.shadowOffsetY = 3
  ctx.fontKerning = 'normal'

  let dateSize = Math.max(21, inner.w * 0.045)
  ctx.font = `650 ${dateSize}px "Fraunces Poster", "Arial Narrow", sans-serif`
  fitText(ctx, state.date, inner.w * 0.48, dateSize)
  ctx.textBaseline = 'top'
  ctx.fillText(state.date, inner.x + pad, inner.y + pad)

  const title = (state.title || 'MEMORY').toUpperCase()
  let titleSize = Math.max(48, inner.w * 0.145)
  ctx.font = `700 ${titleSize}px ${posterFont(title)}, "Arial Narrow", sans-serif`
  titleSize = fitText(ctx, title, inner.w - pad * 2, titleSize, 32)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  ctx.letterSpacing = `${Math.max(2, titleSize * 0.055)}px`
  const titleX = inner.x + inner.w / 2
  const titleY = inner.y + inner.h - pad * 1.9 - Math.max(24, inner.w * 0.045)
  ctx.strokeStyle = 'rgba(0,0,0,.22)'
  ctx.lineWidth = Math.max(1.2, titleSize * .018)
  ctx.strokeText(title, titleX, titleY)
  ctx.fillText(title, titleX, titleY)

  const locationSize = Math.max(18, inner.w * 0.043)
  ctx.font = `600 ${locationSize}px ${posterFont(state.location)}, "Arial Narrow", sans-serif`
  ctx.letterSpacing = `${Math.max(1, locationSize * 0.14)}px`
  fitText(ctx, state.location, inner.w - pad * 3, locationSize, 14)
  ctx.fillText(state.location, inner.x + inner.w / 2, inner.y + inner.h - pad)
  ctx.restore()

  if (editing) {
    ctx.save()
    ctx.strokeStyle = 'rgba(255,255,255,.82)'
    ctx.lineWidth = 2
    ctx.setLineDash([8, 8])
    ctx.strokeRect(stamp.x - 7, stamp.y - 7, stamp.w + 14, stamp.h + 14)
    ctx.setLineDash([])
    for (const [x, y] of [
      [stamp.x, stamp.y], [stamp.x + stamp.w, stamp.y],
      [stamp.x, stamp.y + stamp.h], [stamp.x + stamp.w, stamp.y + stamp.h],
    ]) {
      ctx.fillStyle = '#fff'
      ctx.beginPath()
      ctx.arc(x, y, 11, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = 'rgba(0,0,0,.3)'
      ctx.stroke()
    }
    ctx.restore()
  }
}

export function renderPoster(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  state: PosterState,
  outputWidth = SCREEN_W,
  outputHeight = SCREEN_H,
  options: RenderOptions = {},
) {
  if (canvas.width !== outputWidth || canvas.height !== outputHeight) {
    canvas.width = outputWidth
    canvas.height = outputHeight
  }
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) return
  let filteredPhotos: FilteredPhotoLayers | undefined
  if (!supportsCanvasFilter()) {
    if (outputWidth === SCREEN_W && outputHeight === SCREEN_H) {
      const gpuLayers = renderWebGLPhotoLayers(
        image,
        photoRect(image, state),
        state.tone,
        outputWidth,
        outputHeight,
        ART_W,
        ART_H,
      )
      if (gpuLayers) {
        filteredPhotos = {
          color: { canvas: gpuLayers.color, space: 'poster' },
          mono: { canvas: gpuLayers.mono, space: 'poster' },
        }
      }
    }
    filteredPhotos ??= filteredPhotoLayers(
      image,
      state,
      outputWidth,
      outputHeight,
      Boolean(options.draftTone),
    )
  }
  const ratio = outputWidth / ART_W
  ctx.save()
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  ctx.fillStyle = '#111'
  ctx.fillRect(0, 0, ART_W, ART_H)
  drawPhoto(ctx, image, state, filters(state).mono, undefined, filteredPhotos?.mono)
  drawStamp(ctx, image, state, Boolean(options.editing), filteredPhotos)
  ctx.restore()
}
