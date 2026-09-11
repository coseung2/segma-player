# Aura Media

Aura Media is an extension-commanded, Companion-executed Windows product.
Users start detection, link input, download, playback, and subtitle actions
from the Chrome/Whale/Edge extension; Aura Media Companion performs the
download, playback, or subtitle work and owns persistent state.

The current desktop implementation is [companion-tauri](companion-tauri/README.md),
using Tauri v2, Svelte 5, TypeScript, Rust commands, and HTML video. Read
[PRODUCT_DIRECTION.md](PRODUCT_DIRECTION.md) for ownership,
[DOCUMENTATION.md](DOCUMENTATION.md) for document authority, and
[TAURI_MIGRATION_SPEC.md](TAURI_MIGRATION_SPEC.md) for the migration contract,
status matrix, and cutover gates.

The repository retains extension-primary source and tests as compatibility
reference; that code is outside the packaged runtime.

## Product direction

- **Browser extension:** free, plan-neutral media detection and link handoff.
  It performs no entitlement checks, download execution, playback, subtitle
  processing, or file management.
- **Companion:** execution engine for downloads and playback, plus persistent
  jobs, subtitle generation/translation/storage, media and subtitle folders,
  local tools, settings, diagnostics, application lifecycle, General/Pro
  entitlement, and all plan limits. The current desktop implementation is
  `companion-tauri/`. A separate experimental cloud agent currently provides
  only a deterministic local mock backend for the file-backed cloud job ABI.
- **Website/services:** installation, policy, support, and explicitly declared
  remote capabilities.

## Companion manager window

The Companion's primary window now lives in this repository as
[companion-tauri](companion-tauri/README.md), a native Tauri v2 application
(`aura-media-manager.exe`) with a Svelte 5 frontend and Rust command layer.
Its five destinations are Queue, Library, Player, Subtitles, and Settings; the
visual token and component reference remains [design-system](design-system/README.md).

The former egui/eframe manager source was removed after the 0.4.73 installed
cutover and is preserved in the verified source backup documented in
`INCIDENTS.md`; it is not part of the current tree. The Tauri
application remains a separate crate from `native-host` so the native messaging
host stays a small stdio process with no GUI dependencies. The installer ships
the host, manager, and separate `aura-media-cloud.exe`; the host's `--manager`
argument continues to launch the Tauri manager.

The host and manager share `%LOCALAPPDATA%\Aura Media\Companion`; there is no
IPC between them. Job state files are the interface, and `settings.json` holds
the one download folder both entry points use. The cloud agent uses an isolated
`cloud-jobs` namespace under the same root and is not wired to the manager UI.

| Capability | Where it runs |
| --- | --- |
| Cancel, pause | Marker files consumed by the host runner |
| Resume, retry, history deletion | Manager commands delegated to the native host |
| Library | Media files listed from the download folder |
| Download folder | Locked, atomically replaced `settings.json`, shared by host and app |
| Playback | HTML `<video>` using the Tauri asset protocol in `companion-tauri/` |
| Experimental cloud jobs | `aura-media-cloud.exe`; local mock provider only |
| General/Pro authentication | App settings; verified against `/api/license` |

[companion-ui](companion-ui/README.md) is an earlier HTML prototype of the same
screens. It is reference material only and is not wired into any runtime.

## Current legacy edition implementation

The table below describes the extension-primary migration baseline. In the
target product, the Companion owns these entitlements and enforcement rules;
the browser connector does not contain General/Pro product logic.

| Capability | General | Pro |
| --- | --- | --- |
| Concurrent media jobs | 1 | Unlimited |
| Per-download byte limit | 1 GiB | No artificial cap |
| YouTube tab | Not included in the store General edition | Direct Pro distribution only |
| AI subtitle generation | Not included | Included |

The development checkout currently uses the Pro profile in `edition.js`, and
the Chrome Web Store packager replaces it with the audited General profile.
This is transitional code to remove after Companion-side entitlement and limit
enforcement are implemented and verified.

## Current implementation architecture

- `page-media-observer.js` and `level5-page-bridge.js` collect bounded
  MAIN-world evidence from supported players and browser requests.
- `content-extraction.js` and `content.js` extract media clues, report frame
  state, and support explicit rescans without downloading or writing files.
- `background.js` composes candidate state/ranking, request evidence, bounded
  player-page resolution, source-token refresh, and Companion command handoff.
- `popup.js` exposes only detection and pasted-link intent. `companion-client.js`
  negotiates the Native Messaging contract with `com.aura.media_companion`.
- The Companion owns jobs, execution, playback, subtitles, folders, settings,
  and General/Pro entitlement. Its Tauri player uses HTML video and owns seek
  preview, fullscreen, and PiP behavior. mpv and embedded HWND surfaces are
  retired from the new package.
- `cloud-agent` defines the separate `cloud-job-v1` process and deterministic
  mock upload/download/delete semantics. Telegram/TDLib, cloud catalog sync,
  and cloud-library UI are not implemented. See
  [CLOUD_STORAGE_ARCHITECTURE.md](CLOUD_STORAGE_ARCHITECTURE.md).

The package graph is declared once in `scripts/store-runtime-files.json` and is
consumed by both development staging and the PowerShell store packager. Each
build validates the complete manifest/import closure, so retained legacy
download worker, browser player, subtitle, license, and file-writer modules
cannot enter the package indirectly. Private page-key code, tests, native
source, build scripts, and fixed extension keys are likewise excluded.

## Development

Bug fixes and regression history are tracked in [INCIDENTS.md](INCIDENTS.md).
Read it before changing a failing path and update it after every handoff.
Real site behavior by extension version, browser, and surface is tracked in
[SITE_QA_LOG.md](SITE_QA_LOG.md); live detection is not treated as proof of
download or subtitle success. The 0.3.76 validation record in
[MEDIA_RECOVERY_VALIDATION.md](MEDIA_RECOVERY_VALIDATION.md) and the completed
0.3.89 refactor record in [MEDIA_MODULE_REFACTOR.md](MEDIA_MODULE_REFACTOR.md)
are historical snapshots. Current site/provider/downloader boundaries are in
[SITE_DOWNLOAD_MODES.md](SITE_DOWNLOAD_MODES.md).

```powershell
rtk npm test
rtk npm run test:media-sites
rtk npm run build:dev-staging
rtk cargo test --locked --manifest-path companion-contract/Cargo.toml
rtk cargo test --locked --manifest-path cloud-agent/Cargo.toml
rtk cargo test --manifest-path native-host/Cargo.toml
rtk cargo fmt --check --manifest-path native-host/Cargo.toml
rtk cargo test --manifest-path companion-tauri/src-tauri/Cargo.toml
rtk npm --prefix companion-tauri/ui run check
rtk npm --prefix companion-tauri/ui run build
```

The extension and Tauri checks above are static or unit checks unless a live
surface is explicitly named. They do not prove installed-app behavior,
browser handoff, ffmpeg execution, PiP, remote subtitles, or live-site QA;
those surfaces remain separately tracked as `NOT_RUN` until exercised.

Site module selection lives in `sites/<id>/profile.js`, while each site's
deterministic and live-only cases live beside it in `sites/<id>/regressions.js`.
The current fixtures cover the MissAV ad-iframe priority and AV19/Level5
token-session regressions. An opt-in live smoke probe is available with
`npm run monitor:media-sites`; it writes redacted candidate and request
metadata to a versioned, timestamped report under `artifacts/`. Full URL
queries, Cookie values, and Authorization values are never written. The
default live target set also permanently includes the configured AsianPorn,
OnlyJerk, Playmogo, and Beeg reproduction URLs; provider hosts are intentionally
not pinned for these rotating live-only cases. See
`MEDIA_PIPELINE_TECHNICAL_REVIEW.md` only for its historical architecture
review and reproduction evidence; it is not the current product roadmap.

The live monitor prefers the newest unbranded Chromium already present in
`PLAYWRIGHT_BROWSERS_PATH` because it supports unpacked-extension automation.
It falls back to the installed Chrome channel on Windows. Set
`AURA_MONITOR_CHANNEL` or `AURA_MONITOR_EXECUTABLE_PATH` to override detection;
`npm run monitor:media-sites -- --headed` uses a temporary visible profile,
and `--cases=<fixture-id>` runs one configured target.

Use `--adblock=auto`, `--adblock=on`, `--adblock=quiet`,
`--adblock=site-allow`, or `--adblock=off` to load the separate Aura AdBlock
extension in the same temporary profile. Auto mode applies each fixture's
recorded recommendation; the other modes test full blocking, reduced page
intervention, a per-site exception, or a global-off control. Add
`--report=<path>` to keep each matrix result separately.
The thin extension monitor is detection-only; playback belongs to Segma Player.
Add `--require-companion` to require a live protocol-compatible Companion with
the `media-download-v1` capability. `--allow-blocked` keeps scheduled
monitoring green only when all non-passing results are explicitly
environment-blocked; the JSON still records `rawOk: false`.
Set `AURA_MONITOR_EXTENSION_ROOT` to verify an exact staging directory instead
of the repository root.

For Cloudflare or Turnstile cases, `--headed --wait-for-challenge=180` brings
the temporary browser forward and pauses for one user verification. It never
automates CAPTCHA interaction; after the challenge disappears, playback,
detection, and reporting resume automatically.

Load the repository root as an unpacked browser connector for development. The
extension detects media and forwards link/candidate downloads to Segma Player;
it does not retain browser download or playback fallbacks. Segma Player saves
under `Downloads\\Aura Media`. `npm run build:dev-staging` refreshes the audited
Pro directory under `artifacts/chrome-web-store/staging-pro` on any
Node-supported platform and intentionally creates no ZIP.

## Browser connector store package

The commands below reproduce the audited Companion-first browser connector.
Historical store listing copy remains separately classified in
`DOCUMENTATION.md` and must be reviewed before publication.

Dry-run package with the Pro link disabled:

```powershell
rtk pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-store-package.ps1
```

Release package after the HTTPS upgrade page exists:

```powershell
rtk pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-store-package.ps1 `
  -UpgradeUrl "https://example.com/aura-media/pro"
```

The deterministic ZIP is written under `artifacts/chrome-web-store`. Follow
`STORE_SUBMISSION_CHECKLIST.md` before upload.

## Companion implementation — migration foundation

`com.aura.media_companion` is the reviewed Native Messaging bridge. YouTube jobs
are detached into Companion job-runner processes so downloads can continue if
the browser or native bridge restarts. Each local YouTube job gets a small
Windows progress window, and `--manager` opens the persistent download manager
view. Job state is stored under the user's local Aura Media Companion directory.

The current Tauri release evidence is recorded in
[TAURI_MIGRATION_SPEC.md](TAURI_MIGRATION_SPEC.md). At version 0.4.73, Tauri
43/43 tests and native-host 69/69 tests passed, the UI check reported zero
errors/warnings, the Vite build passed, and the raw release app exercised
actual local-data invokes, MP4 play/seek, a seek-preview JPEG, OS PiP, and
single-instance behavior. Inno Setup built and installed the 0.4.73 package;
installed manager/native-host hashes match release, retired mpv is absent, and
the installed app passed MP4 play/seek, thumbnails, PiP, fullscreen exit, and
native `show-ui`. User-profile Chrome/Whale reload, destructive library
operations, TS remux, GIF export, sidecar sync, and synthetic remote subtitle
generation have also passed. Chrome Default is loaded with current staging,
but the exact browser-action popup click remains unautomated; native subtitle
import, external-player fallback, uninstall, real multi-speaker diarization,
and the remaining live-site matrix are still separate pending gates.

The installer also builds and ships `aura-media-cloud.exe`. This foundation
supports the file-backed `cloud-job-v1` contract and a deterministic local mock
provider. It is foundation infrastructure rather than a user-facing cloud
feature. Telegram explicitly reports unavailable and Telegram jobs fail closed;
there is no TDLib authentication, remote catalog, or Telegram storage yet.

```powershell
rtk pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-companion-installer.ps1 `
  -ChromeExtensionId "<published-chrome-store-id>" `
  -EdgeExtensionId "<published-edge-addons-id>" `
  -ToolsDirectory "<reviewed-tools-directory>" `
  -SignToolName "<configured-inno-sign-tool>"
```

Code signing, HTTPS hosting, store account registration, support contact, legal
publisher details, and final policy URLs remain publisher-owned release
prerequisites.

## Authorized use

Use Aura Media only for media you own or are authorized to download. Neither
the Companion nor its browser connector grants rights to third-party content or
claims to bypass DRM, authentication, paywalls, or private-video controls.
