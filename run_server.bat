@echo off
chcp 65001 > nul
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo [1/3] 가상환경을 만듭니다...
    python -m venv .venv
    echo [2/3] 패키지를 설치합니다...
    ".venv\Scripts\python.exe" -m pip install --upgrade pip
    ".venv\Scripts\python.exe" -m pip install -r requirements.txt
)

echo [3/3] 서버를 시작합니다. 종료하려면 Ctrl+C 를 누르세요.
".venv\Scripts\python.exe" run_server.py
pause
