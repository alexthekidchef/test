@echo off
cd /d %~dp0
echo Starting Amtrak Board server...
where py >nul 2>nul
if %errorlevel%==0 (
  py server.py
) else (
  where python >nul 2>nul
  if %errorlevel%==0 (
    python server.py
  ) else (
    echo Python is not installed or not on PATH.
    echo Install Python 3 from python.org and check "Add python to PATH".
    pause
    exit /b 1
  )
)
pause
