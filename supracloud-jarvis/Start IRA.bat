@echo off
rem =============================================================================
rem Start IRA.bat — double-click launcher for Windows.
rem Thin wrapper around start-ira.ps1 (the real launcher): checks .env, Postgres,
rem Redis, Ollama, then starts the IRA backend + frontend and opens the dashboard.
rem No secrets live in this file — configuration comes from your local .env.
rem =============================================================================
setlocal
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-ira.ps1"
set EXITCODE=%ERRORLEVEL%

if %EXITCODE% neq 0 (
    echo.
    echo IRA did not start cleanly — see the messages above.
) else (
    echo.
    echo IRA is ready, boss.
)

pause
exit /b %EXITCODE%
