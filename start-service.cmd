@echo off
setlocal
title F1 TV Subtitle Translator
cd /d "%~dp0"
chcp 65001 >nul
where node >nul 2>&1
if errorlevel 1 (
  echo Please install Node.js 22.16 or later from https://nodejs.org/
  pause
  exit /b 1
)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a<22||(a===22&&b<16)?1:0)"
if errorlevel 1 (
  echo Please update Node.js to 22.16 or later.
  pause
  exit /b 1
)
node server.mjs --open
if errorlevel 1 pause
