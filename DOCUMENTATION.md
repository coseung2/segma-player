# Documentation map

Use this file to decide which documents are current contracts and which are
historical evidence. A historical document may still be useful, but it is not a
product-direction source of truth.

## Current direction and entry points

- `PRODUCT_DIRECTION.md` — approved Companion-first product ownership.
- `README.md` — repository overview and current implementation status.
- `TAURI_MIGRATION_SPEC.md` — Tauri v2/Svelte 5 layout, compatibility contract,
  command/media inventory, verification status matrix, and rollback criteria.
- `companion-tauri/README.md` — local Tauri source checks and 0.4.73 installed evidence.
- `AGENTS.md` — development, incident, packaging, and live-QA working rules.

`companion-tauri/` is the primary desktop source. The former `companion-gui`
egui/eframe source was removed after installed verification and retained in the
source backup documented by `INCIDENTS.md`. The browser extension and
`native-host/` remain compatibility-bound surfaces and are not replaced by this
UI migration.

## Active implementation contracts

- `REFACTORING_PLAN.md` — in-progress/historical Companion-first refactoring
  order, frozen compatibility contracts, phase gates, progress, and validation
  requirements. It contains user changes, is not updated by this documentation
  cutover, and must not be used to infer the current version.
- `SITE_DOWNLOAD_MODES.md` — browser connector site/provider diagnostic layers
  and the Companion execution boundary.
- `MODAL_SUBTITLE_INTEGRATION.md` — target Companion/Worker/Modal subtitle job
  and security contract.
- `INCIDENTS.md` — append-only incident status and regression history.
- `SITE_QA_LOG.md` — append-only real-browser site evidence.
- `modal/README.md` — current Modal service setup.
- `site/README.md` and `site/design-system.md` — website operation and tokens.
- `design-system/README.md` — exported Figma tokens, components, and screens
  that the manager window is built from.
- `companion-contract/` — persisted job/settings/native-host disk contract.

## Reference material, not a runtime contract

- `companion-ui/README.md` — earlier HTML prototype of the manager screens. It
  is kept for reference and is not wired into any runtime.

## Extension-primary release material

These files reflect the current extension-primary release. They may support an
explicit maintenance release, but require a Companion-first rewrite before a
new product listing or rebrand:

- `STORE_SUBMISSION_CHECKLIST.md`
- `EDGE_ADDONS_SUBMISSION.md`
- `store/STORE_LISTING_EN.md` and `store/STORE_LISTING_KO.md`
- `store/RELEASE_NOTES.md`
- `store/PRIVACY_DISCLOSURE.md`
- `store/SINGLE_PURPOSE_AND_PERMISSIONS.md`
- `TERMS_OF_USE.md` and `PRIVACY_POLICY.md`
- `assets/store-listing/README.md`

## Historical implementation snapshots

- `MEDIA_RECOVERY_VALIDATION.md` — 0.3.76 recovery validation record.
- `MEDIA_PIPELINE_TECHNICAL_REVIEW.md` — extension pipeline review at its stated
  branch and reproduction set.
- `MEDIA_MODULE_REFACTOR.md` — refactor plan and 0.3.89 completion record.

Historical evidence should not be shortened or rewritten into current claims.
Add a new incident, QA entry, or current contract instead.

Static tests, browser preview, native build, installed-app behavior, browser
handoff, bundled ffmpeg, remote subtitles, PiP, and live-site QA are separate
claims. The Tauri migration specification is the current status source of
truth; a green static test or preview does not close the other statuses.
