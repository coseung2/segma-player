# Segma Player refactoring plan

## Status

**IN PROGRESS — phases that do not overlap the in-flight Companion GUI/PiP
work may proceed. Phase 6 and every edit to the files owned by that session
remain blocked until the user confirms the PiP work is finished.**

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

These paths and versions are a snapshot, not an implementation baseline. They
must be re-read after the other session finishes. This planning pass changed no
runtime code, staging artifact, installer, or browser state.

## Progress tracking

Update this table and the relevant phase notes in the same commit that finishes
each phase. A phase is not complete until its checks and known gaps are recorded.

| Phase | Status | Completion evidence |
| --- | --- | --- |
| 0. Stable baseline | Complete for non-GUI scope | 2026-08-30 baseline below; GUI baseline deferred |
| 1. Trustworthy tests and frozen contracts | Complete | Shared protocol/disk fixtures; 2026-08-30 checks below |
| 2. Native-host module split | Pending | Pending |
| 3. Shared host/GUI disk contract | Pending | Pending |
| 4. Shipped extension split | Pending | Pending |
| 5. Packaging and retired runtime | Pending | Pending |
| 6. Native manager split | Blocked on PiP session | User confirmation required |
| 7. Integrated validation and handoff | Pending | Pending |

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

The source of truth for the packaged extension is `STORE_RUNTIME_FILES` in
`scripts/build-dev-staging.mjs`. The active flow is:

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

Examples of source that is present but not in the current staging allowlist
include `hls-download.js`, `download-worker.js`, `player.js`,
`playback-session.js`, `native-file-writer.js`, `save-directory.js`, and the
transport implementations under `downloaders/` other than `ids.js`. These are
transitional or compatibility surfaces until reachability and installed-client
compatibility are proved. Their tests do not prove the shipped connector path.

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

#### Phase 2 result — 2026-08-30

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
- Local subtitle path/audio command primitives and title encoding now live in
  `subtitle.rs`; the long-running transport/state orchestration remains in
  `main.rs` until a later behavior-preserving follow-up has an independent
  executable seam.
- Legacy `media-open/chunk/close/abort/suspend` chunk decoding, persistence
  thresholds, and progress calculation are isolated in `legacy_writer.rs`;
  dispatch stays in `main.rs` to preserve reply and manager-launch behavior.
- Host-side fixture checks now cover every disk ABI filename, current and
  legacy job-state deserialization/serialization, the real hello body, and
  `requestId` reply correlation. Source-text architecture checks were narrowed
  to the retired Win32 per-job UI invariant; Rust behavior tests own the moved
  process and disk contracts.

Validation at this checkpoint: native-host 52 passed; focused Companion
architecture/client 21 passed; Cargo check and Rust formatting passed;
development staging refreshed with 54 files at `0.4.56`. No live installed
Native Messaging or browser flow is claimed by this refactor phase.

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
