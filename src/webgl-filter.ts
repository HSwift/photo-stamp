import type { Tone } from './types'

type PhotoRect = { x: number; y: number; w: number; h: number }
type FilterKind = 'color' | 'mono'

export type WebGLPhotoLayers = {
  color: HTMLCanvasElement
  mono: HTMLCanvasElement
}

const VERTEX_SHADER = `
  attribute vec2 a_position;
  attribute vec2 a_texCoord;
  varying vec2 v_texCoord;

  void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
    v_texCoord = a_texCoord;
  }
`

const FRAGMENT_SHADER = `
  precision mediump float;

  uniform sampler2D u_image;
  uniform float u_brightness;
  uniform float u_contrast;
  uniform float u_saturation;
  uniform float u_monochrome;
  varying vec2 v_texCoord;

  void main() {
    vec4 source = texture2D(u_image, v_texCoord);
    vec3 color = source.rgb;

    if (u_monochrome > 0.5) {
      float gray = dot(color, vec3(0.2126, 0.7152, 0.0722));
      color = vec3(gray);
      color *= u_brightness;
      color = (color - 0.5) * u_contrast + 0.5;
    } else {
      color *= u_brightness;
      color = (color - 0.5) * u_contrast + 0.5;
      float gray = dot(color, vec3(0.213, 0.715, 0.072));
      color = mix(vec3(gray), color, u_saturation);
    }

    gl_FragColor = vec4(clamp(color, 0.0, 1.0), source.a);
  }
`

function compileShader(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type)
  if (!shader) return undefined
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader)
    return undefined
  }
  return shader
}

function createProgram(gl: WebGLRenderingContext) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER)
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER)
  if (!vertex || !fragment) {
    if (vertex) gl.deleteShader(vertex)
    if (fragment) gl.deleteShader(fragment)
    return undefined
  }

  const program = gl.createProgram()
  if (!program) return undefined
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program)
    return undefined
  }
  return program
}

function textureSource(image: HTMLImageElement) {
  // WebGL 1 guarantees at least a 2048px texture. Previewing does not benefit
  // from uploading the full multi-megapixel camera image to two GPU contexts.
  const maxDimension = 2048
  const maxPixels = 2_000_000
  const scale = Math.min(
    1,
    maxDimension / image.naturalWidth,
    maxDimension / image.naturalHeight,
    Math.sqrt(maxPixels / (image.naturalWidth * image.naturalHeight)),
  )
  const width = Math.max(1, Math.round(image.naturalWidth * scale))
  const height = Math.max(1, Math.round(image.naturalHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { alpha: false })
  if (!context) return undefined
  context.drawImage(image, 0, 0, width, height)
  return canvas
}

class FilterSurface {
  readonly canvas: HTMLCanvasElement
  private readonly gl: WebGLRenderingContext
  private readonly program: WebGLProgram
  private readonly buffer: WebGLBuffer
  private readonly positionLocation: number
  private readonly texCoordLocation: number
  private readonly brightnessLocation: WebGLUniformLocation
  private readonly contrastLocation: WebGLUniformLocation
  private readonly saturationLocation: WebGLUniformLocation
  private readonly monochromeLocation: WebGLUniformLocation
  private lost = false

  private constructor(
    canvas: HTMLCanvasElement,
    gl: WebGLRenderingContext,
    program: WebGLProgram,
    buffer: WebGLBuffer,
    positionLocation: number,
    texCoordLocation: number,
    brightnessLocation: WebGLUniformLocation,
    contrastLocation: WebGLUniformLocation,
    saturationLocation: WebGLUniformLocation,
    monochromeLocation: WebGLUniformLocation,
  ) {
    this.canvas = canvas
    this.gl = gl
    this.program = program
    this.buffer = buffer
    this.positionLocation = positionLocation
    this.texCoordLocation = texCoordLocation
    this.brightnessLocation = brightnessLocation
    this.contrastLocation = contrastLocation
    this.saturationLocation = saturationLocation
    this.monochromeLocation = monochromeLocation
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault()
      this.lost = true
    })
  }

  static create(source: HTMLCanvasElement, width: number, height: number) {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const gl = canvas.getContext('webgl', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    })
    if (!gl) return undefined

    const program = createProgram(gl)
    const buffer = gl.createBuffer()
    const texture = gl.createTexture()
    if (!program || !buffer || !texture) return undefined

    const positionLocation = gl.getAttribLocation(program, 'a_position')
    const texCoordLocation = gl.getAttribLocation(program, 'a_texCoord')
    const imageLocation = gl.getUniformLocation(program, 'u_image')
    const brightnessLocation = gl.getUniformLocation(program, 'u_brightness')
    const contrastLocation = gl.getUniformLocation(program, 'u_contrast')
    const saturationLocation = gl.getUniformLocation(program, 'u_saturation')
    const monochromeLocation = gl.getUniformLocation(program, 'u_monochrome')
    if (
      positionLocation < 0 || texCoordLocation < 0 || !imageLocation
      || !brightnessLocation || !contrastLocation || !saturationLocation || !monochromeLocation
    ) return undefined

    gl.useProgram(program)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
    gl.uniform1i(imageLocation, 0)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.enableVertexAttribArray(positionLocation)
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 16, 0)
    gl.enableVertexAttribArray(texCoordLocation)
    gl.vertexAttribPointer(texCoordLocation, 2, gl.FLOAT, false, 16, 8)
    gl.clearColor(0, 0, 0, 1)
    if (gl.getError() !== gl.NO_ERROR) return undefined

    return new FilterSurface(
      canvas, gl, program, buffer,
      positionLocation, texCoordLocation,
      brightnessLocation, contrastLocation, saturationLocation, monochromeLocation,
    )
  }

  render(rect: PhotoRect, tone: Tone, kind: FilterKind, artWidth: number, artHeight: number) {
    const gl = this.gl
    if (this.lost || gl.isContextLost()) return false

    const left = rect.x / artWidth * 2 - 1
    const right = (rect.x + rect.w) / artWidth * 2 - 1
    const top = 1 - rect.y / artHeight * 2
    const bottom = 1 - (rect.y + rect.h) / artHeight * 2
    const vertices = new Float32Array([
      left, bottom, 0, 0,
      right, bottom, 1, 0,
      left, top, 0, 1,
      right, top, 1, 1,
    ])

    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.useProgram(this.program)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    gl.enableVertexAttribArray(this.positionLocation)
    gl.vertexAttribPointer(this.positionLocation, 2, gl.FLOAT, false, 16, 0)
    gl.enableVertexAttribArray(this.texCoordLocation)
    gl.vertexAttribPointer(this.texCoordLocation, 2, gl.FLOAT, false, 16, 8)
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW)

    if (kind === 'mono') {
      gl.uniform1f(this.brightnessLocation, Math.max(0, 100 + tone.monoBrightness) / 100)
      gl.uniform1f(this.contrastLocation, Math.max(0, 100 + tone.monoContrast) / 100)
      gl.uniform1f(this.saturationLocation, 1)
      gl.uniform1f(this.monochromeLocation, 1)
    } else {
      gl.uniform1f(this.brightnessLocation, Math.max(0, 100 + tone.colorBrightness) / 100)
      gl.uniform1f(this.contrastLocation, Math.max(0, 100 + tone.colorContrast) / 100)
      gl.uniform1f(this.saturationLocation, Math.max(0, 100 + tone.colorSaturation) / 100)
      gl.uniform1f(this.monochromeLocation, 0)
    }

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.flush()
    // Avoid getError() in the animation loop: it can force GPU/CPU
    // synchronization on WebKit. Context loss is handled explicitly above.
    return true
  }
}

class PreviewRenderer {
  readonly color: FilterSurface
  readonly mono: FilterSurface

  private constructor(color: FilterSurface, mono: FilterSurface) {
    this.color = color
    this.mono = mono
  }

  static create(image: HTMLImageElement, width: number, height: number) {
    const source = textureSource(image)
    if (!source) return undefined
    const color = FilterSurface.create(source, width, height)
    const mono = FilterSurface.create(source, width, height)
    source.width = source.height = 1
    return color && mono ? new PreviewRenderer(color, mono) : undefined
  }

  render(rect: PhotoRect, tone: Tone, artWidth: number, artHeight: number) {
    return this.mono.render(rect, tone, 'mono', artWidth, artHeight)
      && this.color.render(rect, tone, 'color', artWidth, artHeight)
  }
}

const renderers = new WeakMap<HTMLImageElement, PreviewRenderer>()
let webGLAvailable: boolean | undefined

export function renderWebGLPhotoLayers(
  image: HTMLImageElement,
  rect: PhotoRect,
  tone: Tone,
  outputWidth: number,
  outputHeight: number,
  artWidth: number,
  artHeight: number,
): WebGLPhotoLayers | undefined {
  if (webGLAvailable === false) return undefined
  let renderer = renderers.get(image)
  if (!renderer) {
    renderer = PreviewRenderer.create(image, outputWidth, outputHeight)
    if (!renderer) {
      webGLAvailable = false
      return undefined
    }
    webGLAvailable = true
    renderers.set(image, renderer)
  }

  if (!renderer.render(rect, tone, artWidth, artHeight)) {
    renderers.delete(image)
    return undefined
  }
  return { color: renderer.color.canvas, mono: renderer.mono.canvas }
}
