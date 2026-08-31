# Aura Media

Aura Media is moving to an extension-commanded, Companion-executed Windows
product. Users start detection, link input, download, playback, and subtitle
actions from the Chrome/Whale/Edge extension; Aura Media Companion performs the
download, playback, or subtitle work and owns persistent state.

The repository still retains extension-primary source and tests as compatibility
reference during this migration, but that code is outside the packaged runtime.
Read [PRODUCT_DIRECTION.md](PRODUCT_DIRECTION.md) for ownership and
[DOCUMENTATION.md](DOCUMENTATION.md) before treating older reports or store copy
as current product documentation.

## Product direction

- **Browser extension:** free, plan-neutral media detection and link handoff.
  It performs no entitlement checks, download execution, playback, subtitle
  processing, or file management.
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
| Cancel, pause | Marker files consumed by the host runner |
| Resume, retry, history deletion | Manager commands delegated to the native host |
| Library | Media files listed from the download folder |
| Download folder | Locked, atomically replaced `settings.json`, shared by host and app |
| Playback | Embedded mpv surface owned by `aura-media-manager.exe` |
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
  and General/Pro entitlement. Its player stores pose-start bookmarks and owns
  seek preview, fullscreen, and PiP behavior.

The package graph is declared once in `scripts/store-runtime-files.json` and is
consumed by both development staging and the PowerShell store packager. Each
build validates the complete manifest/import closure, so retained legacy
download worker, browser player, subtitle, license, and file-writer modules
cannot enter the package indirectly. Private page-key code, tests, native
source, build scripts, and fixed extension keys are likewise excluded.

## Paddle + USDT Pro payments

The public purchase modal keeps the existing USDT-TRC20 flow and adds Paddle
Checkout as a second payment method. Both providers converge on the same
license records in the `LICENSES` KV namespace; the desktop/extension license
validation contract does not change.

Configure Paddle with two one-time prices matching the existing license
periods, then provide these Worker bindings:

- `PADDLE_CLIENT_TOKEN`: Paddle.js client-side token (`test_...` or `live_...`)
- `PADDLE_PRICE_MONTH`: one-time price ID for the 1-month license
- `PADDLE_PRICE_YEAR`: one-time price ID for the 1-year license
- `PADDLE_WEBHOOK_SECRET`: endpoint secret for webhook signature verification

Create a Paddle notification destination for:

`https://<worker-host>/api/pay/paddle/webhook`

and subscribe it to `transaction.completed`. The Worker verifies the raw
`Paddle-Signature`, matches the transaction to the exact pending order and
expected price, then approves the same Pro license record used by the USDT
path. Browser-side `checkout.completed` is only a UI signal; it never grants
the entitlement by itself.

For sandbox checkout, use a `test_...` client token and sandbox price IDs. For
production, use a `live_...` token, production price IDs, an approved checkout
domain, and the production webhook endpoint secret. Do not commit the webhook
secret to this repository.

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
The thin extension monitor is detection-only; playback belongs to Segma Player.
Add `--require-companion` to require a live protocol-compatible Companion with
the `media-download-v1` capability. `--allow-blocked` keeps scheduled monitoring green only when
all non-passing results are explicitly environment-blocked; the JSON still
records `rawOk: false`.
Set `AURA_MONITOR_EXTENSION_ROOT` to verify an exact staging directory instead
of the repository root.

For Cloudflare or Turnstile cases, `--headed --wait-for-challenge=180` brings
the temporary browser forward and pauses for one user verification. It never
automates CAPTCHA interaction; after the challenge disappears, playback,
detection, and reporting resume automatically.

Load the repository root as an unpacked browser connector for development. The
extension detects media and forwards link/candidate downloads to Segma Player;
it does not retain browser download or playback fallbacks. Segma Player saves under
`Downloads\\Aura Media`. `npm run build:dev-staging` refreshes
the audited Pro directory under `artifacts/chrome-web-store/staging-pro` on any
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
