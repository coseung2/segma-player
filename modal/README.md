# Aura Japanese ASR

The extension never receives the Modal secret. Cloudflare Worker validates the
Pro license and proxies the short-lived job request to this service.

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
are supported.
