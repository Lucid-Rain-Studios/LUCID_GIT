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
where git >nul 2>&1
if errorlevel 1 (
  echo ERROR: git is not installed or not on PATH.
  exit /b 1
)

echo [0/6] Verifying git working tree is clean...
git diff --quiet
if errorlevel 1 (
  echo ERROR: You have uncommitted changes. Commit or stash them before running patch release.
  exit /b 1
)
git diff --cached --quiet
if errorlevel 1 (
  echo ERROR: You have staged but uncommitted changes. Commit or stash them before running patch release.
  exit /b 1
)
echo.

echo [1/6] Installing dependencies...
call npm ci
if errorlevel 1 (
  echo ERROR: npm ci failed.
  exit /b 1
)
echo.

echo [2/6] Bumping patch version...
call npm version patch
if errorlevel 1 (
  echo ERROR: Version bump failed.
  exit /b 1
)
echo.

echo [3/6] Building + publishing release...
call npm run release
if errorlevel 1 (
  echo ERROR: Release publish failed.
  exit /b 1
)
echo.

echo [4/6] Pushing main branch...
git push origin main
if errorlevel 1 (
  echo ERROR: Failed to push main branch.
  exit /b 1
)
echo.

echo [5/6] Pushing tags...
git push origin --tags
if errorlevel 1 (
  echo ERROR: Failed to push tags.
  exit /b 1
)
echo.

echo [6/6] Patch release complete.
for /f "tokens=*" %%v in ('node -e "process.stdout.write(require('./package.json').version)"') do set VERSION=%%v
echo Published version: v%VERSION%
exit /b 0
