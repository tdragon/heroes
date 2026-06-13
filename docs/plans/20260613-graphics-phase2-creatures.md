# Graphics Phase 2 — Creature seal tokens & the horseman hero marker

## Overview

Second phase of the Gilded Woodcut visual language (concept:
`docs/design/graphics-concept.html`, ledger folio vii "phase ii · the pieces").
Replaces the placeholder circle/shield tokens with the heraldic **seal**: a
parchment disc + double ink ring + gold tier pips + a player-color banner
notch, carrying a creature emblem; and the **mounted-horseman** hero marker
whose swallow-tail banner carries the player color and the hero's initial.

- Problem: creatures render as a flat colored circle with initials + a numeric
  tier; heroes as a colored shield with a letter. No faction/identity, and
  combat still uses the plain tokens entirely.
- Scope (decided): build the seal/horseman **framework** and port the **9
  emblems already drawn in the concept**; the other 42 creatures fall back to
  initials-on-seal until a later batch (phase 2b). Wire emblems into **both**
  the adventure map and the combat hex grid.
- Benefit: one emblem serves adventure monsters, combat stacks (and later town
  garrison/recruit views) — the payoff of the phase-1 atlas infrastructure.
- Integration: entirely behind the existing `Painter` interface +
  `SpriteAtlas`; `src/core/` and determinism untouched.

## Context (from discovery)

- `src/render/painter.ts` — `Painter` interface + `TokenPainter`.
  `creatureToken(ctx, cx, cy, r, color, initials, tier)` and
  `heroToken(ctx, cx, cy, r, color, initial)` are the swap points.
- `src/render/spritePainter.ts` — wraps `TokenPainter`; currently delegates
  `creatureToken`/`heroToken` straight through (lines ~138/150).
- `src/render/spriteAtlas.ts` — static SVG→bitmap, `get(key)`, injectable
  rasterizer; `RASTER_PX = 64`. No per-instance color support (by design).
- `src/assets/themes/woodcut/index.ts` — glob loader, keys `terrain/<id>`,
  `road/<id>`, `roadend/<id>` from `./terrain/*.svg` filename prefixes.
- Call sites passing the creature: `adventureRenderer.ts:172-181` (wandering
  monster, has `obj.creature` id + looked-up `creature`) and
  `combatRenderer.ts:449-457` (stack, has `creature`). `heroToken` at
  `adventureRenderer.ts:252` (color + initial).
- **Combat does NOT use sprites today**: `combatScreen.ts:119` builds
  `new CombatRenderer(ctx, new TokenPainter(), data)`. The adventure shared
  atlas lives in `adventureScreen.ts` as module-level `sharedAtlas` /
  `woodcutAtlas()`.
- Town/hero **recruit & garrison lists are DOM**, not canvas
  (`townScreen.ts`) — out of scope here (a later DOM-emblem phase).
- Concept emblems to port (symbol → creature id): `u-pikeman`→`pikeman`,
  `u-griffin`→`griffin`, `u-archangel`→`archangel`, `u-centaur`→`centaur`,
  `u-woodelf`→`wood_elf`, `u-golddragon`→`gold_dragon`, `u-skeleton`→`skeleton`,
  `u-vampire`→`vampire`, `u-bonedragon`→`bone_dragon`; `u-horseman`→`hero/horseman`.
  Seal disc, double ink ring and tier pips are drawn procedurally (per-instance),
  not ported as sprites.
- Tests: Vitest **node** env (no DOM globals — string-based SVG checks, recording
  context stubs); Playwright e2e; `npm run check` gate; combat e2e uses
  `/?map=combat-arena&seed=5`.

## Development Approach

- **testing approach**: Regular (code first, then tests in the same task)
- complete each task fully before the next; small focused changes
- **CRITICAL: every task ships its tests** (success + error), as separate
  checklist items; **all tests pass before the next task**
- **CRITICAL: update this plan when scope changes during implementation**
- maintain backward compatibility: `TokenPainter` stays the fallback;
  un-arted creatures and missing/pending bitmaps render initials-on-seal

## Testing Strategy

- **unit tests**: emblem loader coverage (the 9 keys exist; every present
  `creature/<id>` maps to a real creature id), string SVG sanity; seal
  furniture geometry via recording 2D-context stub (pip count == tier, banner
  notch uses owner color, emblem-bitmap path vs initials fallback); horseman
  banner color + letter; combat painter wiring
- **e2e**: adventure monster seal renders (sprites-ready, no console errors);
  combat stacks render emblems on `combat-arena`; existing e2e stays green
- **determinism**: no `src/core/` changes; golden replay tests untouched

## Progress Tracking

- mark `[x]` immediately when done; `➕` for newly discovered tasks; `⚠️` for
  blockers; keep this file in sync with actual work

## Solution Overview

The emblem art is a **static** bitmap (atlas, key `creature/<id>` and
`hero/horseman`). Everything per-instance — the seal disc, double ink ring,
gold tier pips (1..7), the banner notch in the owner color, and the hero
banner's color fill + letter — is drawn **procedurally** on the canvas by
`SpritePainter` around/under the blitted emblem. This keeps the atlas static
(one bitmap per creature, shared by all stacks/owners) while ownership, tier
and the hero letter stay dynamic.

Key decisions:

- **Pass the creature id through `creatureToken`** (like terrain got `id` in
  phase 1): `creatureToken(ctx, cx, cy, r, color, id, initials, tier)`. The
  painter looks up `creature/${id}`; `initials` remains the fallback label.
  `TokenPainter` ignores `id` (current look unchanged).
- **Fallback chain**: emblem bitmap → (missing/pending) initials centered on
  the seal. The seal furniture always draws, so even un-arted creatures get the
  parchment-disc upgrade.
- **One shared atlas across screens**: relocate `sharedAtlas`/`woodcutAtlas()`
  out of `adventureScreen.ts` into a neutral `src/render/woodcutTheme.ts` so
  the combat screen reuses the same rasterized bitmaps (no second rasterization,
  no `combatScreen → adventureScreen` dependency).
- **Hero horseman is one static sprite** for all heroes/classes; the banner
  color + letter are procedural. Class-specific portraits remain a later phase.
- **Single new theme folder** `creatures/` + `heroes/`; the loader globs
  `./*/*.svg` and derives the category from the folder (terrain keeps its
  `road.`/`roadend.` filename special-case).

## Technical Details

- Sprite keys: `creature/<id>` (e.g. `creature/gold_dragon`), `hero/horseman`.
  Filenames: `creatures/<id>.svg`, `heroes/horseman.svg`.
- Loader: switch the glob to `import.meta.glob('./*/*.svg', …)`; `spriteKey`
  derives category from the parent folder — `creatures`→`creature`,
  `heroes`→`hero`, `terrain`→`terrain` (with the existing `road.`/`roadend.`
  prefix special-case retained).
- `Painter` interface change (mechanical, all implementers + 2 call sites):
  `creatureToken(ctx, cx, cy, r, color, id: string, initials: string, tier: number)`.
  `heroToken` signature is unchanged (already carries color + initial).
- Seal furniture geometry (procedural, in `SpritePainter`): parchment disc
  radius `r`; double ink ring (thick outer + hairline inner); emblem bitmap
  blitted centered at ~`1.5*r` square; `tier` gold diamond pips along the lower
  arc; banner notch (a small chevron) at the bottom filled with `color`
  (owner) — neutral grey for unowned. Constants named, not magic.
- Horseman: blit `hero/horseman` bitmap at the token box; fill the banner
  region with `color` and draw the `initial` in parchment over it
  (procedural, since color+letter are per-instance). Fallback: `TokenPainter`
  shield when the bitmap is missing.
- Combat: `combatScreen.ts` builds `new CombatRenderer(ctx, woodcutSpritePainter(), data)`
  using the shared atlas; set `data-sprites-ready` on the combat canvas when the
  atlas resolves (mirrors the adventure screen), guarded against teardown.
- Emblem coverage test must **not** require all 51 — assert (a) the 9 ported
  keys exist, and (b) every `creature/*` key present maps to a real
  `GameData.creatures` id (catches typos/renames without blocking the 42
  un-arted creatures).

## What Goes Where

- **Implementation Steps**: all code/asset/test changes in this repo
- **Post-Completion**: visual sign-off in a real browser; the remaining 42
  emblems (phase 2b); town/hero DOM emblem integration

## Implementation Steps

### Task 1: Theme assets — 9 creature emblems + horseman + loader keys

**Files:**
- Create: `src/assets/themes/woodcut/creatures/pikeman.svg` (+ `griffin`,
  `archangel`, `centaur`, `wood_elf`, `gold_dragon`, `skeleton`, `vampire`,
  `bone_dragon` — 9 files)
- Create: `src/assets/themes/woodcut/heroes/horseman.svg`
- Modify: `src/assets/themes/woodcut/index.ts` (glob `./*/*.svg`, folder→category)
- Modify: `src/assets/themes/woodcut/index.test.ts`

- [x] port the 9 creature `<symbol>`s + `u-horseman` from
      `docs/design/graphics-concept.html` into standalone 64×64 SVGs — the
      emblem art only (no seal disc/ring/pips; those are procedural)
- [x] **CRITICAL: inline the `.s`/`.s2`/`.shdw` classes as presentation
      attributes** (the standalone files have no `<style>` block, and `.shdw`
      elements carry no inline fill — dropping the class would render the
      drop-shadow solid black and remove every ink outline). Map:
      `.s` → `stroke="#241b16" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"`,
      `.s2` → same with `stroke-width="2.2"`, `.shdw` → `fill="rgba(20,14,10,0.26)"`.
      The element's own `fill=` is kept; the result has no `class=`.
- [x] update the loader to glob `./*/*.svg` and key by folder
      (`creatures/<id>`→`creature/<id>`, `heroes/<n>`→`hero/<n>`, terrain
      unchanged incl. `road.`/`roadend.`)
- [x] coverage test: the 9 `creature/<id>` keys + `hero/horseman` exist, and
      every `creature/*` key maps to a real `GameData.creatures` id
- [x] update key-format regex to
      `^(terrain|road|roadend|creature|hero)\/[a-z][a-z0-9_]*$` (verify
      `horseman`, `wood_elf`, `gold_dragon`, `bone_dragon` all match); string
      SVG sanity (viewBox 64×64, `<svg>…</svg>`, no `class=`) covers new files
- [x] run `npm test` — must pass before task 2

### Task 2: Relocate the shared woodcut atlas to a neutral module

**Files:**
- Create: `src/render/woodcutTheme.ts` (shared `SpriteAtlas` singleton + a
  `woodcutSpritePainter(fallback)` helper)
- Modify: `src/app/adventureScreen.ts` (import the shared atlas/painter)
- Create: `src/render/woodcutTheme.test.ts`

- [ ] move `sharedAtlas`/`woodcutAtlas()` from `adventureScreen.ts` into
      `woodcutTheme.ts` (constructs `SpriteAtlas(woodcutSprites, rasterizeSvg)`
      once, memoized); export a helper that wraps it in a `SpritePainter`
- [ ] update `adventureScreen.ts` to use the shared module (behavior identical:
      same atlas, same `data-sprites-ready` + redraw on load)
- [ ] test: `woodcutAtlas()` returns the same instance across calls (the new
      singleton behavior; `SpriteAtlas.load()` is already memoized via
      `loadPromise ??=`, so just confirm one shared atlas, not new memoization)
- [ ] run `npm test` — must pass before task 3

### Task 3: Seal token framework — `creatureToken`

**Files:**
- Modify: `src/render/painter.ts` (interface + `TokenPainter` signature)
- Modify: `src/render/spritePainter.ts` (seal furniture + emblem blit)
- Modify: `src/render/adventureRenderer.ts` (pass `obj.creature` id)
- Modify: `src/render/combatRenderer.ts` (pass `creature.id`)
- Modify: `src/render/spritePainter.test.ts`, `src/render/testSupport.ts`

- [ ] add `id` to `Painter.creatureToken`; update `TokenPainter` (ignores id —
      current circle look unchanged) and both call sites
- [ ] implement `SpritePainter.creatureToken`: draw parchment disc + double ink
      ring + `tier` gold pips + banner notch in `color`; blit `creature/${id}`
      centered; fall back to centered `initials` text when the bitmap is missing
- [ ] name all furniture constants (disc/ring radii, pip size, notch size)
- [ ] tests (recording-context stub): emblem-present path (drawImage of the
      right key + furniture), fallback path (no bitmap → initials text + furniture),
      pip count == tier, banner notch uses the owner color, neutral color path
- [ ] run `npm test` — must pass before task 4

### Task 4: Horseman hero marker — `heroToken`

**Files:**
- Modify: `src/render/spritePainter.ts`
- Modify: `src/render/spritePainter.test.ts`

- [ ] implement `SpritePainter.heroToken`: blit `hero/horseman`; fill the
      banner region with `color` and draw `initial` (single char, passed
      verbatim) in parchment over it; fall back to `TokenPainter` shield when
      the bitmap is missing
- [ ] note the layering: `adventureRenderer.ts:249` draws `selectionRing` at
      `rect.size*0.48` before `heroToken` at `rect.size*0.36` — verify the
      horseman's banner fits within the ring radius (or accept the overlap
      explicitly) so the banner isn't clipped for the selected hero
- [ ] tests: bitmap path (drawImage `hero/horseman` + banner fill `color` +
      letter), fallback path delegates to the wrapped painter
- [ ] run `npm test` — must pass before task 5

### Task 5: Combat renders emblems via the shared SpritePainter

**Files:**
- Modify: `src/ui/combatScreen.ts`
- Modify: `src/render/combatRenderer.ts` (badge/ring/wide-stack reconciliation)
- Modify: `src/render/combatRenderer.test.ts` (painter-injection assertion)

- [ ] build the combat renderer with `woodcutSpritePainter(new TokenPainter())`
      (shared atlas) instead of a bare `TokenPainter`
- [ ] reconcile the renderer-drawn furniture with the seal token: the count
      badge anchored at `center.x + r*0.4, center.y + r*0.55`
      (`combatRenderer.ts:461-477`) and the `selectionRing` at `r+4` (`:459`)
      were tuned for the round token — adjust so they don't collide with the
      seal's bottom banner notch / lower-arc pips; verify wide creatures
      (`r = HEX_R*0.85`, tween-aware center at `:439-447`) center correctly
- [ ] set `data-sprites-ready` on the `combat-canvas` when the atlas resolves,
      guarding the `load().then` callback with the screen's teardown signal
      (`this.running` / `dprAborter`, per `destroy()` at `combatScreen.ts:176`);
      the combat frame loop already repaints continuously, so no explicit
      markDirty is needed
- [ ] confirm the DOM stack strip (`combat-stacks`) is untouched (canvas-only
      change)
- [ ] test in `combatRenderer.test.ts`: stacks draw via the injected painter
      (recording-painter stub receives `creatureToken` with the creature id)
- [ ] run `npm test` — must pass before task 6

### Task 6: e2e — emblems on the adventure map and the combat grid

**Files:**
- Modify: `e2e/adventure.spec.ts` (or the combat spec)

- [ ] adventure smoke: a wandering-monster tile shows the emblem (sprites-ready,
      no console errors), existing flows unchanged
- [ ] combat smoke on `/?map=combat-arena&seed=5`: canvas reaches
      `data-sprites-ready`, stacks render without console errors
- [ ] run `npm run test:e2e` — must pass before task 7

### Task 7: Verify acceptance criteria

- [ ] the 9 emblems render on adventure monsters and combat stacks; un-arted
      creatures show initials-on-seal; heroes show the banner horseman with the
      right player color + letter (manual check via `npm run dev` + screenshot,
      plus e2e green)
- [ ] tier pips match creature tier; banner notch matches owner color
- [ ] golden replay tests pass untouched; minimap unchanged
- [ ] run full gate: `npm run check`; coverage for `src/core/` still ≥ 80%

### Task 8: [Final] Update documentation

- [ ] README "Themes & sprites": document `creatures/<id>.svg`→`creature/<id>`
      and `heroes/horseman.svg`→`hero/horseman` keys, the procedural-furniture
      split, and the initials-on-seal fallback
- [ ] note the remaining 42 emblems as phase 2b (faction batches)
- [ ] move this plan to `docs/plans/completed/`

## Post-Completion

**Manual verification:**
- browser sign-off: emblems at adventure zoom and combat scale; banner color
  per player; tier pips legible; the 24 px adventure read still works
- confirm the seal disc reads against every terrain (incl. fog dimming)
- hiDPI/zoomed-in check: the 64 px emblem blitted small then upscaled (combat
  on a small viewport, or map zoom-in) should not soften unacceptably

**Future phases (not in scope):**
- phase 2b: remaining 42 creature emblems (Castle/Rampart/Necropolis/Neutral
  batches), each verified visually
- town/hero **DOM** lists: inline-SVG emblems in recruit/garrison rows
- phase iii: map objects + resource icons
