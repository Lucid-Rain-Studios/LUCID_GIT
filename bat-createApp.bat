@echo off
setlocal EnableDelayedExpansion
title Lucid Git - Create Portable App

cd /d "%~dp0"

echo.
echo ============================================
echo  Lucid Git - Create Portable App
echo ============================================
echo.
echo This builds the CURRENT source into a single portable .exe.
echo Nothing is installed and no version number is changed, so your
echo existing Lucid Git install is left exactly as it is.
echo.

:: -- Preflight: tools ---------------------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
  echo ERROR: node is not installed or not on PATH.
  echo If you use nvm for Windows: nvm use 20, then reopen this window.
  goto :fail
)
where npm >nul 2>&1
if errorlevel 1 (
  echo ERROR: npm is not installed or not on PATH.
  goto :fail
)

:: -- Read the version we are building (never modified) -------------------------
for /f "tokens=*" %%v in ('node -e "process.stdout.write(require('./package.json').version)"') do set VERSION=%%v
if not defined VERSION (
  echo ERROR: Could not read the version from package.json.
  goto :fail
)
echo Building version: !VERSION!  ^(unchanged^)
echo.

:: -- [1/3] Dependencies --------------------------------------------------------
:: Unlike the release scripts this does not run "npm ci" every time. A clean
:: reinstall takes minutes and this script is meant to be run repeatedly while
:: testing a change. The check below is the part that actually matters: a
:: node_modules missing its local TypeScript is what makes the build fail with
:: a confusing error further down.
echo [1/3] Checking dependencies...
if not exist "node_modules\typescript\bin\tsc" (
  echo        node_modules looks incomplete - running npm ci...
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
) else (
  echo        Dependencies present - skipping npm ci.
  echo        Delete node_modules first if you want a clean reinstall.
)
echo.

:: -- [2/3] Compile -------------------------------------------------------------
echo [2/3] Building main process and renderer...
call :stop_dev_processes
call npm run build
if errorlevel 1 (
  echo ERROR: Build failed.
  goto :fail
)
echo.

:: -- [3/3] Package as a portable executable -------------------------------------
:: "--win portable" overrides the nsis target in electron-builder.yml for this
:: run only, so the release configuration is untouched. The artifactName
:: override matters: without it the portable build inherits the root pattern and
:: lands on the same filename as the NSIS installer, and the two are very
:: different things to double-click.
echo [3/3] Packaging portable executable...
set CSC_IDENTITY_AUTO_DISCOVERY=false
set "OUT_DIR=%~dp0Build-exe\Portable_v!VERSION!"
call npx electron-builder --win portable --x64 ^
  --config.directories.output="!OUT_DIR!" ^
  --config.portable.artifactName="${productName}-${version}-win-x64-portable.${ext}"
if errorlevel 1 (
  echo ERROR: Packaging failed.
  goto :fail
)

set "APP_EXE=!OUT_DIR!\Lucid Git-!VERSION!-win-x64-portable.exe"
if not exist "!APP_EXE!" (
  echo WARNING: Packaging reported success but the expected file is missing:
  echo   !APP_EXE!
  echo Contents of the output folder:
  dir /b "!OUT_DIR!"
  goto :fail
)

echo.
echo ============================================
echo  Done - v!VERSION!
echo ============================================
echo.
echo Double-click this to run the build:
echo   !APP_EXE!
echo.
echo It runs straight from that file. Nothing was installed, no shortcut was
echo created, and your existing Lucid Git install still points at its own copy.
echo.

set "LAUNCH="
set /p "LAUNCH=Open it now? (Y/N): "
if /i "!LAUNCH!"=="Y" (
  echo Launching...
  start "" "!APP_EXE!"
)

echo.
echo Press any key to close this window...
pause >nul
exit /b 0

:fail
echo.
echo Build stopped. Press any key to close this window...
pause >nul
exit /b 1

:stop_dev_processes
echo [preflight] Stopping repo dev processes that can lock node_modules...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; $root=(Resolve-Path '.').Path; Get-Process electron | Where-Object { $_.Path -like ($root + '\node_modules\electron\dist\electron.exe') } | Stop-Process -Force; $vitePid=(Get-NetTCPConnection -LocalPort 5173 -State Listen | Select-Object -First 1 -ExpandProperty OwningProcess); if ($vitePid) { Get-Process -Id $vitePid | Stop-Process -Force }"
exit /b 0
