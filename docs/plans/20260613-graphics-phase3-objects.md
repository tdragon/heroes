# Graphics Phase 3 — The Field: map objects & resource icons

## Overview

Third phase of the Gilded Woodcut visual language (concept:
`docs/design/graphics-concept.html`, ledger folio vii "phase iii · the field").
Replaces the placeholder `objectToken` (colored rounded-rect + initials) and the
text-only HUD resource bar with woodcut art: sprites for all **18 map-object
types** and icons for the **7 resources**, on the existing
SpritePainter/SpriteAtlas/woodcut-theme infrastructure.

- Problem: every adventure-map object except creatures (done in phase 2) still
  renders as a colored box with 1–2 letters ("WM", "B", …); the HUD/marketplace
  show resources as plain text.
- Scope (decided): **all 18 object types + 7 resource icons**. Mines and
  resource piles share one base sprite each, distinguished by a small **resource
  pip** (reusing the resource icons) rather than bespoke per-subtype art.
- Benefit: the adventure map becomes fully illustrated and the HUD resource bar
  gains icons; the resource SVGs do double duty (canvas pips + DOM icons).
- Integration: behind the existing `Painter` interface (canvas) plus a small
  inline-SVG injection in the HUD resource bar (DOM); `src/core/` untouched.
- **Marketplace is out of scope**: its resource pickers are `<select>`/`<option>`
  elements, which render content as plain text only (no inline `<svg>`). Adding
  marketplace icons would require redesigning those selectors into custom
  widgets — deferred to a later UI pass.

## Context (from discovery)

- 18 object types (`src/data/objects.json`): `town` (enterable); `mine`
  (flaggable, 7 subtypes sawmill/ore_pit/alchemist_lab/sulfur_dune/
  crystal_cavern/gem_pond/gold_mine, each with an `income` resource);
  `resource`/`treasure_chest`/`artifact` (pickup); `monster` (special — already
  a creature seal, **out of scope**); `dwelling` (flaggable); 9 visitables
  (windmill, water_wheel, mystical_garden, magic_well, fountain_of_fortune,
  rally_flag, learning_stone, school_of_war, observatory); 4 special (sign,
  monolith, prison, obelisk).
- 7 resources (`RESOURCE_IDS` in `src/data/schema.ts`): gold, wood, ore,
  mercury, sulfur, crystal, gems.
- Canvas render path (`src/render/adventureRenderer.ts`, `drawObject` ~168):
  `townToken(cx,cy,r,ownerColor)` for towns; `objectToken(cx,cy,r,color,label)`
  for everything else (label via `objectLabel`, color via `objectColor`); a
  separate `flag(x,y,size,ownerColor)` for `mine`/`dwelling` ownership.
  `drawObject` runs for both live (visible) and last-seen (explored) objects.
- HUD resources are **DOM** (`src/ui/hud.ts` ~117): a `resource-bar` with one
  `resource-cell`/`resource-<id>` per `RESOURCE_ID` (text label + value) — real
  cells that CAN host an inline `<svg>`. (The marketplace in `townScreen.ts`
  ~407-483 uses `<select>`/`<option>` text and is out of scope, see Overview.)
- Vitest runs in the **node** env (no jsdom/`document`); every existing "UI
  test" exercises pure logic only. So DOM construction can't be unit-tested
  directly — icon markup is extracted to a pure string function for unit tests,
  with actual DOM injection covered by e2e.
- Phase 1-2 infra reused as-is: `SpriteAtlas` (static SVG→bitmap, `get(key)`),
  `SpritePainter` wrapping `TokenPainter`, the folder-keyed loader
  (`src/assets/themes/woodcut/index.ts`, glob `./*/*.svg`, folder→category), the
  shared atlas in `src/render/woodcutTheme.ts`.
- Tests: Vitest **node** env (no DOM globals — string SVG checks, recording
  context/painter stubs); Playwright e2e; `npm run check` gate.

## Development Approach

- **testing approach**: Regular (code first, then tests in the same task)
- complete each task fully before the next; small focused changes
- **CRITICAL: every task ships its tests** (success + error), as separate
  checklist items; **all tests pass before the next task**
- **CRITICAL: update this plan when scope changes during implementation**
- maintain backward compatibility: `TokenPainter` stays the fallback; an object
  type with no sprite (or a pending/failed bitmap) still renders its label

## Testing Strategy

- **unit tests**: resource + object loader coverage (every `RESOURCE_ID` has a
  `resource/<id>` sprite; every non-`monster` object type has an `object/<id>`
  sprite; keys map to real ids), string SVG sanity; `SpritePainter.objectToken`/
  `townToken` (sprite path, label fallback, resource-pip overlay, owner flag),
  `adventureRenderer` pip-resolution (mine subtype → income resource; resource
  pickup → `obj.subtype`), incl. the `SeenObject` (explored) path; a pure
  `resourceIconMarkup(id)` string function (the DOM injection itself is e2e-only,
  node env has no `document`)
- **e2e**: adventure map shows object sprites (town/mine/resource/etc.) with
  `data-sprites-ready`; HUD resource bar shows icons; existing e2e stays green
  (selectors/`data-*` unchanged)
- **determinism**: no `src/core/` changes; golden replay untouched

## Progress Tracking

- mark `[x]` immediately when done; `➕` for newly discovered tasks; `⚠️` for
  blockers; keep this file in sync with actual work

## Solution Overview

Author each resource and object as a 64×64 woodcut SVG keyed by id, rasterized
once into the shared atlas; `SpritePainter` blits them and overlays per-instance
furniture procedurally, falling back to the existing token/label when a bitmap
is missing.

Key decisions:

- **Resource SVGs do double duty.** The 7 `resources/<id>.svg` files are
  rasterized into the atlas (`resource/<id>`) for canvas pips AND inlined raw
  into the DOM (HUD/marketplace) from the same `woodcutSprites` map — one source,
  both paths, no duplication.
- **Mines & resource piles = shared base + resource pip.** One `object/mine`
  and one `object/resource` sprite; the painter overlays a small `resource/<id>`
  pip. The **renderer resolves the pip** (it has `GameData`): for a mine, the
  `income` resource of its subtype; for a resource pickup, the pile's resource.
  Keeps the painter generic (draw `object/<type>` + optional pip), no resource
  logic in the painter.
- **`objectToken` gains `type` + `pip`** (like terrain/creature gained ids):
  `objectToken(ctx, cx, cy, r, color, type, pip, label)`. Painter looks up
  `object/${type}`; draws the `resource/${pip}` pip if `pip` is non-null; else
  delegates to `TokenPainter` (label). `TokenPainter` ignores the new params
  (current look unchanged).
- **Town ownership stays visible.** The town sprite is static, so `SpritePainter.townToken`
  draws `object/town` + a small procedural owner-color flag/pennant (neutral grey
  if unowned), preserving today's ownership read. `mine`/`dwelling` keep their
  existing separate `flag` call.
- **`monster` is untouched** — it already routes through `creatureToken`
  (phase 2). Only the `objectToken`/`townToken` paths change.
- **New theme folders** `resources/` and `objects/`; the loader's `./*/*.svg`
  glob already keys by folder — add `resources`→`resource`, `objects`→`object`.

## Technical Details

- Sprite keys: `resource/<id>` (7), `object/<type>` (18 minus `monster` = 17,
  incl. one shared `object/mine` and one `object/resource`). Filenames:
  `resources/<id>.svg`, `objects/<type>.svg`.
- `Painter` change (mechanical, all implementers + call sites):
  `objectToken(ctx, cx, cy, r, color, type: string, pip: string | null, label: string)`.
  `townToken` signature unchanged (already carries owner color).
- Pip resolution (in `adventureRenderer`, confirmed against the code):
  `mine` → the single key of `objectTypes.mine.subtypes[obj.subtype].income`
  (guard for an absent/empty `income` — it is `.optional()` in the schema);
  `resource` → `obj.subtype` (it IS the `ResourceId`; `MapObjectState` has no
  `obj.resource` field — `dsl.ts` validates a resource pickup's subtype against
  `RESOURCE_IDS`, and `objectLabel` already reads `obj.subtype`); else `null`.
  Both `mine` and `resource` carry `subtype` on the `SeenObject` snapshot too,
  so pips resolve for explored-but-not-visible objects.
- Pip geometry: a small `resource/<id>` bitmap drawn in a corner of the object
  token (e.g. lower-right), sized ~0.5r, with a thin parchment/ink backing so it
  reads over the object art. Named constants, no magic numbers.
- DOM resource icons: import `woodcutSprites` in `hud.ts`/`townScreen.ts`; inject
  `resource/<id>` raw SVG into the resource cell (replacing/with the text label),
  sized via CSS; keep the numeric value + the existing `data-testid`s.
- Object/resource SVGs follow the established emblem style (viewBox 0 0 64 64,
  inline ink outlines `#241b16` 1.5/2.2 round, three-tone flat fills, no
  `class=`, ground shadow where apt). Objects read as small structures/icons,
  not figures.

## What Goes Where

- **Implementation Steps**: all code/asset/test changes in this repo
- **Post-Completion**: browser sign-off; any per-object art refinement

## Implementation Steps

### Task 1: Resource icon SVGs + loader key

**Files:**
- Create: `src/assets/themes/woodcut/resources/gold.svg` (+ wood, ore, mercury,
  sulfur, crystal, gems — 7 files)
- Modify: `src/assets/themes/woodcut/index.ts` (folder→category: `resources`→`resource`)
- Modify: `src/assets/themes/woodcut/index.test.ts`

- [x] author 7 woodcut resource icons (gold coins, wood logs, ore chunk,
      mercury vial, sulfur lump, crystal cluster, gems), 64×64, emblem style,
      no `class=` — each a clear icon readable small
- [x] extend the loader folder map with `resources`→`resource`
- [x] coverage test: every `RESOURCE_IDS` id has a `resource/<id>` sprite; update
      the key-format regex to allow `resource` and (for Task 2) `object` — it
      appears in **two** places in `index.test.ts` (the "valid sprite keys" test
      ~line 48 and the spot-check ~line 57); update both
- [x] string SVG sanity covers the new files
- [x] run `npm test` — must pass before task 2

### Task 2: Core map-object SVGs (town, mine, dwelling, resource, treasure, artifact)

**Files:**
- Create: `src/assets/themes/woodcut/objects/town.svg`, `mine.svg`,
  `dwelling.svg`, `resource.svg`, `treasure_chest.svg`, `artifact.svg`
- Modify: `src/assets/themes/woodcut/index.ts` (`objects`→`object`)
- Modify: `src/assets/themes/woodcut/index.test.ts`

- [x] author the 6 core object sprites (town keep/castle; a mine entrance;
      a dwelling hut; a resource pile/sack; a treasure chest; an artifact
      pedestal/relic) — 64×64, woodcut style, no `class=`
- [x] extend the loader folder map with `objects`→`object`
- [x] coverage test scaffolding: assert these 6 `object/<type>` keys exist (full
      18-type coverage asserted in Task 3 once visitables/specials land)
- [x] run `npm test` — must pass before task 3

### Task 3: Visitable & special object SVGs (the remaining 12)

**Files:**
- Create: `src/assets/themes/woodcut/objects/windmill.svg`, `water_wheel.svg`,
  `mystical_garden.svg`, `magic_well.svg`, `fountain_of_fortune.svg`,
  `rally_flag.svg`, `learning_stone.svg`, `school_of_war.svg`, `observatory.svg`,
  `sign.svg`, `monolith.svg`, `prison.svg`, `obelisk.svg` (13 — monster excluded)
- Modify: `src/assets/themes/woodcut/index.test.ts`

- [x] author the 13 visitable/special sprites, woodcut style, no `class=`
- [x] tighten the object coverage test to require an `object/<type>` sprite for
      EVERY `objects.json` type except `monster`; assert every `object/*` key
      maps to a real object type id
- [x] run `npm test` — must pass before task 4

### Task 4: objectToken/townToken sprite path + pip + owner flag

**Files:**
- Modify: `src/render/painter.ts` (interface + `TokenPainter` signature)
- Modify: `src/render/spritePainter.ts` (object sprite + pip + town owner flag)
- Modify: `src/render/adventureRenderer.ts` (pass type/pip; resolve pip)
- Modify: `src/render/testSupport.ts` (`RecordingPainter.objectToken` arity),
  `src/render/spritePainter.test.ts` (incl. the existing delegation arg-array
  assertion ~lines 385/393), `src/render/adventureRenderer.test.ts`

- [x] extend `Painter.objectToken` with `type` + `pip`; update `TokenPainter`
      (ignores them — current look), the `RecordingPainter` stub in
      `testSupport.ts`, and the call site. NOTE keep `objectColor` + the object
      palette constants — they still tint the `TokenPainter` fallback
- [x] `SpritePainter.objectToken`: draw `object/${type}`; overlay `resource/${pip}`
      pip (named geometry, a few constants — no general "badge" subsystem) when
      `pip` non-null; fall back to label when the object bitmap is missing
- [x] `SpritePainter.townToken`: draw `object/town` + a procedural owner-color
      flag (neutral grey if unowned) — reuse the swallow-tail geometry from the
      existing `drawHeroBanner` (`spritePainter.ts` ~355) as the template; fall
      back to the `TokenPainter` castle
- [x] `adventureRenderer`: resolve the pip resource (per Technical Details) and
      pass type+pip to `objectToken`
- [x] tests: object sprite path + label fallback + pip overlay + town owner flag
      (SpritePainter); pip resolution per type (adventureRenderer, recording
      painter stub) **including the `SeenObject`/explored path** for a mine and a
      resource pickup; update the broken delegation arg-array assertion
- [x] run `npm test` — must pass before task 5

### Task 5: DOM resource icons in the HUD resource bar

**Files:**
- Create: `src/ui/resourceIcon.ts` (pure `resourceIconMarkup(id): string`)
- Create: `src/ui/resourceIcon.test.ts`
- Modify: `src/ui/hud.ts` (resource bar cells)
- Modify: CSS for icon sizing

- [x] add a pure `resourceIconMarkup(id: string): string` returning the
      `resource/<id>` raw SVG from `woodcutSprites` (with size/aria attributes
      added), so it is unit-testable as a string in the node env
- [x] inject that markup into each HUD `resource-cell` (replacing the text label
      with the icon), keeping the numeric value and the existing `resource-<id>`
      `data-testid`s; size via CSS
- [x] marketplace icons are OUT OF SCOPE (its `<select>/<option>` cannot host
      SVG — see Overview); leave the marketplace text as-is
- [x] tests: `resourceIcon.test.ts` asserts `resourceIconMarkup(id)` returns an
      `<svg>…</svg>` for each `RESOURCE_ID` (string assertions, node-env safe).
      Actual DOM injection is verified in the Task 6 e2e
- [x] run `npm test` + `npm run test:e2e` — must pass before task 6

### Task 6: e2e — objects on the map, icons in the HUD

**Files:**
- Modify: `e2e/adventure.spec.ts`

- [ ] adventure smoke: a town + a mine (+ resource pip) + a resource pile render
      as sprites (`data-sprites-ready`, no console errors)
- [ ] HUD smoke: each `resource-<id>` cell contains an `<svg>` icon
- [ ] existing e2e unchanged and green
- [ ] run `npm run test:e2e` — must pass before task 7

### Task 7: Verify acceptance criteria

- [ ] all 18 object types render as sprites on the map (manual `npm run dev` +
      screenshot, plus e2e); mines/piles show the correct resource pip; town
      ownership reads via the owner flag
- [ ] HUD + marketplace show resource icons; values unchanged
- [ ] golden replay tests pass untouched; minimap unchanged
- [ ] full gate `npm run check`; core coverage still ≥ 80%

### Task 8: [Final] Update documentation

- [ ] README "Themes & sprites": document `resources/<id>`→`resource/<id>` and
      `objects/<type>`→`object/<type>` keys, the shared-base+pip mine/pile
      scheme, the resource-SVG dual use (canvas + DOM), and the town owner flag
- [ ] regenerate the bestiary only if affected (it isn't — creatures only)
- [ ] move this plan to `docs/plans/completed/`

## Post-Completion

**Manual verification:**
- browser sign-off: all object sprites at adventure zoom + fog dimming; mine/
  pile resource pips legible; town owner flag color per player; resource icons
  crisp in the HUD bar
- confirm last-seen (explored, out-of-sight) objects still render their sprite

**Future phases (not in scope):**
- phase iv: town buildings; phase v: spell/skill/artifact icons; phase vi: hero
  portraits
