@echo off
setlocal EnableDelayedExpansion
title Lucid Git - One-Click Patch Release

cd /d "%~dp0"

echo.
echo ============================================
echo  Lucid Git - Patch Release (GitHub Actions)
echo ============================================
echo.

where git >nul 2>&1
if errorlevel 1 (
  echo ERROR: git is not installed or not on PATH.
  goto :fail
)
where node >nul 2>&1
if errorlevel 1 (
  echo ERROR: node is not installed or not on PATH.
  echo.
  echo Checked PATH and could not find node.exe. If you use nvm for Windows,
  echo run:
  echo   nvm list
  echo   nvm use 20
  echo.
  echo Then reopen this window and run bat-patch.bat again.
  goto :fail
)
where npm >nul 2>&1
if errorlevel 1 (
  echo ERROR: npm is not installed or not on PATH.
  echo.
  echo Found node here:
  where node
  echo.
  echo If that path is under WindowsApps or Codex, it is not your project Node.js.
  echo Install or repair Node.js 20. If you use nvm for Windows, run:
  echo   nvm list
  echo   nvm use 20
  echo.
  echo Then reopen this window and run bat-patch.bat again.
  goto :fail
)

echo [preflight] Tool paths:
where git
where node
where npm
echo.

echo [0/7] Switching to main and syncing latest...
git checkout main
if errorlevel 1 (
  echo ERROR: Failed to checkout main.
  goto :fail
)
git pull origin main
if errorlevel 1 (
  echo ERROR: Failed to pull latest main.
  goto :fail
)
echo.

echo [1/7] Verifying git working tree is clean...
git diff --quiet
if errorlevel 1 (
  echo ERROR: You have uncommitted changes. Commit or stash them before running patch release.
  goto :fail
)
git diff --cached --quiet
if errorlevel 1 (
  echo ERROR: You have staged but uncommitted changes. Commit or stash them before running patch release.
  goto :fail
)
echo.

echo [2/7] Installing dependencies...
call :stop_dev_processes
call npm ci --include=dev
if errorlevel 1 (
  echo ERROR: npm ci failed.
  goto :fail
)
if not exist "node_modules\typescript\bin\tsc" (
  echo ERROR: npm ci completed, but local TypeScript was not installed.
  echo Delete node_modules and run this script again.
  goto :fail
)
echo.

echo [3/7] Bumping patch version...
call npm version patch
if errorlevel 1 (
  echo ERROR: Version bump failed.
  goto :fail
)
echo.

echo [4/7] Running package build sanity check...
call npm run package
if errorlevel 1 (
  echo ERROR: Package build failed.
  goto :fail
)
echo.

echo [5/7] Pushing main branch...
git push origin main
if errorlevel 1 (
  echo ERROR: Failed to push main branch.
  goto :fail
)
echo.

echo [6/7] Pushing tags...
git push origin --tags
if errorlevel 1 (
  echo ERROR: Failed to push tags.
  goto :fail
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
echo.
echo Press any key to close this window...
pause >nul
exit /b 0

:fail
echo.
echo Patch release stopped. Press any key to close this window...
pause >nul
exit /b 1

:stop_dev_processes
echo [preflight] Stopping repo dev processes that can lock node_modules...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; $root=(Resolve-Path '.').Path; Get-Process electron | Where-Object { $_.Path -like ($root + '\node_modules\electron\dist\electron.exe') } | Stop-Process -Force; $vitePid=(Get-NetTCPConnection -LocalPort 5173 -State Listen | Select-Object -First 1 -ExpandProperty OwningProcess); if ($vitePid) { Get-Process -Id $vitePid | Stop-Process -Force }"
exit /b 0
