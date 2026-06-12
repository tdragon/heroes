import { describe, expect, it } from 'vitest';
import { loadGameData } from '../data';
import { compileMap } from '../maps/dsl';
import { tinyMapSource } from '../maps/fixtures/tiny.dsl';
import {
  BLUE_TOWN,
  FULL_GAME_SEED,
  fullGameScript,
  MINE_GUARD_XP,
  MONSTER_PACK_XP,
  RED_TOWN,
} from './fixtures/full-game.replay';
import { canonicalJson, checkInvariants, runScript, stateHash, type ScriptStep } from './replay';
import type { Command } from './commands';
import type { GameState } from './state';

const data = loadGameData();
const tinyMap = compileMap(tinyMapSource, data);

const GOLDEN_HASH = '01e6469f';

function runFullGame(seed = FULL_GAME_SEED, options = {}) {
  return runScript(tinyMap, seed, fullGameScript(), data, options);
}

describe('runScript', () => {
  it('executes literal commands and counts them', () => {
    const result = runScript(
      tinyMap,
      1,
      [
        { type: 'endTurn', player: 'red' },
        { type: 'endTurn', player: 'blue' },
      ],
      data,
    );
    expect(result.commandCount).toBe(2);
    expect(result.state.day).toBe(2);
    expect(result.events.some((e) => e.type === 'dayStarted')).toBe(true);
  });

  it('skips generator steps that return null', () => {
    const result = runScript(tinyMap, 1, [() => null], data);
    expect(result.commandCount).toBe(0);
    expect(result.state.day).toBe(1);
  });

  it('expands generator steps returning command arrays', () => {
    const both: ScriptStep = (state): Command[] => [
      { type: 'endTurn', player: state.currentPlayer },
      { type: 'endTurn', player: 'blue' },
    ];
    const result = runScript(tinyMap, 1, [both], data);
    expect(result.commandCount).toBe(2);
    expect(result.state.day).toBe(2);
  });

  it('runs until-loops to their condition', () => {
    const untilDay3: ScriptStep = {
      until: (state) => state.day >= 3,
      step: (state): Command => ({ type: 'endTurn', player: state.currentPlayer }),
    };
    const result = runScript(tinyMap, 1, [untilDay3], data);
    expect(result.state.day).toBe(3);
  });

  it('throws when an until-loop exceeds its iteration cap', () => {
    const endless: ScriptStep = {
      until: () => false,
      step: (state): Command => ({ type: 'endTurn', player: state.currentPlayer }),
      max: 5,
    };
    expect(() => runScript(tinyMap, 1, [endless], data)).toThrow(/exceeded 5 iterations/);
  });

  it('wraps checkpoint failures with the checkpoint label', () => {
    const failing: ScriptStep = {
      label: 'impossible',
      assert: () => {
        throw new Error('nope');
      },
    };
    expect(() => runScript(tinyMap, 1, [failing], data)).toThrow(
      /checkpoint 'impossible' failed: nope/,
    );
  });

  it('invokes afterCommand for every dispatched command', () => {
    const seen: Command[] = [];
    runScript(tinyMap, 1, [{ type: 'endTurn', player: 'red' }], data, {
      afterCommand: (_state, command) => seen.push(command),
    });
    expect(seen).toEqual([{ type: 'endTurn', player: 'red' }]);
  });
});

describe('stateHash', () => {
  it('is identical for a structured clone of the same state', () => {
    const { state } = runScript(tinyMap, 1, [{ type: 'endTurn', player: 'red' }], data);
    expect(stateHash(structuredClone(state))).toBe(stateHash(state));
  });

  it('does not depend on object key insertion order', () => {
    expect(canonicalJson({ a: 1, b: [{ x: 1, y: 2 }] })).toBe(
      canonicalJson({ b: [{ y: 2, x: 1 }], a: 1 }),
    );
  });

  it('changes when the state changes', () => {
    const before = runScript(tinyMap, 1, [], data).state;
    const after = runScript(tinyMap, 1, [{ type: 'endTurn', player: 'red' }], data).state;
    expect(stateHash(before)).not.toBe(stateHash(after));
  });
});

describe('checkInvariants', () => {
  it('accepts a freshly created game', () => {
    const { state } = runScript(tinyMap, 1, [], data);
    expect(checkInvariants(state)).toEqual([]);
  });

  it('reports negative resources, MP and empty stacks', () => {
    const { state } = runScript(tinyMap, 1, [], data);
    const broken = structuredClone(state);
    const red = broken.players[0];
    if (!red) throw new Error('missing red player');
    red.resources.gold = -1;
    const edric = broken.heroes.edric;
    if (!edric) throw new Error('missing edric');
    edric.movementPoints = -5;
    edric.army[0] = { creature: 'pikeman', count: 0 };
    const problems = checkInvariants(broken);
    expect(problems.some((p) => p.includes('gold'))).toBe(true);
    expect(problems.some((p) => p.includes('movementPoints'))).toBe(true);
    expect(problems.some((p) => p.includes('count <= 0'))).toBe(true);
  });
});

describe('full miniature game on the tiny fixture', () => {
  it('plays out to a red victory with all checkpoints passing', () => {
    const { state, events } = runFullGame();

    expect(state.status).toEqual({ winner: 'red' });
    expect(state.day).toBe(10);
    expect(state.towns[RED_TOWN]?.owner).toBe('red');
    expect(state.towns[BLUE_TOWN]?.owner).toBe('red');
    expect(state.players[1]?.defeated).toBe(true);
    expect(state.heroes.mortus).toBeUndefined();
    expect(state.tavernPool).toContain('mortus');

    const edric = state.heroes.edric;
    expect(edric).toBeDefined();
    // golden seed: the chest rolls the 1500 xp tier, crossing the level-2 line
    expect(edric?.xp).toBe(MINE_GUARD_XP + 1500 + MONSTER_PACK_XP);
    expect(edric?.level).toBe(2);
    expect(edric?.skills.length).toBeGreaterThanOrEqual(2);

    const types = events.map((e) => e.type);
    for (const milestone of [
      'resourcesGained',
      'combatStarted',
      'combatResolved',
      'objectFlagged',
      'heroLevelUp',
      'buildingBuilt',
      'creaturesRecruited',
      'townCaptured',
      'playerDefeated',
      'gameOver',
    ]) {
      expect(types).toContain(milestone);
    }
    expect(events.filter((e) => e.type === 'combatResolved')).toHaveLength(2);
    expect(events.find((e) => e.type === 'gameOver')).toEqual({
      type: 'gameOver',
      winner: 'red',
    });

    expect(stateHash(state)).toBe(GOLDEN_HASH);
  });

  it('is deterministic: the same script twice yields an identical hash', () => {
    const first = runFullGame();
    const second = runFullGame();
    expect(stateHash(second.state)).toBe(stateHash(first.state));
    expect(second.commandCount).toBe(first.commandCount);
    expect(second.events.map((e) => e.type)).toEqual(first.events.map((e) => e.type));
  });

  it('a different seed gives different rng outcomes but a valid red victory', () => {
    const base = runFullGame();
    const other = runFullGame(FULL_GAME_SEED + 1);
    expect(stateHash(other.state)).not.toBe(stateHash(base.state));
    expect(other.state.rngState).not.toBe(base.state.rngState);
    expect(other.state.status).toEqual({ winner: 'red' });
    expect(checkInvariants(other.state)).toEqual([]);
  });

  it('holds all invariants after every command in the script', () => {
    let checks = 0;
    const sweep = (state: GameState, command: Command): void => {
      checks += 1;
      const problems = checkInvariants(state);
      if (problems.length > 0) {
        throw new Error(`invariants broken after ${command.type}: ${problems.join('; ')}`);
      }
    };
    const { commandCount } = runFullGame(FULL_GAME_SEED, { afterCommand: sweep });
    expect(checks).toBe(commandCount);
    expect(checks).toBeGreaterThan(30);
  });
});
