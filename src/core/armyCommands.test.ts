import { describe, expect, it } from 'vitest';
import { loadGameData } from '../data';
import { compileMap } from '../maps/dsl';
import { tinyMapSource } from '../maps/fixtures/tiny.dsl';
import { CommandRejectedError, dispatch, type Command } from './commands';
import { newGame, townIdAt } from './setup';
import type { GameState, Hero } from './state';

const data = loadGameData();
const tinyMap = compileMap(tinyMapSource, data);
const RED_TOWN = townIdAt([2, 2]);

function makeGame(seed = 42): GameState {
  return newGame(tinyMap, {}, seed, data);
}

function getHero(state: GameState, id: string): Hero {
  const hero = state.heroes[id];
  if (!hero) throw new Error(`missing hero ${id}`);
  return hero;
}

// a second red hero placed next to edric, used for hero-to-hero transfers
function addSecondHero(state: GameState, pos: [number, number] = [3, 2]): Hero {
  const clone = structuredClone(getHero(state, 'edric'));
  clone.id = 'edric2';
  clone.pos = pos;
  state.heroes[clone.id] = clone;
  state.players[0]?.heroes.push(clone.id);
  return clone;
}

function run(state: GameState, command: Command): GameState {
  return dispatch(state, command, data).state;
}

function moveStack(
  state: GameState,
  from: Extract<Command, { type: 'moveStack' }>['from'],
  fromSlot: number,
  to: Extract<Command, { type: 'moveStack' }>['to'],
  toSlot: number,
  count?: number,
): GameState {
  const command: Command = { type: 'moveStack', player: 'red', from, fromSlot, to, toSlot };
  if (count !== undefined) command.count = count;
  return run(state, command);
}

const edricLoc = { kind: 'hero', hero: 'edric' } as const;
const garrisonLoc = { kind: 'garrison', town: RED_TOWN } as const;

describe('moveStack command', () => {
  it('splits a stack into an empty slot of the same army', () => {
    const state = makeGame();
    const before = getHero(state, 'edric').army[0];
    expect(before).not.toBeNull();
    const total = before?.count ?? 0;

    const next = moveStack(state, edricLoc, 0, edricLoc, 3, 4);
    const army = getHero(next, 'edric').army;
    expect(army[3]).toEqual({ creature: before?.creature, count: 4 });
    expect((army[0]?.count ?? 0) + (army[3]?.count ?? 0)).toBe(total);
  });

  it('merges stacks of the same creature and swaps different creatures', () => {
    let state = makeGame();
    state = moveStack(state, edricLoc, 0, edricLoc, 3, 4);
    const total =
      (getHero(state, 'edric').army[0]?.count ?? 0) + (getHero(state, 'edric').army[3]?.count ?? 0);
    state = moveStack(state, edricLoc, 3, edricLoc, 0);
    expect(getHero(state, 'edric').army[0]?.count).toBe(total);
    expect(getHero(state, 'edric').army[3]).toBeNull();

    const swapped = moveStack(state, edricLoc, 0, edricLoc, 1);
    const army = getHero(swapped, 'edric').army;
    expect(army[0]?.creature).toBe('archer');
    expect(army[1]?.creature).toBe('pikeman');
  });

  it('moves a stack between a visiting hero and the garrison', () => {
    const state = makeGame();
    expect(state.towns[RED_TOWN]?.visitingHero).toBe('edric');
    const next = moveStack(state, edricLoc, 1, garrisonLoc, 0);
    expect(next.towns[RED_TOWN]?.garrison[0]?.creature).toBe('archer');
    expect(getHero(next, 'edric').army[1]).toBeNull();
  });

  it('rejects emptying a hero army into the garrison', () => {
    let state = makeGame();
    state = moveStack(state, edricLoc, 1, garrisonLoc, 0);
    expect(() => moveStack(state, edricLoc, 0, garrisonLoc, 1)).toThrow(CommandRejectedError);
  });

  it('rejects garrison access when the hero is not visiting the town', () => {
    const state = makeGame();
    const hero = addSecondHero(state, [6, 3]);
    expect(() => moveStack(state, { kind: 'hero', hero: hero.id }, 0, garrisonLoc, 0, 2)).toThrow(
      'not at the same place',
    );
  });

  it('transfers between two adjacent heroes but rejects distant ones', () => {
    const near = makeGame();
    addSecondHero(near, [3, 2]);
    const moved = moveStack(near, edricLoc, 0, { kind: 'hero', hero: 'edric2' }, 2, 3);
    expect(getHero(moved, 'edric2').army[2]).toEqual({
      creature: 'pikeman',
      count: 3,
    });

    const far = makeGame();
    addSecondHero(far, [6, 6]);
    expect(() => moveStack(far, edricLoc, 0, { kind: 'hero', hero: 'edric2' }, 2, 3)).toThrow(
      'not at the same place',
    );
  });

  it('rejects foreign heroes, foreign towns, and bad counts', () => {
    const state = makeGame();
    expect(() => moveStack(state, { kind: 'hero', hero: 'mortus' }, 0, edricLoc, 3)).toThrow(
      CommandRejectedError,
    );
    expect(() =>
      moveStack(state, edricLoc, 0, { kind: 'garrison', town: townIdAt([9, 9]) }, 0),
    ).toThrow(CommandRejectedError);
    expect(() => moveStack(state, edricLoc, 0, edricLoc, 3, 999)).toThrow(CommandRejectedError);
    expect(() => moveStack(state, edricLoc, 2, edricLoc, 3)).toThrow('empty');
  });
});

describe('artifact commands', () => {
  it('equips from the backpack and unequips back', () => {
    const state = makeGame();
    getHero(state, 'edric').backpack.push('iron_sword');

    const equipped = run(state, {
      type: 'equipArtifact',
      player: 'red',
      hero: 'edric',
      artifact: 'iron_sword',
    });
    expect(getHero(equipped, 'edric').artifacts).toContain('iron_sword');
    expect(getHero(equipped, 'edric').backpack).not.toContain('iron_sword');

    const unequipped = run(equipped, {
      type: 'unequipArtifact',
      player: 'red',
      hero: 'edric',
      artifact: 'iron_sword',
    });
    expect(getHero(unequipped, 'edric').artifacts).not.toContain('iron_sword');
    expect(getHero(unequipped, 'edric').backpack).toContain('iron_sword');
  });

  it('rejects equipping into a full slot or from outside the backpack', () => {
    const state = makeGame();
    const hero = getHero(state, 'edric');
    hero.artifacts.push('iron_sword');
    hero.backpack.push('steel_sabre');
    expect(() =>
      run(state, { type: 'equipArtifact', player: 'red', hero: 'edric', artifact: 'steel_sabre' }),
    ).toThrow('slot weapon is full');
    expect(() =>
      run(state, { type: 'equipArtifact', player: 'red', hero: 'edric', artifact: 'oak_shield' }),
    ).toThrow(CommandRejectedError);
  });

  it('transfers artifacts between adjacent heroes only', () => {
    const state = makeGame();
    addSecondHero(state, [3, 2]);
    const hero = getHero(state, 'edric');
    hero.backpack.length = 0;
    hero.backpack.push('lucky_coin');
    hero.artifacts.length = 0;
    hero.artifacts.push('iron_sword');

    let next = run(state, {
      type: 'transferArtifact',
      player: 'red',
      from: 'edric',
      to: 'edric2',
      artifact: 'lucky_coin',
    });
    next = run(next, {
      type: 'transferArtifact',
      player: 'red',
      from: 'edric',
      to: 'edric2',
      artifact: 'iron_sword',
    });
    expect(getHero(next, 'edric2').backpack).toEqual(
      expect.arrayContaining(['lucky_coin', 'iron_sword']),
    );
    expect(getHero(next, 'edric').artifacts).toHaveLength(0);

    getHero(next, 'edric2').pos = [7, 7];
    expect(() =>
      run(next, {
        type: 'transferArtifact',
        player: 'red',
        from: 'edric2',
        to: 'edric',
        artifact: 'lucky_coin',
      }),
    ).toThrow('not adjacent');
  });
});
