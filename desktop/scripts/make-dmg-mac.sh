#!/usr/bin/env bash
# macOS dmg 만들기. electron-builder의 dmg 단계(node)는 provenance 추적 대상이라 이미지 안 파일에 속성이 붙으므로
# 시스템 도구(hdiutil)만 쓰는 launchd 작업으로 만든다. 사용: make-dmg-mac.sh "<path>/Foo.app" "<out>.dmg"
set -euo pipefail
APP=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
OUT=$(cd "$(dirname "$2")" && pwd)/$(basename "$2")
NAME=$(basename "$APP" .app)
WORK=$(mktemp -d /tmp/make-dmg.XXXXXX)
LABEL="today.core.hwpx-dmg.$$"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
cat > "$WORK/job.sh" <<JOB
#!/bin/bash
set -e
mkdir -p "$WORK/stage"
/usr/bin/rsync -rlpt "$APP/" "$WORK/stage/$NAME.app/"
ln -s /Applications "$WORK/stage/Applications"
rm -f "$OUT"
/usr/bin/hdiutil create -quiet -volname "$NAME" -srcfolder "$WORK/stage" -ov -format UDZO "$OUT"
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
for _ in $(seq 1 900); do [ -f "$WORK/done" ] && break; sleep 1; done
[ -f "$WORK/done" ] || { echo "dmg 작업이 끝나지 않았습니다:" >&2; cat "$WORK/err.log" >&2 || true; exit 1; }
rm -rf "$WORK"
echo "dmg: $OUT ($(du -h "$OUT" | cut -f1))"
