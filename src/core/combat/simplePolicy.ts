// A deliberately simple, always-legal combat policy: shoot the biggest stack,
// otherwise melee the first reachable enemy, otherwise advance toward the
// nearest one. Kept for scripted replay battles (stable golden hashes); the
// game itself uses the real combat AI in src/core/ai/combatAI.ts.

import type { GameData } from '../../data';
import { cellsFor, isBound, minCellDistance, requireCreature, stackCells } from './abilities';
import { activeCombatStack, reachableHexesFor, type CombatAction } from './engine';
import type { Hex } from './grid';
import { livingStacks, oppositeSide, type CombatState } from './state';

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
    (cell) => minCellDistance([cell], stackCells(stack, data)) === 1,
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
      const reaches = cellsFor(from, wide, stack.side).some(
        (cell) => minCellDistance([cell], cells) === 1,
      );
      if (reaches) {
        return { type: 'melee', target: enemy.id, from };
      }
    }
  }

  let best: Hex | null = null;
  let bestDistance = minCellDistance([stack.pos], allEnemyCells);
  for (const hex of candidates) {
    const distance = minCellDistance([hex], allEnemyCells);
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
