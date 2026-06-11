import type { GameData } from '../data';
import type { Road, Terrain } from '../data/schema';
import { objectFootprint } from '../maps/dsl';
import { NO_ROAD_CHAR, type Pos } from '../maps/schema';
import type { Command, GameEvent } from './commands';
import { CommandRejectedError } from './commands';
import { startFieldCombat } from './combat/resolve';
import { revealFor, sightRadius } from './fog';
import { handleObjectTrigger } from './objects';
import {
  getPlayer,
  skillValue,
  type GameState,
  type Hero,
  type HeroId,
  type ObjectId,
} from './state';

export const DIAGONAL_FACTOR = 1.414;
export const TERRAIN_COST_FLOOR = 100;
const MIN_STEP_COST = 50;

export function reducedTerrainCost(baseCost: number, pathfindingPct: number): number {
  if (baseCost <= TERRAIN_COST_FLOOR) return baseCost;
  const penalty = baseCost - TERRAIN_COST_FLOOR;
  return Math.max(TERRAIN_COST_FLOOR, baseCost - Math.floor((penalty * pathfindingPct) / 100));
}

export interface MoveContext {
  size: number;
  tileCosts: (number | null)[];
  blocked: boolean[];
  triggers: (ObjectId | null)[];
  // enemy hero on the tile: enterable as a path destination, stepping toward
  // it triggers a field battle (or a siege when the tile is a town)
  enemyHeroes: (HeroId | null)[];
}

export function buildMoveContext(state: GameState, data: GameData, hero: Hero): MoveContext {
  const { size, terrain, roads, objects } = state.map;
  const terrainByChar = new Map<string, Terrain>(
    Object.values(data.terrains).map((t) => [t.char, t]),
  );
  const roadByChar = new Map<string, Road>(Object.values(data.roads).map((r) => [r.char, r]));
  const pathfinding = skillValue(hero, 'pathfinding', data);

  const tileCosts: (number | null)[] = Array.from({ length: size * size }, () => null);
  for (let i = 0; i < size * size; i++) {
    const roadChar = roads[i] ?? NO_ROAD_CHAR;
    if (roadChar !== NO_ROAD_CHAR) {
      const road = roadByChar.get(roadChar);
      if (!road) throw new Error(`unknown road char '${roadChar}' at tile ${String(i)}`);
      tileCosts[i] = road.moveCost;
      continue;
    }
    const terrainChar = terrain[i] ?? '';
    const t = terrainByChar.get(terrainChar);
    if (!t) throw new Error(`unknown terrain char '${terrainChar}' at tile ${String(i)}`);
    tileCosts[i] = t.moveCost === null ? null : reducedTerrainCost(t.moveCost, pathfinding);
  }

  const blocked = Array.from({ length: size * size }, () => false);
  const triggers: (ObjectId | null)[] = Array.from({ length: size * size }, () => null);
  for (const obj of objects) {
    if (obj.removed) continue;
    for (const [x, y] of objectFootprint(obj.type, obj.at)) {
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      blocked[y * size + x] = true;
    }
    triggers[obj.at[1] * size + obj.at[0]] = obj.id;
  }
  for (let i = 0; i < size * size; i++) {
    if (triggers[i] !== null) blocked[i] = false;
  }
  const enemyHeroes: (HeroId | null)[] = Array.from({ length: size * size }, () => null);
  for (const other of Object.values(state.heroes)) {
    if (other.id === hero.id) continue;
    const index = other.pos[1] * size + other.pos[0];
    if (other.owner === hero.owner) {
      blocked[index] = true;
    } else {
      enemyHeroes[index] = other.id;
    }
  }

  return { size, tileCosts, blocked, triggers, enemyHeroes };
}

function tileIndex(ctx: MoveContext, pos: Pos): number {
  return pos[1] * ctx.size + pos[0];
}

function isInside(ctx: MoveContext, pos: Pos): boolean {
  return pos[0] >= 0 && pos[1] >= 0 && pos[0] < ctx.size && pos[1] < ctx.size;
}

export function isEnterable(ctx: MoveContext, pos: Pos): boolean {
  if (!isInside(ctx, pos)) return false;
  const i = tileIndex(ctx, pos);
  return ctx.tileCosts[i] !== null && !ctx.blocked[i];
}

function isAdjacentStep(from: Pos, to: Pos): boolean {
  const dx = Math.abs(to[0] - from[0]);
  const dy = Math.abs(to[1] - from[1]);
  return dx <= 1 && dy <= 1 && dx + dy > 0;
}

export function stepCost(ctx: MoveContext, from: Pos, to: Pos): number {
  const cost = ctx.tileCosts[tileIndex(ctx, to)];
  if (cost === null || cost === undefined) {
    throw new Error(`step into impassable tile (${String(to[0])},${String(to[1])})`);
  }
  const diagonal = from[0] !== to[0] && from[1] !== to[1];
  return diagonal ? Math.round(cost * DIAGONAL_FACTOR) : cost;
}

interface HeapNode {
  index: number;
  f: number;
}

class MinHeap {
  private items: HeapNode[] = [];

  get size(): number {
    return this.items.length;
  }

  push(node: HeapNode): void {
    this.items.push(node);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const a = this.items[i];
      const b = this.items[parent];
      if (!a || !b || b.f <= a.f) break;
      this.items[i] = b;
      this.items[parent] = a;
      i = parent;
    }
  }

  pop(): HeapNode | undefined {
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0 && last) {
      this.items[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if ((this.items[left]?.f ?? Infinity) < (this.items[smallest]?.f ?? Infinity)) {
          smallest = left;
        }
        if ((this.items[right]?.f ?? Infinity) < (this.items[smallest]?.f ?? Infinity)) {
          smallest = right;
        }
        if (smallest === i) break;
        const a = this.items[i];
        const b = this.items[smallest];
        if (!a || !b) break;
        this.items[i] = b;
        this.items[smallest] = a;
        i = smallest;
      }
    }
    return top;
  }
}

const NEIGHBOR_OFFSETS: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
];

export function findPath(state: GameState, data: GameData, hero: Hero, dest: Pos): Pos[] | null {
  const ctx = buildMoveContext(state, data, hero);
  return findPathInContext(ctx, hero.pos, dest);
}

export function findPathInContext(ctx: MoveContext, start: Pos, dest: Pos): Pos[] | null {
  if (!isInside(ctx, start) || !isEnterable(ctx, dest)) return null;
  const startIndex = tileIndex(ctx, start);
  const destIndex = tileIndex(ctx, dest);
  if (startIndex === destIndex) return [];

  const heuristic = (i: number): number => {
    const x = i % ctx.size;
    const y = Math.floor(i / ctx.size);
    return Math.max(Math.abs(x - dest[0]), Math.abs(y - dest[1])) * MIN_STEP_COST;
  };

  const g = new Map<number, number>([[startIndex, 0]]);
  const cameFrom = new Map<number, number>();
  const closed = new Set<number>();
  const open = new MinHeap();
  open.push({ index: startIndex, f: heuristic(startIndex) });

  while (open.size > 0) {
    const current = open.pop();
    if (!current) break;
    const i = current.index;
    if (closed.has(i)) continue;
    closed.add(i);

    if (i === destIndex) {
      const path: Pos[] = [];
      let node = i;
      while (node !== startIndex) {
        path.push([node % ctx.size, Math.floor(node / ctx.size)]);
        const prev = cameFrom.get(node);
        if (prev === undefined) throw new Error('broken A* back-pointer chain');
        node = prev;
      }
      path.reverse();
      return path;
    }

    // movement stops on trigger and enemy-hero tiles, never passing through
    if (i !== startIndex && (ctx.triggers[i] !== null || ctx.enemyHeroes[i] !== null)) continue;

    const x = i % ctx.size;
    const y = Math.floor(i / ctx.size);
    for (const [dx, dy] of NEIGHBOR_OFFSETS) {
      const next: Pos = [x + dx, y + dy];
      if (!isEnterable(ctx, next)) continue;
      const nextIndex = tileIndex(ctx, next);
      if (closed.has(nextIndex)) continue;
      const tentative = (g.get(i) ?? Infinity) + stepCost(ctx, [x, y], next);
      if (tentative < (g.get(nextIndex) ?? Infinity)) {
        g.set(nextIndex, tentative);
        cameFrom.set(nextIndex, i);
        open.push({ index: nextIndex, f: tentative + heuristic(nextIndex) });
      }
    }
  }
  return null;
}

export function pathCost(ctx: MoveContext, start: Pos, path: readonly Pos[]): number {
  let total = 0;
  let cur = start;
  for (const step of path) {
    total += stepCost(ctx, cur, step);
    cur = step;
  }
  return total;
}

export type MoveHeroCommand = Extract<Command, { type: 'moveHero' }>;

function townAt(state: GameState, pos: Pos): string | null {
  for (const town of Object.values(state.towns)) {
    if (town.pos[0] === pos[0] && town.pos[1] === pos[1]) return town.id;
  }
  return null;
}

function leaveTile(state: GameState, hero: Hero, pos: Pos): void {
  const townId = townAt(state, pos);
  if (townId === null) return;
  const town = state.towns[townId];
  if (town?.visitingHero === hero.id) {
    town.visitingHero = null;
  }
}

export function moveHero(
  state: GameState,
  command: MoveHeroCommand,
  data: GameData,
  events: GameEvent[],
): void {
  const hero = state.heroes[command.hero];
  if (!hero) {
    throw new CommandRejectedError(`unknown hero: ${command.hero}`);
  }
  if (hero.owner !== command.player) {
    throw new CommandRejectedError(`hero ${hero.id} belongs to ${hero.owner}`);
  }
  if (command.path.length === 0) {
    throw new CommandRejectedError('moveHero: empty path');
  }

  const ctx = buildMoveContext(state, data, hero);
  let prev = hero.pos;
  for (const step of command.path) {
    if (!isAdjacentStep(prev, step)) {
      throw new CommandRejectedError(
        `moveHero: step (${String(step[0])},${String(step[1])}) is not adjacent to (${String(prev[0])},${String(prev[1])})`,
      );
    }
    if (!isEnterable(ctx, step)) {
      throw new CommandRejectedError(
        `moveHero: tile (${String(step[0])},${String(step[1])}) is not passable`,
      );
    }
    prev = step;
  }

  const isTownTile = (objectId: ObjectId | null): boolean =>
    objectId !== null && state.map.objects.some((o) => o.id === objectId && o.type === 'town');

  const player = getPlayer(state, hero.owner);
  const radius = sightRadius(hero, data);
  for (const step of command.path) {
    const cost = stepCost(ctx, hero.pos, step);
    if (hero.movementPoints < cost) break;
    const stepIndex = tileIndex(ctx, step);
    const enemyId = ctx.enemyHeroes[stepIndex] ?? null;
    // an enemy hero defends the tile: fight a field battle without entering
    // it (an enemy hero visiting a town is handled by the town trigger below)
    if (enemyId !== null && !isTownTile(ctx.triggers[stepIndex] ?? null)) {
      const defender = state.heroes[enemyId];
      if (!defender) {
        throw new Error(`enemy hero ${enemyId} is missing from the map`);
      }
      hero.movementPoints -= cost;
      startFieldCombat(state, hero, defender, data, events);
      break;
    }
    hero.movementPoints -= cost;
    const from: Pos = [...hero.pos];
    leaveTile(state, hero, from);
    hero.pos = [...step];
    revealFor(state, player, hero.pos, radius);
    events.push({
      type: 'heroMoved',
      hero: hero.id,
      from,
      to: [...step],
      mpLeft: hero.movementPoints,
    });

    const triggerId = ctx.triggers[tileIndex(ctx, step)] ?? null;
    if (triggerId !== null) {
      events.push({ type: 'objectTriggered', hero: hero.id, object: triggerId });
      handleObjectTrigger(state, hero, triggerId, data, events);
      break;
    }
  }
}
