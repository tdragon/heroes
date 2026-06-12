import { describe, expect, it } from 'vitest';
import { loadGameData } from '../data';
import { compileMap } from '../maps/dsl';
import { tinyMapSource } from '../maps/fixtures/tiny.dsl';
import { dispatch } from './commands';
import { deserializeGame, serializeGame, SAVE_VERSION } from './serialize';
import { newGame } from './setup';

const data = loadGameData();
const tinyMap = compileMap(tinyMapSource, data);

describe('serializeGame / deserializeGame', () => {
  it('round-trips a freshly created game', () => {
    const state = newGame(tinyMap, {}, 42, data);
    expect(deserializeGame(serializeGame(state))).toEqual(state);
  });

  it('round-trips a state after several commands', () => {
    let state = newGame(tinyMap, {}, 7, data);
    for (let i = 0; i < 5; i++) {
      state = dispatch(state, { type: 'endTurn', player: state.currentPlayer }, data).state;
    }
    const restored = deserializeGame(serializeGame(state));
    expect(restored).toEqual(state);
    // restored state is fully playable
    const next = dispatch(restored, { type: 'endTurn', player: restored.currentPlayer }, data);
    expect(next.state.day).toBeGreaterThanOrEqual(state.day);
  });

  it('writes a version field', () => {
    const state = newGame(tinyMap, {}, 1, data);
    const parsed: unknown = JSON.parse(serializeGame(state));
    expect(parsed).toMatchObject({ version: SAVE_VERSION });
  });

  it('rejects an unsupported version', () => {
    const state = newGame(tinyMap, {}, 1, data);
    const tampered = serializeGame(state).replace(
      `"version":${String(SAVE_VERSION)}`,
      '"version":999',
    );
    expect(() => deserializeGame(tampered)).toThrow('save version 999 is not supported');
  });

  it('rejects invalid JSON and missing version', () => {
    expect(() => deserializeGame('not json {')).toThrow('not valid JSON');
    expect(() => deserializeGame('{"state":{}}')).toThrow('no version field');
    expect(() => deserializeGame('"hello"')).toThrow('no version field');
  });

  it('rejects malformed state payloads', () => {
    const bad = JSON.stringify({ version: SAVE_VERSION, state: { seed: 'x' } });
    expect(() => deserializeGame(bad)).toThrow('malformed');
    const missing = JSON.stringify({ version: SAVE_VERSION });
    expect(() => deserializeGame(missing)).toThrow('malformed');
  });

  it('defaults a missing combat field to null instead of soft-locking', () => {
    const state = newGame(tinyMap, {}, 3, data);
    const raw = JSON.parse(serializeGame(state)) as { version: number; state: { combat?: unknown } };
    delete raw.state.combat;
    const restored = deserializeGame(JSON.stringify(raw));
    expect(restored.combat).toBeNull();
    // and the restored state accepts commands
    const next = dispatch(restored, { type: 'endTurn', player: restored.currentPlayer }, data);
    expect(next.state).toBeDefined();
  });

  it('rejects malformed players and entities that would crash the renderer', () => {
    const state = newGame(tinyMap, {}, 3, data);
    const breakField = (mutate: (s: Record<string, unknown>) => void): string => {
      const raw = JSON.parse(serializeGame(state)) as { version: number; state: Record<string, unknown> };
      mutate(raw.state);
      return JSON.stringify(raw);
    };
    expect(() => deserializeGame(breakField((s) => (s.players = [42])))).toThrow('malformed');
    expect(() =>
      deserializeGame(breakField((s) => (s.heroes = { edric: { id: 'edric' } }))),
    ).toThrow('malformed');
    expect(() => deserializeGame(breakField((s) => (s.combat = 'fighting')))).toThrow('malformed');
  });

  it('rejects malformed combat sub-state instead of crashing later', () => {
    const state = newGame(tinyMap, {}, 3, data);
    const breakField = (mutate: (s: Record<string, unknown>) => void): string => {
      const raw = JSON.parse(serializeGame(state)) as { version: number; state: Record<string, unknown> };
      mutate(raw.state);
      return JSON.stringify(raw);
    };
    // an empty combat object passes a shallow isRecord check but has none of
    // the fields the combat screen dereferences on the first frame
    expect(() => deserializeGame(breakField((s) => (s.combat = {})))).toThrow('malformed');
    // combat stacks missing required fields
    expect(() =>
      deserializeGame(
        breakField((s) => {
          s.combat = {
            reason: 'guard',
            attackerHero: 'edric',
            attackerSlots: [0],
            defenderHero: null,
            defenderTown: null,
            defenderSlots: [],
            object: 'obj-1',
            combat: {
              round: 1,
              rngState: 1,
              attackerHero: {},
              defenderHero: {},
              stacks: [{ id: 'a0' }],
              obstacles: [],
              queue: ['a0'],
              waitQueue: [],
              castThisRound: { attacker: false, defender: false },
              siege: null,
              winner: null,
            },
          };
        }),
      ),
    ).toThrow('malformed');
  });

  it('rejects garbage pendingChoices and resources', () => {
    const state = newGame(tinyMap, {}, 3, data);
    const breakField = (mutate: (s: Record<string, unknown>) => void): string => {
      const raw = JSON.parse(serializeGame(state)) as { version: number; state: Record<string, unknown> };
      mutate(raw.state);
      return JSON.stringify(raw);
    };
    expect(() => deserializeGame(breakField((s) => (s.pendingChoices = [{ id: 'x' }])))).toThrow(
      'malformed',
    );
    expect(() => deserializeGame(breakField((s) => (s.pendingChoices = 'none')))).toThrow(
      'malformed',
    );
    expect(() =>
      deserializeGame(
        breakField((s) => {
          const players = s.players as { resources: unknown }[];
          if (players[0]) players[0].resources = { gold: 'lots' };
        }),
      ),
    ).toThrow('malformed');
    expect(() =>
      deserializeGame(
        breakField((s) => {
          const players = s.players as { resources: Record<string, number> }[];
          if (players[0]) delete players[0].resources.wood;
        }),
      ),
    ).toThrow('malformed');
  });
});
