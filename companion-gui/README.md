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
| Play | Load the file into the embedded mpv player and resume saved progress |
| Delete | Move the library file to the Windows Recycle Bin (`SHFileOperationW` with `FOF_ALLOWUNDO`) after an in-window confirmation |
| Reveal file | `explorer.exe /select,<file>` so a tile's file is highlighted in the folder |
| Read library | List media files, folders, watch progress, favorites, and 0–5 ratings |
| Organize library | Create/rename folders and move files by menu or drag/drop without overwriting |
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
- Each tile carries a `⋯` toggle: `폴더에서 보기` highlights the file in
  Explorer, and `삭제` moves it to the recycle bin behind a confirmation
  dialog, keeping a mistaken tap recoverable. On volumes without a recycle bin
  (for example some USB drives) the shell deletes permanently instead.

Subtitle sidecars, `.part` files, and subfolders are excluded: the listing is
non-recursive and limited to media extensions.

## Design fidelity

`theme.rs` mirrors `design-system/tokens/tokens.json` exactly, and a test
asserts the key values plus the absence of a blue accent. Figma renders in
Inter; this window uses Segoe UI with Malgun Gothic loaded as a Hangul
fallback, so glyph metrics differ slightly from the frames.

## Remaining backend boundaries

These are backend gaps, not missing UI work. The Settings view states each one
rather than showing a control that would fail:

- **Adding links.** `youtube-download` needs the host's stdio channel, which
  this process does not own. Downloads start from the browser extension.
- **Library metadata.** The app generates and caches a local 16:9 frame with
  the bundled ffmpeg. Duration and resolution metadata are not shown yet.
- **Subtitle pause.** Subtitle work runs remotely with no resume point, so those
  rows offer cancel only.

## Playback

Completed files play inside the manager through the bundled `mpv.exe`, embedded
in a child Win32 surface. The controller uses JSON IPC for play/pause, seeking,
volume, speed, subtitle visibility and track selection. Seek-hover previews are
generated by the bundled ffmpeg worker. Output is full range; the range control
can leave source detection automatic or force 16–235 / 0–255 interpretation.

Player tools also include subtitle timing in 0.1-second steps, fit/fill/stretch,
A–B repeat, frame stepping, and a nonblocking A–B GIF export. GIF output uses a
single ffmpeg palette pipeline, is capped at 30 seconds, and is written through
a temporary file before the final name appears. Playback position is stored in
`library-state.json`; 95% watched is completed, while explicit watched state,
favorites, and ratings remain independently filterable.

The player process uses no terminal window and the manager opens no HTTP
listener. IPC is polled without a blocking reader thread so a quiet player
cannot prevent later commands such as `loadfile`.
