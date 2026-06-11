// Damage formula per spec section 7.5. computeDamage is pure: the random base
// roll is produced separately by rollBaseDamage so estimates can reuse the math.

import { rollRange, type RngState } from '../rng';

export const ATTACK_MULT_CAP = 4.0;
export const DEFENSE_MULT_FLOOR = 0.3;
export const SINGLE_ROLL_THRESHOLD = 10;
export const RANGED_PENALTY_DISTANCE = 10;

export interface DamageContext {
  base: number;
  attack: number;
  defense: number;
  ranged: boolean;
  offenseBonus?: number;
  archeryBonus?: number;
  armorerReduction?: number;
  distancePenalty?: boolean;
  meleePenalty?: boolean;
  wallPenalty?: boolean;
  lucky?: boolean;
  joustingHexes?: number;
}

export interface DamageBreakdown {
  base: number;
  attackMult: number;
  skillMult: number;
  penaltyMult: number;
  luckMult: number;
  joustingMult: number;
  total: number;
}

export function computeDamage(ctx: DamageContext): DamageBreakdown {
  const diff = ctx.attack - ctx.defense;
  const attackMult =
    diff > 0
      ? Math.min(ATTACK_MULT_CAP, 1 + 0.05 * diff)
      : Math.max(DEFENSE_MULT_FLOOR, 1 + 0.025 * diff);

  const skillBonus = ctx.ranged ? (ctx.archeryBonus ?? 0) : (ctx.offenseBonus ?? 0);
  const skillMult = (1 + skillBonus) * (1 - (ctx.armorerReduction ?? 0));

  let penaltyMult = 1;
  if (ctx.distancePenalty) penaltyMult *= 0.5;
  if (ctx.meleePenalty) penaltyMult *= 0.5;
  if (ctx.wallPenalty) penaltyMult *= 0.5;

  const luckMult = ctx.lucky ? 2 : 1;
  const joustingMult = 1 + 0.05 * (ctx.joustingHexes ?? 0);

  const product = ctx.base * attackMult * skillMult * penaltyMult * luckMult * joustingMult;
  const total = Math.max(1, Math.floor(product));
  return { base: ctx.base, attackMult, skillMult, penaltyMult, luckMult, joustingMult, total };
}

// per-creature rolls; stacks larger than 10 roll once and multiply by count
export function rollBaseDamage(
  rng: RngState,
  dmgMin: number,
  dmgMax: number,
  count: number,
): [number, RngState] {
  if (count < 1) {
    throw new Error(`rollBaseDamage: count must be positive, got ${String(count)}`);
  }
  if (count > SINGLE_ROLL_THRESHOLD) {
    const [roll, next] = rollRange(rng, dmgMin, dmgMax);
    return [roll * count, next];
  }
  let total = 0;
  let state = rng;
  for (let i = 0; i < count; i++) {
    const [roll, next] = rollRange(state, dmgMin, dmgMax);
    total += roll;
    state = next;
  }
  return [total, state];
}
