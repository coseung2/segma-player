# Segma Player cloud storage architecture

## Status

The Companion cloud agent implements the shared file-backed cloud job ABI, a
deterministic local mock provider, and a Telegram Bot API provider. Telegram
upload, download, and deletion are available after a bot token and storage-chat
ID are configured. The manager Library exposes these operations in its Telegram
tab and runs them through the same file-backed job contract.

## Runtime boundary

Cloud execution belongs to the installed Companion product. The browser
connector does not upload media bytes or hold Telegram credentials.

```text
browser extension
  -> aura-media-companion.exe        protocol-2 native host

Segma Player manager
  -> cloud job request/state files
  -> aura-media-cloud.exe            separate cloud execution process
      -> mock blob store
      -> Telegram Bot API
```

The separate cloud process keeps provider dependencies and credentials out of
the Tauri manager and Native Messaging host. Existing `--manager` behavior and
native-host protocol version 2 are unchanged.

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

The request contract is `cloud-job-v1`. A request names its provider and
operation (`upload`, `download`, or `delete`), logical item ID, local path where
applicable, optional virtual folder and filename, and creation time. State files
record status, phase, byte progress, filename, sanitized errors, and timestamps.

The logical item ID is the stable Segma identity. Telegram message and file IDs
remain provider metadata. Virtual-folder changes can be represented as catalog
changes without re-uploading media.

## Telegram Bot API provider

The provider uses a private Telegram group containing the user and storage bot.
Configuration is accepted only through `aura-media-cloud.exe
--configure-telegram` as bounded stdin JSON and is stored at:

```text
%LOCALAPPDATA%\Aura Media\Companion\telegram-config.dpapi
```

The token and chat ID are encrypted with Windows current-user DPAPI. They are
not written to job files, catalogs, logs, command-line arguments, or status
output. `--status` reports `telegram: true` when the protected configuration can
be decrypted and validated structurally; it is a local configuration signal,
not a live Telegram health check.

Uploads use conservative 45 MiB parts. The local durable catalog under
`cloud-telegram\items` records total size, whole-file SHA-256, ordered part
sizes and hashes, and Telegram message/file references. The catalog is written
after each successful part, so a retry can resume from completed parts. A file
is committed only after every part is recorded and the whole-file digest is
known.

Downloads resolve each Telegram file, verify every part hash and the whole-file
hash, write to a temporary path, and atomically publish only after verification.
An existing destination is never overwritten. Deletes remove every cataloged
Telegram message and retain unresolved references if an operation fails.
Cancellation is checked between remote operations.

The Bot API cannot enumerate a bot's existing chat history. Consequently, the
current implementation depends on its DPAPI configuration and local durable
catalog for automatic recovery. Copying only the Telegram group to a new PC, or
deleting `cloud-telegram\items`, does not reconstruct the library. Multi-device
catalog sync, remote manifest discovery, and in-app bot setup are future work.
Empty files are represented by a committed zero-part local catalog and do not
create a Telegram document message.

## Mock provider

The deterministic mock provider stores blobs under:

```text
%LOCALAPPDATA%\Aura Media\Companion\cloud-mock\items\{itemId}
```

It remains available for job, retry, cancellation, and materialization tests.
It is not used as a fallback for failed Telegram jobs.

## Verification checkpoint (2026-09-12 Asia/Seoul)

- `cargo test --manifest-path cloud-agent/Cargo.toml`: 11 tests passed.
- `cargo fmt --manifest-path cloud-agent/Cargo.toml -- --check`: passed.
- `cargo clippy --manifest-path cloud-agent/Cargo.toml --all-targets --no-deps
  -- -D warnings -A clippy::manual-div-ceil`: passed.
- Live Bot API fixture: upload, download, byte equality, and delete passed.
- Protected configuration: DPAPI file exists in the Companion root and
  `aura-media-cloud.exe --status` reports `telegram: true`.

The manager integration additionally has typed UI checks and Tauri command tests.
Installed-app picker and transfer behavior still requires a real manager-window
check for each packaged release.
