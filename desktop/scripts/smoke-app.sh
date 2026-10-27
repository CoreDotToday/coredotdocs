#!/usr/bin/env bash
# 설치본 스모크 테스트 (설계 문서 04 §8.2-7): 빌드한 앱을 띄워 내장 API가 살아나는지 보고 끝낸다.
#   scripts/smoke-app.sh dist/mac-arm64/coredotdocs.app
set -euo pipefail
APP="${1:?앱 경로}"
PORT=9339
# 이전 실행이 남긴 백엔드(editor-server)가 47371을 잡고 있으면 새 앱은 다른 포트로 물러나고, 밖에서 47371로 묻는 쪽은 옛 프로세스와 이야기한다
if pgrep -f "$APP/Contents/Resources/backend" >/dev/null; then
  echo "이전 백엔드가 남아 있어 끝냅니다"; pkill -f "$APP/Contents/Resources/backend" || true; sleep 1
fi
open -a "$APP" --args --remote-debugging-port=$PORT
ok=0
for i in $(seq 1 90); do
  if curl -fsS http://127.0.0.1:47371/api/health >/dev/null 2>&1 && curl -fsS http://127.0.0.1:47370/ >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
pkill -f "$APP/Contents/MacOS/" || true
sleep 2
pkill -f "$APP/Contents/Resources/backend" || true  # 앱이 정리 못 한 백엔드까지
if [ "$ok" = 1 ]; then echo "smoke OK: 내장 API·웹 응답 (${i}s)"; else echo "smoke FAIL: 90초 안에 응답 없음 (로그: ~/Library/Application Support/coredotdocs/editor.log)"; exit 1; fi
