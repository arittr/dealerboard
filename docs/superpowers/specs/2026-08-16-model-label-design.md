# Session model label on tiles

Date: 2026-08-16
Status: approved by user (design presented in chat; label format "strip vendor prefixes" chosen; SDD execution chosen)

## Problem

Tiles show the provider chip (`[ K ]`) but not the model driving the
session. With the same harness running different models (e.g. Codex on
`gpt-5.6-luna` vs `gpt-5.6-sol`, pi on `zai/glm-5.3`), the grid cannot tell
them apart. Target rendering: `[ K ] k3`.

## Data availability (probed 2026-08-16)

- **Kimi — push.** The SessionStart hook payload carries `model` (and
  `profile`) per the official hook docs. UserPromptSubmit does NOT carry it,
  so a session whose SessionStart was missed shows no model for its lifetime.
  Acceptable: best-effort.
- **Claude — pull.** Transcript JSONL assistant records carry
  `"model":"claude-fable-5"` (verified on a live transcript). The title
  resolver already tail-reads this file; one read serves both facts.
- **Codex — pull.** `session_index.jsonl` has no model field, but the rollout
  JSONL at the row's `transcript_path` carries `"model":"gpt-5.6-luna"`
  records (verified on a live rollout).
- **zcode — none.** The `session` table in `db.sqlite` has no model column
  (live `PRAGMA table_info(session)` probe). `~/.zcode/cli/config.json`'s
  `model.main` is the configured default, not a per-session fact — using it
  could mislabel, so zcode renders chip-only.
- **pi/omp/deepseek — future.** No hooks yet (P2). The decoder allowlist and
  protocol field make shim adoption a config-side change later.

## Design

### Events and decoding

- `SessionStart` and `SessionObserved` events gain `model: string | null`.
- Decoder `SAFE_FIELDS` gains `model: ["model"]` — same privacy contract
  (allowlisted, bounded to 256 code points).
- Null is sticky-safe: an event carrying `model: null` never clears a stored
  model. This matters because Kimi's UserPromptSubmit late-join events have
  no model field; without the rule they would erase the SessionStart value.

### Registry (schema v6)

- Migration v5 → v6: `ALTER TABLE sessions ADD COLUMN model TEXT` (nullable,
  no default; existing rows become NULL).
- `applyEvent` stores a non-null event model like it stores titles.
- Projection rows carry `model` through to the snapshot.
- The daemon's maintenance resolver writes back resolved models without
  touching `updated_at` (the prune aging signal) — same discipline as titles.

### Snapshot protocol (stays schemaVersion 2)

- `ProjectedSession` gains `model: string | null`.
- `parseSession` validates `model` as a nullable bounded string and treats a
  MISSING key as null. Old plugin + new daemon and new plugin + old daemon
  both work; the lockstep deploy requirement does not tighten.

### Daemon resolver

Extend the existing title resolver pass to also resolve models (one tail read
per transcript serves title and model):

- Claude: the same 64 KiB transcript tail, parsed per line like the ai-title
  scan — complete `assistant` records only, reading the authoritative
  `message.model`; last parsed value wins, malformed or truncated lines skip.
  An unstructured regex over the tail is NOT acceptable: tool-call inputs
  nested inside an assistant record can carry their own `model` argument
  (e.g. a subagent dispatch's model), and a last-occurrence regex would
  resolve the decoy instead of the session model (final-review finding,
  2026-08-16).
- Codex: same per-line parse of the rollout tail at `transcript_path`,
  reading `payload.model` from `turn_context` records only (the turn's actual
  model). Per-path (mtime, size) cache, mirroring the Claude one. Rows without
  a `transcript_path` resolve nothing.
- zcode and Kimi rows are never resolved (no source / hooks push).

A mid-session `/model` switch flips the label because the last authoritative
record in the growing tail changes.

Resolution is additive: a found model is proposed only when it differs from
the stored one; a missing model never clears an existing value.

### Rendering

- New text element right of the chip: `x=56`, `y=32` (chip-letter baseline),
  `text-anchor=start`, `font-size=12`, fill `COLOR_NEUTRAL` (chrome, never a
  status color). Unknown model → element absent.
- Label rule (pure, render-side; the registry stores the raw id):
  1. Strip the first matching leading prefix from
     `["claude-", "gpt-", "zai/", "openai/"]`; if stripping would empty the
     string, keep the raw id.
  2. Cap at 10 code points when the tile shows no descendant badge, and at 6
     code points (5 + `…`) when it does: a badge occupies x≈99–130 in the same
     top band (baseline y=38), and a 10-code-point label starting at x=56 would
     draw through it (measured on the 144px tile; final-review finding,
     2026-08-16 — the earlier "sit close together" claim was wrong).
  Examples (no badge): `claude-fable-5` → `fable-5`, `gpt-5.6-luna` →
  `5.6-luna`, `k3` → `k3`, `zai/glm-5.3` → `glm-5.3`.
- The descendant badge (upper right) keeps its position and precedence; the
  model label yields width to it per the cap rule above.

## Non-goals

- No zcode model display (no data source).
- No pi/omp/deepseek shims (P2 scope).
- No chip geometry or status-color changes.

## Files

- `src/protocol.ts` — event + `ProjectedSession` fields, parser tolerance.
- `src/core/providers.ts` — `SAFE_FIELDS.model`.
- `src/core/registry.ts` — schema v6, `applyEvent`, resolver write-back.
- `src/core/titles.ts` — resolver returns title and/or model updates;
  docstring updated.
- `src/core/daemon.ts` / `src/core/cli.ts` — wiring if the resolver interface
  changes shape.
- `src/plugin/render.ts` — model label element, prefix-strip + cap.
- `test/*` — migration v6, decoder allowlist, resolver model cases (incl.
  last-wins on switch), projection pass-through, snapshot parse tolerance,
  render strip/cap/absent.
- `docs/design.md`, `AGENTS.md`, `docs/hook-configuration.md` (Kimi `model`
  field) — contract docs.
- `com.drewritter.stream-deck-agents.sdPlugin/manifest.json` — Version
  0.4.0.0.

## Deploy

Full `bun scripts/install-local.ts` (core changes; migrates the live DB to
v6). User has pre-authorized installs this session.
