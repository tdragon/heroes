import { describe, expect, it } from 'vitest';
import { seedRng } from '../rng';
import {
  ATTACK_MULT_CAP,
  computeDamage,
  DEFENSE_MULT_FLOOR,
  rollBaseDamage,
  SINGLE_ROLL_THRESHOLD,
  type DamageContext,
} from './damage';

function ctx(overrides: Partial<DamageContext>): DamageContext {
  return { base: 100, attack: 10, defense: 10, ranged: false, ...overrides };
}

describe('computeDamage golden cases', () => {
  it('equal attack and defense leaves base unchanged', () => {
    const result = computeDamage(ctx({}));
    expect(result.attackMult).toBe(1);
    expect(result.total).toBe(100);
  });

  it('attack advantage adds 5% per point', () => {
    expect(computeDamage(ctx({ attack: 14 })).total).toBe(120);
    expect(computeDamage(ctx({ attack: 11 })).attackMult).toBeCloseTo(1.05);
  });

  it('caps attack multiplier at 4.0', () => {
    const result = computeDamage(ctx({ attack: 210, defense: 0 }));
    expect(result.attackMult).toBe(ATTACK_MULT_CAP);
    expect(result.total).toBe(400);
  });

  it('defense advantage subtracts 2.5% per point', () => {
    expect(computeDamage(ctx({ defense: 14 })).total).toBe(90);
  });

  it('floors defense multiplier at 0.3', () => {
    const result = computeDamage(ctx({ defense: 1000 }));
    expect(result.attackMult).toBe(DEFENSE_MULT_FLOOR);
    expect(result.total).toBe(30);
  });

  it('never deals less than 1 damage', () => {
    const result = computeDamage(ctx({ base: 1, defense: 1000 }));
    expect(result.total).toBe(1);
  });

  it('doubles damage on a lucky strike', () => {
    expect(computeDamage(ctx({ lucky: true })).total).toBe(200);
  });

  it('jousting adds 5% per hex traveled', () => {
    const result = computeDamage(ctx({ joustingHexes: 4 }));
    expect(result.joustingMult).toBeCloseTo(1.2);
    expect(result.total).toBe(120);
  });

  it('applies offense to melee and archery to ranged only', () => {
    expect(computeDamage(ctx({ offenseBonus: 0.3 })).total).toBe(130);
    expect(computeDamage(ctx({ offenseBonus: 0.3, ranged: true })).total).toBe(100);
    expect(computeDamage(ctx({ archeryBonus: 0.5, ranged: true })).total).toBe(150);
    expect(computeDamage(ctx({ archeryBonus: 0.5 })).total).toBe(100);
  });

  it('armorer reduces damage taken', () => {
    expect(computeDamage(ctx({ armorerReduction: 0.15 })).total).toBe(85);
  });

  it('stacks distance, melee, and wall penalties multiplicatively', () => {
    expect(computeDamage(ctx({ distancePenalty: true, ranged: true })).total).toBe(50);
    expect(
      computeDamage(ctx({ distancePenalty: true, wallPenalty: true, ranged: true })).total,
    ).toBe(25);
    expect(computeDamage(ctx({ meleePenalty: true })).total).toBe(50);
  });

  it('combines all multipliers and floors the product', () => {
    const result = computeDamage(
      ctx({
        base: 40,
        attack: 20,
        defense: 10,
        offenseBonus: 0.2,
        armorerReduction: 0.1,
        lucky: true,
      }),
    );
    // 40 * 1.5 * 1.2 * 0.9 * 2 = 129.6
    expect(result.total).toBe(129);
  });
});

describe('rollBaseDamage', () => {
  it('sums one roll per creature for small stacks', () => {
    for (let seed = 0; seed < 20; seed++) {
      const [base] = rollBaseDamage(seedRng(seed), 2, 3, 5);
      expect(base).toBeGreaterThanOrEqual(10);
      expect(base).toBeLessThanOrEqual(15);
    }
  });

  it('rolls once and multiplies for stacks above the threshold', () => {
    const count = SINGLE_ROLL_THRESHOLD + 10;
    for (let seed = 0; seed < 20; seed++) {
      const [base] = rollBaseDamage(seedRng(seed), 2, 3, count);
      expect(base % count).toBe(0);
      expect(base).toBeGreaterThanOrEqual(2 * count);
      expect(base).toBeLessThanOrEqual(3 * count);
    }
  });

  it('is deterministic and advances rng state', () => {
    const [a, nextA] = rollBaseDamage(seedRng(7), 1, 6, 4);
    const [b, nextB] = rollBaseDamage(seedRng(7), 1, 6, 4);
    expect(a).toBe(b);
    expect(nextA).toBe(nextB);
    expect(nextA).not.toBe(seedRng(7));
  });

  it('rejects non-positive counts', () => {
    expect(() => rollBaseDamage(seedRng(1), 1, 3, 0)).toThrow('count must be positive');
  });
});
