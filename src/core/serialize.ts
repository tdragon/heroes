import type { GameState } from './state';

export const SAVE_VERSION = 4;

interface SaveFile {
  version: number;
  state: GameState;
}

export function serializeGame(state: GameState): string {
  const save: SaveFile = { version: SAVE_VERSION, state };
  return JSON.stringify(save);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isValidPlayer(p: unknown): boolean {
  return (
    isRecord(p) &&
    typeof p.id === 'string' &&
    typeof p.isHuman === 'boolean' &&
    isArray(p.heroes) &&
    isArray(p.towns) &&
    isArray(p.explored) &&
    isRecord(p.resources) &&
    isRecord(p.seenObjects)
  );
}

function isValidEntity(e: unknown): boolean {
  return isRecord(e) && typeof e.id === 'string' && isArray(e.pos);
}

// Structural sanity check; trusts deeply nested entity shapes after checking
// the envelope plus the per-player and per-hero fields the UI reads every
// frame (so a malformed import fails on load instead of inside the rAF loop).
function isGameState(value: unknown): value is GameState {
  if (!isRecord(value)) return false;
  const map = value.map;
  return (
    typeof value.seed === 'number' &&
    typeof value.rngState === 'number' &&
    typeof value.day === 'number' &&
    typeof value.currentPlayer === 'string' &&
    isArray(value.players) &&
    value.players.every(isValidPlayer) &&
    isArray(value.tavernPool) &&
    isArray(value.pendingChoices) &&
    isRecord(value.heroes) &&
    Object.values(value.heroes).every(isValidEntity) &&
    isRecord(value.towns) &&
    Object.values(value.towns).every(isValidEntity) &&
    isRecord(map) &&
    typeof map.size === 'number' &&
    typeof map.terrain === 'string' &&
    isArray(map.objects) &&
    (value.combat === null || isRecord(value.combat)) &&
    (value.status === 'running' || isRecord(value.status))
  );
}

// migration hook: SAVE_MIGRATIONS[n] upgrades a raw version-n state to n+1;
// deserializeGame chains migrations until the state reaches SAVE_VERSION
export type SaveMigration = (state: unknown) => unknown;

export const SAVE_MIGRATIONS: Record<number, SaveMigration> = {};

export function deserializeGame(
  json: string,
  migrations: Record<number, SaveMigration> = SAVE_MIGRATIONS,
): GameState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('save file is not valid JSON');
  }
  if (!isRecord(parsed) || typeof parsed.version !== 'number') {
    throw new Error('save file has no version field');
  }
  if (parsed.version > SAVE_VERSION) {
    throw new Error(
      `save version ${String(parsed.version)} is not supported (newer than ${String(SAVE_VERSION)})`,
    );
  }
  let state = parsed.state;
  for (let v = parsed.version; v < SAVE_VERSION; v++) {
    const step = migrations[v];
    if (!step) {
      throw new Error(
        `save version ${String(parsed.version)} is not supported (no migration from ${String(v)} to ${String(v + 1)})`,
      );
    }
    state = step(state);
  }
  // a save without a combat field means "no battle in progress"
  if (isRecord(state) && state.combat === undefined) {
    state.combat = null;
  }
  if (!isGameState(state)) {
    throw new Error('save file state is malformed');
  }
  return state;
}
