@echo off
rem Starts VO Studio on this PC and opens the dashboard.
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (echo Run setup.bat first. & pause & exit /b 1)
start "" http://localhost:8790
.venv\Scripts\python.exe -m vo_studio.server
pause
