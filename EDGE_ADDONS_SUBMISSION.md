# Microsoft Edge Add-ons release preparation

> [!WARNING]
> Migration hold: this is the extension-primary Edge release plan. The next
> release requires a connector-only review after the Companion becomes the
> primary application. Keep this document as preparation evidence, not as an
> instruction to submit the current package.

Aura Media Downloader uses the same audited Manifest V3 package for Chrome Web Store and Microsoft Edge Add-ons. Do not submit the Pro development package; submit the free-edition ZIP produced by `scripts/build-store-package.ps1`.

## Required owner inputs

- Microsoft Partner Center / Edge Add-ons publisher account
- Published Edge extension ID
- Product, privacy-policy, terms, and support URLs; Companion guide is `https://aura.mdownloader.workers.dev/download`
- Windows code-signing certificate and signing command registered with Inno Setup
- Redistributable `ffmpeg`, `yt-dlp`, Node.js, and `THIRD_PARTY_NOTICES.txt`

## Release sequence

1. Build the free store ZIP with both product URLs:

   `rtk pwsh -NoProfile -File scripts/build-store-package.ps1 -Edition free -UpgradeUrl "[UPGRADE_HTTPS_URL]" -CompanionInstallUrl "https://aura.mdownloader.workers.dev/download" -OutputDirectory "[RELEASE_OUTPUT_DIRECTORY]"`

2. Upload the audited ZIP to the Edge Add-ons draft and obtain the final Edge extension ID.
3. Build and sign the Companion installer with both published extension IDs:

   `rtk pwsh -NoProfile -File scripts/build-companion-installer.ps1 -ChromeExtensionId kniniopdkceodiddkijnddnggdgmjmmo -EdgeExtensionId "[EDGE_EXTENSION_ID]" -ToolsDirectory "[REDISTRIBUTABLE_TOOLS_DIRECTORY]" -OutputDirectory "[SIGNED_INSTALLER_OUTPUT]" -SignToolName "[INNO_SIGN_TOOL_NAME]"`

4. Publish the signed installer, SHA-256 checksum, and third-party license notices on the Companion guide page.
5. Install from the Edge store in a clean Windows account. Verify detection, playback, extension download, Companion status, native save, detached job recovery, and uninstall cleanup independently.

## Current blockers

- Edge extension ID is not assigned yet.
- Inno Setup 6, redistributable tools, and production code-signing inputs are not present in the current verified workspace.

Until these inputs exist, the repository is submission-prepared but neither the Edge listing nor the official Companion installer is publishable.
