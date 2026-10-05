#!/bin/bash
# Lucid Git - Create App (macOS)
#
# macOS counterpart to bat-createApp.bat. Double-click this file in Finder (or
# run ./mac-createApp.command from a terminal) to build the CURRENT source into
# a runnable "Lucid Git.app". Nothing is installed and no version number is
# changed, so an existing Lucid Git in /Applications is left exactly as it is.

set -uo pipefail

cd "$(dirname "$0")" || exit 1
ROOT="$(pwd)"

# Finder-launched .command files get a minimal PATH, so node from Homebrew or
# nvm would otherwise be invisible.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
fi

finish() {
  echo
  if [ -t 0 ]; then
    read -r -n 1 -s -p "$1 Press any key to close this window..."
    echo
  fi
}

fail() {
  echo "ERROR: $*"
  finish "Build stopped."
  exit 1
}

stop_dev_processes() {
  echo "[preflight] Stopping repo dev processes that can hold node_modules..."
  pkill -f "$ROOT/node_modules/electron/dist/Electron.app" 2>/dev/null
  local vite_pids
  vite_pids="$(lsof -ti tcp:5173 -sTCP:LISTEN 2>/dev/null)"
  if [ -n "$vite_pids" ]; then
    # shellcheck disable=SC2086
    kill $vite_pids 2>/dev/null
  fi
  return 0
}

echo
echo "============================================"
echo " Lucid Git - Create App (macOS)"
echo "============================================"
echo
echo "This builds the CURRENT source into a runnable Lucid Git.app."
echo "Nothing is installed and no version number is changed, so your"
echo "existing Lucid Git install is left exactly as it is."
echo

# -- Preflight: tools ----------------------------------------------------------
command -v node >/dev/null 2>&1 || fail "node is not installed or not on PATH. Install it with 'brew install node@20' or nvm."
command -v npm  >/dev/null 2>&1 || fail "npm is not installed or not on PATH."

# -- Read the version we are building (never modified) --------------------------
VERSION="$(node -e "process.stdout.write(require('./package.json').version)")"
[ -n "$VERSION" ] || fail "Could not read the version from package.json."

# Build for this Mac's architecture only - a universal/dual-arch build doubles
# the packaging time and the other slice would never be run from here.
case "$(uname -m)" in
  arm64)  ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *)      fail "Unsupported architecture: $(uname -m)" ;;
esac

echo "Building version: $VERSION  (unchanged)"
echo "Architecture:     $ARCH"
echo

# -- [1/3] Dependencies ---------------------------------------------------------
# Same reasoning as bat-createApp.bat: skip the slow "npm ci" when node_modules
# is already usable, but catch the missing-TypeScript case that otherwise fails
# with a confusing error further down.
echo "[1/3] Checking dependencies..."
if [ ! -f node_modules/typescript/bin/tsc ] || [ ! -d node_modules/electron/dist/Electron.app ]; then
  echo "       node_modules looks incomplete - running npm ci..."
  stop_dev_processes
  npm ci --include=dev || fail "npm ci failed."
  [ -f node_modules/typescript/bin/tsc ] || fail "npm ci completed, but local TypeScript was not installed. Delete node_modules and run this script again."
else
  echo "       Dependencies present - skipping npm ci."
  echo "       Delete node_modules first if you want a clean reinstall."
fi
echo

# -- [2/3] Compile --------------------------------------------------------------
echo "[2/3] Building main process and renderer..."
npm run build || fail "Build failed."
echo

# -- [3/3] Package as a .app ------------------------------------------------------
# "--mac dir" overrides the dmg target in electron-builder.yml for this run only,
# so the release configuration is untouched and we get a plain .app folder.
# Auto-discovery is disabled so a stray developer certificate in the keychain
# is not picked up; scripts/afterSign.js then applies an ad-hoc signature so
# the app launches.
echo "[3/3] Packaging Lucid Git.app..."
export CSC_IDENTITY_AUTO_DISCOVERY=false
OUT_DIR="$ROOT/Build-app/App_v$VERSION"
rm -rf "$OUT_DIR"

BUILDER_ARGS=(--mac dir "--$ARCH" "--config.directories.output=$OUT_DIR")
# electron-builder.yml points at assets/icon.icns, which is not in the repo.
# The 1024px PNG converts to an .icns automatically, so fall back to it.
if [ ! -f assets/icon.icns ]; then
  BUILDER_ARGS+=("--config.mac.icon=assets/icon.png")
fi

npx electron-builder "${BUILDER_ARGS[@]}" || fail "Packaging failed."

if [ "$ARCH" = arm64 ]; then
  APP_PATH="$OUT_DIR/mac-arm64/Lucid Git.app"
else
  APP_PATH="$OUT_DIR/mac/Lucid Git.app"
fi

if [ ! -d "$APP_PATH" ]; then
  echo "WARNING: Packaging reported success but the expected app is missing:"
  echo "  $APP_PATH"
  echo "Contents of the output folder:"
  ls -1 "$OUT_DIR"
  fail "Expected app not found."
fi

echo
echo "============================================"
echo " Done - v$VERSION"
echo "============================================"
echo
echo "Double-click this to run the build:"
echo "  $APP_PATH"
echo
echo "It runs straight from that folder. Nothing was copied to /Applications,"
echo "and your existing Lucid Git install still points at its own copy."
echo

if [ -t 0 ]; then
  read -r -p "Open it now? (y/N): " LAUNCH
  case "$LAUNCH" in
    [yY]*) echo "Launching..."; open "$APP_PATH" ;;
    *)     open -R "$APP_PATH" ;;
  esac
fi

finish "Done."
exit 0
