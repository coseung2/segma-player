# Companion–Modal subtitle integration

## Status and scope

This document defines the target subtitle execution contract for the
Companion-first product. It is based on the current Cloudflare Worker and Modal
implementation, but the caller and durable job owner move from the extension to
Aura Media Companion.

The extension remains the browser interaction surface. It detects media and
page-provided subtitle tracks and sends the user's Subtitle command to the
Companion. It never calls Modal, stores a Modal secret, runs ASR/translation, or
saves generated subtitle files.

## Local implementation checkpoint (2026-08-24)

The backend foundation now includes:

- a strict extension helper for the version-1 `subtitle.create` Native
  Messaging command; caller-selected request IDs, license keys, cookies,
  headers, and media bytes are rejected before a native connection;
- a Companion detached public-URL runner with durable state, bounded responses,
  three-second polling, a thirty-minute deadline, remote cancellation, WebVTT
  validation, and atomic save under `Downloads\Aura Media\Subtitles`;
- Companion-owned entitlement input from `%LOCALAPPDATA%\Aura Media\Companion\settings.json`;
- Cloudflare `DELETE /api/subtitles?id=<jobId>` and Modal
  `DELETE /cancel/<jobId>` cancellation paths.
- approved-Companion authentication on status polling as well as create/cancel,
  plus public-DNS pinning with proxy and automatic redirect suppression before
  Modal downloads a URL input.
- per-job owner binding in the Worker using a 24-hour SHA-256 license
  fingerprint, so another approved key cannot inspect or cancel the job;
- cancellation-race handling that preserves an already completed VTT and does
  not report success when remote cancellation failed;
- Windows atomic state replacement, collision-safe subtitle output allocation,
  and two-hour cleanup of crash-left active URL request files;
- App-owned routing: the free extension only detects media and hands it to the
  installed app. Library subtitle creation starts in the app, and the Native
  Host reads only the app-approved Pro entitlement.

There is no extension-side license or subtitle-worker fallback. General/Pro is
an app product state: General keeps detection, downloading, playback, and the
library available; Pro unlocks AI subtitle creation. A rejected or expired key
remains blocked by both the app gate and the Worker.

The temporary settings contract is:

```json
{
  "licenseKey": "AM-<36 uppercase hex characters>",
  "licenseEdition": "pro",
  "licenseStatus": "approved",
  "licenseExpiresAt": null,
  "licenseDevices": 1,
  "licenseLimit": 3
}
```

Only the installed app and Native Host read this file. The extension command
and job state never contain the key. A future hardening pass can move the key
to a Windows-protected secret store without changing the app-owned entitlement
contract.

## Existing service contract to reuse

The current asynchronous path is:

```text
extension
  -> https://aura.mdownloader.workers.dev/api/subtitles
  -> Cloudflare Worker validates Pro and rate limits
  -> Worker adds MODAL_ASR_TOKEN
  -> Modal /submit or /submit-audio
  -> Modal FunctionCall job
  -> Worker GET /api/subtitles?id=<jobId>
  -> Modal /result/<jobId>
  -> translated WebVTT result
```

Current verified limits and behavior:

- source languages: Japanese (`ja`) and English (`en`);
- target language: Korean (`ko`);
- Japanese ASR: `litagin/anime-whisper`;
- English ASR: `openai/whisper-large-v3-turbo`;
- translation: `google/translategemma-12b-it`;
- maximum processed duration: 60 minutes per subtitle job (longer local and
  remote media inputs are limited to the first 60 minutes);
- binary audio upload limit: 80 MiB;
- accepted upload types: octet-stream, AAC/MP4/MPEG/OGG audio, and MPEG-TS;
- progress phases: `queued`, `extracting-audio`, `transcribing`, `translating`,
  and `finalizing`;
- result: WebVTT plus model/source metadata;
- speaker diarization: `pyannote/speaker-diarization-community-1` assigns
  stable `화자 1`, `화자 2`, ... labels to translated cues using exclusive
  speaker turns; WebVTT carries them as standard `<v ...>` voice spans and the
  result includes `speakers` plus `speakerCount` metadata;
- unfinished jobs are polled asynchronously; uploaded Modal audio files are
  removed in job cleanup and stale files are pruned after two hours.

The current extension additionally limits returned VTT to 2 MiB, polls every
three seconds for up to thirty minutes, and caches generated VTT for seven days.
Those are migration baselines, not immutable Companion product limits.

## Target ownership

| Component | Responsibility |
| --- | --- |
| Extension | Detect media/text tracks, collect user intent, identify page/tab/frame source, and send a bounded local command |
| Companion | Check plan capability, acquire/prepare audio, create and persist the subtitle job, call the Worker, poll/cancel/retry, validate and save output, and attach it to the player |
| Cloudflare Worker | Independently authorize the subtitle capability, rate-limit, validate URLs/uploads, keep the Modal secret, and proxy create/status/cancel requests |
| Modal | Normalize audio, run ASR, translate timestamped chunks to Korean, report progress, and return validated subtitle output |

The Worker remains an authorization boundary even though the Companion owns
General/Pro UI and local enforcement. A modified local client must not be able
to bypass server-side entitlement or upload limits.

## Extension to Companion command

The versioned Native Messaging command should be small and contain no media
bytes:

```json
{
  "protocolVersion": 1,
  "type": "subtitle.create",
  "requestId": "uuid",
  "candidateId": "extension-session-candidate-id",
  "sourceLanguage": "ja",
  "targetLanguage": "ko",
  "mode": "generate",
  "media": {
    "type": "hls",
    "title": "display title",
    "pageUrl": "https://page.example/video",
    "resourceUrl": "https://media.example/master.m3u8",
    "audioRenditionUrl": "https://media.example/audio.m3u8"
  },
  "sourceContext": {
    "tabId": 123,
    "frameId": 7,
    "contextLeaseId": "short-lived-local-lease"
  }
}
```

Rules:

- `tabId`, `frameId`, candidate IDs, and lease IDs are local session values and
  are never forwarded to Cloudflare or Modal.
- Raw Cookie, Authorization, or complete recorded-header objects are not placed
  in the command or persisted in the Companion database.
- URLs are retained only for the active job where needed and are redacted from
  logs and diagnostics.
- `mode` can later support `import-track`, `generate`, and `translate-existing`,
  but each mode needs its own schema and capability check.

## Input selection

The Companion chooses one of two Modal input paths.

### 1. Stable public/referer URL

Use the existing JSON submission only when the URL is public, stable for the
expected job duration, and does not require browser cookies or private headers:

```http
POST /api/subtitles
Content-Type: application/json
Authorization: Bearer <short-lived-subtitle-capability>

{
  "mediaUrl": "https://public.example/video.m3u8",
  "sourceUrl": "https://public.example/watch/123",
  "title": "display title",
  "sourceLanguage": "ja"
}
```

The Worker maps this to Modal `POST /submit`. Modal uses CPU FFmpeg ingest,
spawns the GPU ASR/translation call, and returns a job ID immediately.

### 2. Browser-authenticated or short-lived source

Do not forward browser cookies or tokens to Modal. The Companion obtains the
audio locally, preferring this order:

1. an already downloaded Companion media file;
2. a separate observed HLS audio rendition;
3. Companion fetch using a bounded, explicitly granted request context;
4. an extension request broker that relays only the requested media bytes when
   the source cannot be fetched outside the browser session.

The extension broker is transport only. Companion owns extraction, temporary
files, size checks, cancellation, and upload. Companion should use local FFmpeg
to create a speech-oriented audio input such as mono Opus/OGG before upload,
then call:

```http
POST /api/subtitles
Authorization: Bearer <short-lived-subtitle-capability>
X-Aura-Audio-Upload: 1
X-Aura-Audio-Bytes: <exact byte count>
X-Aura-Audio-Source: companion-local-audio
X-Aura-Source-Language: ja
X-Aura-Title: <percent-encoded title>
Content-Type: audio/ogg

<audio bytes>
```

The Worker maps this to Modal `POST /submit-audio`. The 80 MiB limit is checked
by Companion, Worker, and Modal independently.

## Authentication migration

The current endpoint accepts the Pro license key in each request. The target
flow should keep the key and device identity in the Companion and exchange them
for a short-lived signed capability:

```text
Companion license state
  -> Worker subtitle-capability endpoint
  -> token scoped to subtitle:create/status/cancel, device, byte limit, and expiry
  -> Companion uses token on /api/subtitles
```

The extension receives neither the license key nor the capability. The Worker
must still reject an expired token, wrong scope/device, excess upload, unsafe
URL, invalid language, or rate-limited request.

## Companion job state

Persist a local job before contacting the Worker:

```text
created
-> preparing-audio
-> uploading | submitting-url
-> modal-queued
-> extracting-audio
-> transcribing
-> translating
-> finalizing
-> saving
-> completed | failed | cancelled
```

Minimum durable fields:

- local subtitle job ID and associated media/download job ID;
- source and target languages, input kind, output format, and display title;
- local temporary/output paths;
- remote Modal job ID after acceptance;
- current phase, progress, completed/total chunks, timestamps, retry count, and
  normalized error code;
- model metadata and a redacted source fingerprint for cache/reuse decisions.

Do not use the current URL/title FNV cache key as the durable identity. Prefer a
content-derived audio fingerprint when a local input exists; otherwise use a
redacted provider/media identity plus source language and model contract.

After Companion restart, jobs with a remote ID resume status polling. Jobs that
stopped before remote acceptance restart from local preparation only when their
input and entitlement remain valid.

## Progress mapping

Companion presents one continuous progress model while preserving the raw phase
for diagnostics:

| Companion phase | Suggested displayed range |
| --- | --- |
| Preparing local audio | 0–10% |
| Uploading or URL submission | 10–20% |
| Modal extracting/transcribing | 20–65% |
| Modal translating | 65–95% |
| Validating and saving | 95–100% |

The current Modal `completed` and `total` chunk counters should be shown during
translation. Polling starts at the current three-second baseline, adds jitter
and capped backoff on transient network errors, and retains the thirty-minute
deadline as an explicit configurable job policy.

## Result handling

On completion, Companion must:

1. require `WEBVTT`, valid monotonically ordered cues, finite timestamps, and a
   bounded decoded size;
2. normalize line endings and unsafe cue metadata without changing spoken text;
3. write through a temporary file and atomic rename;
4. save under the Companion subtitle folder policy;
5. associate the file, source language, target language, model, and generation
   time with the media item;
6. load it immediately into the Companion player and expose reveal, rename,
   timing offset, regenerate, and delete actions.

The extension receives only a bounded completion event such as job ID, status,
language, and display label. It does not receive or cache the VTT body.

## Cancellation and cleanup

The current API stops client polling but does not cancel Modal compute. Add:

```http
DELETE /api/subtitles?id=<jobId>
Authorization: Bearer <short-lived-subtitle-capability>
```

The Worker calls a Modal cancel endpoint. Modal reconstructs the call with
`modal.FunctionCall.from_id(jobId)` and invokes `cancel()`, clears progress
mapping, and relies on immediate cleanup plus the existing two-hour stale-file
prune as a backstop. Cancellation is idempotent; an already completed job stays
completed and its result can still be saved.

Companion also deletes unfinished local temporary audio unless the user chose an
explicit retry-preservation option.

## Error contract

Normalize errors into these Companion-visible groups while retaining a specific
internal code:

- entitlement: `pro-license-required`, capability expired, device limit;
- input: unsafe/expired URL, unsupported language/type, empty or oversized audio;
- browser context: lease expired, tab/frame unavailable, authenticated fetch
  failed;
- service: rate limited, Worker unreachable, Modal unavailable, timeout;
- processing: audio extraction, ASR, translation, empty/invalid subtitle;
- local output: folder unavailable, write failed, rename failed;
- user action: cancelled.

Retries must not silently switch an authenticated source to a public URL path or
upload full video when bounded audio extraction failed.

## Verification gate

Before deleting the extension-side subtitle pipeline, verify:

1. protocol schema and size/redaction tests;
2. Companion persistence, restart, retry, cancellation, and atomic-save tests;
3. Worker capability, rate-limit, URL validation, upload-size/content-type, and
   cancel-proxy tests;
4. Modal URL ingest, audio ingest, Japanese ASR, English ASR, Korean translation,
   progress, cancellation, and two-hour cleanup tests;
5. end-to-end fixture audio with deterministic VTT validation;
6. real Chrome and Whale checks for a public source, a referer source, a
   browser-authenticated source, an observed subtitle track, and player loading;
7. General/Pro enforcement from Companion with independent Worker rejection of
   unauthorized requests.
