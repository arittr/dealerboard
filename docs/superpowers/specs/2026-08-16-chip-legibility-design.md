# Provider chip legibility on the LCD panel

Date: 2026-08-16
Status: approved by user (design presented in chat, palette option "rotate the colliders" chosen)

## Problem

On the physical Stream Deck LCD, three provider chips sit in the same blue
family and read as near-identical at 144px: codex `#A855F7` (purple drifts
blue at that size), zcode `#49A1E8`, deepseek `#426EFE`, with kimi `#3B82F6`
beside them. The derived two-letter marks (`provider.slice(0, 2)` → CL, CO,
KI, PI, OM, ZC, DE) are also cramped inside the 38x26 chip.

## Decisions

**One-letter marks.** Replace the derived abbreviation with an explicit
`PROVIDER_LETTERS: Record<Provider, string>` in `src/plugin/render.ts`:

| provider  | mark |
| --------- | ---- |
| claude    | C    |
| codex     | X    |
| kimi      | K    |
| pi        | P    |
| omp       | O    |
| zcode     | Z    |
| deepseek  | D    |

Chip geometry is unchanged (38x26 rect, font-size 20, centered dark letter).
If the single letter reads small on the panel, a mark font bump is a
deliberate follow-up, not part of this change.

**Palette rotation** — move only the blue-family colliders; keep the four
hues that already read distinctly:

| provider  | old       | new       | hue        |
| --------- | --------- | --------- | ---------- |
| claude    | `#D97757` | `#D97757` | terracotta (unchanged) |
| codex     | `#A855F7` | `#D946EF` | fuchsia    |
| kimi      | `#3B82F6` | `#3B82F6` | blue (unchanged) |
| pi        | `#0EA514` | `#0EA514` | green (unchanged) |
| omp       | `#F5F0EA` | `#F5F0EA` | cream (unchanged) |
| zcode     | `#49A1E8` | `#EAB308` | gold       |
| deepseek  | `#426EFE` | `#2DD4BF` | teal       |

Status frame colors (working cyan, waiting amber, idle green, error red) and
`COLOR_NEUTRAL` are untouched; chips remain a small corner block with a
letter, visually distinct from full-tile frames.

## Non-goals

- No geometry, animation, or layout changes.
- No daemon/protocol changes — plugin-only render surface.

## Files

- `src/plugin/render.ts` — `PROVIDER_COLORS` values, new `PROVIDER_LETTERS`,
  `providerMark` reads the letter map, module docstring updated.
- `test/render.test.ts` — mark and chip-color assertions updated to the new
  contract (they remain the regression guards).
- `docs/design.md` — tile contract wording (two-letter → one-letter, hues).
- `AGENTS.md` — conventions entry for chip colors/marks.
- `com.drewritter.stream-deck-agents.sdPlugin/manifest.json` — Version
  0.3.0.0 → 0.3.1.0 so the Stream Deck app accepts the updated bundle.

## Deploy sequencing

Deploy (`build:plugin` + copy + plugin restart; daemon untouched) happens
after the P1 zcode live-verification run completes: that run's own
`install-local.ts` from its worktree would otherwise overwrite the deployed
bundle with one lacking this change.
