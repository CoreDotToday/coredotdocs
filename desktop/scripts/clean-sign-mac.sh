#!/usr/bin/env bash
# macOS: 빌드한 .app에서 com.apple.provenance 속성을 떼고 ad-hoc 서명한다.
# 이 속성은 내려받은 앱(iTerm2 등)에서 시작한 프로세스가 만든 파일에 자동으로 붙고 xattr로 지워지지 않으며,
# 붙어 있으면 Gatekeeper가 ad-hoc 서명 앱을 "손상됨"으로 막는다. launchd가 띄운 프로세스는 추적되지 않으므로
# 임시 LaunchAgent로 복사(--no-xattrs)와 서명을 수행한다. 사용: clean-sign-mac.sh "<path>/Foo.app"
set -euo pipefail
APP=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
[ -d "$APP" ] || { echo "앱이 없습니다: $APP" >&2; exit 1; }
# 서명은 electron-builder가 Electron 전용 entitlements로 이미 했을 수 있다. 유효하면 건드리지 않는다
# (codesign --deep로 프레임워크까지 다시 서명하면 Electron이 초기화 중 SIGTRAP으로 죽는다).
ensure_signed() {
  if codesign --verify --deep --strict "$1" >/dev/null 2>&1; then echo "서명 유효: $1"; else codesign --force --deep --sign - "$1" && echo "ad-hoc 서명: $1"; fi
}
tagged=$(find "$APP" -xattrname com.apple.provenance 2>/dev/null | wc -l | tr -d ' ')
if [ "$tagged" = "0" ]; then
  ensure_signed "$APP"
  exit 0
fi
echo "provenance 속성이 붙은 파일 $tagged개 → launchd 작업으로 깨끗한 복사본을 만듭니다"
WORK=$(mktemp -d /tmp/clean-sign.XXXXXX)
LABEL="today.core.hwpx-clean-sign.$$"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
cat > "$WORK/job.sh" <<JOB
#!/bin/bash
set -e
# cp·tar·ditto는 provenance를 메타데이터로 함께 복사하므로 rsync(-X 없이)로 내용만 복사한다.
# 디렉터리 생성·이름 바꾸기도 추적되는 셸이 아니라 이 launchd 작업 안에서 한다 (최상위 .app 디렉터리까지 깨끗해야 한다).
rm -rf "$APP.clean"
/usr/bin/rsync -rlpt "$APP/" "$APP.clean/"
/usr/bin/codesign --verify --deep --strict "$APP.clean" || /usr/bin/codesign --force --deep --sign - "$APP.clean"
rm -rf "$APP"
mv "$APP.clean" "$APP"
touch "$WORK/done"
JOB
chmod +x "$WORK/job.sh"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$LABEL</string>
<key>ProgramArguments</key><array><string>/bin/bash</string><string>$WORK/job.sh</string></array>
<key>RunAtLoad</key><true/>
<key>StandardErrorPath</key><string>$WORK/err.log</string>
</dict></plist>
PL
cleanup() { launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true; rm -f "$PLIST"; }
trap cleanup EXIT
launchctl bootstrap "gui/$(id -u)" "$PLIST"
for _ in $(seq 1 600); do [ -f "$WORK/done" ] && break; sleep 1; done
[ -f "$WORK/done" ] || { echo "launchd 작업이 끝나지 않았습니다. 로그: $WORK/err.log" >&2; cat "$WORK/err.log" >&2 || true; exit 1; }
rm -rf "$WORK"
left=$(find "$APP" -xattrname com.apple.provenance 2>/dev/null | wc -l | tr -d ' ')
codesign --verify --deep --strict "$APP"
echo "완료: provenance 남은 파일 $left개, 서명 검증 OK → $APP"
