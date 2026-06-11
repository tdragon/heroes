// Creature ability hooks and combat math shared by the engine and the magic
// system: stack effects, effective stats, HP-pool damage/heal, morale/luck and
// magic resistance.

import type { GameData } from '../../data';
import type { Creature, SpecialType } from '../../data/schema';
import { hexDistance } from './grid';
import {
  heroInfoFor,
  livingStacks,
  occupiedHexes,
  oppositeSide,
  type CombatSideId,
  type CombatStack,
  type CombatState,
  type EffectKind,
  type StackEffect,
} from './state';

export const MORALE_LUCK_DIE = 24;
export const MORALE_CAP = 3;
export const ON_HIT_EFFECT_ROUNDS = 3;

export function requireCreature(data: GameData, id: string): Creature {
  const creature = data.creatures[id];
  if (!creature) {
    throw new Error(`unknown creature: ${id}`);
  }
  return creature;
}

export function hasSpecial(creature: Creature, type: SpecialType): boolean {
  return creature.specials.some((s) => s.type === type);
}

export function specialValue(creature: Creature, type: SpecialType): number | undefined {
  return creature.specials.find((s) => s.type === type)?.value;
}

// --- stack effects ---

export function getEffect(stack: CombatStack, kind: EffectKind): StackEffect | null {
  return stack.effects.find((e) => e.kind === kind) ?? null;
}

export function addEffect(stack: CombatStack, effect: StackEffect): void {
  stack.effects = stack.effects.filter((e) => e.kind !== effect.kind);
  stack.effects.push(effect);
}

export function removeEffect(stack: CombatStack, kind: EffectKind): void {
  stack.effects = stack.effects.filter((e) => e.kind !== kind);
}

export function isBlinded(stack: CombatStack): boolean {
  return getEffect(stack, 'blind') !== null;
}

export function isBound(stack: CombatStack): boolean {
  return getEffect(stack, 'bind') !== null;
}

// --- effective stats (creature base + active effects) ---

export function effectiveAttack(stack: CombatStack, creature: Creature, melee: boolean): number {
  let attack = creature.attack;
  const bloodlust = getEffect(stack, 'bloodlust');
  if (bloodlust && melee) attack += bloodlust.value;
  const weakness = getEffect(stack, 'weakness');
  if (weakness) attack -= weakness.value;
  const disease = getEffect(stack, 'disease');
  if (disease) attack -= disease.value;
  return attack;
}

export function effectiveDefense(stack: CombatStack, creature: Creature): number {
  let defense = creature.defense;
  const stoneSkin = getEffect(stack, 'stone_skin');
  if (stoneSkin) defense += stoneSkin.value;
  const disease = getEffect(stack, 'disease');
  if (disease) defense -= disease.value;
  return defense;
}

export function effectiveSpeed(stack: CombatStack, creature: Creature): number {
  let speed = creature.speed;
  const haste = getEffect(stack, 'haste');
  if (haste) speed += haste.value;
  const slow = getEffect(stack, 'slow');
  if (slow) speed = Math.floor(speed * (1 - slow.value / 100));
  return Math.max(1, speed);
}

export function effectiveHp(stack: CombatStack, creature: Creature): number {
  return getEffect(stack, 'aging') ? Math.ceil(creature.hp / 2) : creature.hp;
}

export function stackHpPool(stack: CombatStack, hpPerCreature: number): number {
  if (stack.count <= 0) return 0;
  return stack.firstHp + (stack.count - 1) * hpPerCreature;
}

// damage hits the stack HP pool; returns creatures killed
export function applyDamage(stack: CombatStack, hpPerCreature: number, damage: number): number {
  const remaining = stackHpPool(stack, hpPerCreature) - damage;
  if (remaining <= 0) {
    const kills = stack.count;
    stack.count = 0;
    stack.firstHp = 0;
    return kills;
  }
  const newCount = Math.ceil(remaining / hpPerCreature);
  const kills = stack.count - newCount;
  stack.count = newCount;
  stack.firstHp = remaining - (newCount - 1) * hpPerCreature;
  return kills;
}

export interface DamageOutcome {
  kills: number;
  died: boolean;
  blindBroken: boolean;
}

// damage with side effects: taking damage breaks Blind
export function damageStack(stack: CombatStack, creature: Creature, damage: number): DamageOutcome {
  const blindBroken = damage > 0 && isBlinded(stack);
  if (blindBroken) removeEffect(stack, 'blind');
  const kills = applyDamage(stack, effectiveHp(stack, creature), damage);
  return { kills, died: stack.count === 0, blindBroken };
}

// add HP to the pool, reviving creatures up to the initial count; returns revived
export function resurrectStack(stack: CombatStack, hpPerCreature: number, amount: number): number {
  const before = stack.count;
  const cap = stack.initialCount * hpPerCreature;
  const pool = Math.min(cap, stackHpPool(stack, hpPerCreature) + amount);
  if (pool <= 0) return 0;
  stack.count = Math.ceil(pool / hpPerCreature);
  stack.firstHp = pool - (stack.count - 1) * hpPerCreature;
  return stack.count - before;
}

// heal the top creature only (Cure, regeneration); returns HP restored
export function healTopCreature(stack: CombatStack, hpPerCreature: number, amount: number): number {
  if (stack.count <= 0) return 0;
  const healed = Math.min(hpPerCreature, stack.firstHp + amount);
  const gain = healed - stack.firstHp;
  stack.firstHp = healed;
  return gain;
}

// --- morale and luck (spec 7.4) ---

function clampMorale(value: number): number {
  return Math.max(-MORALE_CAP, Math.min(MORALE_CAP, value));
}

export function stackMorale(combat: CombatState, stack: CombatStack, data: GameData): number {
  const creature = requireCreature(data, stack.creature);
  if (creature.flags.includes('undead')) return 0;

  let morale = heroInfoFor(combat, stack.side).morale;
  const allies = livingStacks(combat, stack.side);
  const allyCreatures = allies.map((a) => requireCreature(data, a.creature));

  const factions = new Set(allyCreatures.map((c) => c.faction));
  if (factions.size === 1) morale += 1;
  if (allyCreatures.some((c) => c.flags.includes('undead'))) morale -= 1;

  let aura = 0;
  for (const ally of allyCreatures) {
    aura = Math.max(aura, specialValue(ally, 'moraleAura') ?? 0);
  }
  morale += aura;

  let debuff = 0;
  for (const enemy of livingStacks(combat, oppositeSide(stack.side))) {
    debuff = Math.max(debuff, specialValue(requireCreature(data, enemy.creature), 'enemyMoraleDebuff') ?? 0);
  }
  morale -= debuff;

  return clampMorale(morale);
}

export function sideLuck(combat: CombatState, side: CombatSideId): number {
  return Math.max(-MORALE_CAP, Math.min(MORALE_CAP, heroInfoFor(combat, side).luck));
}

// --- magic resistance (dwarf innate + unicorn aura on adjacent allies) ---

export function magicResistChance(combat: CombatState, stack: CombatStack, data: GameData): number {
  const creature = requireCreature(data, stack.creature);
  let chance = specialValue(creature, 'magicResistance') ?? 0;
  for (const ally of livingStacks(combat, stack.side)) {
    if (ally.id === stack.id) continue;
    const allyCreature = requireCreature(data, ally.creature);
    const aura = specialValue(allyCreature, 'magicResistAura') ?? 0;
    if (aura === 0) continue;
    const allyHexes = occupiedHexes(ally, allyCreature);
    const ownHexes = occupiedHexes(stack, creature);
    const adjacent = ownHexes.some((h) => allyHexes.some((a) => hexDistance(h, a) === 1));
    if (adjacent) chance += aura;
  }
  return Math.min(100, chance);
}
