// Simplified siege per spec 7.7: a wall in column 10 with 3 destructible
// segments and a gate, an automatic catapult, keep/castle arrow towers and a
// moat. All numbers are MVP-tunable constants.

import { FIELD_HEIGHT, hexEquals, type Hex } from './grid';
import type { CombatSideId } from './state';

export type SiegeLevel = 'fort' | 'citadel' | 'castle';

export const WALL_X = 10;
export const MOAT_X = 9;
export const WALL_SEGMENT_HP = 2;
export const GATE_HP = 2;
export const WALL_MELEE_DAMAGE = 1;
export const CATAPULT_HIT_CHANCE = 0.5;
export const TOWER_SHOOTER_COUNT = 10;
export const TOWER_CREATURE = 'archer';
export const MOAT_DAMAGE = 70;

const SEGMENT_ROWS: readonly number[] = [1, 3, 8];
export const GATE_ROW = 5;

export interface WallSegment {
  pos: Hex;
  hp: number;
  isGate: boolean;
}

export interface SiegeTower {
  pos: Hex;
  count: number;
}

export interface SiegeState {
  level: SiegeLevel;
  segments: WallSegment[];
  staticWalls: Hex[];
  towers: SiegeTower[];
  moat: Hex[];
}

export function siegeLevelFromBuildings(buildings: readonly string[]): SiegeLevel | null {
  if (buildings.includes('castle')) return 'castle';
  if (buildings.includes('citadel')) return 'citadel';
  if (buildings.includes('fort')) return 'fort';
  return null;
}

export function createSiege(level: SiegeLevel): SiegeState {
  const segments: WallSegment[] = SEGMENT_ROWS.map((y) => ({
    pos: { x: WALL_X, y },
    hp: WALL_SEGMENT_HP,
    isGate: false,
  }));
  segments.push({ pos: { x: WALL_X, y: GATE_ROW }, hp: GATE_HP, isGate: true });

  const staticWalls: Hex[] = [];
  for (let y = 0; y < FIELD_HEIGHT; y++) {
    if (y === GATE_ROW || SEGMENT_ROWS.includes(y)) continue;
    staticWalls.push({ x: WALL_X, y });
  }

  const towers: SiegeTower[] = [];
  if (level === 'citadel' || level === 'castle') {
    towers.push({ pos: { x: 11, y: GATE_ROW }, count: TOWER_SHOOTER_COUNT });
  }
  if (level === 'castle') {
    towers.push({ pos: { x: 11, y: 0 }, count: TOWER_SHOOTER_COUNT });
    towers.push({ pos: { x: 11, y: FIELD_HEIGHT - 1 }, count: TOWER_SHOOTER_COUNT });
  }

  const moat: Hex[] = [];
  if (level === 'citadel' || level === 'castle') {
    for (let y = 0; y < FIELD_HEIGHT; y++) {
      moat.push({ x: MOAT_X, y });
    }
  }

  return { level, segments, staticWalls, towers, moat };
}

export function segmentAt(siege: SiegeState, hex: Hex): WallSegment | null {
  return siege.segments.find((s) => hexEquals(s.pos, hex)) ?? null;
}

// hexes a ground stack of the given side can never enter right now
export function siegeBlockedHexes(siege: SiegeState, side: CombatSideId): Hex[] {
  const blocked: Hex[] = [...siege.staticWalls, ...siege.towers.map((t) => t.pos)];
  for (const segment of siege.segments) {
    if (segment.hp <= 0) continue;
    // the closed gate opens for the defender
    if (segment.isGate && side === 'defender') continue;
    blocked.push(segment.pos);
  }
  return blocked;
}

export function isMoatHex(siege: SiegeState, hex: Hex): boolean {
  return siege.moat.some((m) => hexEquals(m, hex));
}

export function wallsBreached(siege: SiegeState): boolean {
  return siege.segments.every((s) => s.hp <= 0);
}

export function standingSegments(siege: SiegeState, includeGate: boolean): WallSegment[] {
  return siege.segments.filter((s) => s.hp > 0 && (includeGate || !s.isGate));
}
