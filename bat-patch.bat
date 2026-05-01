@echo off
setlocal EnableDelayedExpansion
title Lucid Git - One-Click Patch Release

cd /d "%~dp0"

echo.
echo ============================================
echo  Lucid Git - Patch Release (GitHub Actions)
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

echo [0/7] Switching to main and syncing latest...
git checkout main
if errorlevel 1 (
  echo ERROR: Failed to checkout main.
  exit /b 1
)
git pull origin main
if errorlevel 1 (
  echo ERROR: Failed to pull latest main.
  exit /b 1
)
echo.

echo [1/7] Verifying git working tree is clean...
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

echo [2/7] Installing dependencies...
call npm ci --include=dev
if errorlevel 1 (
  echo ERROR: npm ci failed.
  exit /b 1
)
echo.

echo [3/7] Bumping patch version...
call npm version patch
if errorlevel 1 (
  echo ERROR: Version bump failed.
  exit /b 1
)
echo.

echo [4/7] Running package build sanity check...
call npm run package
if errorlevel 1 (
  echo ERROR: Package build failed.
  exit /b 1
)
echo.

echo [5/7] Pushing main branch...
git push origin main
if errorlevel 1 (
  echo ERROR: Failed to push main branch.
  exit /b 1
)
echo.

echo [6/7] Pushing tags...
git push origin --tags
if errorlevel 1 (
  echo ERROR: Failed to push tags.
  exit /b 1
)
echo.

echo [7/7] Patch release triggered.
for /f "tokens=*" %%v in ('node -e "process.stdout.write(require('./package.json').version)"') do set VERSION=%%v
echo Version tagged: v!VERSION!
echo.
echo Next steps:
echo   1. Open GitHub ^> Actions ^> Release workflow.
echo   2. Wait for Windows publish job success.
echo   3. Confirm release v!VERSION! assets include:
echo      - latest.yml
echo      - Lucid-Git-!VERSION!-win-x64.exe
echo      - Lucid-Git-!VERSION!-win-x64.exe.blockmap
exit /b 0
