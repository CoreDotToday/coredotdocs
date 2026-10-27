@echo off
rem Windows: Docker Desktop이 켜져 있어야 한다. 전부 띄운 뒤 브라우저를 연다. 내리기: docker compose down
cd /d "%~dp0"
docker info >nul 2>&1 || (echo Docker Desktop을 켠 뒤 다시 실행하세요. & pause & exit /b 1)
docker compose up --build -d || (pause & exit /b 1)
echo 화면 http://localhost:3000  API http://localhost:8000
start "" http://localhost:3000
pause
