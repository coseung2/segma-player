# Segma Player Companion (Tauri)

This directory is the Tauri v2 companion manager. It keeps the Rust application
boundary separate from the Svelte 5 frontend:

```text
companion-tauri/
  ui/                 Svelte 5 + TypeScript + Vite frontend
  src-tauri/          Tauri v2 Rust application
```

The window is named `main`, uses the existing Segma Player light visual
direction, and starts at 1280x860 with an 880x560 minimum. The frontend owns
the five shell destinations: Queue, Library, Player, Subtitles, and Settings;
the 232px rail and design tokens remain UI concerns.

## Local development

From the repository root:

```powershell
npm --prefix companion-tauri/ui ci
npm --prefix companion-tauri/ui run build
cargo tauri dev --manifest-path companion-tauri/src-tauri/Cargo.toml
```

The Tauri configuration starts the Vite server at `http://localhost:1420`.
The production frontend output must be `ui/dist`, which is the configured
`frontendDist` path.

## Local checks

From the repository root:

```powershell
cargo fmt --manifest-path companion-tauri/src-tauri/Cargo.toml -- --check
cargo check --manifest-path companion-tauri/src-tauri/Cargo.toml
cargo test --manifest-path companion-tauri/src-tauri/Cargo.toml
npm --prefix companion-tauri/ui run build
```

To build the release executable after building `ui/dist`:

```powershell
cargo build --release --manifest-path companion-tauri/src-tauri/Cargo.toml
```

The raw release output is
`companion-tauri/src-tauri/target/release/aura-media-manager.exe`. The
`aura-media-manager.exe` filename is part of the native-host compatibility
contract: the host resolves this executable as its sibling, and the installer
places it at the installed application root. The crate package remains
`segma-player-tauri` and the library remains `segma_player_tauri`.

The bundle reuses the repository's canonical Segma Player icon at
`../../assets/microsoft-store/source/segma-player.ico` until packaging assets
are moved as part of a later migration phase.

## Current boundary

The single-instance plugin is registered before any other Tauri plugin. When a
second desktop launch is attempted, the existing `main` window is unminimized,
shown, and focused. The Tauri manager currently registers jobs, library,
license, settings, media, subtitle, and system invoke handlers. The native
messaging host remains a separate stdio process and resolves this manager by
the compatibility filename `aura-media-manager.exe` beside itself.

## 0.4.73 verification evidence

The [migration specification](../TAURI_MIGRATION_SPEC.md) is the current status
source. Its 0.4.73 release record reports 43/43 Tauri tests and 69/69 native-host
tests passing. The UI check reported zero errors or warnings, and the Vite
production build passed. The raw release loaded actual local data through its
invoke commands, played and sought a real MP4 through the scoped asset
protocol, generated and loaded a seek-preview JPEG, entered and exited OS PiP,
and passed the single-instance smoke: a second launch exited successfully while
the original responsive window remained the sole manager process.

Inno Setup compiled and installed the 0.4.73 package with the native host,
Tauri manager, ffmpeg, yt-dlp, node, notices, and icon. Retired mpv files and
their directory are absent. Installed manager/native-host hashes equal release;
the installed app passed MP4 playback/seek, thumbnails, PiP, fullscreen exit,
single-instance, and native `show-ui`. Synthetic installed-app checks cover
metadata, move, recycle delete, auto-organize preview, TS remux, GIF export,
sidecar synchronization, and remote subtitle generation. The exact Chrome
popup click, native subtitle import picker, external-player fallback,
uninstall, real multi-speaker diarization, and the remaining live-site matrix
are pending.
