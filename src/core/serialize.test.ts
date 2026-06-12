import { describe, expect, it } from 'vitest';
import { loadGameData } from '../data';
import { compileMap } from '../maps/dsl';
import { tinyMapSource } from '../maps/fixtures/tiny.dsl';
import { dispatch } from './commands';
import { deserializeGame, serializeGame, SAVE_VERSION } from './serialize';
import { newGame } from './setup';
import type { GameState } from './state';

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

// well-formed saves with dangling cross-references must be rejected at load
// time, not crash later in visitingHeroOf/endTurn/the combat screen
describe('referential integrity', () => {
  const state = newGame(tinyMap, {}, 3, data);
  const breakRefs = (mutate: (s: Record<string, unknown>) => void): string => {
    const raw = JSON.parse(serializeGame(state)) as {
      version: number;
      state: Record<string, unknown>;
    };
    mutate(raw.state);
    return JSON.stringify(raw);
  };

  // walk edric onto the guarded sawmill and confirm, leaving a live combat
  function makeMidCombatGame(): GameState {
    let s = newGame(tinyMap, {}, 7, data);
    const hero = s.heroes.edric;
    if (!hero) throw new Error('missing edric');
    // hand-teleport for test speed: clear the visit link like leaveTile does
    for (const town of Object.values(s.towns)) {
      if (town.visitingHero === hero.id) town.visitingHero = null;
    }
    hero.pos = [5, 2];
    hero.movementPoints = 2000;
    s = dispatch(s, { type: 'moveHero', player: 'red', hero: 'edric', path: [[6, 2]] }, data).state;
    const choice = s.pendingChoices[0];
    if (choice?.kind !== 'guardAttack') throw new Error('expected guard attack choice');
    s = dispatch(
      s,
      { type: 'resolveChoice', player: 'red', choiceId: choice.id, option: 0 },
      data,
    ).state;
    if (s.combat === null) throw new Error('combat did not start');
    return s;
  }

  it('rejects an unknown currentPlayer', () => {
    expect(() => deserializeGame(breakRefs((s) => (s.currentPlayer = 'green')))).toThrow(
      'currentPlayer: unknown player green',
    );
  });

  it('rejects a dangling town.visitingHero', () => {
    expect(() =>
      deserializeGame(
        breakRefs((s) => {
          const towns = s.towns as Record<string, { visitingHero: string | null }>;
          const town = Object.values(towns)[0];
          if (town) town.visitingHero = 'ghost';
        }),
      ),
    ).toThrow(/towns\..*\.visitingHero: unknown hero ghost/);
  });

  it('rejects a hero owned by a player that is not in the game', () => {
    expect(() =>
      deserializeGame(
        breakRefs((s) => {
          const heroes = s.heroes as Record<string, { owner: string }>;
          const edric = heroes.edric;
          if (edric) edric.owner = 'green';
        }),
      ),
    ).toThrow('heroes.edric.owner: unknown player green');
  });

  it('rejects a town owned by a player that is not in the game', () => {
    expect(() =>
      deserializeGame(
        breakRefs((s) => {
          const towns = s.towns as Record<string, { owner: string | null }>;
          const town = Object.values(towns)[0];
          if (town) town.owner = 'green';
        }),
      ),
    ).toThrow(/towns\..*\.owner: unknown player green/);
  });

  it('rejects player.heroes entries that are missing or owned by someone else', () => {
    expect(() =>
      deserializeGame(
        breakRefs((s) => {
          const players = s.players as { heroes: string[] }[];
          players[0]?.heroes.push('ghost');
        }),
      ),
    ).toThrow('players.red.heroes: unknown hero ghost');
    expect(() =>
      deserializeGame(
        breakRefs((s) => {
          const players = s.players as { heroes: string[] }[];
          players[0]?.heroes.push('mortus'); // mortus belongs to blue
        }),
      ),
    ).toThrow('players.red.heroes: hero mortus is owned by blue');
  });

  it('rejects player.towns entries that are missing or owned by someone else', () => {
    expect(() =>
      deserializeGame(
        breakRefs((s) => {
          const players = s.players as { towns: string[] }[];
          players[0]?.towns.push('ghost-town');
        }),
      ),
    ).toThrow('players.red.towns: unknown town ghost-town');
    expect(() =>
      deserializeGame(
        breakRefs((s) => {
          const players = s.players as { towns: string[] }[];
          const blueTown = players[1]?.towns[0];
          if (blueTown !== undefined) players[0]?.towns.push(blueTown);
        }),
      ),
    ).toThrow(/players\.red\.towns: town .* is owned by blue/);
  });

  it('rejects a hero missing from its owner roster', () => {
    expect(() =>
      deserializeGame(
        breakRefs((s) => {
          const players = s.players as { heroes: string[] }[];
          if (players[0]) players[0].heroes = players[0].heroes.filter((id) => id !== 'edric');
        }),
      ),
    ).toThrow('heroes.edric.owner: not listed in players.red.heroes');
  });

  it('rejects a town missing from its owner town list', () => {
    expect(() =>
      deserializeGame(
        breakRefs((s) => {
          const players = s.players as { towns: string[] }[];
          if (players[0]) players[0].towns = [];
        }),
      ),
    ).toThrow(/towns\..*\.owner: not listed in players\.red\.towns/);
  });

  it('rejects a visiting hero that belongs to another player', () => {
    expect(() =>
      deserializeGame(
        breakRefs((s) => {
          const towns = Object.values(s.towns as Record<string, { owner: string | null; visitingHero: string | null }>);
          for (const town of towns) {
            // mortus (blue) ends up visiting only the red town
            town.visitingHero = town.owner === 'red' ? 'mortus' : null;
          }
        }),
      ),
    ).toThrow(/towns\..*\.visitingHero: hero mortus belongs to blue but the town belongs to red/);
  });

  it('rejects a visiting hero standing off the town tile', () => {
    expect(() =>
      deserializeGame(
        breakRefs((s) => {
          const heroes = s.heroes as Record<string, { pos: [number, number] }>;
          const edric = heroes.edric;
          if (edric) edric.pos = [0, 0];
        }),
      ),
    ).toThrow(/towns\..*\.visitingHero: hero edric is not on the town tile/);
  });

  it('rejects a hero visiting two towns at once', () => {
    expect(() =>
      deserializeGame(
        breakRefs((s) => {
          const towns = Object.values(s.towns as Record<string, { visitingHero: string | null }>);
          for (const town of towns) town.visitingHero = 'edric';
        }),
      ),
    ).toThrow(/towns\..*\.visitingHero: hero edric already visits/);
  });

  it('rejects combat hero/town/object ids missing from the state', () => {
    const fighting = makeMidCombatGame();
    const breakCombat = (mutate: (c: Record<string, unknown>) => void): string => {
      const raw = JSON.parse(serializeGame(fighting)) as {
        version: number;
        state: { combat: Record<string, unknown> };
      };
      mutate(raw.state.combat);
      return JSON.stringify(raw);
    };
    expect(() => deserializeGame(breakCombat((c) => (c.attackerHero = 'ghost')))).toThrow(
      'combat.attackerHero: unknown hero ghost',
    );
    expect(() => deserializeGame(breakCombat((c) => (c.defenderHero = 'ghost')))).toThrow(
      'combat.defenderHero: unknown hero ghost',
    );
    expect(() => deserializeGame(breakCombat((c) => (c.defenderTown = 'ghost-town')))).toThrow(
      'combat.defenderTown: unknown town ghost-town',
    );
    expect(() => deserializeGame(breakCombat((c) => (c.object = 'ghost-object')))).toThrow(
      'combat.object: unknown object ghost-object',
    );
  });

  it('rejects combat hero infos that disagree with the active combat', () => {
    const fighting = makeMidCombatGame();
    const breakBattle = (mutate: (battle: Record<string, unknown>) => void): string => {
      const raw = JSON.parse(serializeGame(fighting)) as {
        version: number;
        state: { combat: { combat: Record<string, unknown> } };
      };
      mutate(raw.state.combat.combat);
      return JSON.stringify(raw);
    };
    const heroInfo = (battle: Record<string, unknown>, side: string): Record<string, unknown> =>
      battle[side] as Record<string, unknown>;
    // edric (red) attacks a neutral guard: the defender side has no hero
    expect(() =>
      deserializeGame(breakBattle((b) => (heroInfo(b, 'attackerHero').hero = 'mortus'))),
    ).toThrow('combat.combat.attackerHero.hero: expected edric, found mortus');
    expect(() =>
      deserializeGame(breakBattle((b) => (heroInfo(b, 'attackerHero').player = 'blue'))),
    ).toThrow('combat.combat.attackerHero.player: expected red, found blue');
    expect(() =>
      deserializeGame(breakBattle((b) => (heroInfo(b, 'defenderHero').hero = 'mortus'))),
    ).toThrow('combat.combat.defenderHero.hero: expected nobody, found mortus');
    expect(() =>
      deserializeGame(breakBattle((b) => (heroInfo(b, 'defenderHero').player = 'blue'))),
    ).toThrow('combat.combat.defenderHero.player: expected nobody, found blue');
  });

  it('rejects combat queues naming unknown or repeated stacks', () => {
    const fighting = makeMidCombatGame();
    const breakBattle = (mutate: (battle: Record<string, unknown>) => void): string => {
      const raw = JSON.parse(serializeGame(fighting)) as {
        version: number;
        state: { combat: { combat: Record<string, unknown> } };
      };
      mutate(raw.state.combat.combat);
      return JSON.stringify(raw);
    };
    expect(() =>
      deserializeGame(breakBattle((b) => ((b.queue as string[])[0] = 'ghost'))),
    ).toThrow('combat.combat.queue: unknown combat stack ghost');
    expect(() =>
      deserializeGame(breakBattle((b) => (b.waitQueue = [(b.queue as string[])[0]]))),
    ).toThrow(/combat\.combat\.waitQueue: stack .* is queued twice/);
    expect(() =>
      deserializeGame(
        breakBattle((b) => {
          const stacks = b.stacks as Record<string, unknown>[];
          stacks.push({ ...stacks[0] });
        }),
      ),
    ).toThrow(/combat\.combat\.stacks: duplicate stack id/);
  });

  it('rejects pendingChoices referencing missing heroes, objects, or players', () => {
    const choice = {
      id: 'c1',
      player: 'red',
      kind: 'levelUp',
      options: ['logistics:basic'],
    };
    expect(() =>
      deserializeGame(breakRefs((s) => (s.pendingChoices = [{ ...choice, hero: 'ghost' }]))),
    ).toThrow('pendingChoices.0.hero: unknown hero ghost');
    expect(() =>
      deserializeGame(
        breakRefs((s) => (s.pendingChoices = [{ ...choice, object: 'ghost-object' }])),
      ),
    ).toThrow('pendingChoices.0.object: unknown object ghost-object');
    expect(() =>
      deserializeGame(breakRefs((s) => (s.pendingChoices = [{ ...choice, player: 'green' }]))),
    ).toThrow('pendingChoices.0.player: unknown player green');
  });

  it('still accepts a consistent mid-combat save', () => {
    const fighting = makeMidCombatGame();
    expect(deserializeGame(serializeGame(fighting))).toEqual(fighting);
  });
});
