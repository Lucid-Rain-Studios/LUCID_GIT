@echo off
setlocal
title Lucid Git - Patch Release

cd /d "%~dp0"

echo.
echo ============================================
echo  Lucid Git - Patch Release
echo ============================================
echo.

where npm >nul 2>&1
if errorlevel 1 (
  echo ERROR: npm is not installed or not on PATH.
  exit /b 1
)

echo [1/4] Installing dependencies...
call npm ci
if errorlevel 1 (
  echo ERROR: npm ci failed.
  exit /b 1
)
echo.

echo [2/4] Bumping patch version...
call npm version patch
if errorlevel 1 (
  echo ERROR: Version bump failed.
  exit /b 1
)
echo.

echo [3/4] Building + publishing release...
call npm run release
if errorlevel 1 (
  echo ERROR: Release publish failed.
  exit /b 1
)
echo.

echo [4/4] Patch release complete.
for /f "tokens=*" %%v in ('node -e "process.stdout.write(require('./package.json').version)"') do set VERSION=%%v
echo Published version: v%VERSION%
exit /b 0
