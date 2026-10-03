---
name: segma-player-ux-audit
description: Audit and improve Segma Player UX with qualitative state-truth review and quantitative interaction, latency, recovery, and continuity measurements across the browser extension, Tauri Companion, player, subtitles, downloads, and cloud library.
metadata:
  short-description: Segma Player UX 정량·정성 감사
---

# Segma Player UX audit

Use this skill for UX review, simplification, redesign, or implementation work in
Segma Player. It combines two kinds of evidence:

- **정성 평가:** whether the interface follows the user's mental model, exposes
  truthful state, provides the right recovery action, and keeps the browser
  extension, Companion, player, subtitles, and cloud library boundaries clear.
- **정량 평가:** KLM interaction cost plus measured media latency, recovery,
  reliability, state accuracy, and context retention.

Do not replace one with the other. A fast flow that claims a download is complete
before the file exists is a P0 defect; a truthful flow with two unnecessary forced
decisions is a measurable UX regression.

## Product boundary

Treat the current architecture as authoritative:

- The browser extension detects media, accepts link input, and hands off bounded
  intent. It is not the desktop job manager, player, subtitle editor, or cloud
  credential holder.
- The Tauri Companion owns persistent jobs, local files, playback, subtitles,
  settings, and cloud job execution.
- Local file state, download job state, playback state, subtitle state, and cloud
  state are separate state machines. Do not collapse them into one generic
  `ready`, `active`, or `connected` label.
- A user-visible success state requires the authoritative operation to have
  completed. A button callback, accepted job, uploaded catalog row, or optimistic
  state is not completion by itself.

## Read before judging a flow

Use this order and read only the documents relevant to the target:

1. `AGENTS.md` and any nested instructions.
2. `PRODUCT_DIRECTION.md` and `TAURI_MIGRATION_SPEC.md`.
3. `companion-tauri/README.md` and the relevant `design-system/` snapshot.
4. The rendered Svelte route and its stores.
5. The Tauri command, DTO, persistence, and job runner behind each important
   action.
6. Tests, incidents, and live verification records when they explain an
   intentional boundary or previous regression.

When `.codegraph/` exists, use CodeGraph before broad text search or manual code
navigation. Do not infer product rules from fixtures, current file counts, or
incidental catalog data.

## Journey contract

Start every audit with one concrete user goal and one persona:

| Persona | Typical goal | Main surfaces |
|---|---|---|
| Browser downloader | Detect a video and send it to Segma Player | Extension popup, current tab |
| Download manager | Complete, retry, pause, or locate a file | Queue |
| Media librarian | Find, organize, play, or delete local media | Library |
| Viewer | Start, seek, fullscreen, PiP, or resume playback | Player |
| Subtitle editor | Import, generate, select, or synchronize subtitles | Subtitles, Player |
| Cloud librarian | Upload, download, or remove a remote copy | Library > Telegram |

Record:

- persona and surface
- user goal in plain language
- entry state and preconditions
- actual interaction path
- system-owned preparation and latency
- authoritative state transitions
- completion evidence
- error, retry, cancel, and restart behavior
- exit behavior and cleanup owner

Use this state shape where applicable:

`entry → preparing → actionable → running → paused/reconnecting → completed | failed | cancelled → retained/removed`

Mark who owns every transition. If the UI can show an impossible state, such as
`completed` while the output is missing or `retry` while no retry can succeed,
report that as a finding.

## Qualitative review

Review the whole journey before polishing an individual component.

### State truth and lifecycle

- Distinguish detected, handed off, queued, running, paused, completed, failed,
  cancelled, expired, and output-available states.
- Trace the authoritative mutation, persistence boundary, invalidation/update,
  and recovery path for every status shown to the user.
- Check cleanup after cancel, delete, recycle, crash, restart, expired media
  URLs, failed cloud operations, and missing local files.
- Keep local library visibility, job history, and cloud catalog visibility
  consistent with their separate lifecycle rules.

### Boundary and mental model

- Do not expose native host protocol details, job IDs, runner locks, catalog
  schema, routine polling, or cache terminology unless the user must act on it.
- Keep browser handoff, Companion execution, and cloud storage understandable as
  one user goal even when the implementation uses multiple processes.
- Do not silently turn a local operation into a cloud upload.
- Keep credentials, tokenized media URLs, and internal identifiers out of UI copy.

### Interaction and hierarchy

- Identify one primary action per task region.
- Remove explanatory copy that merely repeats a visible label or status.
- Keep confirmation only for destructive, irreversible, privacy-sensitive, or
  genuinely ambiguous decisions.
- Treat refresh, sync, prepare, and reconcile as state unless the user has a real
  choice about when to perform them. If automatic refresh would move selection or
  scroll, use a stable `새 항목` or `변경 사항 있음` affordance.
- Check long Korean titles, missing thumbnails, long paths, zero-byte files,
  unknown duration, large subtitle text, and unavailable cloud agents.

### Media continuity

- Preserve selected media, playback position, subtitle track, seek preview,
  fullscreen/PiP context, and scroll position through refresh or recovery where
  the product contract permits it.
- Separate first load, background refresh, pending mutation, reconnecting,
  offline, recoverable error, and terminal error.
- Do not claim playback-ready before the media source is actually prepared.
- For subtitles, distinguish no track, unsupported format, readable track,
  generation pending, sync pending, and sync failure.
- For Telegram, distinguish local catalog presence, remote upload completion,
  remote download materialization, and remote deletion success.

### Accessibility and responsive behavior

- Check semantic names, keyboard focus, focus restoration after dialogs and async
  jobs, contrast, non-color state cues, text scaling, reduced motion, and icon
  labels.
- Review compact, medium, and wide desktop layouts. Check rail collapse,
  player controls, nested scrolling, modal cut-off, and reachability of retry,
  cancel, and file actions.

## Quantitative review

### 1. KLM interaction cost

Use the bundled scorer at `scripts/klm_score.py`.

| Operator | Meaning | Seconds |
|---|---|---:|
| `M` | mental preparation / decision | 1.35 |
| `P` | pointer movement | 1.10 |
| `B` | mouse or touch press | 0.10 |
| `K` | keyboard input | 0.20 |
| `H` | keyboard and pointer hand movement | 0.40 |

Score the actual path and the shortest defensible path. Report `ΔM` first and
seconds second. Use ratios for comparison; KLM is an expert, error-free model and
does not include network or processing latency.

```powershell
python .codex/skills/segma-player-ux-audit/scripts/klm_score.py selftest
python .codex/skills/segma-player-ux-audit/scripts/klm_score.py score `
  "M P B" `
  "M P B M P B" `
  --label "direct" "extra-confirm"
python .codex/skills/segma-player-ux-audit/scripts/klm_score.py steps `
  "미디어 선택=MPB" `
  "다운로드 시작=MPB" `
  "재시도=MPB"
```

Never report an illustrative sequence as measured. Mark code-traced paths,
real-browser walks, and user-observed paths separately.

### 2. Segma media metrics

Capture timestamps from the same run where possible:

- `T_handoff`: user action to Companion acceptance.
- `T_start`: acceptance to actual job execution.
- `T_ready`: job start to output available or first playable frame.
- `T_recover`: error recognition to authoritative successful recovery.
- `completion_rate`: completed jobs / started jobs.
- `recovery_rate`: successful retries / retry attempts.
- `state_truth_rate`: user-visible terminal states matching authoritative state.
- `context_retention_rate`: preserved selection, position, subtitle, and scroll
  context after refresh/retry/restart / applicable transitions.

Compare the same flow before and after. Do not invent universal millisecond
thresholds: use baseline, regression delta, sample size, environment, and the
observed failure mode. Network and provider latency must be reported separately
from interaction cost.

### 3. Combined scorecard

Use one row per persona and goal:

| Goal | Surface | KLM `M` / sec | `T_ready` or `T_recover` | completion / recovery | state truth | context retention | qualitative 0–4 | severity |
|---|---|---:|---:|---:|---:|---:|---:|---|

Rate qualitative quality only with evidence:

- `0` absent, misleading, or impossible to complete
- `1` technically available but confusing or fragile
- `2` usable with repeated friction or weak recovery
- `3` clear, truthful, and recoverable
- `4` direct, stable, context-preserving, and appropriately adaptive

Do not average away a critical defect. Any wrong-result, data-loss, unrecoverable,
or authoritative-state mismatch finding remains P0 regardless of the numeric
average. Use P1 for repeated core-flow friction or significant recovery cost and
P2 for non-blocking hierarchy, copy, or polish issues.

## Excise test

For each measured step, classify it as goal-directed or forced excise. A step is
excise when it is forced on the persona and does not advance that persona's goal.
Name the labour:

- cognitive: deciding when or why to press a system-owned action
- memory: remembering a hidden refresh, retry, or location
- visual: scanning to discover current state or changes
- physical: extra navigation, clicks, or repeated input

The same action can be valid for one persona and excise for another. A user-owned
choice such as selecting a quality or confirming deletion is not excise merely
because it adds a step.

## Report format

Report findings before editing unless the user explicitly asks for implementation.
For each finding include:

- severity, persona, surface, and state
- visible symptom
- qualitative evidence and quantitative evidence
- root cause: UI, state model, persistence, transport, packaging, or contract
- recommended user-facing behavior
- local versus cross-cutting scope
- verification status: code-traced, deterministic test, real app, or real site

Then provide:

1. the scorecard table
2. state-transition and lifecycle gaps
3. safe simplifications and removed excise
4. cross-cutting fixes
5. product decisions that must not be guessed
6. remaining live verification gaps

When code changes are requested, add a regression test for the user-visible
failure, preserve authoritative boundaries, run focused checks, and verify the
real Companion or browser surface. A unit test alone cannot close a live UX gate.

