#!/usr/bin/env bash
# HWPX AI 협업 편집기 실행기
#   ./start.sh            Docker로 PostgreSQL·백엔드·프런트엔드를 띄우고 브라우저를 연다 (기본)
#   ./start.sh dev        개발 모드: PostgreSQL 컨테이너 + uvicorn(--reload) + next dev (Ctrl+C로 함께 종료)
#   ./start.sh stop       Docker로 띄운 것을 내린다 (DB 볼륨은 남는다)
#   ./start.sh logs       백엔드·프런트엔드 로그
#   ./start.sh test       백엔드·프런트엔드 테스트 (PostgreSQL 컨테이너 필요)
# 환경 변수: API_URL (브라우저가 쓰는 API 주소, 기본 http://localhost:8000 — 다른 PC에서 열 때 바꾼다)
set -euo pipefail
cd "$(dirname "$0")"
MODE="${1:-docker}"
UI_URL="http://localhost:3000"
API_URL="${API_URL:-http://localhost:8000}"

say() { printf '\033[1;34m▶ %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 이(가) 필요합니다. $2"; }
open_browser() { command -v open >/dev/null 2>&1 && open "$UI_URL" || { command -v xdg-open >/dev/null 2>&1 && xdg-open "$UI_URL" || true; }; }
wait_for() {
  local url=$1 label=$2 i
  for i in $(seq 1 120); do
    if curl -fsS "$url" >/dev/null 2>&1; then say "$label 준비됨"; return 0; fi
    sleep 2
  done
  die "$label 이(가) 응답하지 않습니다: $url"
}
has_compose() { docker compose version >/dev/null 2>&1; }

docker_ready() {
  need docker "Docker Desktop을 설치하세요: https://www.docker.com/products/docker-desktop/"
  docker info >/dev/null 2>&1 || die "Docker 데몬이 꺼져 있습니다. Docker Desktop을 켠 뒤 다시 실행하세요."
}

case "$MODE" in
  docker|up)
    docker_ready
    say "이미지를 빌드하고 컨테이너를 띄웁니다 (처음엔 몇 분 걸립니다)"
    if has_compose; then
      NEXT_PUBLIC_API_URL="$API_URL" docker compose up --build -d
    else
      API_URL="$API_URL" scripts/run-docker.sh up
    fi
    wait_for http://localhost:8000/api/health "백엔드"
    wait_for "$UI_URL" "화면"
    say "화면 $UI_URL · API $API_URL · 내리기: ./start.sh stop"
    open_browser
    ;;
  dev)
    docker_ready
    need uv "설치: curl -LsSf https://astral.sh/uv/install.sh | sh"
    need pnpm "설치: corepack enable && corepack prepare pnpm@12 --activate"
    if ! docker ps -a --format '{{.Names}}' | grep -qx coredotdocs-pg; then
      say "PostgreSQL 컨테이너(coredotdocs-pg, 127.0.0.1:5441)를 만듭니다"
      docker run -d --name coredotdocs-pg -e POSTGRES_USER=coredotdocs -e POSTGRES_PASSWORD=coredotdocs -e POSTGRES_DB=coredotdocs -p 127.0.0.1:5441:5432 postgres:17-alpine >/dev/null
    else
      docker start coredotdocs-pg >/dev/null
    fi
    for _ in $(seq 1 30); do docker exec coredotdocs-pg pg_isready -U coredotdocs >/dev/null 2>&1 && break; sleep 1; done
    say "백엔드 (uvicorn --reload, :8000)"
    (cd backend && uv sync --quiet && exec uv run uvicorn app.main:app --port 8000 --reload) &
    BACK=$!
    trap 'say "종료 중"; kill $BACK 2>/dev/null || true; wait $BACK 2>/dev/null || true' EXIT INT TERM
    wait_for http://127.0.0.1:8000/api/health "백엔드"
    say "프런트엔드 (next dev, :3000) — Ctrl+C로 둘 다 종료"
    (sleep 6 && open_browser) &
    cd frontend && pnpm install --silent && exec pnpm dev
    ;;
  stop|down)
    docker_ready
    if has_compose; then docker compose down; else scripts/run-docker.sh down; fi
    ;;
  logs)
    docker_ready
    if has_compose; then docker compose logs --tail 50 backend frontend; else scripts/run-docker.sh logs; fi
    ;;
  test)
    need uv "설치: curl -LsSf https://astral.sh/uv/install.sh | sh"
    need pnpm "설치: corepack enable"
    (cd backend && uv run pytest -q)
    (cd frontend && pnpm install --silent && pnpm test && pnpm typecheck && pnpm lint)
    ;;
  *)
    sed -n '2,8p' "$0"; exit 2 ;;
esac
