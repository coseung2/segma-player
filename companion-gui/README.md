# Companion manager window

Native Rust GUI for Aura Media Companion, built from the exported design system
in `../design-system`. Binary name: `aura-media-manager.exe`.

Separate crate from `native-host` on purpose. The native messaging host is a
small stdio process that Chrome spawns; it stays free of GUI dependencies. This
crate owns the window and is launched by the Start Menu shortcut.

```
companion-gui/
  src/theme.rs     design tokens ported from Figma, the only place colors live
  src/jobs.rs      reads job state files, writes cancel markers, opens folders
  src/model.rs     view models: status tones, labels, byte and progress format
  src/widgets.rs   pieces matching the Figma components
  src/app.rs       window state, the four views, polling
  src/main.rs      entry point
```

Run `cargo test` in this folder. Everything except `widgets.rs` and the window
shell is covered; the view models and job reading have no egui dependency.

## How it reaches the backend

There is no IPC. The manager and the native host are separate processes that
share `%LOCALAPPDATA%\Aura Media\Companion\jobs`:

| Action | Mechanism |
| --- | --- |
| Read jobs | Parse every `*.state.json`, newest first, capped at 100 |
| Cancel | Write `{job_id}.cancel`, which the host's download loop polls every 250 ms |
| Pause | Write `{job_id}.pause`; the loop stops but keeps yt-dlp's `.part` file |
| Resume / retry | Clear both markers, mark the job queued, then run the host's `--run-job` on the persisted `{job_id}.request.json` |
| Play | Hand the file to the system's default player |
| Read library | List media files in the download folder |
| Open folder | `explorer.exe` on the configured download folder |

State files are polled every 900 ms. A partially written file is skipped and
retried on the next poll rather than failing the whole list. A failed read keeps
the last good list on screen and marks the rail, because clearing it would make
a transient error look like lost history.

This binary opens no network listener.

## One download folder, two entry points

The folder lives in `settings.json` under `downloadFolder`, beside the license
key the host already owns. Both sides read it and both validate it
independently: absolute path, no `..` segments, no control characters. A
malformed value falls back to `%USERPROFILE%\Downloads\Aura Media` rather than
being trusted.

Changing it in Settings writes that one value, so the extension and this window
cannot end up saving to different places. Writes are read-modify-write, so the
license key survives a folder change.

## Library is the folder, not the history

The Library view lists media files present in the download folder. Job records
only supply a nicer title and media type when one matches by file name.

- A file moved or deleted outside the app disappears from the list.
- A file dropped into the folder by hand appears, tagged `기록 없음`.
- The on-disk size wins over a job's recorded byte count.
- Completed jobs whose file is gone are counted and explained in the header
  instead of silently vanishing.
- Playback is offered only when the file is actually there, so a stale
  "completed" record cannot produce a button that fails.

Subtitle sidecars, `.part` files, and subfolders are excluded: the listing is
non-recursive and limited to media extensions.

## Design fidelity

`theme.rs` mirrors `design-system/tokens/tokens.json` exactly, and a test
asserts the key values plus the absence of a blue accent. Figma renders in
Inter; this window uses Segoe UI with Malgun Gothic loaded as a Hangul
fallback, so glyph metrics differ slightly from the frames.

## What the backend does not expose yet

These are backend gaps, not missing UI work. The Settings view states each one
rather than showing a control that would fail:

- **In-window playback.** `재생` hands the file to the system's default player.
  A libmpv surface inside this window is not built yet.
- **Per-file reveal.** `폴더 열기` opens the folder, not the file's position in
  it; the host has no per-file reveal.
- **Adding links.** `youtube-download` needs the host's stdio channel, which
  this process does not own. Downloads start from the browser extension.
- **Library metadata.** No duration, resolution, or thumbnail. Rows show the
  file name and size only.
- **Subtitle pause.** Subtitle work runs remotely with no resume point, so those
  rows offer cancel only.

## Playback direction

Stage one ships: completed files open in the system player.

Stage two is an embedded surface. WebView2 was rejected for playback because it
is Chromium, so codec coverage depends on OS packs, frame-accurate seeking is
unreliable, and subtitles are limited to WebVTT. libmpv is the intended engine
since the installer already ships ffmpeg under `tools/`, so it would add one dll
rather than a new runtime dependency.
