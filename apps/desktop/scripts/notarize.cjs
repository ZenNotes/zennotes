const path = require('node:path')
const { notarize } = require('@electron/notarize')

module.exports = async function notarizeApp(context) {
  if (context.electronPlatformName !== 'darwin') return

  const requireSigning = process.env.REQUIRE_MAC_SIGNING === 'true'
  const appleId = process.env.APPLE_ID
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD
  const teamId = process.env.APPLE_TEAM_ID

  if (!appleId || !appleIdPassword || !teamId) {
    if (requireSigning) {
      throw new Error(
        'Missing Apple notarization credentials. Set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID.'
      )
    }
    console.log('[notarize] Skipping macOS notarization because Apple credentials are not configured.')
    return
  }

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  )

  console.log(`[notarize] Notarizing ${appPath}`)
  await notarize({
    appPath,
    appleId,
    appleIdPassword,
    teamId
  })
}
