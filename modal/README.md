# Aura Japanese ASR

> [!NOTE]
> Current implementation: the extension calls the Cloudflare subtitle proxy.
> Target implementation: Aura Media Companion owns subtitle jobs and calls the
> same Worker boundary. See `../MODAL_SUBTITLE_INTEGRATION.md` for the migration
> contract; the extension remains detection and command UI only.

No local client receives the Modal secret. Cloudflare Worker validates subtitle
entitlement and proxies the short-lived job request to this service. During the
current migration the extension is the caller; the target caller is Companion.

## One-time setup

```powershell
modal setup
modal secret create aura-asr-auth MODAL_ASR_TOKEN=<long-random-token>
```

Deploy the service:

```powershell
modal deploy modal/asr_app.py
```

Copy the deployed web URL into `wrangler.jsonc` as `MODAL_ASR_URL`, then set the
same secret in the Worker:

```powershell
npx wrangler secret put MODAL_ASR_TOKEN
npx wrangler deploy
```

The first worker cold start downloads `litagin/anime-whisper` into the
`aura-asr-models` Modal Volume. VOD transcription is asynchronous because a
long media request cannot be kept inside a browser HTTP request.

Protected media that requires browser cookies is intentionally not forwarded
to Modal in this first version. Public media URLs and referer-protected URLs
are supported. URL ingest rejects private/loopback DNS results, disables proxy
inheritance and automatic redirects, pins the validated public address for each
curl request, and only then passes a local file to FFmpeg.

## Service endpoints

All Modal endpoints require `Authorization: Bearer <MODAL_ASR_TOKEN>` and are
called only by the Cloudflare Worker:

- `POST /submit` starts a public URL job.
- `POST /submit-audio` starts a bounded binary-audio job.
- `GET /result/{job_id}` returns progress or the completed WebVTT result.
- `DELETE /cancel/{job_id}` cancels unfinished compute. Completed jobs remain
  completed, and progress mappings are cleared only after a terminal result so
  a transient cancellation failure can be retried.

The public Worker boundary is `POST`, `GET`, and `DELETE /api/subtitles`; local
clients never call these Modal routes or receive the Modal token directly.
