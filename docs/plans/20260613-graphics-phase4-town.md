# Graphics Phase 4 — The Town: building art

## Overview

Fourth phase of the Gilded Woodcut visual language (concept:
`docs/design/graphics-concept.html`, ledger folio vii "phase iv · the town").
Gives every town building a bespoke woodcut icon, shown on the town-screen
building grid (DOM), on the existing woodcut-theme/sprite infrastructure.

- Problem: the town screen's building grid renders each building as a text
  name + cost on a bare card — no art.
- Scope (decided): a **bespoke** icon for **all 66 buildings** — 16 shared,
  42 faction dwellings (14 × 3, in base/upgrade pairs), 8 faction specials.
- Benefit: the town screen becomes fully illustrated, matching the adventure
  map + combat from phases 1–3.
- Integration: DOM inline-SVG icon on each building card via a **pure string
  helper** injected with `innerHTML` (the phase-3 `resourceIconMarkup` + HUD
  pattern — node-unit-testable, unlike the `DOMParser`-based `icons.ts`
  `resourceIcon`); `src/core/` untouched.

## Context (from discovery)

- Town screen (`src/ui/townScreen.ts`): `buildingGrid` iterates
  `townBuildingCatalog(town.faction, data)` and renders a `buildingCard` per
  building — a `<button class="building-card <status>" data-testid="building-<id>">`
  with a name, help icon, built-status/cost. **No building art today.** Already
  imports `resourceIcon` from `./icons` (a `DOMParser`-based DOM helper, used in
  `costRow`). Two icon patterns exist: `icons.ts resourceIcon` (DOM Element,
  browser-only, **not** node-unit-testable) and `src/ui/resourceIcon.ts
  resourceIconMarkup` (pure string, node-tested, injected via `innerHTML` in the
  HUD). Phase 4 mirrors the **string** one so its helper is node-unit-testable.
- Building data: 16 shared (`src/data/buildings.json`: village_hall, town_hall,
  city_hall, capitol, fort, citadel, castle, tavern, marketplace, resource_silo,
  blacksmith, mage_guild_1..5); per-faction in `src/data/factions/<f>.json` —
  `dwellings` (14 each: `<faction>_dwelling_<1..7>` + `…u` upgrades) and
  `specialBuildings`. Specials: castle = stables, brotherhood_of_the_sword,
  griffin_bastion; rampart = fountain_of_fortune, treasury, mystic_pond;
  necropolis = necromancy_amplifier, skeleton_transformer.
- `building/fountain_of_fortune` (this phase) is distinct from the phase-3 map
  object `object/fountain_of_fortune` — different namespaces, no collision.
- Phase 1–3 infra reused: folder-keyed loader (`src/assets/themes/woodcut/index.ts`,
  glob `./*/*.svg`, folder→category map), `woodcutSprites` raw-SVG map,
  `icons.ts` DOM helpers, the well-formedness + coverage test patterns.
- Tests: Vitest **node** env (no DOM — DOM rendering is e2e-only; logic/markup
  via pure string helpers + string SVG checks); Playwright e2e; `npm run check`.

## Development Approach

- **testing approach**: Regular (code first, then tests in the same task)
- complete each task fully before the next; small focused changes
- **CRITICAL: every task ships its tests** (success + error) as separate
  checklist items; **all tests pass before the next task**
- **CRITICAL: update this plan when scope changes during implementation**
- backward compatible: a building with no sprite (or pre-load) shows the card
  with no icon (or a neutral placeholder) — never an error

## Testing Strategy

- **unit tests**: building loader coverage (every building id across shared +
  all 3 factions' catalogs has a `building/<id>` sprite; every `building/*` key
  maps to a real building id); string SVG sanity + well-formedness; the pure
  building-icon markup/helper; town-screen build-availability logic unaffected
- **e2e**: town screen building grid shows an icon per building card; existing
  town/hero e2e stays green (selectors/`data-*` unchanged)
- **determinism**: no `src/core/` or `src/data/` changes; golden replay untouched

## Progress Tracking

- mark `[x]` immediately when done; `➕` newly discovered; `⚠️` blockers; keep
  this file in sync

## Solution Overview

Author one 64×64 woodcut SVG per building, keyed `building/<id>` in the shared
theme; render it as an inline DOM `<svg>` on each town-screen building card via
a small helper, mirroring `resourceIcon`. Dwelling upgrades derive from their
base (recolor/embellish), as creature upgrades did in phase 2b.

Key decisions:

- **One bespoke sprite per building** (`buildings/<id>.svg` → `building/<id>`),
  66 total. Dwelling `…u` upgrades start as a copy of their base and add
  richer/upgraded detail so the pair reads as base vs upgrade.
- **DOM render via a pure string helper** — add `buildingIconMarkup(id): string`
  (in `src/ui/resourceIcon.ts` alongside `resourceIconMarkup`, or a sibling
  module) that returns the `building/<id>` raw SVG from `woodcutSprites` with a
  `building-icon` class + `aria-hidden`/role injected, and `''` for a missing id.
  The town card injects it via `iconSpan.innerHTML = buildingIconMarkup(id)`
  (matching the HUD). This keeps the helper **node-unit-testable as a string**;
  the actual DOM injection is covered by e2e (as `resourceIconMarkup` is). Do
  NOT use the `DOMParser`-based `icons.ts` path — it can't be node-tested. Town
  buildings are not per-instance colored, so no procedural furniture.
- **New theme folder** `buildings/`; loader folder map gains `buildings`→`building`.
- **Coverage via the catalog**: the test iterates `townBuildingCatalog(faction,
  data)` for each faction (its union covers all 66) and asserts each id has a
  sprite — so a future building without art fails the gate.

## Technical Details

- Sprite keys: `building/<id>` (66). Filenames `buildings/<id>.svg`.
- `icons.ts`: `buildingIcon(id: string, size = 28): Element` — look up
  `woodcutSprites['building/'+id]`; parse to an `<svg>` node, set width/height,
  `role="img"`, `aria-label`. Return a neutral empty node (or skip) if missing.
- `townScreen.ts buildingCard`: insert the icon into the card (e.g. a
  `building-icon` wrapper at the head, before the name). Keep the
  `building-<id>` testid, name, help, cost/status untouched.
- CSS: a `.building-icon` rule sizing the svg on the card (consistent with the
  card layout); reuse/extend existing town-screen styles in `index.html`.
- Building SVG style: woodcut structures (like the phase-3 `object/town`,
  `object/mine`, `object/dwelling`) — 64×64, inline ink outlines `#241b16`
  1.5/2.2 round, three-tone flat fills, no `class=`, ground shadow where apt.
  Halls/forts read as escalating structures across their tiers; mage guilds as
  a mage tower escalating 1→5; dwellings as faction-flavored creature housing,
  upgrade richer than base; specials as their themed structure.
- Authoring at exec time fans out in parallel batches (shared; castle/rampart/
  necropolis dwellings; specials), each verified on a rendered contact sheet —
  the phase-2b approach.

## What Goes Where

- **Implementation Steps**: code/asset/test changes in this repo
- **Post-Completion**: browser sign-off on the town screen

## Implementation Steps

### Task 1: Loader + shared building sprites (16)

**Files:**
- Create: `src/assets/themes/woodcut/buildings/{village_hall,town_hall,city_hall,
  capitol,fort,citadel,castle,tavern,marketplace,resource_silo,blacksmith,
  mage_guild_1,mage_guild_2,mage_guild_3,mage_guild_4,mage_guild_5}.svg`
- Modify: `src/assets/themes/woodcut/index.ts` (folder map `buildings`→`building`)
- Modify: `src/assets/themes/woodcut/index.test.ts`

- [x] author the 16 shared building sprites, woodcut style, no `class=`
      (hall tiers escalate; fort/citadel/castle escalate; mage_guild_1..5
      a mage tower escalating; tavern/marketplace/resource_silo/blacksmith
      distinct structures)
- [x] add `buildings: 'building'` to the loader folder map AND, in the SAME
      commit, extend the key-format regex to include `building` at BOTH sites in
      `index.test.ts` (the "contains only valid sprite keys" test ~line 84 and
      the spot-check ~line 94) — the all-keys test runs against every loaded
      sprite, so a missed regex site reds the suite the moment a `building/*`
      sprite loads
- [x] coverage scaffold test: the 16 shared `building/<id>` keys exist; SVG
      sanity + well-formedness covers the new files
- [x] run `npm test` — must pass before task 2

### Task 2: Faction dwelling sprites (42)

**Files:**
- Create: `src/assets/themes/woodcut/buildings/<faction>_dwelling_<1..7>{,u}.svg`
  (14 each × 3 factions = 42)
- Modify: `src/assets/themes/woodcut/index.test.ts`

- [x] author 42 dwelling sprites (parallel faction batches at exec); each `…u`
      upgrade derives from its base but MUST carry a visible embellishment (added
      structure/banner/gilding — not just a recolor) so base vs upgrade reads at
      the ~28px card size, faction-flavored
- [x] extend the coverage test to assert all dwelling keys exist
- [x] run `npm test` — must pass before task 3

### Task 3: Faction special building sprites (8)

**Files:**
- Create: `src/assets/themes/woodcut/buildings/{stables,brotherhood_of_the_sword,
  griffin_bastion,fountain_of_fortune,treasury,mystic_pond,necromancy_amplifier,
  skeleton_transformer}.svg`
- Modify: `src/assets/themes/woodcut/index.test.ts`

- [x] author the 8 faction special sprites, woodcut style, no `class=`
- [x] tighten coverage: for each faction (enumerate from `data.factions`, don't
      hard-code three) iterate `townBuildingCatalog(faction, data)` and assert
      every building id has a `building/<id>` sprite. For the REVERSE check,
      build a single `Set` of all building ids from the catalogs across ALL
      factions (their union covers all 66; no single faction does) and assert
      every `building/*` sprite key is in that set
- [x] run `npm test` — must pass before task 4

### Task 4: buildingIconMarkup helper + town-screen wiring

**Files:**
- Modify: `src/ui/resourceIcon.ts` (add pure `buildingIconMarkup`) — or a sibling
  module if cleaner
- Modify: `src/ui/townScreen.ts` (`buildingCard` injects the icon)
- Modify: `index.html` (`.building-icon` CSS)
- Modify: `src/ui/resourceIcon.test.ts` (extend for `buildingIconMarkup`)

- [x] add pure `buildingIconMarkup(id: string): string` returning the
      `building/<id>` raw SVG from `woodcutSprites` with a `building-icon` class +
      `aria-hidden="true"` injected onto the root `<svg>`; `''` for a missing id.
      (Node-unit-testable as a string — do NOT use the `DOMParser`-based
      `icons.ts` helper.)
- [x] render the icon in `buildingCard`: an icon span with
      `innerHTML = buildingIconMarkup(building.id)` (keep the `building-<id>`
      testid, name, help, cost/status intact). For accessibility the name text
      stays on the card, so no sr-only span is needed (unlike the icon-only HUD)
- [x] add a `.building-icon` CSS rule that is the SINGLE source of truth for
      size (the helper injects only the class, no inline width/height, so CSS
      sizing doesn't fight inline attrs)
- [x] unit-test `buildingIconMarkup` in `resourceIcon.test.ts`: returns
      `<svg>…</svg>` with the `building-icon` class for a known id; `''` for an
      unknown id (node-safe string assertions). DOM injection is e2e (Task 5)
- [x] run `npm test` — must pass before task 5

### Task 5: e2e — building icons on the town screen

**Files:**
- Modify: `e2e/town-hero.spec.ts` (or the town spec)

- [ ] open the town screen and assert several `building-<id>` cards contain an
      `<svg>` icon; no console errors
- [ ] existing town/hero e2e unchanged and green
- [ ] run `npm run test:e2e` — must pass before task 6

### Task 6: Verify acceptance criteria

- [ ] all 66 buildings render an icon on the town-screen grid (manual
      `npm run dev` + screenshot, plus e2e)
- [ ] **hard check**: each dwelling base vs its `…u` upgrade is visually
      distinguishable at rendered card size (~28px) — render a base/upgrade
      contact sheet and confirm; if a pair is indistinguishable, add embellishment
- [ ] golden replay tests pass untouched
- [ ] full gate `npm run check`; core coverage still ≥ 80%

### Task 7: [Final] Update documentation

- [ ] README "Themes & sprites": document `buildings/<id>.svg`→`building/<id>`
      and the town-screen `buildingIconMarkup` rendering; update the coverage-test
      sentence (~README line 244) to include buildings + the `building/*`→id
      reverse check
- [ ] CLAUDE.md sprites note: add `buildings/`
- [ ] move this plan to `docs/plans/completed/`

## Post-Completion

**Manual verification:**
- town-screen sign-off: every building card has a legible icon at card size;
  base vs upgrade dwellings distinguishable; halls/forts/mage-guild tiers read
  as escalating; built vs locked card states still clear with the icon present

**Future phases (not in scope):**
- phase v: spell/skill/artifact icons; phase vi: hero portraits
