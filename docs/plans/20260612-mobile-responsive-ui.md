# Mobile / Narrow-Screen Support (Phase 2)

## Overview

Make Open Heroes playable on phones and narrow windows. Today every dimension is
hard-coded for a ~1280×800 desktop window: the adventure canvas is a fixed 1000×760,
the sidebar a fixed 280px, the town/hero panel 960px, the main menu 1280×800, and all
input is mouse-only (middle-button drag pan, edge scroll, right-click info). On a phone
the page overflows ~3×, the map is mostly off-screen, and there is no way to pan it.

This phase delivers:

- **Responsive canvas + camera** — the map canvas fills its container at any size, with
  `devicePixelRatio`-aware crisp rendering and a camera that follows the viewport.
- **Camera zoom** — pinch / mouse-wheel / keyboard zoom (continuous, clamped 0.5–2.0).
- **Touch input** — Pointer Events unification: one-finger drag pans, tap clicks,
  long-press shows tile info, two-finger pinch zooms. Existing two-tap move
  confirmation already suits touch and stays unchanged.
- **Overlay screens fit the viewport** — town/hero panels, spellbook, dialogs, menu,
  and the combat screen (scale-to-fit) work at 390px-wide portrait.
- **Mobile HUD** — on narrow screens the sidebar becomes a slide-in drawer behind a ☰
  button; critical actions (End Turn, Next Hero) stay reachable in the bottom bar.
- **Mobile e2e coverage** — Playwright tests at a phone viewport with touch enabled.

Out of scope (possible phase 3): PWA manifest, safe-area insets / `viewport-fit=cover`,
pull-to-refresh prevention beyond `touch-action` on the canvas, haptics, orientation
prompts.

## Context (from discovery)

- `src/render/camera.ts` — pure camera math (`Camera {x,y,width,height}` in world px,
  `TILE_PX = 48`, `clampCamera`/`panCamera`/`worldToScreen`/`screenToWorld`/
  `tileAtScreen`/`tileScreenRect`/`centerCameraOn`/`visibleTileRange`), fully
  unit-tested in `src/render/camera.test.ts`.
- `src/app/adventureScreen.ts` — owns the canvas (`CANVAS_W = 1000`, `CANVAS_H = 760`
  at lines ~38–39), all input binding (`bindInput()`: click, contextmenu, mousemove,
  middle-button drag, keydown), edge scroll, and the render loop. Exposes
  `data-camera-x`/`data-camera-y` on the canvas for e2e.
- `index.html` — all CSS lives in a single `<style>` block; fixed sizes:
  `.adventure-screen` 1280×800, `.canvas-wrap` 1000×760, `.sidebar` 280px,
  `.menu-screen` 1280×800, `.panel` 960px, `.spellbook-box` 460px,
  `.system-panel-box` 560px.
- `src/ui/hud.ts` — `Hud` builds `sidebar` (title, 200px minimap, date, hero/town
  lists, hero panel, buttons: Next Hero / Spellbook / End Turn / System) and
  `bottomBar`. `MINIMAP_PX = 200`.
- `src/render/combatRenderer.ts` — fixed-size hex field: `HEX_R = 30`,
  `COMBAT_CANVAS_W/H` derived constants; `src/ui/combatScreen.ts` owns the combat
  canvas and click handling.
- `playwright.config.ts` — single `chromium` Desktop Chrome project; e2e specs in
  `e2e/` (`smoke`, `shell`, `adventure`, `town-hero`, `combat`). Boot shortcut
  `?map=<id>&seed=<n>` skips the menu.
- **No touch/pointer/resize handling exists anywhere in the codebase.**
- Determinism rule: `src/core/` must not be touched by this plan — everything here is
  `src/app/`, `src/ui/`, `src/render/`, `index.html`, `e2e/`. Golden replay hashes
  must not change.

## Development Approach

- **testing approach**: Regular (code first, then tests in the same task)
- complete each task fully before moving to the next
- make small, focused changes
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task
  - tests are not optional - they are a required part of the checklist
  - write unit tests for new functions/methods
  - write unit tests for modified functions/methods
  - add new test cases for new code paths
  - update existing test cases if behavior changes
  - tests cover both success and error scenarios
- **CRITICAL: all tests must pass before starting next task** - no exceptions
- **CRITICAL: update this plan file when scope changes during implementation**
- run tests after each change
- maintain backward compatibility: desktop mouse + keyboard interaction must keep
  working exactly as before (click to select/move, middle-drag pan, edge scroll,
  right-click info, arrow-key scroll, all shortcuts)
- **do not modify anything under `src/core/` or `src/data/`** — UI-only phase; golden
  replay tests (`src/core/replay.test.ts`) must pass untouched

## Testing Strategy

- **unit tests** (Vitest): camera zoom math, gesture state machine, combat fit-scale
  math — all pure functions, tested exhaustively like the existing `camera.test.ts`.
- **e2e tests** (Playwright): a new `e2e/mobile.spec.ts` using
  `test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })`
  inside the existing chromium project (so desktop specs are not duplicated). Covers:
  page fits viewport (no overflow), drawer HUD, touch tap-to-move, long-press info.
- **existing e2e must keep passing**: desktop specs assert selectors and use the
  `data-camera-x/y` datasets — keep those stable; if a spec assumed the fixed 1000×760
  canvas, update it deliberately in the same task that breaks it.
- `npm run check` (tsc + eslint + vitest) green at the end of every task.

## Progress Tracking

- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix
- document issues/blockers with ⚠️ prefix
- update plan if implementation deviates from original scope
- keep plan in sync with actual work done

## Solution Overview

Key architectural choice: **the camera stays in world pixels; zoom is applied only at
the boundaries** (canvas transform for drawing, input conversion for hit-testing).

- `Camera` gains a `zoom` field, but `x/y/width/height` remain world-px: on every
  resize or zoom change, `width = cssWidth / zoom`, `height = cssHeight / zoom`,
  then clamp. All existing camera functions (`clampCamera`, `visibleTileRange`,
  `centerCameraOn`, …) keep working unchanged — they just receive different
  width/height values.
- The adventure renderer applies one transform per frame:
  `ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, 0, 0)` and then draws exactly as it
  does today in world-px space. Crisp on hiDPI, scaled for zoom, near-zero renderer
  churn. (Text and line widths scale with zoom — acceptable for placeholder art.)
- Input converts CSS px → camera space with a single division by `zoom` before
  `tileAtScreen`.
- Touch is handled by a **pure gesture state machine** (`src/app/gestures.ts`): it
  consumes synthetic pointer events and emits semantic actions (`tap`, `longPress`,
  `panBy`, `pinch`, `hover`). `adventureScreen.bindInput()` becomes a thin adapter
  that feeds real PointerEvents in and maps actions to existing handlers. The FSM is
  unit-testable without a DOM, matching the project's testing style.
- Layout becomes fluid CSS: the shell fills `100dvw × 100dvh`, the canvas flexes, a
  `ResizeObserver` keeps the canvas backing store and camera in sync. A single
  `@media (max-width: 768px)` breakpoint switches the sidebar to a drawer.
- The combat battlefield does not scroll, so it scale-to-fits: a pure
  `combatFitScale(availW, availH)` returns the uniform scale, the canvas backing store
  is sized `logical × fit × dpr`, and hit-testing divides by `fit`.

## Technical Details

### Camera zoom math (`src/render/camera.ts`)

```ts
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2;

export interface Camera {
  x: number;       // world px (unchanged)
  y: number;
  width: number;   // viewport size in WORLD px (= cssWidth / zoom)
  height: number;
  zoom: number;    // 1 = 48 css px per tile
}

// resize/zoom entry point: derives world-px viewport from css size, clamps
export function cameraForViewport(cam, cssW, cssH, zoom, mapTiles): Camera

// pinch/wheel: change zoom keeping the world point under (anchorSx, anchorSy) fixed;
// anchor is in CSS px relative to the canvas
export function zoomCameraAt(cam, newZoom, anchorSx, anchorSy, cssW, cssH, mapTiles): Camera
//   fixed-point identity: cam.x + anchorSx/oldZoom === newCam.x + anchorSx/newZoom

// hit-testing wrapper used by input handlers (sx, sy in CSS px):
export function tileAtClientPoint(cam, sx, sy, mapTiles): Pos | null
//   = tileAtScreen(cam, sx / cam.zoom, sy / cam.zoom, mapTiles)
```

When the zoomed-out viewport is larger than the map, `clampCamera` already pins to 0 —
the renderer letterboxes naturally (background fill). Wheel zoom steps ×1.1 per tick;
keyboard `+`/`-` steps ×1.25; all clamped to `[ZOOM_MIN, ZOOM_MAX]`.
`cameraForViewport` preserves the current viewport **center** (re-centers on
`cam.x + cam.width/2`) so resizes/rotations don't jump the view to a clamped corner.

**e2e transform contract:** the existing specs compute tile→pixel positions with a
shared `canvasPoint`-style helper assuming a fixed 1000×760 canvas at zoom 1. Once the
canvas is fluid, `renderAll()` must expose the full transform on the canvas dataset —
keep `data-camera-x`/`data-camera-y` (world px) and add `data-zoom` — and the e2e
helpers must be rewritten to use them: `cssX = (worldX - cameraX) * zoom`. The combat
canvas likewise exposes `data-fit`. This is a required change in the tasks that alter
canvas sizing, not a contingency.

### Gesture state machine (`src/app/gestures.ts`)

Pure FSM, no DOM types beyond a minimal `{pointerId, x, y, pointerType, button}` input
shape. Config: `TAP_SLOP_PX = 8`, `LONG_PRESS_MS = 500`. Timers injected (the adapter
owns `setTimeout`) so tests drive time explicitly.

States: `idle → pressed → (tap | longPress | panning) | pinching`.
Emitted actions:

- `tap {x, y}` — pointerup within slop and before long-press fires → existing
  click/tile-select logic (two-tap move confirmation unchanged)
- `longPress {x, y}` — touch only; shows the info popup (replaces right-click)
- `panBy {dx, dy}` — single-pointer drag past slop (touch: any button; mouse:
  middle button only, preserving current desktop behavior)
- `pinch {scale, cx, cy}` — two-pointer distance ratio + midpoint → `zoomCameraAt`
- `hover {x, y}` — mouse-only move, feeds edge scroll / `mousePos`

Adapter details: `touch-action: none` CSS on the canvas, `setPointerCapture` on drag
start, suppress the synthetic `contextmenu` after a handled long-press, keep real
right-click info for mouse, edge scroll gated on `pointerType === 'mouse'`.

**Popup edge clamping:** `InfoPopup.show` currently places at `(sx+8, sy+8)` with no
bounds check — a long-press near the right/bottom edge of a 390px screen pushes it
off-screen. Add a pure `clampPopupPosition(x, y, popupW, popupH, boundsW, boundsH)`
helper (flip/clamp inside bounds) used by both the adventure info popup and the combat
tooltip, with unit tests.

### Responsive layout (index.html CSS)

- `html, body, #app`: `height: 100dvh`; `.adventure-screen`: `width: 100vw; height:
  100dvh` (desktop simply gets a bigger map — fixed 1280×800 frame removed).
- `.canvas-wrap`: `flex: 1; min-width: 0; overflow: hidden;` canvas fills it
  (`width/height: 100%` CSS; backing store set from `ResizeObserver` × dpr).
- `.menu-screen`: fills viewport; `.menu-box`: `max-width: min(720px, calc(100vw -
  24px))`; logo `max-width: 100%`.
- `.panel`: `width: min(960px, calc(100vw - 16px)); max-height: calc(100dvh - 16px)`;
  `.spellbook-box`, `.system-panel-box`, `.modal-box` likewise capped to viewport.
- `@media (max-width: 768px)`: `.hero-columns` stacks vertically; `.building-grid`
  2 columns; `.sidebar` becomes the drawer (below); `.setup-options` wraps
  (`flex-wrap: wrap` — new-game setup overflows 390px today); `.menu-box` padding
  drops to ~12px; count-dialog rows (`.count-row`, `.count-input`, slider) wrap and
  stay tappable; pass-device and game-over overlays reuse `.menu-box` so they inherit
  the caps — verify, don't assume.

### Mobile HUD drawer

- Sidebar element unchanged in content; on narrow screens it is `position: absolute`,
  right-anchored, translated off-screen, shown by toggling an `open` class +
  semi-transparent backdrop (tap to close).
- Bottom bar gains a ☰ button (`data-testid="hud-menu-toggle"`, hidden on wide
  screens via CSS) and keeps End Turn / Next Hero reachable without opening the
  drawer (move/duplicate the buttons into the bottom bar under the breakpoint —
  implementer picks the simpler of the two; keep existing `data-testid`s working on
  desktop).

### Combat scale-to-fit (`src/render/combatRenderer.ts`, `src/ui/combatScreen.ts`)

```ts
export function combatFitScale(availW: number, availH: number): number
//  = min(1, availW / COMBAT_CANVAS_W, availH / COMBAT_CANVAS_H), floor at 0.35
```

Canvas CSS size = `logical × fit`; backing = `css × dpr`; renderer prepends
`ctx.setTransform(fit * dpr, ...)`; combat click/tap handlers divide CSS coords by
`fit` before `hexAtPixel`-style lookups. Recomputed on resize. The combat canvas
exposes `data-fit`, and `e2e/combat.spec.ts` (which mirrors `hexCenter` with raw
`HEX_R = 30` pixel math) is updated to scale by it — note `fit` may already be < 1 on
the desktop e2e viewport once the panel includes log + controls, so this is part of
the same task, not optional. The combat tooltip uses the shared `clampPopupPosition`
helper.

### e2e

`e2e/mobile.spec.ts` with `test.use({ viewport: {width: 390, height: 844}, hasTouch:
true, isMobile: true })` — stays inside the existing chromium project so the desktop
specs run once (`hasTouch` at file scope is enough for `page.touchscreen`). Taps via
`page.touchscreen.tap`. For the drag-pan test, synthetic pointer events dispatched
from `page.evaluate` are untrusted and bypass `setPointerCapture` — use CDP
`Input.dispatchTouchEvent` (`page.context().newCDPSession(page)`) with touchStart /
touchMove / touchEnd instead; spike this first and fall back to asserting drag-pan
via unit tests only if CDP proves flaky. Pinch is covered by unit tests only.

## What Goes Where

- **Implementation Steps** (`[ ]` checkboxes): all code/CSS/test changes in this repo.
- **Post-Completion** (no checkboxes): manual device testing, Pages deploy.

## Implementation Steps

### Task 1: Camera zoom math

**Files:**
- Modify: `src/render/camera.ts`
- Modify: `src/render/camera.test.ts`
- Modify: `src/app/adventureScreen.ts` (construction sites pass `zoom: 1`)

- [x] add `zoom` to `Camera`, `ZOOM_MIN`/`ZOOM_MAX` constants; existing functions keep
      operating on world-px `width/height` unchanged
- [x] implement `cameraForViewport(cam, cssW, cssH, zoom, mapTiles)` (derive world-px
      viewport from CSS size, preserve the current viewport center, clamp)
- [x] implement `zoomCameraAt(cam, newZoom, anchorSx, anchorSy, cssW, cssH, mapTiles)`
      with the fixed-anchor identity from Technical Details
- [x] implement `tileAtClientPoint(cam, sx, sy, mapTiles)` and switch
      `adventureScreen.ts` hit-testing call sites to it; initialize camera with
      `zoom: 1` (no behavior change yet at zoom 1)
- [x] write tests: zoom clamp bounds, `cameraForViewport` at several sizes/zooms
      (including viewport larger than map, and center preservation across a resize),
      `zoomCameraAt` keeps anchor world point fixed and clamps at map edges,
      `tileAtClientPoint` at zoom 0.5/1/2
- [x] run `npm run check` - must pass before task 2

### Task 2: Responsive adventure canvas with DPR rendering

**Files:**
- Modify: `src/app/adventureScreen.ts`
- Modify: `src/render/adventureRenderer.ts`
- Modify: `index.html` (shell/canvas/menu CSS made fluid)
- Modify: `e2e/adventure.spec.ts`, `e2e/shell.spec.ts`, `e2e/town-hero.spec.ts`
  (tile→pixel helpers rewritten — required, the fixed-canvas math breaks)

- [x] remove fixed `CANVAS_W`/`CANVAS_H` usage: `ResizeObserver` on `.canvas-wrap`
      sizes the backing store (`css × devicePixelRatio`), updates the camera via
      `cameraForViewport`, and marks dirty; canvas CSS size `100%`
- [x] adventure renderer applies `ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, 0, 0)`
      each frame and otherwise draws in world-px space as today; clear/letterbox in
      device space first
- [x] expose `data-zoom` on the canvas in `renderAll()` next to the existing
      `data-camera-x`/`data-camera-y`
- [x] make shell CSS fluid per Technical Details (`100dvh` shell, flexing canvas-wrap,
      fluid `.menu-screen`/`.menu-box`); desktop keeps sidebar + bottom bar layout
- [x] edge scroll and keyboard pan: bounds checked against live CSS width/height, pan
      deltas stay world-px constants (`EDGE_SCROLL_SPEED`, `KEY_SCROLL_STEP`)
- [x] wire mouse-wheel zoom (×1.1 per tick about the cursor) and `+`/`-` shortcuts
      (×1.25 about the viewport center) through `zoomCameraAt`; extend
      `src/app/shortcuts.ts` + `src/app/shortcuts.test.ts` for the new keys
- [x] rewrite the shared e2e tile→pixel helper(s) to derive positions from the live
      canvas box + `data-camera-x/y` + `data-zoom` (`cssX = (worldX - cameraX) * zoom`)
      instead of assuming a 1000×760 canvas at origin (new `e2e/helpers.ts` shared by
      adventure/shell/town-hero specs)
- [x] write/extend unit tests for any new pure helpers (e.g. backing-size/letterbox
      math, edge-scroll bound check) and the shortcut additions (`src/app/viewport.ts`
      + `viewport.test.ts`: `canvasBackingSize`, `edgeScrollDelta`)
- [x] run `npm run check` and `npm run test:e2e` — all desktop specs green before task 3
- ➕ `.bottom-bar` gained `box-sizing: border-box` so its 1px top border doesn't
      steal a pixel from the flexing canvas-wrap (kept the desktop canvas exactly
      1000×760 at the 1280×800 e2e viewport)

### Task 3: Pointer-event gesture state machine and touch input

**Files:**
- Create: `src/app/gestures.ts`
- Create: `src/app/gestures.test.ts`
- Modify: `src/app/adventureScreen.ts` (`bindInput()` becomes the adapter)
- Modify: `src/ui/hud.ts` (`InfoPopup` clamps to bounds)
- Modify: `src/ui/helpers.ts` + `src/ui/helpers.test.ts` (`clampPopupPosition`)
- Modify: `index.html` (`touch-action: none` on the adventure canvas)

- [x] implement the gesture FSM per Technical Details (tap / longPress / panBy /
      pinch / hover; injected timer; slop 8px; long-press 500ms; mouse pan stays
      middle-button-only, touch pans with one finger)
- [x] replace the mouse listeners in `bindInput()` with pointer-event listeners
      feeding the FSM; map actions: tap → existing click logic, longPress → info
      popup, panBy → `panCamera`, pinch → `zoomCameraAt`, hover → edge-scroll
      `mousePos`; `setPointerCapture` during pans; suppress synthetic `contextmenu`
      after a handled long-press, keep real right-click info
- [x] gate edge scroll on `pointerType === 'mouse'`; add `touch-action: none` CSS
- [x] add `clampPopupPosition` to `src/ui/helpers.ts` and use it in `InfoPopup.show`
      so long-press info near the right/bottom edge stays on-screen
- [x] write FSM tests: tap within slop, drag past slop emits panBy (and no tap on
      release), long-press fires once and suppresses tap, movement cancels long-press,
      pinch ratio/midpoint from two pointers, pointer-cancel resets state, mouse
      left-button drag does NOT pan (preserves click semantics)
- [x] write `clampPopupPosition` tests (interior, right/bottom edge flip, popup larger
      than bounds)
- [x] run `npm run check` and `npm run test:e2e` (desktop specs must still pass:
      click-to-move, right-click info) - must pass before task 4

### Task 4: Overlay screens fit the viewport

**Files:**
- Modify: `index.html` (panel/dialog/spellbook/modal CSS + 768px breakpoint)
- Modify: `e2e/shell.spec.ts` (narrow-viewport menu assertions)

- [x] cap `.panel`, `.modal-box`, `.spellbook-box`, `.system-panel-box`,
      `.count-dialog` content to `min(<current>, calc(100vw - 16px))` and
      `max-height: calc(100dvh - 16px)` with internal scroll
- [x] add the `@media (max-width: 768px)` breakpoint: `.hero-columns` stacks,
      `.building-grid` → 2 columns, army rows/recruit rows wrap, menu logo scales,
      `.setup-options` wraps (new-game setup), `.menu-box` padding ~12px,
      count-dialog rows (`.count-row`/`.count-input`/slider) wrap and stay tappable
- [x] add a narrow-viewport e2e test (in `e2e/shell.spec.ts` via `test.describe` +
      `test.use({ viewport: {width: 390, height: 844} })`): main menu renders with no
      horizontal page overflow (`document.documentElement.scrollWidth <= innerWidth`),
      new-game setup usable, a town panel opens within viewport bounds
- [x] run `npm run check` and `npm run test:e2e` - must pass before task 5

### Task 5: Combat screen scale-to-fit

**Files:**
- Modify: `src/render/combatRenderer.ts` (`combatFitScale` + transform)
- Modify: `src/render/combatRenderer.test.ts`
- Modify: `src/ui/combatScreen.ts` (canvas sizing, hit-test mapping, resize handling,
  tooltip clamping)
- Modify: `e2e/combat.spec.ts` (hex→pixel math scaled by `data-fit` — required: `fit`
  may be < 1 even on the desktop e2e viewport)
- Modify: `index.html` (combat panel CSS on narrow screens)

- [x] implement pure `combatFitScale(availW, availH)` (≤1, floor 0.35) and apply
      `ctx.setTransform(fit * dpr, ...)` in the combat renderer
- [x] combat canvas backing store = logical size × fit × dpr, CSS size = logical ×
      fit; recompute on `ResizeObserver`/window resize; expose `data-fit` on the
      combat canvas
- [x] divide click/tap coordinates by `fit` before hex lookup in `combatScreen.ts`;
      clamp the combat tooltip via `clampPopupPosition`
- [x] update `e2e/combat.spec.ts` hex-click helper to scale its `hexCenter` mirror by
      the live `data-fit` and canvas box
- [x] narrow-screen combat CSS: panel fits `100vw/100dvh`, hero panels/controls wrap,
      log shrinks
- [x] write tests: `combatFitScale` (wide, tall, tiny, huge inputs; floor), hit-test
      coordinate mapping at fit 0.5/1 (`hexAtCanvasPoint`)
- [x] run `npm run check` and `npm run test:e2e` (combat spec) - must pass before task 6
- ➕ chrome around the canvas (header, log/controls) is measured from the live
      elements + constant paddings so the fit computation cannot feed back on the
      canvas size; verified mid-combat resize 1280×800 → 390×844 → back (fit
      1 → 0.40 → 1, no page overflow) via a dev-server probe

### Task 6: Mobile HUD — drawer sidebar and bottom bar

**Files:**
- Modify: `src/ui/hud.ts`
- Modify: `index.html` (drawer/backdrop/bottom-bar CSS under the breakpoint)
- Modify: `src/app/adventureScreen.ts` (only if wiring requires it)
- Create: `e2e/mobile.spec.ts`

- [x] add drawer behavior to `Hud`: ☰ toggle button in the bottom bar
      (`data-testid="hud-menu-toggle"`, CSS-hidden on wide screens), `open` class on
      the sidebar, backdrop that closes on tap; selecting a hero/town from the drawer
      closes it
- [x] keep End Turn and Next Hero reachable on narrow screens without opening the
      drawer: MOVE the existing buttons into the bottom bar under the breakpoint (CSS
      reparenting/order or a single relocated element) — do NOT duplicate them, or
      `getByTestId` breaks on two matches; desktop sidebar/testids unchanged
- [x] drawer CSS: right-anchored slide-over with transition, sized
      `min(280px, 85vw)`, scrollable
- [x] create `e2e/mobile.spec.ts` (`test.use({ viewport: {width: 390, height: 844},
      hasTouch: true, isMobile: true })`): adventure screen boots via
      `?map=tiny&seed=42` with no page overflow, canvas fills viewport width, drawer
      opens/closes via ☰ and backdrop, End Turn reachable and works
- [x] run `npm run check` and `npm run test:e2e` - must pass before task 7
- ➕ a `matchMedia('(max-width: 768px)')` listener in `Hud` physically relocates the
      Next Hero / End Turn buttons between sidebar and bottom bar (CSS cannot reparent
      across containers); resources got a `.resource-cells` scrollable wrapper so the
      relocated buttons + ☰ stay visible on 390px; `Hud.destroy()` (called from
      `AdventureScreen.destroy`) removes the listener

### Task 7: Touch gameplay e2e

**Files:**
- Modify: `e2e/mobile.spec.ts`

- [x] touch tap selects own hero (tap hero tile → selected state in HUD)
- [x] two-tap move: tap destination (path preview/status appears), tap again → hero
      moves (asserted via the HUD `hero-pos` changing 2,2 → 4,2 — simpler and
      stronger than camera/movement-point proxies)
- [x] one-finger drag pans the camera via CDP `Input.dispatchTouchEvent`
      (touchStart/touchMove/touchEnd through `page.context().newCDPSession(page)`;
      synthetic pointer events from `page.evaluate` are untrusted and bypass
      `setPointerCapture`); assert `data-camera-x/y` changed; if CDP proves flaky,
      drop this case and rely on the FSM unit tests for pan — CDP proved reliable,
      exact `data-camera-x` 0 → 120 asserted
- [x] long-press shows the tile info popup; it dismisses on next tap
- [x] run full `npm run test:e2e` (desktop + mobile specs) - must pass before task 8

### Task 8: Verify acceptance criteria

- [ ] verify all Overview requirements implemented (responsive canvas, zoom, touch
      input, overlays fit, drawer HUD, mobile e2e)
- [ ] verify pass-device and game-over overlays fit a 390px viewport (they reuse
      `.menu-box`; confirm via the narrow-viewport e2e or a quick manual dev-server
      check at a mobile viewport)
- [ ] verify `src/core/` and `src/data/` untouched (`git diff --stat main -- src/core
      src/data` empty) and golden replay tests pass unchanged
- [ ] run full test suite: `npm run check`
- [ ] run e2e: `npm run test:e2e`
- [ ] verify coverage: `npm test -- --coverage` (≥80% lines in `src/core/` still holds)

### Task 9: [Final] Update documentation

- [ ] update README.md: mobile support note (touch controls: drag to pan, pinch to
      zoom, long-press for info), drawer HUD mention
- [ ] update CLAUDE.md if new conventions emerged (e.g. gesture FSM pattern,
      breakpoint value)
- [ ] move this plan to `docs/plans/completed/`

## Post-Completion

*Items requiring manual intervention or external systems — informational only*

**Manual verification:**
- Test on a real phone (iOS Safari + Android Chrome) via the GH Pages deploy: pan,
  pinch, two-tap move, long-press info, drawer, town/combat screens in portrait and
  landscape. Emulators don't catch everything (Safari gesture quirks, dvh behavior).
- Check hiDPI desktop rendering is crisp after the DPR change.

**External system updates:**
- None — GH Pages deploy picks the changes up on merge to `main` (user deploys).
