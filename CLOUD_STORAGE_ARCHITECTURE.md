# Segma Player cloud storage architecture

## Status

This document is the implementation contract for the current Companion-owned
cloud foundation. The implemented scope is the shared file-backed cloud job ABI
and a deterministic local mock provider. Telegram/TDLib authentication, remote
catalog synchronization, and cloud-library UI are not implemented and must not
be advertised as available.

## Runtime boundary

Cloud execution belongs to the installed Companion product. The browser
connector remains plan-neutral and does not upload media bytes or hold cloud
credentials.

```text
browser extension
  -> aura-media-companion.exe        existing protocol-2 native host

Segma Player manager
  -> cloud job request/state files   future UI wiring
  -> aura-media-cloud.exe            separate cloud execution process
      -> mock blob store             implemented foundation
      -> Telegram/TDLib              not implemented
```

The separate process keeps future provider dependencies out of both the Tauri
manager and the Native Messaging host. Existing `--manager` behavior continues
to launch `aura-media-manager.exe`; the native host protocol remains version 2.

## File-backed ABI

Cloud jobs use `%LOCALAPPDATA%\Aura Media\Companion\cloud-jobs` and the safe-ID,
atomic-JSON, and bounded-state conventions in `companion-contract`. Each job
uses these files:

```text
{id}.request.json
{id}.state.json
{id}.cancel
{id}.runner.lock
```

The request contract is `cloud-job-v1`. A request names its job, provider,
operation (`upload`, `download`, or `delete`), logical item ID, local path where
applicable, optional virtual folder and filename, and creation time. State files
record status, phase, byte progress, filename, errors, and timestamps.

The logical item ID is the stable Segma identity. Provider-native identifiers
must remain provider metadata. Virtual folder changes are catalog changes and
must not require media re-upload.

## Mock provider

The foundation stores deterministic mock blobs under:

```text
%LOCALAPPDATA%\Aura Media\Companion\cloud-mock\items\{itemId}
```

Uploads split data into 512 MiB parts. Retries reuse a completed part only when
its size matches the expected size. The manifest is written after every part is
present. Downloads assemble into a temporary file and atomically rename it;
existing destinations are not overwritten. Delete is idempotent.

This provider exists to verify job, retry, cancellation, and materialization
semantics before any network provider is introduced. It is foundation-only and
is not a user-facing cloud storage feature.

## Telegram target and release gate

A future Telegram provider may use a user-account Telegram API through TDLib.
It would require protected sessions, private storage bootstrap and recovery,
integrity metadata, restart and orphan handling, a recoverable catalog, manager
folder UI, deterministic fixtures, dedicated-account live tests, third-party
notices, and a platform-terms review.

Until those gates are complete, `aura-media-cloud.exe --status` reports
`telegram: false`, and Telegram jobs fail closed with a persisted failure state.
No Telegram credentials or live Telegram calls belong in the current build.
