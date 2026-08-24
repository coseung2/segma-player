# Companion UI

Front end for Aura Media Companion, built from the exported design system in
`../design-system`. It talks to the existing Rust native host over the same JSON
request/reply envelope the browser extension already uses.

```
companion-ui/
  index.html            shell markup, strict CSP, no inline script
  styles/tokens.css     copied verbatim from design-system/tokens/tokens.css
  styles/app.css        component styles, tokens only
  scripts/model.js      pure view model, no DOM
  scripts/transport.js  WebView2 bridge and fixture replay
  scripts/render.js     DOM rendering
  scripts/app.js        state, events, polling
  fixtures/jobs.json    recorded payloads for preview and tests
```

Tests live in `../companion-ui.test.mjs` and run with the repo's `npm test`.

## How it reaches the backend

Every request name is a kind that `run_native_host` already matches on:

| UI action | Request | Reply used |
| --- | --- | --- |
| Poll connection | `status` | protocol, version, toolsReady, downloadsFolder, entitlementOwner, licenseConfigured |
| Poll jobs | `list-jobs` | `jobs[]` serialized from `JobState` |
| Cancel a job | `cancel-job` | ok / error |
| Open folder | `open-folder` | ok / error |
| Add link, step 1 | `youtube-info` | title, qualities |
| Add link, step 2 | `youtube-download` | accepted, jobId |

Polling runs every 2 seconds. A failed poll keeps the last good job list on
screen and marks the rail as offline, because clearing the list would make a
transient disconnect look like lost history.

## Transport modes

`scripts/transport.js` picks a mode at startup:

- **WebView2** when `window.chrome.webview` exists. Requests are posted as
  `{ type, requestId, ...payload }` and replies are matched by `requestId`, so
  the Rust side can forward them straight into its existing dispatch.
- **Fixture** otherwise. `fixtures/jobs.json` is replayed so the UI can be
  opened in a plain browser. Preview mode says so in a banner rather than
  pretending to be live.

To preview locally, serve this folder over loopback and open `index.html`. ES
modules will not load from `file://`.

## What the backend does not expose yet

These are backend gaps, not missing UI work:

- **Playback.** There is no file-read or stream command, so the player stage is
  a labeled placeholder. Pointing a `<video>` at a Windows path from the WebView
  would fail as a silent black frame, which is worse than saying so.
- **Pause and resume.** Only `cancel-job` exists. The design system has a Paused
  chip; nothing emits it, and no pause button is rendered.
- **Retry.** No retry command, and re-sending `youtube-download` with a used job
  id is not supported. Failed jobs show the host's reason with no retry action.
- **Per-file reveal.** `open-folder` opens the shared downloads folder only.
- **Settings writes.** No settings command, so Settings is read-only. The
  license key is reported as configured or missing, never edited here.
- **Non-YouTube links.** `youtube-download` is the only link command, so the
  Add link field rejects other hosts and points at the extension instead of
  failing later in the native layer.
- **Library metadata.** Library is derived from completed download jobs that
  wrote a file. There is no media scan, duration, or thumbnail, so tiles show a
  format placeholder instead of a frame.

## To wire this into the companion

1. Host a WebView2 window in the Rust manager path (`--manager`) and load
   `index.html` from the installed app directory.
2. In the WebView message handler, parse `{ type, requestId, ... }`, run the
   same match arms `run_native_host` uses, and post the reply back with the same
   `requestId`.
3. Ship this folder with the installer, next to `tools/`.

No file here changes extension or native-host behavior today.
