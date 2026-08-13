# Aura Media Downloader

Chrome Manifest V3 extension and Windows native companion for detecting compatible media resources and saving media the user is authorized to download.

## Editions

| Capability | General | Pro |
| --- | --- | --- |
| Concurrent media jobs | 1 | 3 |
| Per-download byte limit | 1 GiB | No artificial cap |
| YouTube tab | Not included in the store General edition | Direct Pro distribution only |

The development checkout uses the Pro profile in `edition.js`. The Chrome Web Store packager always replaces it with the audited General profile.

## Architecture

- `content.js` and `background.js` detect compatible progressive and HLS resources.
- `download-worker.js` keeps accepted downloads running in an offscreen document.
- `hls-download.js` streams data and enforces the active edition limits.
- `com.aura.media_companion` writes local files and runs supported public YouTube downloads.
- The notebook YouTube server accepts only HMAC capability tokens issued by the
  license worker (`/api/youtube-token`); free tokens are quota- and
  rate-limited, Pro tokens require an approved key, and the server enforces a
  global daily cap, queue cap, and disk guard.
- The commercial runtime has no VPN, proxy, private egress, or private native bridge dependency.

The store ZIP excludes private page-key code, static site-specific redirect rules, tests, native source, build scripts, and fixed extension keys.

## Development

```powershell
rtk npm test
rtk cargo test --manifest-path native-host/Cargo.toml
rtk cargo fmt --check --manifest-path native-host/Cargo.toml
```

Load the repository root as an unpacked extension for development. Because the manifest intentionally contains no fixed `key`, use the extension ID shown by `chrome://extensions` when installing the local companion:

```powershell
rtk pwsh -NoProfile -ExecutionPolicy Bypass -File .\install-media-companion.ps1 `
  -ExtensionId "<32-character-extension-id>" `
  -ToolsArchive "<authorized-tools-archive.zip>"
```

The tools archive must contain `tools/ffmpeg/ffmpeg.exe`, `tools/yt-dlp.exe`, and `tools/node.exe`. Do not redistribute third-party binaries until their provenance, build configuration, and license notices have been reviewed.

## Chrome Web Store package

Dry-run package with the Pro link disabled:

```powershell
rtk pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-store-package.ps1
```

Release package after the HTTPS upgrade page exists:

```powershell
rtk pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-store-package.ps1 `
  -UpgradeUrl "https://example.com/aura-media/pro"
```

The deterministic ZIP is written under `artifacts/chrome-web-store`. Follow `STORE_SUBMISSION_CHECKLIST.md` before upload.

## Companion installer

The commercial Windows installer template uses Inno Setup 6 and requires a reviewed redistributable tools directory containing `THIRD_PARTY_NOTICES.txt`:

```powershell
rtk pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-companion-installer.ps1 `
  -ExtensionId "<published-store-id>" `
  -ToolsDirectory "<reviewed-tools-directory>" `
  -SignToolName "<configured-inno-sign-tool>"
```

Code signing, HTTPS hosting, store account registration, support contact, legal publisher details, and final policy URLs remain publisher-owned release prerequisites.

## Authorized use

Use the extension only for media you own or are authorized to download. It does not grant rights to third-party content and the store edition does not claim to bypass DRM, authentication, paywalls, or private-video controls.
