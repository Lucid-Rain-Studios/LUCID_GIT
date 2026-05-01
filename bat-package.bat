@echo off
setlocal
title Lucid Git - Package Installer

cd /d "%~dp0"

echo.
echo ============================================
echo  Lucid Git - Package (Installer)
echo ============================================
echo.

where npm >nul 2>&1
if errorlevel 1 (
  echo ERROR: npm is not installed or not on PATH.
  exit /b 1
)

echo [1/3] Installing dependencies...
call npm ci
if errorlevel 1 (
  echo ERROR: npm ci failed.
  exit /b 1
)
echo.

echo [2/3] Building app...
call npm run build
if errorlevel 1 (
  echo ERROR: Build failed.
  exit /b 1
)
echo.

echo [3/3] Packaging installer artifacts...
call npm run package
if errorlevel 1 (
  echo ERROR: Packaging failed.
  exit /b 1
)
echo.

echo Done. Installer artifacts are available in the Build\ folder.
exit /b 0
