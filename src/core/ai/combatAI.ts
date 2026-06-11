// Combat AI per spec section 9.4, also used for auto-combat: cast the hero's
// best damage spell at the biggest enemy stack, shooters shoot the biggest
// threat, melee picks the best damage-minus-retaliation trade, otherwise
// advance toward the nearest enemy. Pure and deterministic: same combat state
// always yields the same (legal) action.

import type { GameData } from '../../data';
import type { Creature, Spell } from '../../data/schema';
import {
  effectiveAttack,
  effectiveDefense,
  effectiveHp,
  getEffect,
  hasSpecial,
  isBound,
  requireCreature,
  stackHpPool,
} from '../combat/abilities';
import { computeDamage, RANGED_PENALTY_DISTANCE } from '../combat/damage';
import {
  activeCombatStack,
  DEFEND_DEFENSE_BONUS,
  reachableHexesFor,
  type CombatAction,
} from '../combat/engine';
import { hexDistance, hexKey, type Hex } from '../combat/grid';
import { isSpellImmune, schoolTier, spellCost } from '../magic';
import {
  heroInfoFor,
  livingStacks,
  occupiedHexes,
  oppositeSide,
  tailOffset,
  type CombatSideId,
  type CombatStack,
  type CombatState,
} from '../combat/state';

function stackCells(stack: CombatStack, data: GameData): Hex[] {
  return occupiedHexes(stack, requireCreature(data, stack.creature));
}

function cellsFor(head: Hex, wide: boolean, side: CombatSideId): Hex[] {
  return wide ? [head, { x: head.x + tailOffset(side), y: head.y }] : [head];
}

function minCellDistance(a: readonly Hex[], b: readonly Hex[]): number {
  let min = Infinity;
  for (const ha of a) {
    for (const hb of b) {
      min = Math.min(min, hexDistance(ha, hb));
    }
  }
  return min;
}

function stackPower(stack: CombatStack, data: GameData): number {
  return stack.count * requireCreature(data, stack.creature).aiValue;
}

// raw offensive potential, used for shooter target priority
function damagePotential(stack: CombatStack, creature: Creature): number {
  return (stack.count * (creature.dmgMin + creature.dmgMax)) / 2;
}

// expected (average roll, no luck) damage of a single strike, reusing the
// real damage formula so caps and penalties match the engine
export function expectedDamage(
  combat: CombatState,
  attacker: CombatStack,
  target: CombatStack,
  ranged: boolean,
  data: GameData,
): number {
  const attackerCreature = requireCreature(data, attacker.creature);
  const targetCreature = requireCreature(data, target.creature);
  const attackerHero = heroInfoFor(combat, attacker.side);
  const targetHero = heroInfoFor(combat, target.side);

  const attack = effectiveAttack(attacker, attackerCreature, !ranged) + attackerHero.attack;
  let defense = effectiveDefense(target, targetCreature) + targetHero.defense;
  if (target.defending) {
    defense = Math.floor(defense * (1 + DEFEND_DEFENSE_BONUS));
  }
  const shield = getEffect(target, 'shield');
  const isShooter = attackerCreature.shots !== undefined;
  return computeDamage({
    base: damagePotential(attacker, attackerCreature),
    attack,
    defense,
    ranged,
    offenseBonus: ranged ? 0 : attackerHero.offenseBonus,
    archeryBonus: ranged ? attackerHero.archeryBonus : 0,
    armorerReduction: targetHero.armorerReduction,
    distancePenalty:
      ranged && minCellDistance(stackCells(attacker, data), stackCells(target, data)) >
        RANGED_PENALTY_DISTANCE,
    meleePenalty: !ranged && isShooter && !hasSpecial(attackerCreature, 'noMeleePenalty'),
    effectMult: shield && !ranged ? 1 - shield.value / 100 : 1,
  }).total;
}

// best affordable single-target damage spell at the biggest enemy stack
function pickSpellCast(
  combat: CombatState,
  side: CombatSideId,
  data: GameData,
): CombatAction | null {
  const hero = heroInfoFor(combat, side);
  if (hero.hero === null || !hero.hasSpellbook || combat.castThisRound[side]) return null;

  let best: { spell: Spell; magnitude: number } | null = null;
  for (const id of [...hero.spells].sort()) {
    const spell = data.spells[id];
    if (spell?.kind !== 'damage') continue;
    if (spell.target !== 'enemyStack' && spell.target !== 'anyStack') continue;
    const tierData = spell.tiers[schoolTier(hero, spell)];
    // skip jumping spells (chain lightning): they can arc into own stacks
    if (!tierData || tierData.jumps !== undefined) continue;
    if (spellCost(combat, side, spell, data) > hero.mana) continue;
    const magnitude = Math.floor((tierData.base ?? 0) + (tierData.spCoef ?? 0) * hero.spellPower);
    if (best === null || magnitude > best.magnitude) {
      best = { spell, magnitude };
    }
  }
  if (best === null) return null;
  const chosen = best.spell;

  let target: CombatStack | null = null;
  for (const enemy of livingStacks(combat, oppositeSide(side))) {
    if (isSpellImmune(enemy, chosen, data)) continue;
    if (
      target === null ||
      stackPower(enemy, data) > stackPower(target, data) ||
      (stackPower(enemy, data) === stackPower(target, data) && enemy.id < target.id)
    ) {
      target = enemy;
    }
  }
  if (target === null) return null;
  return { type: 'cast', spell: chosen.id, target: target.id };
}

function canShootNow(
  combat: CombatState,
  stack: CombatStack,
  creature: Creature,
  data: GameData,
): boolean {
  if (creature.shots === undefined || stack.shots < 1) return false;
  const forget = getEffect(stack, 'forgetfulness');
  if (forget && forget.value >= 100) return false;
  const cells = stackCells(stack, data);
  return !livingStacks(combat, oppositeSide(stack.side)).some(
    (enemy) => minCellDistance(cells, stackCells(enemy, data)) === 1,
  );
}

function pickShootTarget(combat: CombatState, side: CombatSideId, data: GameData): CombatStack {
  const enemies = livingStacks(combat, oppositeSide(side));
  let best = enemies[0];
  if (!best) {
    throw new Error('no living enemies to shoot');
  }
  for (const enemy of enemies) {
    const threat = damagePotential(enemy, requireCreature(data, enemy.creature));
    const bestThreat = damagePotential(best, requireCreature(data, best.creature));
    if (threat > bestThreat || (threat === bestThreat && enemy.id < best.id)) {
      best = enemy;
    }
  }
  return best;
}

interface MeleePlan {
  target: CombatStack;
  from: Hex;
  net: number;
}

// expected retaliation damage, scaled by the fraction of the target expected
// to survive the strike
function expectedRetaliation(
  combat: CombatState,
  attacker: CombatStack,
  attackerCreature: Creature,
  target: CombatStack,
  dealt: number,
  data: GameData,
): number {
  if (hasSpecial(attackerCreature, 'noRetaliation')) return 0;
  const targetCreature = requireCreature(data, target.creature);
  if (!hasSpecial(targetCreature, 'unlimitedRetaliation') && target.retaliationsLeft <= 0) {
    return 0;
  }
  const blind = getEffect(target, 'blind');
  const blindMult = blind ? (blind.value >= 100 ? 0 : 1 - blind.value / 100) : 1;
  if (blindMult === 0) return 0;
  const pool = stackHpPool(target, effectiveHp(target, targetCreature));
  const surviving = Math.max(0, pool - dealt) / Math.max(1, pool);
  if (surviving === 0) return 0;
  return expectedDamage(combat, target, attacker, false, data) * blindMult * surviving;
}

function pickMelee(
  combat: CombatState,
  stack: CombatStack,
  creature: Creature,
  candidates: readonly Hex[],
  data: GameData,
): MeleePlan | null {
  const wide = creature.flags.includes('wide');
  const ownPool = stackHpPool(stack, effectiveHp(stack, creature));
  let best: MeleePlan | null = null;
  for (const enemy of livingStacks(combat, oppositeSide(stack.side))) {
    const enemyCells = stackCells(enemy, data);
    const origins = candidates.filter((from) =>
      cellsFor(from, wide, stack.side).some((cell) => minCellDistance([cell], enemyCells) === 1),
    );
    const from = closestHex(origins, stack.pos);
    if (!from) continue;
    const enemyCreature = requireCreature(data, enemy.creature);
    const pool = stackHpPool(enemy, effectiveHp(enemy, enemyCreature));
    const dealt = Math.min(pool, expectedDamage(combat, stack, enemy, false, data));
    const taken = Math.min(
      ownPool,
      expectedRetaliation(combat, stack, creature, enemy, dealt, data),
    );
    const net = dealt - taken;
    if (best === null || net > best.net || (net === best.net && enemy.id < best.target.id)) {
      best = { target: enemy, from, net };
    }
  }
  return best;
}

function closestHex(origins: readonly Hex[], to: Hex): Hex | null {
  let best: Hex | null = null;
  for (const origin of origins) {
    if (
      best === null ||
      hexDistance(origin, to) < hexDistance(best, to) ||
      (hexDistance(origin, to) === hexDistance(best, to) && hexKey(origin) < hexKey(best))
    ) {
      best = origin;
    }
  }
  return best;
}

// when nothing is reachable in a siege, bash the gate open
function pickGateAttack(
  combat: CombatState,
  stack: CombatStack,
  creature: Creature,
  candidates: readonly Hex[],
): CombatAction | null {
  const siege = combat.siege;
  if (!siege || stack.side !== 'attacker') return null;
  const gateIndex = siege.segments.findIndex((s) => s.isGate && s.hp > 0);
  if (gateIndex === -1) return null;
  const gate = siege.segments[gateIndex];
  if (!gate) return null;
  const wide = creature.flags.includes('wide');
  const origins = candidates.filter((from) =>
    cellsFor(from, wide, stack.side).some((cell) => hexDistance(cell, gate.pos) === 1),
  );
  const from = closestHex(origins, stack.pos);
  if (!from) return null;
  return { type: 'attackWall', segment: gateIndex, from };
}

export function chooseCombatAction(combat: CombatState, data: GameData): CombatAction {
  const stack = activeCombatStack(combat);
  if (!stack) {
    throw new Error('no active combat stack');
  }
  const creature = requireCreature(data, stack.creature);
  const enemies = livingStacks(combat, oppositeSide(stack.side));
  if (enemies.length === 0) {
    throw new Error('no living enemies in combat');
  }

  const cast = pickSpellCast(combat, stack.side, data);
  if (cast) return cast;

  if (canShootNow(combat, stack, creature, data)) {
    return { type: 'shoot', target: pickShootTarget(combat, stack.side, data).id };
  }

  const candidates: Hex[] = isBound(stack)
    ? [stack.pos]
    : [stack.pos, ...reachableHexesFor(combat, stack.id, data)];

  const melee = pickMelee(combat, stack, creature, candidates, data);
  if (melee) {
    return { type: 'melee', target: melee.target.id, from: melee.from };
  }

  const gate = pickGateAttack(combat, stack, creature, candidates);
  if (gate) return gate;

  // advance toward the nearest enemy cell; defend when stuck
  const enemyCells = enemies.flatMap((enemy) => stackCells(enemy, data));
  let bestHex: Hex | null = null;
  let bestDistance = minCellDistance([stack.pos], enemyCells);
  for (const hex of candidates) {
    const distance = minCellDistance([hex], enemyCells);
    if (
      distance < bestDistance ||
      (distance === bestDistance && bestHex !== null && hexKey(hex) < hexKey(bestHex))
    ) {
      bestHex = hex;
      bestDistance = distance;
    }
  }
  if (bestHex && hexKey(bestHex) !== hexKey(stack.pos)) {
    return { type: 'move', to: bestHex };
  }
  return { type: 'defend' };
}
