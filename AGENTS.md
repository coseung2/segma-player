# Development package version policy

Whenever a source change is handed off through the development package, increment
`manifest.json`'s version before building `staging-pro` or the development ZIP.

Use a three-part numeric version `major.minor.patch`:

- Increment `patch` by one for each changed development handoff.
- At `patch` 100, reset it to `0` and increment `minor`.
- At `minor` 10, reset it to `0` and increment `major`.

Examples: `0.3.33` -> `0.3.34`, `0.3.99` -> `0.4.0`, and
`0.9.99` -> `1.0.0`.

Do not increment a development version for a verification-only rebuild with no
source changes. When the user explicitly requests a development ZIP, build with
`scripts/build-dev-package.ps1` after the version is updated so the staging folder
and served ZIP have the same version. Otherwise run `npm run build:dev-staging`
to refresh `artifacts/chrome-web-store/staging-pro` without creating a ZIP.

## Incident and regression policy

Read `INCIDENTS.md` before changing code for a bug. Every bug fix must be
recorded there using an existing incident ID when it is the same root cause;
do not create duplicate incidents for repeated symptoms.

For each incident, record the exact reproduction path, browser and extension
version, affected surface, confirmed root cause, changed files, regression test,
staging version, and real-browser verification result. Keep speculation separate
from confirmed evidence.

Never mark an incident resolved from unit tests alone. Use
`CODE-FIXED / LIVE-UNVERIFIED` until the actual Chrome/Whale user path has been
retested. For media work, check detection, link input, YouTube, subtitle, tab
switching, and Aura AdBlock on/off when those surfaces are in scope.

Before a new patch, compare it with the incident timeline and existing failed
attempts. Do not repeat a prior fix without explaining why the previous fix did
not cover the failing path. Add or strengthen a regression test before handoff.

After source changes, increment the manifest patch version and copy the changed
files directly into `artifacts/chrome-web-store/staging-pro`. Do not create a
ZIP unless the user explicitly asks. Update `INCIDENTS.md` immediately with the
test result and remaining live-verification gap.

## Site QA policy

Use `SITE_QA_LOG.md` for real site behavior. Do not describe a site as
supported from `npm test` or a deterministic fixture alone. Record each live
check by extension version, browser/channel, site ID, AdBlock/VPN mode, surface,
status, failure reason, and evidence path.

Keep `detect`, `playback`, `progressive-probe`, `extension-download`,
`subtitle`, and `overlay` as separate surfaces. A live smoke result proves only
the surfaces it actually ran; untested download or subtitle behavior must be
`NOT_RUN`.

Site results are append-only. When a site changes behavior between versions,
add a new versioned entry and preserve the previous result. New sites require a
fixture, deterministic regression assertion, live smoke evidence, and a
`SITE_QA_LOG.md` entry. Update the site log after every real-browser check and
before calling a site regression resolved.

## Media module repair boundary

For a failure reported on one site, start in `sites/<site-id>/profile.js` and
`sites/<site-id>/regressions.js`. A site profile may select downloader and
provider modules, but must not implement transport, token, key, or file-writing
logic.

Provider-specific extraction and authentication belong in `providers/`.
Progressive, HLS, and DASH preparation and saving belong in `downloaders/` and
the shared media engine. Do not change a common downloader for a site-local
failure unless the same transport failure is reproduced on another unrelated
site or a protocol-level defect is demonstrated by a focused fixture.

Keep site fixes narrow: update the site profile or its selected provider first,
add the failing site fixture beside that profile, then run the provider,
downloader, site-regression, and full suites before handoff.
