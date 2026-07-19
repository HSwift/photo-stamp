export type Tone = {
  colorBrightness: number
  colorContrast: number
  colorSaturation: number
  monoBrightness: number
  monoContrast: number
}

export type StampRect = { x: number; y: number; w: number; h: number }

export type PhotoTransform = { panX: number; panY: number; zoom: number }

export type PosterState = {
  tone: Tone
  stamp: StampRect
  photo: PhotoTransform
  date: string
  title: string
  location: string
}

export type EditorMode = 'photo' | 'stamp-move' | 'stamp-resize' | 'pinch'

export type Point = { x: number; y: number }

