#!/usr/bin/env bash
# Docker Compose 플러그인이 없는 환경용. 컴포즈가 있으면 `docker compose up --build`를 쓰면 된다.
#   scripts/run-docker.sh up      # 빌드 + PostgreSQL·백엔드·프런트엔드 기동 (http://localhost:3000)
#   scripts/run-docker.sh down    # 컨테이너 제거 (DB 볼륨은 남긴다)
#   scripts/run-docker.sh logs    # 백엔드·프런트엔드 로그
set -euo pipefail
cd "$(dirname "$0")/.."
NET=hwpx-net
API_URL="${API_URL:-http://localhost:8000}"

up() {
  docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null
  docker build -t hwpx-editor-backend ./backend
  docker build --build-arg "NEXT_PUBLIC_API_URL=$API_URL" -t hwpx-editor-frontend ./frontend
  docker rm -f hwpx-backend hwpx-frontend >/dev/null 2>&1 || true
  if ! docker ps -a --format '{{.Names}}' | grep -qx hwpx-db; then
    docker run -d --name hwpx-db --network "$NET" -v hwpx-pgdata:/var/lib/postgresql/data \
      -e POSTGRES_USER=coredotdocs -e POSTGRES_PASSWORD=coredotdocs -e POSTGRES_DB=coredotdocs postgres:17-alpine >/dev/null
  else
    docker start hwpx-db >/dev/null
  fi
  for _ in $(seq 1 30); do docker exec hwpx-db pg_isready -U coredotdocs >/dev/null 2>&1 && break; sleep 1; done
  docker run -d --name hwpx-backend --network "$NET" -p 127.0.0.1:8000:8000 \
    -e EDITOR_DATABASE_URL=postgresql+psycopg://coredotdocs:coredotdocs@hwpx-db:5432/coredotdocs \
    -e 'EDITOR_CORS_ORIGINS=["http://localhost:3000"]' \
    -e 'EDITOR_ALLOWED_HOSTS=["localhost","127.0.0.1","::1","hwpx-backend"]' hwpx-editor-backend >/dev/null
  docker run -d --name hwpx-frontend --network "$NET" -p 127.0.0.1:3000:3000 -e API_INTERNAL_URL=http://hwpx-backend:8000 hwpx-editor-frontend >/dev/null
  echo "백엔드 http://localhost:8000/api/health · 화면 http://localhost:3000"
}

down() { docker rm -f hwpx-backend hwpx-frontend hwpx-db >/dev/null 2>&1 || true; echo "내렸습니다 (DB 볼륨 hwpx-pgdata는 남아 있습니다)"; }
logs() { docker logs --tail 50 hwpx-backend; docker logs --tail 50 hwpx-frontend; }

case "${1:-up}" in
  up) up ;;
  down) down ;;
  logs) logs ;;
  *) echo "usage: $0 up|down|logs" >&2; exit 2 ;;
esac
