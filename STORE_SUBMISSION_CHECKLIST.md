# Aura Media Downloader Chrome Web Store submission checklist

This checklist is the release gate for the commercial store distribution. Bracketed values are owner-supplied prerequisites; do not submit while any required placeholder remains.

## Owner prerequisites

| Required item | Owner value / evidence |
| --- | --- |
| Chrome Web Store developer account and current developer-account fee status | `[OWNER INPUT: DEVELOPER_ACCOUNT_EMAIL_OR_ID]` / `[OWNER INPUT: ACCOUNT_FEE_STATUS]` |
| Publisher display name and legal publisher name | `[OWNER INPUT: PUBLISHER_DISPLAY_NAME]` / `[OWNER INPUT: LEGAL_PUBLISHER_NAME]` |
| Support email | `[OWNER INPUT: SUPPORT_EMAIL]` |
| Privacy-policy HTTPS URL | `[OWNER INPUT: PRIVACY_POLICY_HTTPS_URL]` |
| Terms-of-use HTTPS URL | `[OWNER INPUT: TERMS_OF_USE_HTTPS_URL]` |
| Upgrade URL | `[OWNER INPUT: UPGRADE_URL]` |
| Product website | `[OWNER INPUT: PRODUCT_WEBSITE_URL]` |
| Primary language, category, visibility, and distribution countries | `[OWNER INPUT: LISTING_DISTRIBUTION_CHOICES]` |
| Store screenshots and promotional images | Prepared under `assets/store-listing`; owner visual approval required |
| Chrome Web Store extension ID | `kniniopdkceodiddkijnddnggdgmjmmo` |
| Microsoft Edge Add-ons extension ID | `[OWNER INPUT: EDGE_EXTENSION_ID]` |
| Native companion code-signing certificate | `[OWNER INPUT: CERTIFICATE_THUMBPRINT_AND_SIGNING_OWNER]` |
| Hosted native companion installer URL | `[OWNER INPUT: NATIVE_INSTALLER_HTTPS_URL]` |
| Published companion download/tool license notices | `[OWNER INPUT: COMPANION_LICENSE_URLS]` |

Each published extension ID is needed to write the final `allowed_origins` entries in the separately hosted native-host manifest. The native installer must be code-signed and must register `com.aura.media_companion` for the exact Chrome and/or Edge published origins; it is not part of either extension-store ZIP.

## Build and artifact gate

- [ ] Replace the upgrade URL when building the release package:

  `rtk pwsh -NoProfile -File scripts/build-store-package.ps1 -UpgradeUrl "[OWNER INPUT: UPGRADE_URL]" -OutputDirectory "[OWNER INPUT: RELEASE_OUTPUT_DIRECTORY]"`

- [ ] Confirm the packager prints `STORE_PACKAGE_OK`, the intended version, the ZIP path, and no placeholder warning.
- [ ] Run `rtk node --test store-package.test.mjs`.
- [ ] Run `rtk npm test` and record the full result; focused store verification is not a substitute for the full suite.
- [ ] Run `rtk git diff --check`.
- [ ] Inspect the ZIP contents. It must contain only the explicit extension-runtime allowlist and must not contain tests, README files, source-control files, native-host files, private bridge files, or build output.
- [ ] Confirm the ZIP has no `personalvpn`, `com.personalvpn`, fixed private extension key, static site-specific redirect rule, or private media-route bridge. The bundled `level5-page-bridge.js` and `level5-key-error.js` are allowed: the bridge reuses the page player's cached key and loader paths, with no runtime asset discovery, dynamic JavaScript import, runtime decoder, WebAssembly, or other remote code execution.
- [ ] Confirm `edition.js` in the ZIP exports `PRODUCT_EDITION = "free"` and the free plan has exactly one concurrent job, 1 GiB per download, YouTube up to 1080p, and tab-switch pause.
- [ ] Confirm Pro benefits remain visible in the product UI/listing and are not represented as free-plan capabilities.

## Prepared graphic assets

- Store icon: `icons/icon128.png` — 128×128 canvas with the required transparent padding.
- Required screenshot: `assets/store-listing/screenshot-01-free-plan.png` — 1280×800.
- Required small promo tile: `assets/store-listing/promo-small.png` — 440×280.
- Optional marquee tile: `assets/store-listing/promo-marquee.png` — 1400×560.
- Optional demonstration video: publisher-hosted YouTube URL, if desired.
- [ ] Publisher visually approves the final images before upload.

## Manifest and permission gate

- [ ] Manifest is MV3, branded Aura Media Downloader, versioned with a valid Chrome Web Store version, and contains no `key` field.
- [ ] Manifest contains no static `declarative_net_request` rule resource and no static site-specific redirect rule.
- [ ] Content scripts contain exactly the bundled `level5-page-bridge.js` at `world: "MAIN"`, `run_at: "document_start"`, followed by the isolated `content.js` detector at `run_at: "document_start"`; there are no other content-script entries.
- [ ] Permissions match `store/manifest.json` and the justifications in `store/SINGLE_PURPOSE_AND_PERMISSIONS.md`; remove any permission not required by the current runtime before release.
- [ ] The background runtime uses the `com.aura.media_companion` native messaging name.

## Listing and privacy gate

- [ ] Copy `store/STORE_LISTING_EN.md` and `store/STORE_LISTING_KO.md` into the store listing fields.
- [ ] Keep the single-purpose and permission explanations in `store/SINGLE_PURPOSE_AND_PERMISSIONS.md` available for review notes.
- [ ] Complete `store/PRIVACY_DISCLOSURE.md` and the Chrome Web Store privacy questionnaire consistently with `PRIVACY_POLICY.md`.
- [ ] Publish `PRIVACY_POLICY.md` at the owner’s HTTPS policy URL and publish `TERMS_OF_USE.md` at the owner’s HTTPS terms URL.
- [ ] Add only owner-approved screenshots/promotional images. Do not show private development paths, VPN branding, private bridge names, or unsupported claims.
- [ ] Use `store/RELEASE_NOTES.md` for the version-specific release notes.
- [ ] Do not claim DRM bypass, universal compatibility, or authorization to download third-party copyrighted media.

## Companion release gate

- [ ] Build and sign the Windows companion with the owner’s code-signing certificate.
- [ ] Host the installer and any required tools at the owner’s HTTPS installer URL with checksums and license notices.
- [ ] Generate the native-host manifest with the exact Chrome origin `chrome-extension://kniniopdkceodiddkijnddnggdgmjmmo/` and, when Edge distribution is enabled, the exact published Edge extension origin.
- [ ] Test installation for a clean Windows user account and confirm current-user-only registration; do not require HKLM or claim that the extension installs the companion automatically.
- [ ] Verify the companion can perform local writing through `com.aura.media_companion`, run a detached YouTube job after the browser closes, restore that active job after browser restart, cancel it, and open the `--manager` download window.

## Submission and post-upload gate

- [ ] Upload only the audited ZIP from the release output directory; never upload the repository root or a development unpacked folder.
- [ ] Record the store draft/version URL and owner reviewer.
- [ ] Complete the store review questionnaire truthfully, including host access, native messaging, data handling, and permissions.
- [ ] After publication, install from the store using a clean browser profile, test detection, a small authorized progressive download, an authorized HLS sample, and the free-plan limits.
- [ ] Test the separately hosted companion installer against the published extension ID before announcing availability.
- [ ] Record the published version, store ID, installer URL, checksums, policy URL, support contact, and rollback owner.
