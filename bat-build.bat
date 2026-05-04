@echo off
setlocal EnableDelayedExpansion
title Lucid Git — Build

cd /d "%~dp0"

echo.
echo  ============================================
echo   Lucid Git Builder
echo  ============================================
echo.

:: ── Install dependencies (including devDependencies) ────────────────────────
echo [1/4] Installing dependencies...
call :stop_dev_processes
call npm ci --include=dev
if %errorlevel% neq 0 (
    echo  ERROR: Dependency install failed.
    pause & exit /b 1
)
if not exist "node_modules\typescript\bin\tsc" (
    echo  ERROR: npm ci completed, but local TypeScript was not installed.
    echo  Delete node_modules and run this script again.
    pause & exit /b 1
)
echo.

:: ── Bump patch version in package.json ──────────────────────────────────────
echo [2/4] Incrementing version...
call npm version patch --no-git-tag-version >nul 2>&1
if %errorlevel% neq 0 (
    echo  ERROR: Failed to increment version.
    pause & exit /b 1
)

:: Read new version for display
for /f "tokens=*" %%v in ('node -e "process.stdout.write(require('./package.json').version)"') do set VERSION=%%v
echo        Version: %VERSION%
echo.

:: ── Compile TypeScript + Vite renderer ───────────────────────────────────────
echo [3/4] Building...
call npm run build
if %errorlevel% neq 0 (
    echo  ERROR: Build failed.
    pause & exit /b 1
)
echo.

:: ── Package with electron-builder ────────────────────────────────────────────
echo [4/4] Packaging...
set CSC_IDENTITY_AUTO_DISCOVERY=false
set OUT_DIR=%~dp0Build-exe\Build_v%VERSION%
call npx electron-builder --win --x64 --config.directories.output="%OUT_DIR%"
if %errorlevel% neq 0 (
    echo  ERROR: Packaging failed.
    pause & exit /b 1
)

echo.
echo  ============================================
echo   Done!  v%VERSION%
echo   Output: %OUT_DIR%
echo  ============================================
echo.
pause
exit /b 0

:stop_dev_processes
echo [preflight] Stopping repo dev processes that can lock node_modules...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; $root=(Resolve-Path '.').Path; Get-Process electron | Where-Object { $_.Path -like ($root + '\node_modules\electron\dist\electron.exe') } | Stop-Process -Force; $vitePid=(Get-NetTCPConnection -LocalPort 5173 -State Listen | Select-Object -First 1 -ExpandProperty OwningProcess); if ($vitePid) { Get-Process -Id $vitePid | Stop-Process -Force }"
exit /b 0
