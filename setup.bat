@echo off
rem One-time setup: Python environment + AI tools (about 3 GB). Needs Python 3.11+ and ffmpeg.
cd /d "%~dp0"
where ffmpeg >nul 2>nul || (echo ffmpeg not found. Install it with:  winget install Gyan.FFmpeg  then open a new terminal. & pause & exit /b 1)
python -m venv .venv || (echo Python 3.11 or newer is needed: https://www.python.org/downloads/ & pause & exit /b 1)
.venv\Scripts\python -m pip install --upgrade pip
.venv\Scripts\python -m pip install -r requirements.txt || (echo Install failed. & pause & exit /b 1)
echo.
echo Setup done. Double-click start.bat to open VO Studio.
pause
