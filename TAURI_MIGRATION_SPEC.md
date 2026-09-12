# Companion GUI to Tauri v2 migration specification

Status: Phase 6 release, installer, installed-app, synthetic file-operation,
and remote-subtitle cutover verified. The exact Chrome browser-action popup,
native import picker, external-player fallback, uninstall, and real
multi-speaker diarization remain pending.

## 1. Compatibility contract

The migration changes the desktop UI implementation only.

- The browser extension and `native-host` remain unchanged. Native Messaging
  host `com.aura.media_companion`, stdio framing, and the extension protocol are
  compatibility boundaries, not migration work.
- The installed manager filename remains `aura-media-manager.exe`.
- Persisted data locations and schemas remain unchanged: the Companion root is
  `%LOCALAPPDATA%\Aura Media\Companion`; job state, marker files,
  `settings.json` (including `downloadFolder`), library metadata, and subtitle
  sidecars remain disk-compatible. `Downloads\Aura Media` remains the default
  download location when settings do not select another valid folder.
- `tools/ffmpeg/ffmpeg.exe` remains bundled and is used for remux, seek preview,
  thumbnails, and GIF export.
- The new app contains no mpv integration and no HWND player surface. Playback
  uses HTML `<video>` with Tauri asset URLs; unsupported media can use the
  external-player command.

## 2. Actual repository layout

```text
companion-tauri/
  ui/                         Svelte 5 + TypeScript + Vite
    src/App.svelte            five-destination shell
    src/lib/api.ts            invoke wrappers and browser-preview boundary
    src/lib/routes/           Queue, Library, Player, Subtitles, Settings
    src/lib/stores/           jobs, library, player, subtitles, settings, license
  src-tauri/                  Tauri v2 Rust application
    src/main.rs, src/lib.rs
    src/commands/              jobs, library, license, settings, media, subtitles, system
    src/{jobs,library_state,license,media,model,subtitles}.rs
    tauri.conf.json            Vite and bundle configuration
```

The former companion-gui egui/eframe implementation was removed after the
cutover gates passed. Its source-only backup is retained outside the repository
for rollback.

## 3. Implemented command and media surface

`src-tauri/src/lib.rs` registers these Tauri commands:

- Jobs: `list_jobs`, `cancel_job`, `pause_job`, `resume_job`,
  `retry_job`, `resolve_job_output`, and `reveal_job_output`.
- Library: list, metadata update, move, single/batch delete, and auto-organize.
- License/settings: get, verify, remove license; get/update download folder.
- Media: prepare source, open externally, TS-to-MP4 remux, seek preview,
  thumbnail, sidecar subtitle loading, and GIF export.
- Subtitles: capability listing, start/generate, import, and synchronization.
- System: open library folder, reveal file, and recycle file.

The Rust modules read the existing disk contract and validate library-relative
media references. The Svelte API layer invokes them in the desktop runtime and
returns deterministic, non-destructive preview results outside Tauri. This is
implemented source behavior; it is not proof of an installed application.

Media playback is implemented around HTML video, custom controls, subtitle
cue rendering for supported sidecar formats, PiP capability detection, TS
remux, seek previews, and external-player fallback. ASS rendering and
authenticated remote subtitle retrieval remain outside the verified boundary.

## 4. Verification status

| Surface | Status | Evidence / boundary |
| --- | --- | --- |
| Static Rust/UI source | IMPLEMENTED | Current `companion-tauri` source and registered commands. |
| Rust tests | PASS | Tauri 43/43 and native-host 69/69 pass at version 0.4.73. |
| UI browser preview | PASS | Svelte check reports 0 errors/warnings; Vite production build and wide/compact browser preview pass. |
| Native release build | PASS | Raw release `aura-media-manager.exe` builds with the embedded custom protocol. |
| Package build | PASS | Inno Setup 7.1.0 created and installed the 0.4.73 package; upgrade registration reports 0.4.73 and the legacy mpv path is absent. |
| Installed app | PASS | Installed manager/native-host hashes equal release, the installed path launches the embedded UI, and restart/single-instance checks pass. Uninstall remains NOT_RUN. |
| Browser handoff | PARTIAL | Installed native-host `show-ui` and isolated Chrome readiness pass. Chrome Default (`coseung2@gmail.com`) was relaunched with staging 0.4.73 and its service worker is registered; browser policy still prevents automation of the browser-action popup itself. |
| Installed app smoke | PASS | Embedded WebView opened at `http://tauri.localhost`; Queue, Library, Settings, license, and subtitle capability invokes returned actual local data. |
| Playback | PASS, PARTIAL | A real MP4 loaded through the scoped asset protocol, played, sought, and exposed no WebView console error. |
| File operations | PASS, SYNTHETIC | Metadata persistence, move, Recycle Bin delete, and auto-organize preview passed against a generated library; user media was not modified. |
| ffmpeg execution | PASS, SYNTHETIC | Seek preview, thumbnail, TS-to-MP4 remux, and a valid two-second 320px GIF passed. |
| Sidecar subtitles | PASS, SYNTHETIC | SRT discovery, +1 second synchronization, collision-safe save, and rediscovery with language metadata passed. Native import picker remains NOT_RUN. |
| Remote subtitle service | PASS, DEGRADED DIARIZATION | Cloudflare deployment `5c48aeb2-2099-4843-b7a5-656d9df2d89f` and Modal v17 accepted a synthetic installed-Tauri upload and saved WebVTT in 51 seconds. Expired gated-model credentials disable speaker diarization without blocking ASR/translation. |
| PiP | PASS, RELEASE APP | WebView2 entered and exited OS Picture-in-Picture during release-app playback. |
| Single instance | PASS, RELEASE APP | A second launch exited 0 while the first responsive window remained the sole process. |
| Live-site QA | PARTIAL | Isolated Chrome 0.4.71 connected to the installed Companion and Beeg native playback/rescan ran, but all 12 HLS candidates were classified as advertisements and no non-ad primary/download was available. |

## 5. Migration phases

1. Shell: Tauri v2, Svelte 5, tokens, window, and five routes.
2. Rust command layer and frontend invoke wrappers.
3. Queue, Library, Settings, and entitlement UI.
4. HTML video playback, subtitles, PiP, remux, previews, and fallback.
5. Subtitle screen and command integration.
6. Documentation cutover, installed verification, handoff verification, and
   legacy removal decision.

Phases 1-5 source and the Phase 6 package/install/backend cutover are present.
Installed and synthetic evidence closes local startup, playback, PiP,
fullscreen, thumbnail, file-operation, remux/GIF, sidecar-sync, basic remote
subtitle, and single-instance gates. It does not close the exact Chrome popup,
native import picker, external-player, uninstall, real multi-speaker, or
remaining live-site gates.

## 6. Cutover and rollback

Cut over only after a clean native/package build and an installed-app smoke
test covering launch, second launch focus, queue actions, library metadata and
file operations, playback, TS remux/fallback, sidecar subtitles, settings, and
license boundaries. Then separately verify extension handoff in Chrome and
Whale, bundled ffmpeg operations, PiP, remote subtitle behavior where enabled,
and the applicable live-site QA matrix.

The user explicitly approved deletion of legacy companion-gui after successful
installed verification. Rollback means restoring the source-only backup or prior
installed `aura-media-manager.exe` package and retaining the same persisted
data and extension/native-host contracts; do not migrate or rewrite user data
as part of a UI rollback.

## 7. References

- `README.md` — repository implementation status.
- `PRODUCT_DIRECTION.md` — product ownership and compatibility boundary.
- `DOCUMENTATION.md` — document authority map.
- `companion-tauri/README.md` — local source checks and development commands.
