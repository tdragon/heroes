import { describe, expect, it } from 'vitest';
import { seedRng } from '../rng';
import {
  bfsReachable,
  FIELD_HEIGHT,
  FIELD_WIDTH,
  generateObstacles,
  hexDistance,
  hexEquals,
  hexKey,
  hexNeighbors,
  inField,
  MAX_OBSTACLES,
  OBSTACLE_MAX_X,
  OBSTACLE_MIN_X,
  type Hex,
} from './grid';

function allHexes(): Hex[] {
  const out: Hex[] = [];
  for (let y = 0; y < FIELD_HEIGHT; y++) {
    for (let x = 0; x < FIELD_WIDTH; x++) {
      out.push({ x, y });
    }
  }
  return out;
}

describe('hex neighbors', () => {
  it('interior hexes have 6 neighbors, all in field', () => {
    for (const hex of [
      { x: 5, y: 5 },
      { x: 7, y: 4 },
      { x: 2, y: 1 },
    ]) {
      const neighbors = hexNeighbors(hex);
      expect(neighbors).toHaveLength(6);
      expect(neighbors.every(inField)).toBe(true);
    }
  });

  it('corner and edge hexes have fewer neighbors', () => {
    expect(hexNeighbors({ x: 0, y: 0 })).toHaveLength(2);
    expect(hexNeighbors({ x: 14, y: 0 })).toHaveLength(3);
    expect(hexNeighbors({ x: 0, y: 10 })).toHaveLength(2);
    expect(hexNeighbors({ x: 14, y: 10 })).toHaveLength(3);
    expect(hexNeighbors({ x: 0, y: 5 })).toHaveLength(5);
    expect(hexNeighbors({ x: 7, y: 0 })).toHaveLength(4);
  });

  it('neighborhood is symmetric', () => {
    for (const hex of allHexes()) {
      for (const neighbor of hexNeighbors(hex)) {
        expect(hexNeighbors(neighbor).some((back) => hexEquals(back, hex))).toBe(true);
      }
    }
  });
});

describe('hex distance', () => {
  it('is 1 for every neighbor pair', () => {
    for (const hex of allHexes()) {
      for (const neighbor of hexNeighbors(hex)) {
        expect(hexDistance(hex, neighbor)).toBe(1);
      }
    }
  });

  it('is symmetric and zero on identity', () => {
    const pairs: [Hex, Hex][] = [
      [
        { x: 0, y: 0 },
        { x: 14, y: 10 },
      ],
      [
        { x: 3, y: 7 },
        { x: 11, y: 2 },
      ],
      [
        { x: 5, y: 5 },
        { x: 5, y: 5 },
      ],
    ];
    for (const [a, b] of pairs) {
      expect(hexDistance(a, b)).toBe(hexDistance(b, a));
    }
    expect(hexDistance({ x: 5, y: 5 }, { x: 5, y: 5 })).toBe(0);
  });

  it('matches straight-line counts', () => {
    expect(hexDistance({ x: 0, y: 0 }, { x: 14, y: 0 })).toBe(14);
    expect(hexDistance({ x: 0, y: 0 }, { x: 0, y: 10 })).toBe(10);
  });

  it('never exceeds BFS step count', () => {
    const start: Hex = { x: 7, y: 5 };
    const within3 = bfsReachable(start, 3, () => true);
    for (const hex of within3) {
      expect(hexDistance(start, hex)).toBeLessThanOrEqual(3);
    }
  });
});

describe('bfsReachable', () => {
  it('reaches every hex within speed on an empty field', () => {
    const start: Hex = { x: 7, y: 5 };
    const reached = bfsReachable(start, 2, () => true);
    const expected = allHexes().filter(
      (h) => !hexEquals(h, start) && hexDistance(start, h) <= 2,
    );
    expect(new Set(reached.map(hexKey))).toEqual(new Set(expected.map(hexKey)));
  });

  it('excludes the start hex', () => {
    const start: Hex = { x: 7, y: 5 };
    expect(bfsReachable(start, 3, () => true).some((h) => hexEquals(h, start))).toBe(false);
  });

  it('does not pass through blocked hexes', () => {
    // wall on column 8 blocks everything to the right for a slow walker at x=7
    const blocked = (h: Hex): boolean => h.x !== 8;
    const reached = bfsReachable({ x: 7, y: 5 }, 2, blocked);
    expect(reached.every((h) => h.x < 8)).toBe(true);
  });
});

describe('generateObstacles', () => {
  it('is deterministic per seed', () => {
    const [a] = generateObstacles(seedRng(123));
    const [b] = generateObstacles(seedRng(123));
    expect(a).toEqual(b);
  });

  it('keeps obstacles unique, in bounds, and off spawn columns', () => {
    for (let seed = 0; seed < 50; seed++) {
      const [obstacles] = generateObstacles(seedRng(seed));
      expect(obstacles.length).toBeLessThanOrEqual(MAX_OBSTACLES);
      const keys = new Set(obstacles.map(hexKey));
      expect(keys.size).toBe(obstacles.length);
      for (const hex of obstacles) {
        expect(inField(hex)).toBe(true);
        expect(hex.x).toBeGreaterThanOrEqual(OBSTACLE_MIN_X);
        expect(hex.x).toBeLessThanOrEqual(OBSTACLE_MAX_X);
      }
    }
  });

  it('advances the rng state', () => {
    const [, next] = generateObstacles(seedRng(123));
    expect(next).not.toBe(seedRng(123));
  });
});
