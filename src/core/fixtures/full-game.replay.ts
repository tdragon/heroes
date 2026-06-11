// A complete miniature game scripted on the tiny fixture map: red (castle)
// collects resources, clears the sawmill guard, levels up from a treasure
// chest, builds up its town, recruits, captures the abandoned enemy town and
// wins when blue runs out the 7-day townless countdown.

import type { GameData } from '../../data';
import type { Pos } from '../../maps/schema';
import type { Command } from '../commands';
import { isBound, requireCreature } from '../combat/abilities';
import { activeCombatStack, reachableHexesFor, type CombatAction } from '../combat/engine';
import { hexDistance, type Hex } from '../combat/grid';
import {
  livingStacks,
  occupiedHexes,
  oppositeSide,
  tailOffset,
  type CombatStack,
  type CombatState,
} from '../combat/state';
import { findPath } from '../movement';
import type { ScriptStep } from '../replay';
import type { GameState, Hero, PlayerId } from '../state';

export const FULL_GAME_SEED = 7;
export const RED_TOWN = 'town-2-2';
export const BLUE_TOWN = 'town-9-9';

function requireHero(state: GameState, id: string): Hero {
  const hero = state.heroes[id];
  if (!hero) {
    throw new Error(`hero ${id} is not on the map`);
  }
  return hero;
}

// --- a deliberately simple, always-legal combat policy for scripted battles ---

function stackCells(stack: CombatStack, data: GameData): Hex[] {
  return occupiedHexes(stack, requireCreature(data, stack.creature));
}

function attackerCells(head: Hex, wide: boolean, side: CombatStack['side']): Hex[] {
  return wide ? [head, { x: head.x + tailOffset(side), y: head.y }] : [head];
}

function minDistanceToEnemies(from: Hex, enemyCells: Hex[]): number {
  return enemyCells.reduce((min, cell) => Math.min(min, hexDistance(from, cell)), Infinity);
}

export function chooseSimpleCombatAction(combat: CombatState, data: GameData): CombatAction {
  const stack = activeCombatStack(combat);
  if (!stack) {
    throw new Error('no active combat stack');
  }
  const creature = requireCreature(data, stack.creature);
  const enemies = livingStacks(combat, oppositeSide(stack.side));
  if (enemies.length === 0) {
    throw new Error('no living enemies in combat');
  }
  const allEnemyCells = enemies.flatMap((enemy) => stackCells(enemy, data));
  const adjacentEnemy = allEnemyCells.some(
    (cell) => minDistanceToEnemies(cell, stackCells(stack, data)) === 1,
  );

  if (creature.shots !== undefined && stack.shots > 0 && !adjacentEnemy) {
    const target = enemies.reduce((best, enemy) => (enemy.count > best.count ? enemy : best));
    return { type: 'shoot', target: target.id };
  }

  const wide = creature.flags.includes('wide');
  const candidates: Hex[] = isBound(stack)
    ? [stack.pos]
    : [stack.pos, ...reachableHexesFor(combat, stack.id, data)];
  for (const enemy of enemies) {
    const cells = stackCells(enemy, data);
    for (const from of candidates) {
      const reaches = attackerCells(from, wide, stack.side).some(
        (cell) => minDistanceToEnemies(cell, cells) === 1,
      );
      if (reaches) {
        return { type: 'melee', target: enemy.id, from };
      }
    }
  }

  let best: Hex | null = null;
  let bestDistance = minDistanceToEnemies(stack.pos, allEnemyCells);
  for (const hex of candidates) {
    const distance = minDistanceToEnemies(hex, allEnemyCells);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = hex;
    }
  }
  if (best) {
    return { type: 'move', to: best };
  }
  return { type: 'defend' };
}

// --- script step helpers ---

export function moveTo(heroId: string, dest: Pos): ScriptStep {
  return (state, data): Command => {
    const hero = requireHero(state, heroId);
    const path = findPath(state, data, hero, dest);
    if (!path || path.length === 0) {
      throw new Error(
        `no path for ${heroId} from (${String(hero.pos[0])},${String(hero.pos[1])}) to (${String(dest[0])},${String(dest[1])})`,
      );
    }
    return { type: 'moveHero', player: hero.owner, hero: heroId, path };
  };
}

export function resolvePendingChoice(
  kind: string,
  pickOption: (options: string[]) => number,
): ScriptStep {
  return (state): Command => {
    const choice = state.pendingChoices.find((c) => c.kind === kind);
    if (!choice) {
      throw new Error(`no pending '${kind}' choice`);
    }
    return {
      type: 'resolveChoice',
      player: choice.player,
      choiceId: choice.id,
      option: pickOption(choice.options),
    };
  };
}

// resolves a level-up choice when one is pending; a no-op otherwise, so the
// same script works for seeds where the chest XP does not reach a level-up
export function resolveLevelUpIfPending(): ScriptStep {
  return (state): Command | null => {
    const choice = state.pendingChoices.find((c) => c.kind === 'levelUp');
    if (!choice) return null;
    return { type: 'resolveChoice', player: choice.player, choiceId: choice.id, option: 0 };
  };
}

export function fightUntilDone(): ScriptStep {
  return {
    until: (state) => state.combat === null,
    step: (state, data): Command => {
      if (!state.combat) {
        throw new Error('no combat in progress');
      }
      return {
        type: 'combatAction',
        player: state.currentPlayer,
        action: chooseSimpleCombatAction(state.combat.combat, data),
      };
    },
  };
}

function endTurn(player: PlayerId): Command {
  return { type: 'endTurn', player };
}

function checkpoint(label: string, assert: (state: GameState) => void): ScriptStep {
  return { label, assert };
}

function expectThat(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

export const WOLF_AI_VALUE = 30;
export const MINE_GUARD_XP = 4 * WOLF_AI_VALUE;
export const MONSTER_PACK_XP = 6 * WOLF_AI_VALUE;
export const PIKEMAN_GROWTH = 14;

export function fullGameScript(): ScriptStep[] {
  return [
    // --- day 1, red: wood pile, then clear the sawmill guard ---
    moveTo('edric', [4, 4]),
    checkpoint('wood pile picked up', (state) => {
      const red = state.players[0];
      expectThat(
        red?.resources.wood === 26,
        `red wood is ${String(red?.resources.wood)}, expected 26`,
      );
    }),
    moveTo('edric', [6, 2]),
    resolvePendingChoice('guardAttack', () => 0),
    fightUntilDone(),
    checkpoint('sawmill captured from its guard', (state) => {
      const mine = state.map.objects.find((o) => o.type === 'mine');
      expectThat(mine?.owner === 'red', `mine owner is ${String(mine?.owner)}, expected red`);
      const edric = requireHero(state, 'edric');
      expectThat(
        edric.xp === MINE_GUARD_XP,
        `edric xp is ${String(edric.xp)}, expected ${String(MINE_GUARD_XP)}`,
      );
    }),
    endTurn('red'),

    // --- day 1, blue: mortus walks off the town tile (and never returns) ---
    moveTo('mortus', [11, 7]),
    endTurn('blue'),

    // --- day 2, red: gold pile, treasure chest (XP), monster pack ---
    checkpoint('day 2 income arrived', (state) => {
      expectThat(state.day === 2, `day is ${String(state.day)}, expected 2`);
      const red = state.players[0];
      expectThat(
        red?.resources.wood === 28,
        `red wood is ${String(red?.resources.wood)}, expected 28`,
      );
      expectThat(
        red?.resources.gold === 20500,
        `red gold is ${String(red?.resources.gold)}, expected 20500`,
      );
    }),
    moveTo('edric', [8, 7]),
    moveTo('edric', [5, 7]),
    resolvePendingChoice('chest', (options) => {
      const xpOption = options.findIndex((option) => option.startsWith('xp:'));
      if (xpOption === -1) {
        throw new Error(`chest offers no xp option: ${options.join(', ')}`);
      }
      return xpOption;
    }),
    resolveLevelUpIfPending(),
    moveTo('edric', [6, 6]),
    resolvePendingChoice('guardAttack', () => 0),
    fightUntilDone(),
    resolveLevelUpIfPending(),
    checkpoint('monster pack cleared', (state) => {
      const monster = state.map.objects.find((o) => o.type === 'monster');
      expectThat(monster?.removed === true, 'monster object should be removed');
    }),
    endTurn('red'),
    endTurn('blue'),

    // --- day 3, red: build a fort, capture the abandoned enemy town ---
    { type: 'build', player: 'red', town: RED_TOWN, building: 'fort' },
    moveTo('edric', [9, 9]),
    checkpoint('enemy town captured without a garrison fight', (state) => {
      expectThat(state.towns[BLUE_TOWN]?.owner === 'red', 'blue town should belong to red');
      expectThat(state.players[1]?.towns.length === 0, 'blue should hold no towns');
      expectThat(state.combat === null, 'capturing an empty town must not start a combat');
    }),
    endTurn('red'),
    endTurn('blue'),

    // --- day 4, red: dwelling + recruit the initial pikeman pool ---
    { type: 'build', player: 'red', town: RED_TOWN, building: 'castle_dwelling_1' },
    {
      type: 'recruit',
      player: 'red',
      town: RED_TOWN,
      dest: 'garrison',
      creature: 'pikeman',
      count: PIKEMAN_GROWTH,
    },
    checkpoint('pikemen recruited into the garrison', (state) => {
      const garrison = state.towns[RED_TOWN]?.garrison ?? [];
      const pikemen = garrison.find((stack) => stack?.creature === 'pikeman');
      expectThat(
        pikemen?.count === PIKEMAN_GROWTH,
        `garrison pikemen: ${String(pikemen?.count)}, expected ${String(PIKEMAN_GROWTH)}`,
      );
    }),
    endTurn('red'),
    endTurn('blue'),

    // --- days 5..9: blue is townless; the countdown reaches 7 at dawn of day 10 ---
    ...Array.from({ length: 5 }, (): ScriptStep[] => [endTurn('red'), endTurn('blue')]).flat(),
    checkpoint('blue eliminated by the townless countdown', (state) => {
      expectThat(state.day === 10, `day is ${String(state.day)}, expected 10`);
      expectThat(state.players[1]?.defeated === true, 'blue should be defeated');
      expectThat(
        typeof state.status === 'object' && state.status.winner === 'red',
        'red should have won the game',
      );
    }),
  ];
}
