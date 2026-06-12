# Heroes Clone — project conventions

Browser-based turn-based strategy game. TypeScript 5 strict, Vite, no UI framework, only
runtime dependency is `zod`. Full spec: `docs/plans/completed/20260611-heroes3-browser-clone.md`.

## Determinism rule (critical)

- `src/core/` and `src/data/` are pure: **no DOM, no `Math.random()`, no `Date`/clock reads**.
- All randomness flows through the seeded PRNG in `src/core/rng.ts` (mulberry32); the rng
  state lives inside `GameState.rngState` and advances with every roll. Same seed + same
  commands must produce an identical game — golden replay tests enforce this.
- The dispatcher never mutates its input state; reducers build manual structural copies
  (no immer, no mutation outside `dispatch`).

## Command/reducer pattern

- All gameplay goes through `dispatch(state, command) -> { state, events }` in
  `src/core/commands.ts`. UI and AI both emit commands; the core does not know who plays.
- New gameplay features = new command (or extending one) + events for the UI, never direct
  state pokes from `src/ui/` or `src/app/`.
- `pendingChoices` blocks other commands until resolved via `resolveChoice` (exception:
  the choice owner may resolve off-turn).

## Data-driven content

- Game content (creatures, spells, buildings, factions, objects, terrain, heroes) is JSON
  in `src/data/`, validated by zod schemas in `src/data/schema.ts` at load.
- Code references content only by string id; the loader (`src/data/index.ts`)
  cross-validates references (dangling ids, prereq cycles) and tests fail on violations.
- Prefer data changes over code changes — adding a faction is JSON-only (see README).
- Maps are authored via the ASCII DSL (`src/maps/dsl.ts`); register new maps in
  `src/maps/index.ts`.

## Testing

- Every code change ships with tests in the same change; all tests must pass before moving on.
- Commands:
  - `npm test` — unit tests (Vitest)
  - `npm run test:e2e` — Playwright browser tests (UI changes need e2e updates)
  - `npm run test:balance` — slow AI-vs-AI simulation suite (separate config, not in default run)
  - `npm run check` — tsc + eslint + unit tests; must pass before commit
- Coverage target: >=80% lines in `src/core/` (`npm test -- --coverage`).
- Golden replay tests (`src/core/replay.test.ts`) pin determinism — if a core change
  legitimately alters rng consumption, regenerate hashes deliberately, never blindly.

## Responsive UI / input

- The camera stays in world px; `zoom` applies only at the boundaries:
  `ctx.setTransform(dpr * zoom, ...)` when drawing, divide CSS coords by `zoom` before
  hit-testing (`tileAtClientPoint`). Combat scale-to-fits via `combatFitScale`.
- All pointer/touch input flows through the pure gesture FSM in `src/app/gestures.ts`
  (tap / longPress / panBy / pinch / hover) — keep it DOM-free and unit-tested;
  `bindInput()` in `adventureScreen.ts` is only a thin adapter.
- Single mobile breakpoint: `@media (max-width: 768px)` in `index.html`; the sidebar
  becomes a drawer and `Hud` relocates Next Hero / End Turn via a `matchMedia` listener.
- e2e position math derives from canvas datasets — keep `data-camera-x`/`data-camera-y`,
  `data-zoom` (adventure) and `data-fit` (combat) exposed; helpers live in `e2e/helpers.ts`.

## Style

- Native type syntax: `list`-style generics (`string[]`, `Record<K, V>`), `| null` /
  `| undefined` unions; no typing wrappers.
- Fix linter/type errors properly — never suppress or cast to `any`.
- Minimal comments; no top-of-function narration for trivial code.
- UI text/selectors: e2e tests rely on DOM selectors — keep `data-*`/ids stable.
