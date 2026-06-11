// Battlefield hex grid: 15 columns x 11 rows, odd-r offset layout
// (odd rows shifted right, pointy-top hexes).

import { rollRange, type RngState } from '../rng';

export const FIELD_WIDTH = 15;
export const FIELD_HEIGHT = 11;

export interface Hex {
  x: number;
  y: number;
}

export function hexEquals(a: Hex, b: Hex): boolean {
  return a.x === b.x && a.y === b.y;
}

export function hexKey(h: Hex): number {
  return h.y * FIELD_WIDTH + h.x;
}

export function inField(h: Hex): boolean {
  return h.x >= 0 && h.x < FIELD_WIDTH && h.y >= 0 && h.y < FIELD_HEIGHT;
}

const EVEN_ROW_OFFSETS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, -1],
  [-1, -1],
  [0, 1],
  [-1, 1],
];

const ODD_ROW_OFFSETS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [1, -1],
  [0, -1],
  [1, 1],
  [0, 1],
];

export function hexNeighbors(h: Hex): Hex[] {
  const offsets = h.y % 2 === 0 ? EVEN_ROW_OFFSETS : ODD_ROW_OFFSETS;
  return offsets.map(([dx, dy]): Hex => ({ x: h.x + dx, y: h.y + dy })).filter(inField);
}

function toCube(h: Hex): [number, number, number] {
  const x = h.x - (h.y - (h.y & 1)) / 2;
  const z = h.y;
  return [x, -x - z, z];
}

export function hexDistance(a: Hex, b: Hex): number {
  const [ax, ay, az] = toCube(a);
  const [bx, by, bz] = toCube(b);
  return (Math.abs(ax - bx) + Math.abs(ay - by) + Math.abs(az - bz)) / 2;
}

// BFS over standable hexes; returns hexes reachable in 1..speed steps (start excluded)
export function bfsReachable(start: Hex, speed: number, canStand: (h: Hex) => boolean): Hex[] {
  const visited = new Set<number>([hexKey(start)]);
  const out: Hex[] = [];
  let frontier: Hex[] = [start];
  for (let step = 0; step < speed; step++) {
    const next: Hex[] = [];
    for (const hex of frontier) {
      for (const neighbor of hexNeighbors(hex)) {
        const key = hexKey(neighbor);
        if (visited.has(key)) continue;
        visited.add(key);
        if (!canStand(neighbor)) continue;
        out.push(neighbor);
        next.push(neighbor);
      }
    }
    frontier = next;
  }
  return out;
}

export const MAX_OBSTACLES = 8;
export const OBSTACLE_MIN_X = 2;
export const OBSTACLE_MAX_X = 12;

// 0-8 impassable hexes, never in spawn columns +-1 (columns 0,1 and 13,14)
export function generateObstacles(rng: RngState): [Hex[], RngState] {
  const [count, afterCount] = rollRange(rng, 0, MAX_OBSTACLES);
  let state = afterCount;
  const candidates: Hex[] = [];
  for (let y = 0; y < FIELD_HEIGHT; y++) {
    for (let x = OBSTACLE_MIN_X; x <= OBSTACLE_MAX_X; x++) {
      candidates.push({ x, y });
    }
  }
  const obstacles: Hex[] = [];
  for (let i = 0; i < count; i++) {
    const [index, next] = rollRange(state, 0, candidates.length - 1);
    state = next;
    const picked = candidates.splice(index, 1)[0];
    if (!picked) {
      throw new Error('obstacle candidate pool exhausted');
    }
    obstacles.push(picked);
  }
  return [obstacles, state];
}
