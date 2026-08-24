# Aura Media product direction

## Status

This is the repository-level product boundary approved for the next architecture.
The Companion UI and visual system are being designed separately in Figma; this
document does not define screens, components, or visual behavior.

The current codebase is still in migration. A statement below describes target
ownership unless it is explicitly marked as current implementation.

Current backend checkpoint: the versioned subtitle command bridge, Companion
public-URL subtitle runner, durable local state/output, and Worker/Modal remote
cancellation path exist locally. The current extension Subtitle command now
routes to the Companion when it reports a configured license, while retaining
the extension worker only as an absent/unconfigured migration fallback. This is
not deployed or real-browser verified. See `MODAL_SUBTITLE_INTEGRATION.md` for
implemented boundaries and remaining migration work.

## Product model

### Aura Media Companion — execution core

The Windows Companion performs the actual work and should own:

- the primary user interface and settings;
- persistent download jobs, history, retry, pause, resume, and cancellation;
- local media tools and post-processing;
- native file selection and writing;
- application updates, diagnostics, and future account/license surfaces.
- General/Pro entitlement, feature availability, job concurrency, byte limits,
  quality policy, and upgrade surfaces.
- media playback, player windows, playback history, and player settings.
- subtitle extraction/import, ASR, translation, synchronization, storage, and
  playback-track management.

### Browser extension — primary browser entry point

The user starts browser-related actions from the Chrome/Whale/Edge extension.
It is the detection and command surface that connects the current browser to the
Companion. It should own only browser-bound capabilities and user intent:

- current-tab and frame media detection;
- browser-authenticated request preparation and short-lived request context;
- the detected-media tab and candidate selection;
- detection of page-provided subtitle tracks and browser-bound subtitle context;
- link input for page or media URLs;
- Download, Play, and Subtitle actions that send bounded commands to the
  Companion;
- Companion connection and installation status.

The extension must not become a second desktop application. New persistent job
management, product dashboards, updater behavior, or durable download history
belong in the Companion.

In the target product, the extension does not execute or save downloads, play
media, generate or translate subtitles, or save subtitle files. Any browser-side
download engine, browser player, subtitle pipeline, queue, file-system UI, or
browser-download fallback in the current repository is transitional migration
code.

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

## Migration rules

1. Keep the existing extension download path working while the Companion is
   incomplete, but treat it as a transitional fallback rather than the future
   product center.
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
  -> user clicks Download, Play, or Subtitle in the extension
  -> extension sends a bounded command and browser context
  -> Companion downloads, opens the player, or processes subtitles
  -> Companion owns progress, retry, history, media/subtitle folders, and plan policy
```

The Companion can still be opened directly for job, folder, player, and settings
management, but browser media discovery and link-command entry remain centered
in the extension.

## Playback migration plan

1. Define a versioned `play` command beside the download command. The payload
   identifies the selected candidate, media type, page/frame source, title, and
   only the bounded browser context required for playback.
2. Build a Companion player spike covering progressive media, HLS, and DASH;
   seeking, pause/resume, volume, fullscreen, hardware decoding, and failure
   diagnostics are acceptance requirements.
3. Decide the player runtime after the spike. Compare a native engine such as
   libmpv with a WebView-based player using the real authenticated site fixtures;
   do not choose from UI convenience alone.
4. Route both detected candidates and extension link input through Download and
   Play-in-Companion commands.
5. Preserve short-lived authenticated playback through a bounded session or
   request broker. Do not copy a browser profile or scrape cookie databases.
6. Verify progressive, HLS, DASH, token refresh, tab switching, Chrome, and
   Whale before removing the browser player from the extension package.

## Subtitle migration plan

The concrete Worker/Modal API, authentication, persistence, progress,
cancellation, cleanup, and verification contract is defined in
`MODAL_SUBTITLE_INTEGRATION.md`.

1. Define versioned subtitle commands for importing an observed subtitle track,
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
   restart recovery, authenticated sources, Chrome, and Whale before deleting
   the extension-side subtitle pipeline.

## Release status

The Microsoft Store Companion submission and any Companion-first browser-store
rebrand are on migration hold. Existing store copy and submission checklists
may still support an explicitly scoped maintenance release of the current
extension-primary product, but must not be reused as Companion-first copy
without review.
