// coredotdocs shim (not from GenOffice): `@genoffice/ui`의 React 리본·대화상자는 가져오지 않는다.
// 편집기 핵심(apps/docs/src/renderer)이 `@genoffice/ui`에서 쓰는 순수 함수·상수 두 모듈만 그대로 복사해 다시 내보낸다.
export { BUILTIN_FONT_FAMILIES, fontFamiliesFor, partitionFontFamilies, systemFamiliesBesidesCandidates } from '../packages/ui/src/font-list'
export { WORDART_PRESETS, wordArtStrokePx } from '../packages/ui/src/wordart-presets'
