// electron-builder afterSign hook (mac only).
//
// When no Developer ID identity is configured, electron-builder skips code
// signing entirely — but the Electron binary it started from still carries
// Apple's ad-hoc signature from its own build, which no longer matches the
// resources electron-builder swapped in (icon, asar, Info.plist). That stale,
// mismatched signature is invalid and can make macOS refuse to launch the
// app at all ("code has no resources but signature indicates they must be
// present" from `spctl`). Re-signing ad-hoc here reseals everything so the
// app actually launches; if a real identity WAS used, the app is already
// validly signed and this is a no-op.
const { execFileSync } = require('child_process')
const path = require('path')

module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)

  try {
    execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'ignore' })
    return
  } catch {
    // Not validly signed — fall through and apply an ad-hoc signature below.
  }

  console.log(`[afterSign] No valid code signature found — applying ad-hoc signature to ${appPath}`)
  execFileSync('codesign', ['--deep', '--force', '--sign', '-', appPath])
}
