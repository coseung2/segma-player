# Aura Media

Aura Media is moving to an extension-commanded, Companion-executed Windows
product. Users start detection, link input, download, playback, and subtitle
actions from the Chrome/Whale/Edge extension; Aura Media Companion performs the
download, playback, or subtitle work and owns persistent state.

The repository still contains the extension-primary implementation during this
migration. Read [PRODUCT_DIRECTION.md](PRODUCT_DIRECTION.md) for target ownership
and [DOCUMENTATION.md](DOCUMENTATION.md) before treating older reports or store
copy as current product documentation.

## Product direction

- **Browser extension:** primary browser interaction surface for detected media,
  page subtitle tracks, link input, Download, Play, and Subtitle commands. It is
  plan-neutral and performs no download, playback, subtitle processing, or file
  management in the target product.
- **Companion:** execution engine for downloads and playback, plus persistent
  jobs, subtitle generation/translation/storage, media and subtitle folders,
  local tools, settings, diagnostics, application lifecycle, General/Pro
  entitlement, and all plan limits.
- **Website/services:** installation, policy, support, and explicitly declared
  remote capabilities.

## Companion manager window

The Companion's own window now lives in this repository as
[companion-gui](companion-gui/README.md), a native Rust binary
(`aura-media-manager.exe`) built with eframe/egui from the exported design
system in [design-system](design-system/README.md).

It is a separate crate from `native-host` so the native messaging host stays a
small stdio process with no GUI dependencies. The installer ships both, and the
host's `--manager` argument launches the window.

The two processes share `%LOCALAPPDATA%\Aura Media\Companion`; there is no IPC
between them. Job state files are the interface, and `settings.json` holds the
one download folder both entry points use.

| Capability | Where it runs |
| --- | --- |
| Cancel, pause, resume, retry | Marker files and the host's `--run-job` |
| Library | Media files listed from the download folder |
| Download folder | `settings.json`, written by either entry point |
| Playback | System default player; an embedded engine is not built yet |

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

The development checkout currently uses the Pro profile in `edition.js`, and
the Chrome Web Store packager replaces it with the audited General profile.
This is transitional code to remove after Companion-side entitlement and limit
enforcement are implemented and verified.

## Current implementation architecture

The following describes the migration baseline on disk, not the completed
Companion-first target.

- `page-media-observer.js` collects bounded MAIN-world evidence from hls.js,
  video.js, Plyr, JWPlayer, Level5, Fetch, and XHR without patching MSE buffers.
- `content.js` reports exact frame playback state and structured iframe layout;
  `candidate-ranking.js` combines that evidence into primary/alternate/ad scores.
- `background.js` owns candidate state, short-lived playback sessions, exact
  request-context leases, and source-frame token refresh. `media-request-context.js`
  makes download and playback select the same observed source context and keeps
  bounded diagnostics free of URL queries and header values.
- `download-worker.js` keeps accepted downloads running in an offscreen document
  and `hls-download.js` refreshes short-lived manifests after 401/403 responses.
- `contextual-hls-loader.js` applies the captured iframe Referer/Origin/Cookie
  context to each manifest, segment, and key request made by the browser player;
  `hls-playback-recovery.js` separates network failures from nonfatal internal
  aborts before consuming Aura's one-shot recovery.
- `save-directory.js` keeps the browser File System Access fallback, while
  `companion-client.js` and `native-file-writer.js` prefer the reviewed Windows
  Companion for local writing when it is available. Progressive/HLS requests
  still originate in the browser so captured request context is preserved.
- The current extension subtitle path prefers a separate HLS audio rendition,
  uploads only that bounded audio input, normalizes it in a CPU Modal function,
  and starts the GPU only for ASR and translation. It is migration code. The
  target Companion/Worker/Modal contract is defined in
  `MODAL_SUBTITLE_INTEGRATION.md`.
- YouTube uses the local Companion first. During migration the notebook server
  remains as a fallback and still accepts only HMAC capability tokens issued by
  the license worker (`/api/youtube-token`).
- Media-route/VPN ownership remains outside this project; the downloader does
  not recreate a second route broker inside the Companion.

The store ZIP excludes private page-key code, static site-specific redirect rules, tests, native source, build scripts, and fixed extension keys.

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
rtk cargo test --manifest-path native-host/Cargo.toml
rtk cargo fmt --check --manifest-path native-host/Cargo.toml
```

Site module selection lives in `sites/<id>/profile.js`, while each site's
deterministic and live-only cases live beside it in `sites/<id>/regressions.js`.
The current fixtures cover the MissAV ad-iframe priority and AV19/Level5
token-session regressions. An opt-in live smoke probe is available with
`npm run monitor:media-sites`; it writes redacted candidate and request
metadata to a versioned, timestamped report under `artifacts/`. Full URL queries,
Cookie values, and Authorization values are never written. The default live target set also permanently
includes the configured AsianPorn, OnlyJerk, Playmogo, and Beeg reproduction
URLs; provider hosts are intentionally not pinned for these rotating live-only
cases. See `MEDIA_PIPELINE_TECHNICAL_REVIEW.md` only for its historical
architecture review and reproduction evidence; it is not the current product
roadmap.

The live monitor prefers the newest unbranded Chromium already present in
`PLAYWRIGHT_BROWSERS_PATH` because it supports unpacked-extension automation.
It falls back to the installed Chrome channel on Windows. Set
`AURA_MONITOR_CHANNEL` or `AURA_MONITOR_EXECUTABLE_PATH` to override detection;
`npm run monitor:media-sites -- --headed` uses a temporary visible profile, and
`--cases=<fixture-id>` runs one configured target.

Use `--adblock=auto`, `--adblock=on`, `--adblock=quiet`,
`--adblock=site-allow`, or `--adblock=off` to load the separate Aura AdBlock
extension in the same temporary profile. Auto mode applies each fixture's
recorded recommendation; the other modes test full blocking, reduced page
intervention, a per-site exception, or a global-off control. Add
`--report=<path>` to keep each matrix result separately.
Add `--autoplay` only for an explicit playback probe; normal monitoring remains
detection-only. `--allow-blocked` keeps scheduled monitoring green only when
all non-passing results are explicitly environment-blocked; the JSON still
records `rawOk: false`.

For Cloudflare or Turnstile cases, `--headed --wait-for-challenge=180` brings
the temporary browser forward and pauses for one user verification. It never
automates CAPTCHA interaction; after the challenge disappears, playback,
detection, and reporting resume automatically.

Load the repository root as an unpacked browser connector for development. In
the current migration baseline, File System Access/browser fallbacks remain
available when the Companion is absent. With the Companion installed, YouTube
and local file writing prefer the native path and save under
`Downloads\\Aura Media`. `npm run build:dev-staging` refreshes
the audited Pro directory under `artifacts/chrome-web-store/staging-pro` on any
Node-supported platform and intentionally creates no ZIP.

## Browser connector store package — migration baseline

The Companion-first listing/rebrand is on hold while the primary application is
implemented. The commands below reproduce the current extension-primary package
for testing or an explicitly scoped maintenance release; they do not authorize
publishing its legacy listing copy as the new product.

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

## Companion implementation — migration foundation

`com.aura.media_companion` is the reviewed Native Messaging bridge. YouTube jobs
are detached into Companion job-runner processes so downloads can continue if
the browser or native bridge restarts. Each local YouTube job gets a small
Windows progress window, and `--manager` opens the persistent download manager
view. Job state is stored under the user's local Aura Media Companion directory.

```powershell
rtk pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-companion-installer.ps1 `
  -ChromeExtensionId "<published-chrome-store-id>" `
  -EdgeExtensionId "<published-edge-addons-id>" `
  -ToolsDirectory "<reviewed-tools-directory>" `
  -SignToolName "<configured-inno-sign-tool>"
```

Code signing, HTTPS hosting, store account registration, support contact, legal publisher details, and final policy URLs remain publisher-owned release prerequisites.

## Authorized use

Use Aura Media only for media you own or are authorized to download. Neither
the Companion nor its browser connector grants rights to third-party content or
claims to bypass DRM, authentication, paywalls, or private-video controls.
