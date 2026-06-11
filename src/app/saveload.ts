import type { GameState } from '../core/state';
import { deserializeGame, serializeGame } from '../core/serialize';

// minimal subset of the DOM Storage interface, so tests can pass an in-memory stub
export interface SaveStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const SAVE_SLOT_COUNT = 5;
export const AUTOSAVE_SLOT_COUNT = 3;

const SLOT_KEY_PREFIX = 'heroes.save.';
const AUTOSAVE_KEY_PREFIX = 'heroes.autosave.';
const AUTOSAVE_COUNTER_KEY = 'heroes.autosave.counter';

export interface SaveSlotMeta {
  day: number;
  mapId: string;
  savedAt: number;
}

interface SlotEnvelope extends SaveSlotMeta {
  save: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function slotKey(slot: number): string {
  if (!Number.isInteger(slot) || slot < 1 || slot > SAVE_SLOT_COUNT) {
    throw new Error(`save slot must be 1..${String(SAVE_SLOT_COUNT)}, got ${String(slot)}`);
  }
  return `${SLOT_KEY_PREFIX}${String(slot)}`;
}

function autosaveKey(slot: number): string {
  if (!Number.isInteger(slot) || slot < 1 || slot > AUTOSAVE_SLOT_COUNT) {
    throw new Error(`autosave slot must be 1..${String(AUTOSAVE_SLOT_COUNT)}, got ${String(slot)}`);
  }
  return `${AUTOSAVE_KEY_PREFIX}${String(slot)}`;
}

function writeEnvelope(storage: SaveStorage, key: string, state: GameState, now: number): void {
  const envelope: SlotEnvelope = {
    day: state.day,
    mapId: state.map.id,
    savedAt: now,
    save: JSON.parse(serializeGame(state)) as unknown,
  };
  storage.setItem(key, JSON.stringify(envelope));
}

function readMeta(storage: SaveStorage, key: string): SaveSlotMeta | null {
  const raw = storage.getItem(key);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.day !== 'number' ||
    typeof parsed.mapId !== 'string' ||
    typeof parsed.savedAt !== 'number'
  ) {
    return null;
  }
  return { day: parsed.day, mapId: parsed.mapId, savedAt: parsed.savedAt };
}

function readEnvelope(storage: SaveStorage, key: string): GameState {
  const raw = storage.getItem(key);
  if (raw === null) {
    throw new Error('save slot is empty');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('save slot is corrupted (not valid JSON)');
  }
  if (!isRecord(parsed) || parsed.save === undefined) {
    throw new Error('save slot is corrupted (missing save payload)');
  }
  return deserializeGame(JSON.stringify(parsed.save));
}

export function saveToSlot(
  storage: SaveStorage,
  slot: number,
  state: GameState,
  now: number = Date.now(),
): void {
  writeEnvelope(storage, slotKey(slot), state, now);
}

export function loadFromSlot(storage: SaveStorage, slot: number): GameState {
  return readEnvelope(storage, slotKey(slot));
}

export function slotMeta(storage: SaveStorage, slot: number): SaveSlotMeta | null {
  return readMeta(storage, slotKey(slot));
}

export function listSlots(storage: SaveStorage): (SaveSlotMeta | null)[] {
  return Array.from({ length: SAVE_SLOT_COUNT }, (_, i) => slotMeta(storage, i + 1));
}

// autosave rotation: a persistent counter picks the next of AUTOSAVE_SLOT_COUNT
// ring slots, so the most recent autosaves survive and the oldest is overwritten
export function autosave(storage: SaveStorage, state: GameState, now: number = Date.now()): void {
  const counter = Number(storage.getItem(AUTOSAVE_COUNTER_KEY) ?? '0');
  const safe = Number.isFinite(counter) && counter >= 0 ? Math.floor(counter) : 0;
  const slot = (safe % AUTOSAVE_SLOT_COUNT) + 1;
  writeEnvelope(storage, autosaveKey(slot), state, now);
  storage.setItem(AUTOSAVE_COUNTER_KEY, String(safe + 1));
}

export function loadAutosave(storage: SaveStorage, slot: number): GameState {
  return readEnvelope(storage, autosaveKey(slot));
}

export function autosaveMeta(storage: SaveStorage, slot: number): SaveSlotMeta | null {
  return readMeta(storage, autosaveKey(slot));
}

// autosaves ordered newest first
export function listAutosaves(storage: SaveStorage): { slot: number; meta: SaveSlotMeta }[] {
  const entries: { slot: number; meta: SaveSlotMeta }[] = [];
  for (let slot = 1; slot <= AUTOSAVE_SLOT_COUNT; slot++) {
    const meta = autosaveMeta(storage, slot);
    if (meta) entries.push({ slot, meta });
  }
  return entries.sort((a, b) => b.meta.savedAt - a.meta.savedAt);
}

export function buildExportFile(state: GameState): { filename: string; json: string } {
  return {
    filename: `heroes-${state.map.id}-day${String(state.day)}.json`,
    json: serializeGame(state),
  };
}

export function importSave(json: string): GameState {
  return deserializeGame(json);
}

export function describeSlot(meta: SaveSlotMeta | null): string {
  if (!meta) return 'Empty';
  return `${meta.mapId} — Day ${String(meta.day)}`;
}
