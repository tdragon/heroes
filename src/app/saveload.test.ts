import { describe, expect, it } from 'vitest';
import { loadGameData } from '../data';
import { compileMap } from '../maps/dsl';
import { tinyMapSource } from '../maps/fixtures/tiny.dsl';
import { dispatch } from '../core/commands';
import { deserializeGame, serializeGame, SAVE_VERSION } from '../core/serialize';
import { newGame } from '../core/setup';
import type { GameState } from '../core/state';
import {
  AUTOSAVE_SLOT_COUNT,
  autosave,
  autosaveMeta,
  buildExportFile,
  describeSlot,
  importSave,
  listAutosaves,
  listSlots,
  loadAutosave,
  loadFromSlot,
  SAVE_SLOT_COUNT,
  saveToSlot,
  slotMeta,
  type SaveStorage,
} from './saveload';
import { configureMap, heroesOfFaction } from './newGameSetup';

const data = loadGameData();
const tinyMap = compileMap(tinyMapSource, data);

class MemoryStorage implements SaveStorage {
  private readonly entries = new Map<string, string>();

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.entries.set(key, value);
  }
  removeItem(key: string): void {
    this.entries.delete(key);
  }
  get size(): number {
    return this.entries.size;
  }
}

function makeGame(seed = 42): GameState {
  return newGame(tinyMap, {}, seed, data);
}

// walk edric onto the guarded sawmill and confirm the fight, leaving a live combat
function makeMidCombatGame(): GameState {
  let state = makeGame(7);
  const hero = state.heroes.edric;
  if (!hero) throw new Error('missing edric');
  hero.pos = [5, 2];
  hero.movementPoints = 2000;
  state = dispatch(
    state,
    { type: 'moveHero', player: 'red', hero: 'edric', path: [[6, 2]] },
    data,
  ).state;
  const choice = state.pendingChoices[0];
  if (choice?.kind !== 'guardAttack') throw new Error('expected guard attack choice');
  state = dispatch(
    state,
    { type: 'resolveChoice', player: 'red', choiceId: choice.id, option: 0 },
    data,
  ).state;
  if (state.combat === null) throw new Error('combat did not start');
  return state;
}

describe('save slots', () => {
  it('round-trips a game through a slot', () => {
    const storage = new MemoryStorage();
    const state = makeGame();
    saveToSlot(storage, 1, state, 1000);
    expect(loadFromSlot(storage, 1)).toEqual(state);
  });

  it('round-trips a mid-combat save with the full battle sub-state', () => {
    const storage = new MemoryStorage();
    const state = makeMidCombatGame();
    expect(state.combat).not.toBeNull();
    saveToSlot(storage, 3, state, 1000);
    const restored = loadFromSlot(storage, 3);
    expect(restored).toEqual(state);
    expect(restored.combat?.combat.stacks.length).toBe(state.combat?.combat.stacks.length);
    // the restored battle is playable: dispatch one legal combat action
    const next = dispatch(
      restored,
      { type: 'combatAction', player: 'red', action: { type: 'defend' } },
      data,
    );
    expect(next.state.combat).not.toBeNull();
  });

  it('lists slot metadata and empty slots', () => {
    const storage = new MemoryStorage();
    const state = makeGame();
    saveToSlot(storage, 2, state, 555);
    const slots = listSlots(storage);
    expect(slots).toHaveLength(SAVE_SLOT_COUNT);
    expect(slots[0]).toBeNull();
    expect(slots[1]).toEqual({ day: 1, mapId: 'tiny', savedAt: 555 });
    expect(describeSlot(slots[1] ?? null)).toBe('tiny — Day 1');
    expect(describeSlot(null)).toBe('Empty');
  });

  it('rejects out-of-range slot numbers', () => {
    const storage = new MemoryStorage();
    expect(() => {
      saveToSlot(storage, 0, makeGame());
    }).toThrow('save slot must be 1..5');
    expect(() => {
      saveToSlot(storage, 6, makeGame());
    }).toThrow('save slot must be 1..5');
    expect(() => loadFromSlot(storage, 1)).toThrow('save slot is empty');
  });

  it('rejects a version-mismatched save gracefully', () => {
    const storage = new MemoryStorage();
    saveToSlot(storage, 1, makeGame(), 1);
    const raw = storage.getItem('heroes.save.1');
    if (raw === null) throw new Error('slot not written');
    storage.setItem('heroes.save.1', raw.replace(/"version":\d+/, '"version":999'));
    expect(() => loadFromSlot(storage, 1)).toThrow('save version 999 is not supported');
    // metadata is still listable, no crash
    expect(slotMeta(storage, 1)).not.toBeNull();
  });

  it('treats corrupted slots as empty in listings and fails loads with a message', () => {
    const storage = new MemoryStorage();
    storage.setItem('heroes.save.4', 'not json {');
    expect(listSlots(storage)[3]).toBeNull();
    expect(() => loadFromSlot(storage, 4)).toThrow('corrupted');
  });
});

describe('migration hook', () => {
  it('chains migrations from an old version up to the current one', () => {
    const state = makeGame();
    const old = serializeGame(state).replace(
      `"version":${String(SAVE_VERSION)}`,
      `"version":${String(SAVE_VERSION - 2)}`,
    );
    const calls: number[] = [];
    const migrations = {
      [SAVE_VERSION - 2]: (s: unknown): unknown => {
        calls.push(SAVE_VERSION - 2);
        return s;
      },
      [SAVE_VERSION - 1]: (s: unknown): unknown => {
        calls.push(SAVE_VERSION - 1);
        return s;
      },
    };
    expect(deserializeGame(old, migrations)).toEqual(state);
    expect(calls).toEqual([SAVE_VERSION - 2, SAVE_VERSION - 1]);
  });

  it('rejects old saves with no migration path', () => {
    const state = makeGame();
    const old = serializeGame(state).replace(`"version":${String(SAVE_VERSION)}`, '"version":1');
    expect(() => deserializeGame(old, {})).toThrow('save version 1 is not supported');
  });

  it('rejects saves newer than the supported version', () => {
    const state = makeGame();
    const future = serializeGame(state).replace(
      `"version":${String(SAVE_VERSION)}`,
      '"version":999',
    );
    expect(() => deserializeGame(future)).toThrow('newer than');
  });
});

describe('autosave rotation', () => {
  it('keeps the newest saves in a fixed-size ring', () => {
    const storage = new MemoryStorage();
    for (let day = 1; day <= 5; day++) {
      const state = makeGame();
      state.day = day;
      autosave(storage, state, day * 100);
    }
    const metas = [1, 2, 3].map((slot) => autosaveMeta(storage, slot));
    const days = metas.map((m) => m?.day).sort((a, b) => (a ?? 0) - (b ?? 0));
    // 5 autosaves over 3 ring slots: days 1 and 2 were overwritten
    expect(days).toEqual([3, 4, 5]);

    const entries = listAutosaves(storage);
    expect(entries.map((e) => e.meta.day)).toEqual([5, 4, 3]);
    const newestSlot = entries[0]?.slot ?? 1;
    expect(loadAutosave(storage, newestSlot).day).toBe(5);
  });

  it('recovers from a corrupted rotation counter', () => {
    const storage = new MemoryStorage();
    storage.setItem('heroes.autosave.counter', 'garbage');
    autosave(storage, makeGame(), 1);
    expect(autosaveMeta(storage, 1)).not.toBeNull();
    expect(storage.getItem('heroes.autosave.counter')).toBe('1');
    expect(AUTOSAVE_SLOT_COUNT).toBe(3);
  });
});

describe('export / import', () => {
  it('round-trips through the export file format', () => {
    const state = makeGame();
    const file = buildExportFile(state);
    expect(file.filename).toBe('heroes-tiny-day1.json');
    expect(importSave(file.json)).toEqual(state);
  });

  it('rejects malformed import data with a readable error', () => {
    expect(() => importSave('nope')).toThrow('not valid JSON');
  });
});

describe('new game setup helpers', () => {
  it('difficulty presets scale starting resources', () => {
    const hard = newGame(tinyMap, { difficulty: 'hard' }, 1, data);
    expect(hard.players[0]?.resources.gold).toBe(10000);
    const normal = newGame(tinyMap, { difficulty: 'normal' }, 1, data);
    expect(normal.players[0]?.resources.gold).toBe(20000);
  });

  it('configureMap swaps faction, control, and a matching start hero', () => {
    const configured = configureMap(tinyMap, data, [
      { color: 'red', faction: 'rampart', isHuman: true },
      { color: 'blue', faction: 'rampart', isHuman: true },
    ]);
    const [red, blue] = configured.players;
    expect(red?.faction).toBe('rampart');
    expect(blue?.faction).toBe('rampart');
    expect(blue?.isHuman).toBe(true);
    expect(red?.startHero).not.toBe(blue?.startHero);
    for (const player of configured.players) {
      const hero = data.heroes[player.startHero];
      expect(data.heroClasses[hero?.class ?? '']?.faction).toBe('rampart');
    }
    // a configured map starts a valid game
    const state = newGame(configured, {}, 5, data);
    expect(state.players.every((p) => p.isHuman)).toBe(true);
    expect(Object.values(state.towns).map((t) => t.faction)).toEqual(['rampart', 'rampart']);
  });

  it('configureMap keeps the authored hero when the faction is unchanged', () => {
    const configured = configureMap(tinyMap, data, [
      { color: 'red', faction: 'castle', isHuman: true },
      { color: 'blue', faction: 'necropolis', isHuman: false },
    ]);
    expect(configured.players[0]?.startHero).toBe('edric');
    expect(configured.players[1]?.startHero).toBe('mortus');
  });

  it('heroesOfFaction returns only matching templates', () => {
    const necro = heroesOfFaction(data, 'necropolis');
    expect(necro.length).toBeGreaterThanOrEqual(4);
    for (const hero of necro) {
      expect(data.heroClasses[hero.class]?.faction).toBe('necropolis');
    }
  });
});
