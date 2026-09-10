# Segma Player cloud storage architecture

## Status

This document is the active implementation contract for Companion-owned cloud storage.
The current foundation build implements the shared cloud job ABI and a local mock blob
backend only. Telegram/TDLib authentication, remote catalog sync, and cloud-library UI
are intentionally not implemented yet and must not be advertised as available.

## Product boundary

Cloud storage belongs to the Companion product, not the browser extension. The browser
connector remains plan-neutral and does not upload media bytes or hold cloud credentials.

The runtime boundary is:

```text
browser extension
  -> aura-media-companion.exe        existing browser-command/download host

Segma Player manager
  -> cloud job request/state files
  -> aura-media-cloud.exe            cloud execution process
      -> provider backend
          -> mock blob store          implemented
          -> Telegram/TDLib           planned
```

The cloud process is separate from `aura-media-companion.exe` so Telegram/TDLib and
future provider dependencies do not enlarge the Native Messaging host or change its
security boundary.

## Shared disk ABI

Cloud jobs use `%LOCALAPPDATA%\Aura Media\Companion\cloud-jobs` and reuse the safe ID,
atomic JSON replacement, and bounded-state conventions in `companion-contract`.

Each job uses:

```text
{id}.request.json
{id}.state.json
{id}.cancel
{id}.runner.lock
```

The versioned request contract is `cloud-job-v1`.

A request identifies:

- `schemaVersion`
- `jobId`
- `provider`: `mock` or `telegram`
- `operation`: `upload`, `download`, or `delete`
- `itemId`: provider-independent logical media ID
- optional `folderId`
- `localPath` for upload/download
- optional `fileName`
- `createdAt`

The job state records status, phase, byte progress, filename, error text, and timestamps.
Unknown future fields remain serde-compatible by default.

## Provider boundary

`itemId` is the stable Segma identity. Provider-native identifiers such as Telegram chat,
message, file, or unique-file IDs must be stored as provider metadata and must never
become the primary library key.

The provider contract must remain narrow enough to support additional backends later:

```text
put logical item
get/materialize logical item
remove logical item
list/recover provider metadata
```

Folder membership is catalog metadata, not physical provider placement. Moving an item
between virtual folders must not re-upload media bytes.

## Mock backend

The foundation agent ships a deterministic local mock backend under:

```text
%LOCALAPPDATA%\Aura Media\Companion\cloud-mock\items\{itemId}
```

Uploads are split into 512 MiB parts. A retry reuses an existing part only when its byte
length matches the expected part length. The final manifest is written after all parts
exist. Downloads concatenate the manifest parts into a temporary file and atomically
rename the result into place. Existing destinations are never overwritten. Delete is
idempotent.

The mock backend exists to freeze job semantics before a network provider is introduced.
It is not a user-facing cloud feature.

## Telegram target contract

A later Telegram provider should use the user-account Telegram API through TDLib rather
than the Bot API. The intended storage topology is one private Segma storage channel per
library. Large logical media is represented by multiple document messages and a separate
catalog/event layer.

Target rules:

1. Default provider chunk size remains below Telegram's per-file limit; 512 MiB is the
   current design value.
2. Each remote chunk records the logical `itemId`, part index/count, size, and integrity
   hash in recoverable metadata.
3. A local SQLite catalog is a projection/cache, not the sole source of truth.
4. Remote catalog changes use append-only events plus periodic snapshots so a new device
   can rebuild the folder tree and item mapping.
5. Folder IDs use parent IDs and support arbitrary nesting; Telegram messages are not
   moved when a virtual folder changes.
6. Playback v1 materializes to a local cloud cache and then reuses the existing mpv
   player. Random-access remote streaming is a later protocol change.
7. Secrets, authentication codes, and 2FA passwords never enter `settings.json` or job
   JSON. TDLib session material and encryption keys require OS-protected storage.
8. User-visible delete should first become a logical Trash operation. Destructive remote
   message deletion requires an explicit permanent-delete action.

## Release gate

Telegram storage must remain experimental until all of the following are complete:

- TDLib authentication and session protection
- private storage-channel bootstrap/recovery
- upload/download integrity hashing
- restart/cancel/orphan cleanup
- SQLite catalog plus remote event/snapshot recovery
- manager folder UI and stable media-ID migration
- installer packaging and third-party notices for TDLib
- deterministic provider fixtures
- live tests with a dedicated Telegram test account
- review of Telegram API/platform terms for the intended distribution model

Until then the agent reports `telegram: false` in `--status` and a Telegram cloud job
fails closed with a persisted failure state.
