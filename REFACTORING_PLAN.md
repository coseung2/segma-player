# Segma Player refactoring plan

## Status

**REOPENED — the 2026-08-31 completion audit found unmet exit-gate details in
phases 1 through 6. Remediation and a fresh Phase 7 handoff are in progress.**

This is the current refactoring roadmap for the Companion-first product. It
supersedes `MEDIA_MODULE_REFACTOR.md` as a roadmap; that file remains a
historical record of the extension-primary 0.3.89 refactor.

Planning snapshot: 2026-08-30, branch `main`, HEAD `9490edd`. At the time of
planning, another session owned uncommitted changes in:

- `INCIDENTS.md`
- `manifest.json`
- `companion-gui/Cargo.toml`
- `companion-gui/Cargo.lock`
- `companion-gui/src/app.rs`
- `companion-gui/src/player_ui.rs`
- `companion-gui/src/seek_preview.rs`

These paths and versions are the initial planning snapshot, not the current
implementation baseline. The PiP work completed in `a6abc39` and its validation
was recorded in `d8420cf`; the committed result is now the Phase 6 baseline.

## Progress tracking

Update this table and the relevant phase notes in the same commit that finishes
each phase. A phase is not complete until its checks and known gaps are recorded.

| Phase | Status | Completion evidence |
| --- | --- | --- |
| 0. Stable baseline | Complete | 2026-08-30 baseline plus committed PiP result |
| 1. Trustworthy tests and frozen contracts | In progress | Missing status/rejection/folder/diagnostic fixtures are frozen; test categorization remains |
| 2. Native-host module split | Complete | Media execution and subtitle transport/state orchestration moved out of `main.rs`; native host 58 passed |
| 3. Shared host/GUI disk contract | Complete | Host is the only durable `JobState` writer; manager writes markers and transient notices only |
| 4. Shipped extension split | Complete | Ranked-candidate and pasted-link routes share one behavior-tested Companion router |
| 5. Packaging and retired runtime | Reopened | Physically quarantine retained legacy extension source and tests |
| 6. Native manager split | Complete | Player/PiP state, HWND lifecycle, geometry, and orchestration have explicit owners; GUI 202 passed |
| 7. Integrated validation and handoff | Reopened | Pending remediation, version reconciliation, staging, and fresh audit |

### Completion audit reopening — 2026-08-31

The first Phase 7 pass proved the deterministic suites and package graph, but a
requirement-by-requirement independent audit found that several written exit
gates were broader than the implementation evidence. The prior `COMPLETE`
label is therefore withdrawn until all of these items are closed:

- freeze the missing status, rejected-command, download-folder, and redacted
  diagnostic contracts; replace route source slicing with behavior tests and
  expose shipped-versus-legacy test categories;
- finish the native-host split so media execution and subtitle transport/state
  orchestration no longer remain in the composition root;
- make the host the only durable `JobState` writer while the manager writes
  only command/request markers and keeps transient feedback in memory;
- move retained extension-primary engines and their tests into an explicit
  compatibility area without allowing them into the 58-file shipped graph;
- finish the manager player/PiP module boundary and reconcile all product
  component versions before rebuilding staging.

Installed Chrome, Whale, Companion-window, PiP, and live-site validation remains
`NOT_RUN`; this reopening does not change any incident or site-QA claim.

## Goal

Make the shipped product easier to change without altering its approved
ownership model:

- the extension detects browser media, accepts link intent, and sends bounded
  commands;
- the native host validates commands, persists jobs, and executes work outside
  the browser lifetime;
- the native manager reads the shared disk job state and owns job control,
  playback, subtitles, settings, and user-facing durable state.

The refactor is behavior-preserving unless a separately approved change says
otherwise. File movement, dead-code retirement, and protocol evolution must not
be combined into one unreviewable change.

## Current runtime boundary

The repository root contains both the shipped Companion-first connector and
older extension-primary implementation code. File size or test coverage alone
does not prove that a module is part of the installed product.

The source of truth for the packaged extension is
`scripts/store-runtime-files.json`, consumed by both build paths. The active
flow is:

```text
page-media-observer.js / level5-page-bridge.js
  -> content.js
  -> background.js candidate collection, ranking, and URL resolution
  -> popup.js user intent
  -> companion-client.js
  -> Native Messaging: com.aura.media_companion
  -> aura-media-companion.exe
  -> jobs/{id}.request.json + jobs/{id}.state.json + marker files
  -> detached --run-job / --run-subtitle-job execution
  -> aura-media-manager.exe polls disk state
```

Examples of retained legacy reference/test source outside the validated runtime
graph include `hls-download.js`, `download-worker.js`, `player.js`,
`playback-session.js`, `native-file-writer.js`, `save-directory.js`, and the
transport implementations under `downloaders/` other than `ids.js`. Their
tests do not prove the shipped connector path, and import-closure validation
prevents them from entering staging indirectly.

## Compatibility invariants

The following contracts stay stable throughout the refactor:

### Native Messaging and command contract

- Native host name: `com.aura.media_companion`
- Companion protocol: `2`
- Media capability: `media-download-v1`
- Media command protocol: `1`
- Existing command names, capability negotiation, error codes, byte limits,
  public-URL checks, payload allowlists, and redacted diagnostics
- `requestId` is owned by the request envelope and echoed by the reply
- No cookies, arbitrary headers, media bytes, secrets, or local paths are added
  to the media-download payload

### Process and disk ABI

- CLI flags: `--run-job`, `--run-subtitle-job`, `--manager`
- Job files:
  - `{id}.request.json`
  - `{id}.state.json`
  - `{id}.cancel`
  - `{id}.pause`
  - `{id}.subtitle.request.json`
- `settings.json` and `downloadFolder`
- Existing `JobState` JSON remains backward-readable
- Atomic state writes and safe job-ID/path validation remain fail-closed

### Product ownership

- The extension remains plan-neutral and has no local download, playback,
  subtitle, durable queue, or file-writing fallback.
- The host remains the authority for execution and persisted job state.
- The GUI remains a disk-state reader and command initiator; it does not become
  a second Native Messaging server.
- Site profiles remain declarative. Provider behavior belongs in `providers/`;
  transport behavior belongs in the Companion/shared media implementation.
- Chrome and Whale are verified independently.

Changing one of these invariants requires a separate protocol or product
decision, explicit migration handling, and coordinated extension/host/installer
validation. It is not an incidental refactor.

## Main hotspots

1. **`native-host/src/main.rs`** — approximately 6,000 lines combining native
   message framing, request validation, job persistence, media/YouTube/subtitle
   execution, progressive ranges, process spawning, settings, manager launch,
   and the legacy `media-*` writer.
2. **Duplicated cross-process contracts** — JS and Rust validate the same media
   command, while host and GUI independently model job state, safe IDs, paths,
   folder validation, and restart behavior.
3. **`companion-gui/src/app.rs` and `jobs.rs`** — polling, queue, library,
   settings, licensing, player, thumbnail, fullscreen, and PiP responsibilities
   are concentrated. Player/PiP extraction conflicts with the in-flight work
   and is intentionally late in this plan.
4. **`background.js` and `content.js`** — active detection/handoff logic is
   mixed with unrelated state, diagnostics, site-specific extraction, and
   obsolete job/overlay message paths.
5. **Dual extension generations** — unpackaged browser downloader/player code
   remains importable and tested from the repository root, making it easy to
   fix or test the wrong runtime.
6. **Brittle structural tests** — several tests inspect source text, function
   location, or string fragments. They guard useful boundaries but produce
   false failures on safe file moves and cannot replace behavior tests.
7. **Duplicated packaging rules** — runtime file allowlists and legacy additions
   exist across JavaScript and PowerShell packaging scripts.

## Execution order

Each phase is independently reviewable and must leave the repository in a
working state. Do not start the next phase when its entry gate is unmet.

### Phase 0 — stable non-overlapping baseline

No refactoring occurs in this phase. While the PiP session is active, capture
the extension and native-host baseline and record GUI files as externally owned.
Defer the GUI test baseline and final version reconciliation until the user
confirms that session is finished.

1. Re-read `git status --short --branch`, HEAD/upstream, the other session's
   final diff, and versions in `manifest.json`, both Cargo manifests, and
   `store/manifest.json`.
2. Confirm the GUI/PiP session has stopped writing and that its changes are
   committed, intentionally parked, or explicitly excluded from the refactor
   write set.
3. Capture the staging allowlist and import closure. Treat staging, not a
   repository-root unpacked load, as the product graph.
4. Run and record the baseline checks below. Existing failures are baseline
   debt and must not be silently attributed to or normalized by the refactor.

Baseline checks:

```powershell
rtk git diff --check
rtk node --test companion-architecture.test.mjs source-hygiene.test.mjs dev-staging.test.mjs store-package.test.mjs site-regression.test.mjs
rtk npm run test:media-sites
rtk npm test
rtk cargo fmt --check --manifest-path native-host/Cargo.toml
rtk cargo test --manifest-path native-host/Cargo.toml
rtk cargo fmt --check --manifest-path companion-gui/Cargo.toml
rtk cargo test --manifest-path companion-gui/Cargo.toml
```

Exit gate: the final in-flight work is identified, version ownership is clear,
and every baseline failure has an owner and reproduction.

#### Phase 0 result — 2026-08-30

- Baseline HEAD: `9490edd`; `main` was one commit ahead of `origin/main`.
- Externally owned dirty paths are the seven PiP/session files listed in
  `Status`. They were excluded from edits, staging, formatting, and tests.
- `npm test`: 524 passed, 0 failed, 22 explicitly skipped.
- `npm run test:media-sites`: 48 passed, 0 failed.
- Focused architecture/hygiene/staging/store/site suite: 43 passed, 0 failed.
- Native host: 45 passed, 0 failed.
- `git diff --check`: passed.
- The Companion GUI suite, installed binaries, staging rebuild, ZIP creation,
  and live Chrome/Whale checks were deliberately not run. They are not needed
  to establish the non-GUI refactor baseline and could overlap the PiP session.

The earlier Windows `%20` failures were reproduced from their implementation
pattern rather than by this baseline: three tests constructed paths from URL
`.pathname`. They are handled as the first Phase 1 change.

### Phase 1 — make tests trustworthy and freeze external contracts

Before moving production code:

1. Fix Windows path handling in tests that derive paths from
   `new URL(import.meta.url).pathname`; use `fileURLToPath` so the workspace's
   space is not interpreted as `%20`.
2. Add golden or round-trip fixtures for:
   - `hello` and `status` capability responses;
   - accepted and rejected `media-download-v1` envelopes;
   - `requestId` echoing;
   - current and older `JobState` JSON records;
   - job/request/state/marker/settings paths;
   - download-folder validation and redacted diagnostics.
3. Add one JS-to-Rust protocol fixture and one host-state-file-to-GUI model
   fixture. The fixtures must assert serialized compatibility rather than copy
   the same constants into unrelated tests.
4. Replace key `indexOf`/source-slice assertions with behavior tests. Retain
   only small structural checks that enforce dependency or absence boundaries.
5. Categorize tests as shipped connector, native host, native GUI, or legacy
   extension engine so a green legacy test is never reported as live-path proof.

Exit gate: `npm test` is genuinely green on the local Windows path without
skipping the repaired checks, both Cargo suites pass, and frozen contracts have
cross-process fixtures.

#### Phase 1 result — 2026-08-30

- Replaced all three URL-`.pathname` repository-root calculations with
  `fileURLToPath`; the local full Node suite now passes on the spaced Windows
  workspace path.
- Added shared fixtures under `test-fixtures/companion/` for protocol 2 hello
  capabilities, `media-download-v1`, current and legacy job-state JSON, and the
  disk filename ABI.
- `companion-client.test.mjs` and native-host tests consume the same hello/media
  fixtures, covering protocol constants, allowlisted fields, `requestId`, and
  command validation without copying separate expected envelopes.
- Manager job tests consume the shared current/legacy state fixtures and disk
  path fixture. The current fixture includes an unknown future field to preserve
  the older-manager/newer-host compatibility rule.
- Focused Companion client: 14 passed, 0 failed.
- Native host: 45 passed, 0 failed.
- Companion GUI after PiP completion: 185 passed, 0 failed. Only
  `companion-gui/src/jobs.rs` was changed by this phase; the completed PiP diff
  was treated as baseline and not rewritten.
- Both Rust format checks and `git diff --check` pass after formatting.

#### Phase 1 remediation — 2026-08-31

- Added shared `status-v2`, media-command rejection, download-folder, and
  redacted-diagnostic fixtures under `test-fixtures/companion/`.
- JavaScript and Rust tests consume the same fixtures for response correlation,
  stable rejection codes, path validation, and public diagnostic redaction.
- Replaced ranked-candidate/pasted-link source slicing with behavior tests over
  the shared `background-download-router.js` handoff.
- Test categorization remains part of the Phase 5 compatibility quarantine, so
  Phase 1 stays in progress until those runnable category commands land.

### Phase 2 — split the native host inside the existing crate

Move code without changing JSON, CLI, error, job, or execution behavior. The
target modules are:

- `protocol.rs` — native framing, typed envelope dispatch, replies, and limits
- `job_store.rs` — paths, atomic JSON, state transitions, and marker handling
- `process.rs` — detached job spawning and manager launch
- `media_download.rs` — command validation and media execution orchestration
- `youtube.rs` — YouTube request and yt-dlp behavior
- `subtitle.rs` — subtitle job validation and execution
- `legacy_writer.rs` — compatibility-only `media-open/chunk/close/abort/suspend`

`main.rs` should retain CLI selection and composition. Do not introduce a
framework, service locator, generic command bus, or behavior rewrite. Extract
one responsibility at a time and run the focused host and protocol tests after
each extraction.

Exit gate: `main.rs` is composition-oriented, all frozen fixtures are
byte/field compatible, and the host test suite has no behavior regression.

#### Phase 2 result — 2026-08-31

Completed as a behavior-neutral native-host split at development version
`0.4.56`:

- Native Messaging framing, typed parse/reply correlation, and message limits
  now live in `protocol.rs`.
- Companion path validation, atomic JSON, shared `JobState`, state listing, and
  persistence now live in `job_store.rs`.
- Detached self-launch and manager-binary resolution now live in `process.rs`.
- The bounded `media-download-v1` command model, public URL validation, secret
  rejection, and field validation now live in `media_download.rs`.
- yt-dlp tool discovery, Windows process setup, runtime flags, info extraction,
  download command construction, and the bounded 403 retry predicate now live
  in `youtube.rs`.
- Subtitle command validation, HTTP transport, remote response parsing,
  cancellation, audio extraction/upload, VTT normalization and saving, and the
  long-running state orchestration now live in `subtitle.rs`.
- Progressive range execution, adaptive concurrency, cancellation/pause
  handling, browser-context yt-dlp preparation, and media state updates now
  live in `media_download.rs`.
- Legacy `media-open/chunk/close/abort/suspend` chunk decoding, persistence
  thresholds, and progress calculation are isolated in `legacy_writer.rs`;
  dispatch stays in `main.rs` to preserve reply and manager-launch behavior.
- Host-side fixture checks now cover every disk ABI filename, current and
  legacy job-state deserialization/serialization, the real hello body, and
  `requestId` reply correlation. Source-text architecture checks were narrowed
  to the retired Win32 per-job UI invariant; Rust behavior tests own the moved
  process and disk contracts.

Validation after remediation: native-host 58 passed; focused Companion
architecture/client/background behavior tests 29 passed; Cargo check and Rust
formatting passed; `git diff --check` passed. No live installed Native
Messaging or browser flow is claimed by this behavior-preserving extraction.

### Phase 3 — unify the host/GUI disk contract

Create a small local shared Rust crate or module containing only stable disk ABI
primitives:

- `JobState` and serialization compatibility
- safe job-ID validation
- job, request, state, marker, subtitle, and settings path construction
- download-folder validation
- shared restart/resume argument construction where appropriate

Keep host-only execution and GUI-only presentation out of the shared layer.
The host remains the state writer. The GUI remains the reader and action
initiator. Consolidate duplicate retry/resume behavior only after compatibility
tests cover both callers.

Exit gate: host and GUI consume the same disk-contract implementation, older
state fixtures still load, and both Cargo suites pass.

#### Phase 3 result — 2026-08-30

Completed at development version `0.4.57` with a dependency-only shared crate,
`companion-contract`:

- `JobState`, its forward/legacy-compatible serde model, job-ID validation,
  Companion root/jobs/settings paths, every job/marker/subtitle path, download
  folder validation, JSON reads, and newest-first bounded state listing now
  have one implementation.
- `native-host` remains the writer and wraps only its host-specific atomic
  persistence. `companion-gui` remains the reader/action initiator and keeps
  settings presentation, marker writes, restart process launch, and library
  behavior outside the contract crate.
- Both consumers use the same local path dependency and the same `0.4.57`
  contract version. The shared fixture tests cover current, future-field, and
  legacy state files plus every disk ABI filename including subtitle requests.
- Restart/resume launch remains GUI-owned because it resolves and launches the
  installed host executable; only its stable request/marker path inputs were
  unified.

Validation at this checkpoint: shared contract 2 passed; native host 53
passed; focused manager jobs 38 passed and full manager 185 passed; Rust format
checks passed; manager Cargo check retained only three pre-existing
unused-method warnings; development staging refreshed with 54 files at
`0.4.57`.

#### Phase 3 remediation — 2026-08-31

- Removed the manager's durable state rewrites for cancel, pause, restart, and
  subtitle startup. The GUI now writes only request/marker files and launches
  the existing host runner.
- Row-action feedback is held in transient manager notice state, and library
  subtitle startup uses the existing Native Messaging command so the host
  creates the initial durable state.
- Shared manager tests assert that action initiation leaves existing
  `JobState` bytes unchanged. Host-only durable writer ownership is restored.

### Phase 4 — simplify and split the shipped extension

Only files reachable from `STORE_RUNTIME_FILES` are refactored in this phase.

1. Prove which content-script messages still have packaged callers and
   responders. Remove obsolete overlay/job/download-direct paths separately
   from module extraction.
2. Preserve `refresh-media-source`, frame state, title selection, rescan, Dood,
   and other browser-context behavior that remains necessary for tokenized
   candidates.
3. Extract duplicated packed-script decoding and public URL/IP validation into
   shared pure helpers used by content detection and player-page resolution.
4. Split `background.js` by ownership:
   - web-request and page-evidence ingestion;
   - candidate and frame-state repository;
   - player-page resolution orchestration;
   - Companion command handoff;
   - message routing and QA diagnostics.
5. Split `content.js` into pure extraction/deduplication logic and a thin
   DOM/runtime shell. Content scripts are manifest-ordered non-module scripts;
   do not assume ordinary ESM imports can be added.
6. Keep `candidate.js`, `candidate-ranking.js`, `sites/profile.js`, the bounded
   Companion payload, and the player graph resolver as existing primitives
   unless a focused test demonstrates a defect.

Do not add a generic event bus or a second candidate/protocol model.

Exit gate: ranked-candidate and pasted-link actions reach the same Companion
handoff, YouTube uses its existing remote command, rescan rebuilds candidates,
and the extension performs no local file write or media execution.

#### Phase 4 result — 2026-08-30

Completed at development version `0.4.58` without changing Companion, PiP, or
native execution ownership:

- `background-candidate-repository.js` owns candidate/frame state, ranking,
  bounded session persistence, restore, replacement, and tab cleanup.
- `background-companion-handoff.js` owns validated media and YouTube Companion
  commands. `background-player-resolution.js` owns observed-frame resolution,
  source refresh, and final candidate resolution. `background-request-evidence.js`
  owns bounded QA request traces and progressive redirect evidence.
- `content-extraction.js` is a manifest-ordered classic-script helper shared by
  `content.js` and `player-page-resolver.js`. Packed, hex, reversed, percent,
  and base64 clues plus public HTTP/IP validation now have one implementation.
- Removed the unreachable content-side `download-direct`, anchor-download, and
  legacy job-overlay message paths. The shipped extension retains detection,
  rescan, token refresh, player-page resolution, and bounded Companion handoff;
  it does not regain local media execution or file writing.
- Root and store manifests, installation reinjection, development staging, and
  store packaging all load `content-extraction.js` before `content.js` and
  include the four new background modules. The duplicated JavaScript and
  PowerShell runtime allowlists are intentionally left for Phase 5.
- `background.js` decreased from 1,111 to 822 lines and `content.js` from 1,460
  to 989 lines. The split reuses the existing candidate, ranking, player graph,
  site registry, and Companion protocol primitives rather than adding a second
  event or candidate model.

Validation at this checkpoint: focused extraction/background/player/staging/
store tests 99 passed; store package builds 2 passed; `npm run test:media-sites`
48 passed; full Node suite 526 passed and 22 explicitly skipped; native host 53
passed; Companion GUI 185 passed; both Rust format checks and `git diff --check`
passed. No Chrome/Whale or installed Companion interaction was run for this
behavior-neutral split, so live validation is `NOT_RUN` and no live behavior is
claimed.

#### Phase 4 remediation — 2026-08-31

- Added `background-download-router.js` as the single candidate/link routing
  boundary and included it in the packaged runtime declaration.
- Behavior tests now prove that ranked candidates and pasted links converge on
  the same bounded Companion handoff; source-slice/index assertions were
  removed from this route.
- The packaged closure is therefore 58 files, not the 57-file count recorded by
  the first Phase 5/7 pass.

### Phase 5 — unify packaging and quarantine retired runtime

1. Make the staging/store runtime allowlist one source of truth consumed or
   generated by both JavaScript and PowerShell tooling.
2. Add an import-closure test that prevents legacy modules from re-entering the
   packaged graph indirectly.
3. Stop development package tooling from silently adding retired pages or
   bookmarks unless they are explicitly retained as a tested product contract.
4. Move legacy extension downloader/player/subtitle/license code to an explicit
   compatibility area or delete it only after reachability is proved.
5. Keep host `media-*` writer compatibility isolated until installed-client
   compatibility is verified. Do not delete it merely because current staging
   omits `native-file-writer.js`.
6. Update current documentation so site/downloader labels are not described as
   browser-side transport execution when they are diagnostic intent for the
   Companion.

Historical documents and append-only incident/QA evidence are not rewritten.

Exit gate: staging and store builds consume the same declared graph, no retired
module is packaged, and root-source tests are clearly separated from shipped
runtime tests.

#### Phase 5 result — 2026-08-31

Completed at development version `0.4.59`:

- `scripts/store-runtime-files.json` is now the sole runtime file declaration.
  The JavaScript staging builder and PowerShell store packager both consume it;
  the duplicated source lists were removed.
- `scripts/runtime-graph.mjs` walks manifest entries, content-script order,
  HTML scripts/styles, static ESM imports/re-exports, and literal dynamic
  imports. Development staging and store packaging fail if an import is missing
  from the declaration or if a declared file is unreachable.
- Reachability proved that the old options page was not a manifest entry, so
  `options.html` and `options.js` were removed from the shipped graph. Legacy
  browser download, player, subtitle, license, collection, and file-writer
  source remains only as explicit reference/test code outside the package.
- `runtime-graph.test.mjs` proved the then-current 57-file closure and rejects both a
  synthetic retired-module import and an unreachable allowlist addition. The
  obsolete duplicate expected-file list in the store package test was removed.
- Current README, documentation map, and site/provider mode contract now
  describe diagnostic downloader IDs and Companion execution. Historical
  incident, QA, and extension-primary snapshot documents were not rewritten.
- Native-host `media-*` compatibility remains isolated in `legacy_writer.rs`;
  this phase neither removed nor changed that installed-client contract.

Validation at this checkpoint: focused graph/staging/store/architecture suite
13 passed including both deterministic store ZIP builds; media-site suite 48
passed; full Node suite 528 passed and 22 explicitly skipped; shared contract 2
passed; native host 53 passed; Companion GUI 185 passed; both Rust format checks
and `git diff --check` passed. No live browser or installed Companion check is
claimed for packaging-only changes; live validation is `NOT_RUN`.

### Phase 6 — split the native manager after PiP work lands

Start with low-conflict ownership boundaries:

- polling and job-state controller;
- queue state and view;
- library controller and view;
- settings and license controller;
- thumbnail coordination.

Player session, fullscreen, PiP, seek preview, native HWND, and mpv ownership are
extracted last. Preserve window/process ownership and replace source-text/layout
assertions with state and geometry tests where practical. Do not perform this
phase while the current PiP/player work is still being changed elsewhere.

Exit gate: manager behavior and disk ABI are unchanged, GUI tests pass, and
real installed-window interactions required by the changed surface are recorded
as live evidence rather than inferred from unit tests or screenshots.

#### Phase 6 result — 2026-08-31

Completed in `cfa3d9f` at development version `0.4.60`:

- `ManagerApp` now holds eight explicit top-level owners instead of the former
  flat state bag: disk polling snapshot, queue state, library state, player
  session, thumbnail coordinator, license controller, PiP session geometry,
  and transient notice state.
- `manager_poll.rs` owns the polling deadline and coherent jobs, restartability,
  folder, and media snapshot while preserving the previous rule that a failed
  job read does not erase the last successful list.
- `queue_controller.rs` owns queue filters and derived rows;
  `library_controller.rs` owns search/filter/sort, metadata, selection, folder,
  organization, and modal state. Their focused tests cover paused/terminal
  filtering, unfiltered totals, explicit selection mode, and folder-scoped
  selected size.
- `license_controller.rs` owns the async verify result channel, existing-Pro
  invalidation rule, key draft, focus, persistence, and removal workflow.
  `ThumbnailCoordinator` owns the worker channels, pending/unavailable keys,
  and GPU texture map as one lifecycle.
- `player_session.rs` groups the existing player backend, GIF export, seek
  preview, shortcut, loaded-media, and fullscreen lifetime. It no longer owns
  native HWND or PiP geometry fields.
- `player_surface.rs` is the sole owner of Win32 child-HWND creation,
  positioning, clipping, visibility, cursor access, and idempotent destruction.
  The existing `SetVideoWindow` command remains the only mpv handle handoff.
- `pip_controller.rs` owns PiP activation/dismissal, floating-area geometry,
  drag/resize state, controls, preview coordination, and transition outputs.
  `app.rs` now wires event/update/render flow and preserves the established
  player/PiP command order without creating another native or egui window.
- No protocol, disk-ABI, extension runtime, package graph, or site behavior was
  changed. The source movement intentionally does not update `INCIDENTS.md` or
  `SITE_QA_LOG.md`.

Validation after the completed player/PiP extraction: focused root
architecture/UI/hygiene tests 43 passed; the full Companion GUI suite 202
passed; Cargo check passed with the three pre-existing `jobs.rs` dead-code
warnings; Rust formatting and `git diff --check` passed. The earlier integrated
suite and staging figures remain historical checkpoints and will be rerun at
the final handoff. No live installed-window, pointer interaction, mpv render,
Chrome, or Whale result is claimed; live validation remains `NOT_RUN`.

### Phase 7 — integrated validation and handoff

For every source-changing phase, run focused owned tests followed by:

```powershell
rtk npm run test:media-sites
rtk npm test
rtk cargo test --manifest-path native-host/Cargo.toml
rtk cargo fmt --check --manifest-path native-host/Cargo.toml
rtk cargo test --manifest-path companion-gui/Cargo.toml
rtk cargo fmt --check --manifest-path companion-gui/Cargo.toml
rtk git diff --check
```

At a development handoff, increment `manifest.json` once according to the
repository version policy and run `npm run build:dev-staging`. Do not create a
development ZIP unless explicitly requested. Do not change the separate store
listing version unless a store release is in scope.

Live validation is required after detection, provider, protocol, staging,
installer, playback, or PiP behavior changes. Record these independently:

- Chrome and Whale Companion `hello`/`status`
- ranked candidate and pasted player-page handoff
- job persistence after closing the popup/browser
- pause, resume, cancel, and retry
- GUI polling and shared download-folder consistency
- representative progressive, HLS, and DASH paths
- per-site `detect`, `extension-download`, `subtitle`, and `overlay` status
- AdBlock on/off when it affects the named site path

Fixture success never implies a live site result. Detection never implies
download. Untested surfaces remain `NOT_RUN`; code-only bug fixes remain
`CODE-FIXED / LIVE-UNVERIFIED` until the actual user path is retested.

#### Phase 7 result — 2026-08-31

Completed at development handoff version `0.4.61`:

- media-site suite: 48 passed;
- full Node suite: 528 passed and 22 explicitly skipped;
- shared Companion contract: 2 passed;
- native host: 53 passed, with Rust formatting clean;
- Companion GUI: 198 passed, with Rust formatting clean;
- packaged runtime graph and exact staging closure: passed as part of the full
  Node suite and the final development staging audit;
- `git diff --check`: passed.

The Pro development staging directory was rebuilt from the `0.4.61` source
manifest and audited as the exact then-current 57-file runtime graph. The
shared background download router subsequently raised the current graph to 58
files, which will be re-audited in the final handoff. No development ZIP was
created. This final phase changed only the handoff version and plan status after
the integrated checks; it did not change runtime behavior.

No installed Companion window, Chrome, Whale, PiP interaction, or live-site
surface was exercised during the refactor handoff. Those surfaces remain
`NOT_RUN`; no `INCIDENTS.md` or `SITE_QA_LOG.md` claim was added.

## Stop conditions

Pause the refactor when any of the following is true:

- the other session still owns or changes an overlapping file or artifact;
- the final baseline or version lineage is unclear;
- a protocol or disk-ABI field changes during a behavior-neutral extraction;
- host and GUI versions are inconsistent while a shared contract is changing;
- JS and PowerShell package allowlists diverge;
- local tests are green only because a failing path or legacy distinction was
  skipped;
- a single-site failure proposes a shared transport change without a second
  unrelated reproduction or protocol-level fixture;
- CI, source-text assertions, static screenshots, or detection-only smoke are
  the sole evidence for a runtime behavior claim.

## Change-set and rollback discipline

- Use small, dependency-ordered changes: tests/fixtures, one extraction, then
  verification.
- Do not mix dead-code deletion, protocol changes, and module moves.
- Preserve unrelated dirty work and never use destructive Git cleanup to obtain
  a clean baseline.
- If a phase fails, revert only that phase's owned files or repair it in place;
  do not roll back the other session's work.
- Preserve the last known-good staging artifact until the new staging build and
  relevant live checks complete.
- Update `INCIDENTS.md` only for actual bug fixes and `SITE_QA_LOG.md` only for
  real browser checks. Planning and file movement alone create neither claim.

## Completion criteria

The refactor is complete when:

1. the shipped extension graph is explicit and contains no execution fallback;
2. the native host is modular while preserving protocol and disk ABI;
3. host and GUI share one tested disk-contract implementation;
4. extension entry points are split by ownership with behavior tests at their
   boundaries;
5. packaging has one allowlist source and legacy code cannot re-enter staging;
6. manager responsibilities are separated without changing player/PiP native
   ownership;
7. deterministic suites pass locally on Windows and required Chrome/Whale/live
   surfaces have evidence in the appropriate logs;
8. version, staging, incident, and QA claims follow the repository handoff
   policy.
