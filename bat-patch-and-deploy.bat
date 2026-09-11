@echo off
setlocal EnableDelayedExpansion
title Lucid Git - Version Release

cd /d "%~dp0"

echo.
echo ============================================
echo  Lucid Git - Version Release (GitHub Actions)
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
  echo Then reopen this window and run this script again.
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
  echo Then reopen this window and run this script again.
  goto :fail
)

echo [preflight] Tool paths:
where git
where node
where npm
echo.

echo [1/7] Switching to main and syncing latest...
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

echo [2/7] Verifying git working tree is clean...
git diff --quiet
if errorlevel 1 (
  echo ERROR: You have uncommitted changes. Commit or stash them before running a release.
  goto :fail
)
git diff --cached --quiet
if errorlevel 1 (
  echo ERROR: You have staged but uncommitted changes. Commit or stash them before running a release.
  goto :fail
)
echo.

:: -- Everything the user has to answer happens before the slow work ----------
:: The build and packaging below take roughly a minute and a half. Asking first
:: means a typo or a change of mind costs nothing, where asking afterwards used
:: to throw that minute and a half away.
echo [3/7] Choosing the new version...
for /f "tokens=*" %%v in ('node -e "process.stdout.write(require('./package.json').version)"') do set CURRENT_VERSION=%%v
echo Current version: !CURRENT_VERSION!
echo Enter the new version as X.Y.Z (for example 1.0.12). A leading "v" is stripped.
set "NEW_VERSION="
set /p "NEW_VERSION=New version: "
if not defined NEW_VERSION (
  echo ERROR: No version entered.
  goto :fail
)
if /i "!NEW_VERSION:~0,1!"=="v" set "NEW_VERSION=!NEW_VERSION:~1!"
echo !NEW_VERSION!|findstr /r /c:"^[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*$" >nul
if errorlevel 1 (
  echo ERROR: "!NEW_VERSION!" is not a valid X.Y.Z version number.
  goto :fail
)
if "!NEW_VERSION!"=="!CURRENT_VERSION!" (
  echo ERROR: !NEW_VERSION! is already the current version.
  goto :fail
)
git rev-parse -q --verify "refs/tags/v!NEW_VERSION!" >nul 2>&1
if not errorlevel 1 (
  echo ERROR: Tag v!NEW_VERSION! already exists locally. Pick a different version.
  goto :fail
)
echo.
echo This will build, then commit !NEW_VERSION!, tag v!NEW_VERSION!, and push to origin/main.
set "CONFIRM="
set /p "CONFIRM=Continue? (Y/N): "
if /i not "!CONFIRM!"=="Y" (
  echo Cancelled. No changes made.
  goto :fail
)
echo.

:: -- Dependencies -------------------------------------------------------------
:: A clean "npm ci" costs about 30 seconds here: 13 to delete the existing
:: 961 MB node_modules and 17 to reinstall from a warm cache. It is skipped when
:: the tree already looks complete, because the artifacts that actually ship are
:: built by GitHub Actions, which does its own clean install from the lockfile.
:: This install only has to be good enough for the local sanity check below.
echo [4/7] Checking dependencies...
call :stop_dev_processes
if not exist "node_modules	ypescriptin	sc" (
  echo        node_modules looks incomplete - running npm ci...
  call npm ci --include=dev
  if errorlevel 1 (
    echo ERROR: npm ci failed.
    goto :fail
  )
  if not exist "node_modules	ypescriptin	sc" (
    echo ERROR: npm ci completed, but local TypeScript was not installed.
    echo Delete node_modules and run this script again.
    goto :fail
  )
) else (
  echo        Dependencies present - skipping npm ci.
  echo        Delete node_modules first if you want a clean reinstall.
)
echo.

:: -- Sanity check before anything is committed --------------------------------
:: This runs ahead of the version bump on purpose. When it ran afterwards, a
:: packaging failure left behind a local commit and tag for a release that never
:: happened, which then had to be unpicked by hand. The version number baked
:: into these artifacts is the old one and that is fine - they are thrown away,
:: and GitHub Actions rebuilds from the tag.
echo [5/7] Package build sanity check...
call npm run package
if errorlevel 1 (
  echo ERROR: Package build failed. Nothing was committed or tagged.
  goto :fail
)
echo.

echo [6/7] Committing and tagging !NEW_VERSION!...
call npm version !NEW_VERSION!
if errorlevel 1 (
  echo ERROR: Version bump failed.
  goto :fail
)
echo.

echo [7/7] Pushing to origin...
git push origin main
if errorlevel 1 (
  echo ERROR: Failed to push main branch.
  goto :fail
)
git push origin --tags
if errorlevel 1 (
  echo ERROR: Failed to push tags.
  goto :fail
)

:: The release workflow triggers on the tag, so a tag that did not reach origin
:: is a silent no-op - the script looks successful and no release ever appears.
git ls-remote --tags origin "refs/tags/v!NEW_VERSION!" | findstr /c:"v!NEW_VERSION!" >nul
if errorlevel 1 (
  echo ERROR: v!NEW_VERSION! was pushed but is not on origin. The release will not trigger.
  echo Push it by hand with:  git push origin refs/tags/v!NEW_VERSION!
  goto :fail
)
echo        Confirmed on origin: v!NEW_VERSION!
echo.

echo ============================================
echo  Release triggered - v!NEW_VERSION!
echo ============================================
echo.
echo Next steps:
echo   1. Open GitHub ^> Actions ^> Release workflow.
echo   2. Wait for the Windows publish job to succeed.
echo   3. Confirm release v!NEW_VERSION! assets include:
echo      - latest.yml
echo      - Lucid Git-!NEW_VERSION!-win-x64.exe
echo      - Lucid Git-!NEW_VERSION!-win-x64.exe.blockmap
echo.
echo Press any key to close this window...
pause >nul
exit /b 0

:fail
echo.
echo Release stopped. Press any key to close this window...
pause >nul
exit /b 1

:stop_dev_processes
echo [preflight] Stopping repo dev processes that can lock node_modules...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; $root=(Resolve-Path '.').Path; Get-Process electron | Where-Object { $_.Path -like ($root + '
ode_modules\electron\dist\electron.exe') } | Stop-Process -Force; $vitePid=(Get-NetTCPConnection -LocalPort 5173 -State Listen | Select-Object -First 1 -ExpandProperty OwningProcess); if ($vitePid) { Get-Process -Id $vitePid | Stop-Process -Force }"
exit /b 0
