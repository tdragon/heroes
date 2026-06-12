# Graphics Phase 1 — Gilded Woodcut terrain, roads & fog

## Overview

First implementation phase of the Gilded Woodcut visual language
(concept: `docs/design/graphics-concept.html`). Replaces the procedural
flat-color terrain, road, and fog rendering on the adventure map with the
SVG tile sprites from the concept, introduced through a theme-ready asset
structure so future themes are a directory drop-in.

- Problem: the adventure map renders terrain as flat color + noise speckles
  and roads as a fixed brown cross — placeholder art with no visual identity.
- Benefit: the entire "land layer" (8 terrains, 3 roads, fog) matches the
  approved concept in one shippable PR; later phases (units, objects) build
  on the same loader/painter infrastructure.
- Integration: everything happens behind the existing `Painter` interface;
  `src/core/` and determinism are untouched.

## Context (from discovery)

- `src/render/painter.ts` — `Painter` interface (designed swap point) and
  `TokenPainter` placeholder implementation. `terrain()` currently receives
  only a color string; `road()` receives no road type — both need ids passed
  through for sprite lookup.
- `src/render/adventureRenderer.ts` — draws terrain/roads/fog via injected
  `Painter`; shared with the per-frame minimap, which draws tiles at a few
  pixels (sprites pointless there — needs flat-color path).
- `src/data/terrain.json` + `src/data/schema.ts` — 8 terrain ids, 3 road ids,
  each terrain has a `color` used today (kept as fallback/minimap color).
- Tile art source: the `<symbol>` sprites in `docs/design/graphics-concept.html`
  (64×64 viewBox, ink/three-tone style, edge-quiet for tiling).
- Tests: Vitest under the **node** environment (no DOM globals at all — no
  `DOMParser`, `Image`, `createImageBitmap`, `devicePixelRatio`), so
  rasterization must sit behind an injectable abstraction and asset sanity
  checks must be string-based; Playwright e2e (`npm run test:e2e`),
  `npm run check` gate.
- Combat renderer never calls `terrain()`/`road()` (verified) — combat is
  unaffected by the signature change beyond recompilation.
- `TokenPainter` instantiation sites: `src/app/adventureScreen.ts:122`
  (adventure) and `src/ui/combatScreen.ts:102` (combat, stays as-is).
- e2e model: `e2e/adventure.spec.ts` already polls `data-camera-*` attributes
  on `getByTestId('adventure-canvas')` — `data-sprites-ready` follows that
  pattern.

## Development Approach

- **testing approach**: Regular (code first, then tests in the same task)
- complete each task fully before moving to the next
- make small, focused changes
- **CRITICAL: every task MUST include new/updated tests** for code changes in
  that task — success and error scenarios, as separate checklist items
- **CRITICAL: all tests must pass before starting next task** — no exceptions
- **CRITICAL: update this plan file when scope changes during implementation**
- run tests after each change
- maintain backward compatibility (TokenPainter remains the fallback and the
  combat renderer's painter is unaffected)

## Testing Strategy

- **unit tests**: theme loader coverage/validation (string-based SVG checks —
  node env has no DOMParser), atlas bucket & cache logic (with a fake
  rasterizer), `SpritePainter` draw/fallback decisions (with a fake atlas +
  recording 2D-context stub), `AdventureRenderer` id plumbing (recording
  painter stub — no renderer unit tests exist today, this adds the first)
- **e2e tests**: Playwright — adventure map smoke test asserting the sprite
  atlas finished loading (`data-sprites-ready` attribute on the map canvas)
  and no console errors; existing e2e must stay green (selectors unchanged)
- **determinism**: no `src/core/` changes; golden replay tests must pass
  untouched (`src/core/replay.test.ts`)

## Progress Tracking

- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix
- document issues/blockers with ⚠️ prefix
- update plan if implementation deviates from original scope

## Solution Overview

Author sprites as individual SVG files keyed by entity id under a theme
directory. Load them eagerly as raw text via Vite glob import, rasterize
once per zoom bucket at startup (async, off the render path), and blit from
an in-memory atlas through a new `SpritePainter` that wraps `TokenPainter`
and falls back to it per-sprite whenever a bitmap is not (yet) available.

Key decisions:

- **Theme contract = directory layout + id-keyed filenames.** No manifest
  file in phase 1 (YAGNI — coverage is validated by a unit test against
  `src/data` ids; a `theme.json` manifest can arrive with the second theme).
  Layout: `src/assets/themes/woodcut/terrain/<terrainId>.svg`,
  `.../terrain/road.<roadId>.svg`. Future themes mirror the layout; the
  fallback chain is theme → TokenPainter.
- **Runtime rasterization, not build-time atlases.** Keeps SVGs the single
  source of truth, keeps themes drop-in, costs milliseconds at startup.
- **Sync atlas lookup, async fill.** The renderer never awaits; until a
  bitmap exists the painter falls back to today's flat-color drawing, so the
  first frames and the loading window are still correct.
- **Minimap stays flat color.** Below a tile size threshold (12 px) the
  painter uses the existing color fill — sprites are unreadable there anyway.
- **Fog joins the theme.** `shroud` becomes Night `#16100c`, `dimmed` becomes
  a warm dark overlay, matching the concept's war-fog.

## Technical Details

- Sprite key: `terrain/<id>` and `road/<id>` strings; later phases add
  `creature/<id>` etc. without loader changes. Filenames map to keys in the
  glob loader: `terrain/grass.svg` → `terrain/grass`,
  `terrain/road.dirt_road.svg` → `road/dirt_road`.
- Concept symbol → data id mapping (explicit, names do NOT match 1:1):
  `t-grass`…`t-water` → the 8 terrain ids; `r-dirt` → `dirt_road`,
  `r-gravel` → `gravel_road`, `r-cobble` → `cobblestone_road`.
- Zoom buckets: rasterize at 32 and 64 CSS px (× `globalThis.devicePixelRatio
  ?? 1`, capped at 2 — guard required, node has no `devicePixelRatio`);
  lookup picks the smallest bucket ≥ requested size, else the largest.
  Live tile size is `TILE_PX = 48` → selects the 64 bucket.
- Rasterizer abstraction: `type Rasterize = (svg: string, px: number) =>
  Promise<CanvasImageSource>`; production impl uses `Blob` URL +
  `HTMLImageElement` + `createImageBitmap` (or canvas fallback); tests inject
  a fake returning a stub object.
- `Painter` signature changes (mechanical, all implementers updated):
  - `terrain(ctx, x, y, size, terrain: { id: string; color: string })`
  - `road(ctx, x, y, size, roadId: string)`
- Road sprites are horizontal-band overlays (from the concept); phase 1 draws
  the same band for all directions — directional/corner road variants are a
  ➕ candidate for a later phase, matching today's non-directional road art.
- `src/data/terrain.json` colors stay: minimap, fallback fill, and the
  concept's ramp bases derive from them.

## What Goes Where

- **Implementation Steps**: all code/asset/test changes in this repo
- **Post-Completion**: visual sign-off in a real browser, deployment

## Implementation Steps

### Task 1: Woodcut theme assets — terrain & road SVG files

**Files:**
- Create: `src/assets/themes/woodcut/terrain/grass.svg` (+ `dirt`, `sand`,
  `snow`, `swamp`, `rough`, `lava`, `water` — 8 files)
- Create: `src/assets/themes/woodcut/terrain/road.dirt_road.svg`
  (+ `road.gravel_road`, `road.cobblestone_road` — 3 files)
- Create: `src/assets/themes/woodcut/index.ts` (glob loader → `Record<spriteKey, svgText>`)
- Create: `src/assets/themes/woodcut/index.test.ts`

- [ ] spike first: confirm `import.meta.glob('./terrain/*.svg', { query:
      '?raw', eager: true })` returns raw SVG **strings** under `vitest run`
      (first use of glob imports in this repo); fall back to `as: 'raw'` if
      the `query` form misbehaves
- [ ] port the 8 terrain `<symbol>`s from `docs/design/graphics-concept.html`
      into standalone 64×64 SVG files (drop organizational `class` attributes;
      per-shape fills/strokes are already inline — confirm no symbol relies
      on a rule from the page `<style>` block)
- [ ] port the 3 road overlay symbols the same way (transparent background),
      using the explicit mapping: `r-dirt` → `road.dirt_road.svg`,
      `r-gravel` → `road.gravel_road.svg`, `r-cobble` → `road.cobblestone_road.svg`
- [ ] write `index.ts`: glob loader mapped to sprite keys `terrain/<id>` /
      `road/<id>` (filename convention from Technical Details)
- [ ] write coverage test: every terrain id and road id in default `GameData`
      has a sprite key (catches future content additions with missing art)
- [ ] write sanity test (string-based — node env has no DOMParser): each SVG
      contains `viewBox="0 0 64 64"`, starts with `<svg`, ends with `</svg>`,
      and contains no `class=` attributes
- [ ] run `npm test` — must pass before task 2

### Task 2: Sprite atlas with injectable rasterizer

**Files:**
- Create: `src/render/spriteAtlas.ts`
- Create: `src/render/spriteAtlas.test.ts`

- [ ] implement `SpriteAtlas`: constructor takes `Record<string, string>`
      (key → svg text) and a `Rasterize` function; `load()` kicks off
      rasterization for all keys × buckets [32, 64] (× dpr, capped ×2)
- [ ] implement sync `get(key, sizePx): CanvasImageSource | null` — smallest
      bucket ≥ size, else largest; `null` for unknown key or not-yet-loaded
- [ ] implement `ready: Promise<void>` resolving when all bitmaps exist
      (rejected rasterizations log once and leave permanent `null` → fallback)
- [ ] implement production rasterizer in the same file (Blob URL + Image +
      `createImageBitmap`, guarded for browsers without it; use
      `globalThis.devicePixelRatio ?? 1` so non-browser contexts don't NaN)
- [ ] write tests with a fake rasterizer: bucket selection (exact, between,
      above max), one rasterize call per key+bucket (caching), `null` before
      load and for unknown keys, `ready` resolves, failed rasterize → `null`
      without rejecting `ready`
- [ ] run `npm test` — must pass before task 3

### Task 3: Painter id plumbing + SpritePainter

**Files:**
- Modify: `src/render/painter.ts` (interface signatures, `TokenPainter`)
- Modify: `src/render/adventureRenderer.ts` (pass terrain/road ids; minimap path)
- Modify: `src/app/adventureScreen.ts` (painter swap at line ~122, ready flag + redraw)
- Create: `src/render/spritePainter.ts`
- Create: `src/render/spritePainter.test.ts`
- Create: `src/render/adventureRenderer.test.ts` (first renderer unit test)

- [ ] extend `Painter.terrain`/`Painter.road` signatures with ids (see
      Technical Details); update `TokenPainter` (ignores ids) and the two
      call sites in `adventureRenderer.ts` (`drawTerrain` lines ~100/103,
      plus minimap path); compile-time only — no existing tests reference
      the painter (verified)
- [ ] implement `SpritePainter` wrapping a `TokenPainter` + `SpriteAtlas`:
      `terrain`/`road` draw from atlas when `size >= 12` and bitmap exists,
      else delegate; `shroud` fills `#16100c`; `dimmed` fills
      `rgba(22, 16, 12, 0.5)`; everything else delegates
- [ ] wire up in `adventureScreen.ts`: instantiate `SpritePainter` (combat
      screen keeps `TokenPainter`); when `atlas.ready` resolves, set
      `data-sprites-ready` on the map canvas **and** trigger the screen's
      existing dirty/redraw path so a sprite frame actually paints (first
      frames legitimately draw fallback art)
- [ ] write tests for `SpritePainter` with fake atlas + recording 2D-context
      stub: drawImage path (sprite exists, size ≥ 12), flat-color fallback
      (size < 12, missing sprite, pre-load), fog fill colors
- [ ] write `adventureRenderer.test.ts` with a recording painter stub:
      asserts the renderer forwards the correct terrain id and resolved road
      id per tile, and the explored/shroud branch — the id plumbing is the
      likeliest regression point and has zero coverage today
- [ ] run `npm test` — must pass before task 4

### Task 4: e2e — adventure map renders the woodcut land

**Files:**
- Modify: e2e adventure-map spec (existing Playwright suite)

- [ ] add smoke assertions: map canvas gains `data-sprites-ready` after load;
      no console errors during initial render and scroll
- [ ] verify existing e2e selectors/flows still pass unchanged
- [ ] run `npm run test:e2e` — must pass before task 5

### Task 5: Verify acceptance criteria

- [ ] all 8 terrains + 3 roads render as woodcut sprites on the adventure map;
      fog uses Night palette (manual check via `npm run dev`, plus e2e green)
- [ ] minimap unchanged (flat terrain colors)
- [ ] golden replay tests pass untouched — no rng/core impact
- [ ] run full gate: `npm run check`
- [ ] coverage for `src/core/` still ≥ 80% (`npm test -- --coverage`) — note:
      trivially unaffected since coverage `include` is core/data/maps only;
      the new `src/render/` code is held to the per-task test checklists
      above, not the numeric gate (extending `coverage.include` to
      `src/render/**` is a reasonable follow-up, out of scope here)

### Task 6: [Final] Update documentation

- [ ] README: short "Themes & sprites" section documenting the directory
      contract (`src/assets/themes/<name>/…`, id-keyed filenames, fallback
      chain theme → TokenPainter)
- [ ] CLAUDE.md: one line under data-driven content — sprites are id-keyed
      SVG assets; adding art must keep the coverage test green
- [ ] move this plan to `docs/plans/completed/`

## Post-Completion

**Manual verification:**
- visual sign-off in a real browser at multiple zoom levels and on a retina
  display (bucket selection / dpr handling)
- shroud `#16100c` vs the renderer's `#000000` canvas clear — confirm no
  jarring seam at map edges
- spot-check performance: full-map scroll should stay smooth (drawImage per
  tile, no per-frame rasterization)

**Future phases (not in scope here):**
- phase ii: creature seal tokens (51 emblems); phase iii: map objects +
  resource icons; directional road variants; `theme.json` manifest when a
  second theme appears
