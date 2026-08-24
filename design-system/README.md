# Aura Media Companion — design system

Source of truth: Figma file `hHbERxUjJeaWJ3eYFM1UlA`
(<https://www.figma.com/design/hHbERxUjJeaWJ3eYFM1UlA>), team `coseung2`.
This folder is an exported snapshot for implementation. When the Figma file
changes, re-export instead of editing these values by hand.

Snapshot date: 2026-08-24.

## Contents

```
design-system/
  tokens/tokens.json          variable collections, exact values and aliases
  tokens/tokens.css           same tokens as CSS custom properties
  components/components.json  component inventory with node ids and slots
  components/component-board.png
  foundations/foundations.png
  screens/queue.png
  screens/library.png
  screens/player.png
  screens/subtitles.png
  screens/settings.png
```

## Theme

Light only. White surfaces on a light gray canvas, near-black ink for emphasis.
There is no dark navy or blue accent: the primary action, progress fill, and
active toggle all use `color/bg/inverse` (`#17191D`).

Status color is the single exception. `Complete`, `Paused`, and `Failed` keep
green, amber, and red at low-saturation tints because removing them would leave
job state distinguishable by label text alone.

## Tokens

Four Figma collections, exported in `tokens/tokens.json`:

| Collection | Modes | Count | Notes |
| --- | --- | --- | --- |
| Primitives | Value | 17 | Raw hex only, scopes hidden, never referenced by a component directly |
| Color | Light | 21 | Semantic aliases to Primitives, scoped per usage |
| Spacing | Value | 10 | 2 through 40 |
| Radius | Value | 5 | sm 6, md 8, lg 12, xl 16, full 999 |

Every semantic variable carries WEB code syntax matching the CSS custom
property name in `tokens/tokens.css`, so `color/bg/surface` in Figma maps to
`var(--color-bg-surface)` in code.

## Typography

Nine text styles: `Heading/lg|md|sm`, `Body/md|strong|sm`, `Label/md|sm`,
`Mono/sm`. `Mono/sm` is a tabular-feeling label used for byte counts, paths,
timecodes, and version strings.

The Figma file renders in Inter because Segoe UI is not available in that
environment. The Windows implementation should use
`Segoe UI Variable Text, Segoe UI, Malgun Gothic, sans-serif`, already set as
`--font-family-ui`. Metrics differ slightly between the two families, so check
line lengths in narrow columns after switching.

## Components

22 components on the `Components` page, listed with node ids in
`components/components.json`.

- Buttons: Primary, Secondary, Quiet
- Status: Downloading, Complete, Paused, Failed
- Media type: HLS, DASH, MP4, SRT
- Navigation: NavItem Selected/Default, SegmentTab Selected/Default
- Input and control: TextField, ProgressBar, Toggle On/Off
- Composed: JobCard, MediaTile, SettingRow

Buttons, chips, and nav items hug their content height. Do not set a fixed
height on them inside an auto-layout parent; they will stretch.

`MediaTile` is intentionally chrome-free. The 16:9 thumbnail is the object and
the title plus metadata sit directly on the canvas beneath it. Item separation
comes from spacing (16 horizontal, 24 vertical in the Library grid), not from a
card border.

`ProgressBar` progress is expressed by resizing the inner `Fill` child. The
track keeps its own width.

## Screens

Five screens at 1280x929 on the `Screens` page, each built from the same shell:
232px left rail with brand, five destinations, and a companion-link status
block; content column at 28px padding.

| Screen | Primary job |
| --- | --- |
| Queue | Active and paused download jobs, filters, per-row progress |
| Library | Saved media grid, full-bleed thumbnails, search |
| Player | Local playback, scrubber, track and speed state, up-next row |
| Subtitles | Generate, import, output folder, per-job stage and failure reason |
| Settings | Folders, download policy, companion link status |

The Subtitles screen intentionally shows a real failure: `Failed` +
"Folder not writable" + `Retry`, matching the case where a track was generated
but the output folder could not be written.

## Known gaps

- Thumbnails are gray placeholders. No real frame captures are embedded yet.
- Light mode only. The Color collection has a single `Light` mode, so adding
  dark later means adding a mode, not renaming values.
- No icon set. Nav items use a small dot as a placeholder marker.
- No Code Connect mappings, and no component descriptions in Figma beyond the
  usage notes captured here.
- Screens are desktop width only. Narrow-window behavior for the rail and the
  Library grid is undefined.

## Scope note

This is design reference only. It does not change extension or companion
runtime behavior, and nothing here has been wired into the build.
