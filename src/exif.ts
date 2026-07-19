export type PhotoMeta = {
  date: string
  title: string
  location: string
  latitude?: number
  longitude?: number
}

function formatDate(value?: Date | string) {
  const date = value instanceof Date ? value : value ? new Date(value) : new Date()
  if (Number.isNaN(date.getTime())) return formatDate(new Date())
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date).replaceAll('/', '.')
}

async function reverseGeocode(latitude: number, longitude: number): Promise<{ title: string; location: string } | null> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), 6000)
  try {
    const url = new URL('https://nominatim.openstreetmap.org/reverse')
    url.search = new URLSearchParams({
      format: 'jsonv2', lat: String(latitude), lon: String(longitude), zoom: '10', 'accept-language': 'zh-CN,zh,en',
    }).toString()
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) return null
    const data = await response.json()
    const address = data.address ?? {}
    const city = address.city || address.town || address.municipality || address.county || address.state
    const country = address.country
    return {
      title: city || country || 'MEMORY',
      location: [country, city].filter(Boolean).join(' · ') || data.display_name?.split(',').slice(0, 2).join(' · '),
    }
  } catch {
    return null
  } finally {
    window.clearTimeout(timer)
  }
}

export async function readPhotoMeta(file: File): Promise<PhotoMeta> {
  const fallback: PhotoMeta = { date: formatDate(), title: 'MEMORY', location: '在此刻 · 在这里' }
  try {
    // lite 构建保留 JPEG/HEIC、TIFF/EXIF 与 GPS，避免加载不需要的 PNG/IPTC/ICC 解析器。
    const exifr = (await import('exifr/dist/lite.esm.mjs')).default
    const data = await exifr.parse(file, {
      pick: ['DateTimeOriginal', 'CreateDate', 'GPSLatitude', 'GPSLongitude', 'latitude', 'longitude'],
      translateValues: false,
      reviveValues: true,
      gps: true,
    })
    if (!data) return fallback
    const latitude = Number(data.latitude ?? data.GPSLatitude)
    const longitude = Number(data.longitude ?? data.GPSLongitude)
    const capturedAt = data.DateTimeOriginal ?? data.CreateDate
    const meta: PhotoMeta = {
      ...fallback,
      date: formatDate(capturedAt instanceof Date || typeof capturedAt === 'string' ? capturedAt : undefined),
      latitude: Number.isFinite(latitude) ? latitude : undefined,
      longitude: Number.isFinite(longitude) ? longitude : undefined,
    }
    if (meta.latitude !== undefined && meta.longitude !== undefined) {
      meta.location = `${meta.latitude.toFixed(4)}°, ${meta.longitude.toFixed(4)}°`
    }
    return meta
  } catch {
    return fallback
  }
}

export async function fillLocation(meta: PhotoMeta, update: (value: { title: string; location: string }) => void) {
  if (meta.latitude === undefined || meta.longitude === undefined) return
  const place = await reverseGeocode(meta.latitude, meta.longitude)
  if (place) update(place)
}
