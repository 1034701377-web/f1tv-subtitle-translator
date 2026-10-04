@echo off
setlocal
cd /d "%~dp0"
set "F1_NODE="
if exist "%~dp0runtime\node.exe" set "F1_NODE=%~dp0runtime\node.exe"
if not defined F1_NODE for /f "delims=" %%N in ('where node 2^>nul') do if not defined F1_NODE set "F1_NODE=%%N"
if not defined F1_NODE (
  echo Node.js was not found. Use the Windows portable ZIP, or install Node.js 22+ for a source checkout.
  goto failed
)
"%F1_NODE%" -e "if (!(Number(process.versions.node.split('.')[0]) >= 22)) { console.error('Node.js 22 or later is required.'); process.exit(1); }"
if errorlevel 1 goto failed
"%F1_NODE%" "%~dp0scripts\start.mjs" %*
if errorlevel 1 goto failed
exit /b 0
:failed
if not "%F1TV_NO_PAUSE%"=="1" pause
exit /b 1
