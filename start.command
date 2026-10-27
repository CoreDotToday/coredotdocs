#!/bin/bash
# macOS Finder에서 두 번 클릭하면 Docker로 띄우고 브라우저를 연다.
cd "$(dirname "$0")" && ./start.sh
echo; read -r -p "창을 닫으려면 Enter를 누르세요 (내리기: ./start.sh stop) "
