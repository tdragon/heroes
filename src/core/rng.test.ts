import { describe, expect, it } from 'vitest';
import { nextFloat, rollChance, rollRange, seedRng, type RngState } from './rng';

function sequence(seed: number, count: number): number[] {
  let state = seedRng(seed);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const [value, next] = nextFloat(state);
    out.push(value);
    state = next;
  }
  return out;
}

describe('nextFloat', () => {
  it('is deterministic: same seed produces the same sequence', () => {
    expect(sequence(42, 100)).toEqual(sequence(42, 100));
  });

  it('different seeds produce different sequences', () => {
    expect(sequence(1, 20)).not.toEqual(sequence(2, 20));
  });

  it('does not mutate input state and returns values in [0,1)', () => {
    const state = seedRng(7);
    const [v1] = nextFloat(state);
    const [v2] = nextFloat(state);
    expect(v1).toBe(v2);
    for (const v of sequence(7, 1000)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('has a sane distribution (mean near 0.5 over 10k rolls)', () => {
    const values = sequence(123, 10000);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    expect(mean).toBeGreaterThan(0.48);
    expect(mean).toBeLessThan(0.52);
  });
});

describe('rollRange', () => {
  it('stays within inclusive bounds and hits every value', () => {
    let state = seedRng(99);
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      const [value, next] = rollRange(state, 1, 6);
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(6);
      expect(Number.isInteger(value)).toBe(true);
      seen.add(value);
      state = next;
    }
    expect(seen.size).toBe(6);
  });

  it('handles min === max', () => {
    const [value] = rollRange(seedRng(5), 3, 3);
    expect(value).toBe(3);
  });

  it('rejects invalid input', () => {
    expect(() => rollRange(seedRng(1), 5, 2)).toThrow('min 5 > max 2');
    expect(() => rollRange(seedRng(1), 0.5, 2)).toThrow('expects integers');
  });
});

describe('rollChance', () => {
  it('returns booleans matching probability over many rolls', () => {
    let state = seedRng(321);
    let hits = 0;
    const n = 10000;
    for (let i = 0; i < n; i++) {
      const [hit, next] = rollChance(state, 0.25);
      if (hit) hits++;
      state = next;
    }
    expect(hits / n).toBeGreaterThan(0.22);
    expect(hits / n).toBeLessThan(0.28);
  });

  it('p=0 never hits, p=1 always hits', () => {
    let state = seedRng(8);
    for (let i = 0; i < 100; i++) {
      const [never, s1] = rollChance(state, 0);
      const [always, s2] = rollChance(s1, 1);
      expect(never).toBe(false);
      expect(always).toBe(true);
      state = s2;
    }
  });

  it('rejects probability outside [0,1]', () => {
    expect(() => rollChance(seedRng(1), -0.1)).toThrow('out of [0,1]');
    expect(() => rollChance(seedRng(1), 1.1)).toThrow('out of [0,1]');
  });
});

describe('state round-trip', () => {
  it('a serialized state number resumes the exact same sequence', () => {
    let state: RngState = seedRng(2024);
    for (let i = 0; i < 50; i++) {
      [, state] = nextFloat(state);
    }
    const saved: number = JSON.parse(JSON.stringify(state)) as number;
    const fromSaved = sequenceFrom(saved, 20);
    const fromLive = sequenceFrom(state, 20);
    expect(fromSaved).toEqual(fromLive);
  });
});

function sequenceFrom(start: RngState, count: number): number[] {
  let state = start;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const [value, next] = nextFloat(state);
    out.push(value);
    state = next;
  }
  return out;
}
