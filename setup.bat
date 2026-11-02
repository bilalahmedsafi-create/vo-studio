@echo off
rem One-time setup. Needs Python 3.11+ and ffmpeg.
cd /d "%~dp0"
where ffmpeg >nul 2>nul || (echo ffmpeg not found. Install it with:  winget install Gyan.FFmpeg  then open a new terminal. & pause & exit /b 1)
echo L = Light: record + render a job someone already prepared (about 100 MB)
echo F = Full: also process new videos (VO removal + script timing, about 3 GB)
choice /c LF /m "Which install"
if errorlevel 2 (set REQ=requirements.txt) else (set REQ=requirements-light.txt)
python -m venv .venv || (echo Python 3.11 or newer is needed: https://www.python.org/downloads/ & pause & exit /b 1)
.venv\Scripts\python -m pip install --upgrade pip
.venv\Scripts\python -m pip install -r %REQ% || (echo Install failed. & pause & exit /b 1)
if not exist data\jobs mkdir data\jobs
echo.
echo Setup done. Put shared job folders in data\jobs, then double-click start.bat.
pause
