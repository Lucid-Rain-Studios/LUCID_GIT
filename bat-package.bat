@echo off
setlocal EnableDelayedExpansion
title Lucid Git - One-Click Package Installer

cd /d "%~dp0"

echo.
echo ============================================
echo  Lucid Git - Package (Installer Artifacts)
echo ============================================
echo.

where npm >nul 2>&1
if errorlevel 1 (
  echo ERROR: npm is not installed or not on PATH.
  exit /b 1
)

echo [1/4] Installing dependencies...
call npm ci --include=dev
if errorlevel 1 (
  echo ERROR: npm ci failed.
  exit /b 1
)
echo.

echo [2/4] Building app...
call npm run build
if errorlevel 1 (
  echo ERROR: Build failed.
  exit /b 1
)
echo.

echo [3/4] Packaging installer artifacts...
call npm run package
if errorlevel 1 (
  echo ERROR: Packaging failed.
  exit /b 1
)
for /f "tokens=*" %%v in ('node -e "process.stdout.write(require('./package.json').version)"') do set VERSION=%%v
echo.
echo [4/4] Build complete for version: v!VERSION!
echo.
echo Done. Upload these files from Build\ to a GitHub release if doing manual release:
echo   - latest.yml
echo   - Lucid Git-!VERSION!-win-x64.exe
echo   - Lucid Git-!VERSION!-win-x64.exe.blockmap
exit /b 0
