# Aura Media product direction

## Status

This is the repository-level product boundary for the current architecture.
The primary desktop implementation is `companion-tauri/` (Tauri v2, Svelte 5,
TypeScript, HTML video, and Rust commands). The former `companion-gui/`
egui/eframe source remains legacy and is retained for rollback and comparison
pending installed verification and explicit user-approved deletion.

The codebase is in cutover verification. A statement below describes current
ownership or implementation unless it is explicitly marked as a pending gate.
The 0.4.73 release, installer build, installed binary parity, installed app
smoke, and native `show-ui` have passed. User-profile Chrome/Whale reload,
native import-picker, external-player, uninstall, real multi-speaker
diarization, and remaining live-site gates stay separate. See
[TAURI_MIGRATION_SPEC.md](TAURI_MIGRATION_SPEC.md) for the status matrix and
acceptance gates.

Current backend checkpoint: the Companion owns download jobs, playback, and
subtitle work. The browser extension migration target is intentionally narrow:
detect media in the current browser tab and send link/download intent to the
Companion. Browser playback and subtitle-generation UI and runtime are not part
of the extension surface.

## Product model

### Aura Media Companion — execution core

The Windows Companion performs the actual work and owns:

- the primary user interface and settings;
- persistent download jobs, history, retry, pause, resume, and cancellation;
- local media tools and post-processing;
- native file selection and writing;
- application updates, diagnostics, and future account/license surfaces;
- General/Pro entitlement, feature availability, job concurrency, byte limits,
  quality policy, and upgrade surfaces;
- media playback, player windows, playback history, and player settings;
- subtitle extraction/import, ASR, translation, synchronization, storage, and
  playback-track management.

`companion-tauri/` is the current implementation of this execution core. Its
Rust command layer retains the existing disk-backed data contract. Playback in
the new package uses HTML `<video>` with Tauri asset URLs; mpv and embedded
HWND surfaces are retired from the new implementation. Bundled ffmpeg remains
available at `tools/ffmpeg/ffmpeg.exe` for local media operations.

### Browser extension — primary browser entry point

The user starts browser-related actions from the Chrome/Whale/Edge extension.
It is the detection and command surface that connects the current browser to the
Companion. It should own only browser-bound capabilities and user intent:

- current-tab and frame media detection;
- browser-authenticated request preparation and short-lived request context;
- the detected-media tab and candidate selection;
- link input for page or media URLs;
- Download actions that send bounded commands to the Companion;
- Companion connection and installation status.

The extension must not become a second desktop application. New persistent job
management, product dashboards, updater behavior, durable download history,
media playback, and subtitle workflows belong in the Companion.

In the target product, the extension does not execute or save downloads, play
media, generate or translate subtitles, or save subtitle files. Any browser-side
download engine, browser player, subtitle pipeline, queue, file-system UI, or
browser-download fallback in the current repository is transitional migration
code and must not be exposed by the extension UI.

The extension must also remain plan-neutral. It must not decide General versus
Pro entitlement, enforce paid limits, advertise plan-specific downloader
behavior, or become the authority for license state. It may display capability
information returned by the Companion only when that information is needed for
the browser-to-app handoff.

### Website and services — supporting surfaces

The website provides installation, policy, support, and release information.
Remote services are used only where the product contract explicitly requires
them. Local work must not silently become a cloud upload path.

## Security and protocol boundary

- The Companion must not scrape browser cookie databases or browser profiles.
- The extension sends only the minimum user-requested, time-bounded context
  needed for a job.
- Native Messaging messages require a versioned schema, capability negotiation,
  bounded payloads, and redacted diagnostics.
- Browser-origin authentication and token refresh stay in the extension when
  they cannot be safely transferred.
- DRM, paywall, login, private-video, or other access-control bypass is outside
  the product boundary.

The extension and `native-host/` remain compatibility boundaries. Native
Messaging continues to use `com.aura.media_companion` over stdio, the installed
manager filename remains `aura-media-manager.exe`, and the Tauri app retains
`%LOCALAPPDATA%\Aura Media\Companion`, job markers, `settings.json` including
`downloadFolder`, library metadata, subtitle sidecars, and the default
`Downloads\Aura Media` location.

## Migration rules

1. Keep the extension's bounded detection and Companion handoff working while
   cutover verification is incomplete. Retained extension-primary download or
   player code is compatibility reference, not the future product center.
2. Move durable state and user-facing job control to the Companion before
   reducing the extension UI.
3. Move General/Pro entitlement and every plan limit to the Companion, then
   remove extension-side edition enforcement and plan-specific store claims.
4. Stabilize and test the extension–Companion protocol before moving individual
   downloader responsibilities.
5. Verify Chrome and Whale independently; both may appear as Chrome to tooling.
6. Do not publish new Companion-first store claims until the implementation and
   real-browser behavior match them.

## Primary interaction flow

```text
User browsing in Chrome/Whale/Edge
  -> extension detects media or accepts a pasted link
  -> user clicks Download in the extension
  -> extension sends a bounded command and browser context
  -> Companion downloads and owns the resulting job
  -> Companion owns progress, retry, history, playback, subtitle folders, and plan policy
```

The Companion can still be opened directly for job, folder, player, and settings
management, but browser media discovery and link-command entry remain centered
in the extension. The current desktop window for this flow is the Tauri app;
the former egui manager is removed from the current tree and retained only in
the verified source backup.

## Playback implementation and verification

The new package's player decision is complete: `companion-tauri/` uses HTML
`<video>` with the scoped Tauri asset protocol, custom controls, subtitle cue
rendering for supported sidecars, seek preview, fullscreen, OS PiP capability,
and external-player fallback. mpv integration and embedded HWND surfaces are
not part of the new package.

The remaining acceptance work preserves the original migration requirements:

1. Route detected candidates and extension link input through bounded
   Companion commands; do not copy a browser profile or scrape cookie stores.
2. Preserve short-lived authenticated playback through bounded session or
   request context when the browser supplies it.
3. Verify progressive, HLS, DASH, token refresh, tab switching, Chrome, and
   Whale behavior before claiming broad browser playback support.
4. Keep TS remux, thumbnails, GIF export, ASS rendering, and authenticated
   remote subtitle retrieval as separately reported surfaces. A release-app
   play/seek or seek-preview result does not close those gates.

## Subtitle migration plan

The concrete Worker/Modal API, authentication, persistence, progress,
cancellation, cleanup, and verification contract is defined in
`MODAL_SUBTITLE_INTEGRATION.md`. The Tauri app now has subtitle capability,
import, synchronization, sidecar-loading, and generation command surfaces;
remote Worker/Modal execution and authenticated retrieval remain pending.

1. Keep versioned subtitle commands for importing an observed subtitle track,
   extracting an audio source, generating ASR, translating, cancelling, and
   retrying.
2. Keep browser-only detection in the extension: text-track URLs, language and
   label metadata, selected media/frame identity, and only the bounded request
   context needed to retrieve an authenticated track.
3. Move audio preparation, ASR/translation orchestration, progress, retry, and
   output validation to Companion-owned jobs. Remote ASR remains an explicit
   service dependency rather than extension execution.
4. Store generated and imported subtitle files through Companion folder policy,
   associate them with the media job, and expose rename, reveal, delete, and
   re-generate actions in the application.
5. Load Companion-owned subtitle tracks in the Companion player, including
   language selection, timing offset, style settings, and external subtitle
   import.
6. Verify existing tracks, generated subtitles, translation, cancellation,
   restart recovery, authenticated sources, Chrome, and Whale before declaring
   the remote subtitle pipeline complete or deleting extension-side legacy
   subtitle code.

## Release status

The 0.4.73 raw Tauri release, Inno Setup installer build/install, installed
binary parity, native `show-ui`, and installed app smoke are verified. The app
evidence covers actual local-data invokes, thumbnails, MP4 play/seek, a seek
preview, OS PiP, fullscreen exit, and single-instance behavior. Synthetic
installed-app checks also cover metadata, move, recycle deletion, TS remux,
GIF export, sidecar synchronization, and remote subtitle generation. The exact
Chrome browser-action popup, native subtitle import picker, external-player
fallback, uninstall, real multi-speaker diarization, and the remaining
live-site matrix stay pending.

The Microsoft Store Companion submission and any Companion-first browser-store
rebrand remain on migration hold. Existing store copy and submission checklists
may still support an explicitly scoped maintenance release of the current
extension-primary product, but must not be reused as Companion-first copy
without review.
