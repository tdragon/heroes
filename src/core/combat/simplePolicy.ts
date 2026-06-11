// A deliberately simple, always-legal combat policy: shoot the biggest stack,
// otherwise melee the first reachable enemy, otherwise advance toward the
// nearest one. Used by scripted replay battles and the combat screen's Auto
// button until the real combat AI lands in Task 16.

import type { GameData } from '../../data';
import { isBound, requireCreature } from './abilities';
import { activeCombatStack, reachableHexesFor, type CombatAction } from './engine';
import { hexDistance, type Hex } from './grid';
import {
  livingStacks,
  occupiedHexes,
  oppositeSide,
  tailOffset,
  type CombatStack,
  type CombatState,
} from './state';

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
