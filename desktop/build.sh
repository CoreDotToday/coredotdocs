#!/usr/bin/env bash
# 데스크톱 앱 빌드: 백엔드(PyInstaller) + 프런트엔드(Next standalone) → resources/ → electron-builder
#   ./build.sh            현재 OS용 설치 파일 (mac: dmg, win: nsis, linux: AppImage) → dist/
#   ./build.sh dir        설치 파일 없이 실행 가능한 폴더만 (빠름) → dist/mac-arm64/… 등
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(cd .. && pwd)
# OUT_DIR=dist-next ./build.sh : 실행 중인 앱(dist/)을 건드리지 않고 다른 폴더에 만든다 (끝나면 dist로 바꿔 넣는다)
OUT_DIR="${OUT_DIR:-dist}"
EB_OUT=(--config.directories.output="$OUT_DIR")


if [ ! -f build/icon.png ]; then
  echo "▶ 0/3 앱 아이콘 (scripts/make-icon.mjs)"
  (cd "$ROOT/frontend" && node "$ROOT/desktop/scripts/make-icon.mjs" "$ROOT/desktop/build/icon.png")
fi

echo "▶ 1/3 백엔드 (PyInstaller)"
"$ROOT/backend/scripts/build-desktop.sh"
rm -rf resources/skills && mkdir -p resources/skills && cp -R "$ROOT/skills/." resources/skills/
rm -rf resources/backend && mkdir -p resources/backend
cp -R "$ROOT/backend/dist/editor-server" resources/backend/

echo "▶ 2/3 프런트엔드 (Next standalone; API 주소는 실행 때 주입)"
(cd "$ROOT/frontend" && pnpm install --silent && NEXT_PUBLIC_API_URL= pnpm build >/dev/null)
rm -rf resources/web && mkdir -p resources/web/.next
cp -R "$ROOT/frontend/.next/standalone/." resources/web/
cp -R "$ROOT/frontend/.next/static" resources/web/.next/static
cp -R "$ROOT/frontend/public" resources/web/public

echo "▶ 3/3 Electron 패키징"
pnpm install --silent
export CSC_IDENTITY_AUTO_DISCOVERY=false
case "${1:-}" in
  dir) pnpm exec electron-builder --dir "${EB_OUT[@]}" ;;
  win) pnpm exec electron-builder --win "${EB_OUT[@]}" ;;
  linux) pnpm exec electron-builder --linux "${EB_OUT[@]}" ;;
  mac|*)
    if [[ "$(uname)" == "Darwin" ]]; then
      pnpm exec electron-builder --dir "${EB_OUT[@]}"   # 서명·provenance 정리는 afterPack 훅(scripts/after-pack.js)
      for APP in "$OUT_DIR"/mac*/*.app; do
        [ -d "$APP" ] && scripts/make-dmg-mac.sh "$APP" "$OUT_DIR/$(basename "$APP" .app | tr ' ' '-')-$(node -p "require('./package.json').version")-$(uname -m).dmg"
      done
    else
      pnpm exec electron-builder "${EB_OUT[@]}"
    fi ;;
esac
# macOS 서명·provenance 정리는 scripts/after-pack.js(electron-builder afterPack 훅)에서 한다.
# Developer ID로 서명하려면 MAC_SIGN_IDENTITY="Developer ID Application: ..." 를 주면 된다 (공증은 별도).
echo "→ $OUT_DIR/"
