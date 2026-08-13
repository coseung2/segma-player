# Aura Media Downloader

Chrome/Whale Manifest V3 extension for detecting compatible media resources
and saving media the user is authorized to download. Saving runs entirely
inside the extension — no native helper or companion app is required.

## Editions

| Capability | General | Pro |
| --- | --- | --- |
| Concurrent media jobs | 1 | Unlimited |
| Per-download byte limit | 1 GiB | No artificial cap |
| YouTube tab | Not included in the store General edition | Direct Pro distribution only |

The development checkout uses the Pro profile in `edition.js`. The Chrome Web Store packager always replaces it with the audited General profile.

## Architecture

- `content.js` and `background.js` detect compatible progressive and HLS resources.
- `download-worker.js` keeps accepted downloads running in an offscreen document.
- `hls-download.js` streams data and enforces the active edition limits.
- `save-directory.js` keeps a one-time File System Access folder handle so the
  extension writes files itself with 6-way parallel reception
  (`parallel-download.js`) — no native helper is involved.
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

Load the repository root as an unpacked extension for development. No
companion installation is needed; the first download asks for a save folder
once (create a new empty folder under Downloads) and every later download
saves silently with parallel reception.

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

## Legacy companion (optional)

The extension no longer uses the native companion (`com.aura.media_companion`)
for saving. The `native-host/`, `install-media-companion.ps1`, and
`scripts/build-companion-installer.ps1` files remain only as legacy references
for older deployments and are not required by the current runtime.

```powershell
rtk pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-companion-installer.ps1 `
  -ExtensionId "<published-store-id>" `
  -ToolsDirectory "<reviewed-tools-directory>" `
  -SignToolName "<configured-inno-sign-tool>"
```

Code signing, HTTPS hosting, store account registration, support contact, legal publisher details, and final policy URLs remain publisher-owned release prerequisites.

## Authorized use

Use the extension only for media you own or are authorized to download. It does not grant rights to third-party content and the store edition does not claim to bypass DRM, authentication, paywalls, or private-video controls.
