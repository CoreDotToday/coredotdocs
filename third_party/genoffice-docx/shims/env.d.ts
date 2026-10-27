// coredotdocs shim (not from GenOffice): 원본 렌더러의 env.d.ts는 Electron preload(`@genoffice/project-store`)의 window.desktop을 선언한다.
// 우리 셸에는 그 preload가 없으므로 apps/docs/src/renderer가 쓰는 멤버만 선택적으로 선언한다 (font-resolve.ts·i18n/locale.tsx·editor/extensions.ts).
import type { FaceVerticalMetrics } from '../packages/font-metrics/src/metrics'
import type { Lang } from '../packages/i18n/src/index'

declare global {
  interface Window {
    desktop: {
      fontMetrics?: (family: string) => Promise<FaceVerticalMetrics | null>
      onLanguageChanged: (cb: (lang: Lang) => void) => () => void
      copyImageToClipboard?: (dataUrl: string, metaJson?: string) => Promise<boolean>
    }
  }
}

export {}
