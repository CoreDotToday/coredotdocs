// Rendering policy only: leave model URLs and original relationship XML intact
// so opening or editing text never silently embeds/removes a linked picture.
const blockedSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80" viewBox="0 0 240 80"><rect width="240" height="80" fill="#f1f5f9" stroke="#94a3b8"/><text x="120" y="44" text-anchor="middle" font-size="16" fill="#475569">외부 그림 차단됨</text></svg>'
export const BLOCKED_IMAGE_SOURCE = `data:image/svg+xml,${encodeURIComponent(blockedSvg)}`

export function safeImageSource(value: unknown): string {
  if (typeof value !== 'string') return BLOCKED_IMAGE_SOURCE
  // Package images are base64 or encoded SVG. Reject CSS-breaking characters
  // too because this helper also feeds picture fills and picture bullets.
  if (/^data:image\/(?:png|jpeg|jpg|gif|bmp|webp|svg\+xml|x-icon|tiff)(?:;base64)?,/i.test(value) && !/["\\\r\n<>]/.test(value)) return value
  if (/^blob:/i.test(value)) {
    try { if (typeof location !== 'undefined' && new URL(value).origin === location.origin) return value } catch { /* Block malformed sources. */ }
  }
  return BLOCKED_IMAGE_SOURCE
}

export function imageSourceAttrs(value: unknown): Record<string, string> {
  const src = safeImageSource(value)
  return src === BLOCKED_IMAGE_SOURCE
    ? { src, 'data-cdd-external-image': 'blocked', alt: '외부 그림 차단됨', title: '개인정보 보호를 위해 외부 그림을 불러오지 않습니다. 원본 문서의 연결은 저장 시 유지됩니다.' }
    : { src }
}
