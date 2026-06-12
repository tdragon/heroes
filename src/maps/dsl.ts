import type { GameData } from '../data';
import { RESOURCE_IDS, type Terrain } from '../data/schema';
import {
  GameMapSchema,
  NO_ROAD_CHAR,
  type GameMap,
  type LossCondition,
  type MapObject,
  type MapPlayer,
  type Pos,
  type VictoryCondition,
} from './schema';

export interface MapSource {
  id: string;
  name: string;
  terrain: readonly string[];
  roads?: readonly string[];
  players: readonly MapPlayer[];
  objects: readonly MapObject[];
  victory?: VictoryCondition;
  loss?: LossCondition;
}

export class MapCompileError extends Error {
  readonly problems: readonly string[];

  constructor(mapId: string, problems: readonly string[]) {
    super(`map '${mapId}' failed to compile:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'MapCompileError';
    this.problems = problems;
  }
}

const n = String;
const at = (x: number, y: number): string => `(${n(x)},${n(y)})`;

const TOWN_OFFSETS: readonly (readonly [number, number])[] = [
  [0, 0],
  [-1, 0],
  [1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
];
const SINGLE_OFFSET: readonly (readonly [number, number])[] = [[0, 0]];

export function objectFootprint(type: string, pos: Pos): Pos[] {
  const offsets = type === 'town' ? TOWN_OFFSETS : SINGLE_OFFSET;
  return offsets.map(([dx, dy]): Pos => [pos[0] + dx, pos[1] + dy]);
}

export function buildRoadLayer(size: number, roadChar: string, tiles: readonly Pos[]): string[] {
  const rows = Array.from({ length: size }, () => Array.from({ length: size }, () => NO_ROAD_CHAR));
  for (const [x, y] of tiles) {
    const row = rows[y];
    if (!row || x < 0 || x >= size) {
      throw new Error(`road tile ${at(x, y)} is out of bounds for map size ${n(size)}`);
    }
    row[x] = roadChar;
  }
  return rows.map((r) => r.join(''));
}

function validateTerrainLayer(
  source: MapSource,
  size: number,
  terrainByChar: ReadonlyMap<string, Terrain>,
  problems: string[],
): void {
  source.terrain.forEach((row, y) => {
    if (row.length !== size) {
      problems.push(`terrain row ${n(y)}: expected ${n(size)} chars, got ${n(row.length)}`);
      return;
    }
    for (let x = 0; x < row.length; x++) {
      const ch = row[x] ?? '';
      if (!terrainByChar.has(ch)) {
        problems.push(`terrain row ${n(y)} col ${n(x)}: unknown terrain char '${ch}'`);
      }
    }
  });
}

function validateRoadLayer(
  roadRows: readonly string[],
  size: number,
  roadChars: ReadonlySet<string>,
  terrainAt: (pos: Pos) => Terrain | undefined,
  problems: string[],
): void {
  if (roadRows.length !== size) {
    problems.push(`road layer: expected ${n(size)} rows, got ${n(roadRows.length)}`);
    return;
  }
  roadRows.forEach((row, y) => {
    if (row.length !== size) {
      problems.push(`road row ${n(y)}: expected ${n(size)} chars, got ${n(row.length)}`);
      return;
    }
    for (let x = 0; x < row.length; x++) {
      const ch = row[x] ?? '';
      if (ch === NO_ROAD_CHAR) continue;
      if (!roadChars.has(ch)) {
        problems.push(`road row ${n(y)} col ${n(x)}: unknown road char '${ch}'`);
        continue;
      }
      const terrain = terrainAt([x, y]);
      if (terrain?.moveCost === null) {
        problems.push(`road row ${n(y)} col ${n(x)}: road on impassable terrain '${terrain.id}'`);
      }
    }
  });
}

function validateObjectFields(
  obj: MapObject,
  label: string,
  data: GameData,
  problems: string[],
): void {
  switch (obj.type) {
    case 'mine': {
      const subtypes = data.objectTypes[obj.type]?.subtypes ?? [];
      if (obj.subtype === undefined) {
        problems.push(`${label}: mine requires a subtype`);
      } else if (!subtypes.some((s) => s.id === obj.subtype)) {
        problems.push(`${label}: unknown mine subtype '${obj.subtype}'`);
      }
      break;
    }
    case 'resource':
      if (obj.subtype === undefined) {
        problems.push(`${label}: resource requires a subtype`);
      } else if (!(RESOURCE_IDS as readonly string[]).includes(obj.subtype)) {
        problems.push(`${label}: unknown resource subtype '${obj.subtype}'`);
      }
      break;
    case 'monster':
      if (obj.creature === undefined) {
        problems.push(`${label}: monster requires a creature`);
      } else if (!(obj.creature in data.creatures)) {
        problems.push(`${label}: unknown creature '${obj.creature}'`);
      }
      if (obj.count === undefined) {
        problems.push(`${label}: monster requires a count`);
      }
      break;
    case 'dwelling':
      if (obj.creature === undefined) {
        problems.push(`${label}: dwelling requires a creature`);
      } else if (!(obj.creature in data.creatures)) {
        problems.push(`${label}: unknown creature '${obj.creature}'`);
      }
      break;
    case 'artifact':
      if (obj.artifact === undefined) {
        problems.push(`${label}: artifact object requires an artifact id`);
      } else if (!(obj.artifact in data.artifacts)) {
        problems.push(`${label}: unknown artifact '${obj.artifact}'`);
      }
      break;
    case 'sign':
      if (obj.message === undefined) {
        problems.push(`${label}: sign requires a message`);
      }
      break;
    case 'monolith':
      if (obj.pairId === undefined) {
        problems.push(`${label}: monolith requires a pairId`);
      }
      break;
    case 'prison':
      if (obj.hero === undefined) {
        problems.push(`${label}: prison requires a hero`);
      } else if (!(obj.hero in data.heroes)) {
        problems.push(`${label}: unknown hero '${obj.hero}'`);
      }
      break;
    default:
      break;
  }
  if (obj.guard && !(obj.guard.creature in data.creatures)) {
    problems.push(`${label}: unknown guard creature '${obj.guard.creature}'`);
  }
}

function validateObjects(
  source: MapSource,
  size: number,
  data: GameData,
  terrainAt: (pos: Pos) => Terrain | undefined,
  problems: string[],
): void {
  const occupied = new Map<string, string>();
  source.objects.forEach((obj, i) => {
    const label = `objects[${n(i)}] (${obj.type} at ${n(obj.at[0])},${n(obj.at[1])})`;
    if (!(obj.type in data.objectTypes)) {
      problems.push(`${label}: unknown object type '${obj.type}'`);
      return;
    }
    for (const tile of objectFootprint(obj.type, obj.at)) {
      const [x, y] = tile;
      if (x < 0 || y < 0 || x >= size || y >= size) {
        problems.push(`${label}: footprint tile ${at(x, y)} is out of bounds`);
        continue;
      }
      const terrain = terrainAt(tile);
      if (terrain?.moveCost === null) {
        problems.push(`${label}: footprint tile ${at(x, y)} is on impassable '${terrain.id}'`);
      }
      const key = `${n(x)},${n(y)}`;
      const prev = occupied.get(key);
      if (prev !== undefined) {
        problems.push(`${label}: footprint overlaps ${prev} at ${at(x, y)}`);
      }
      occupied.set(key, label);
    }
    validateObjectFields(obj, label, data, problems);
  });

  const pairCounts = new Map<string, number>();
  for (const obj of source.objects) {
    if (obj.type === 'monolith' && obj.pairId !== undefined) {
      pairCounts.set(obj.pairId, (pairCounts.get(obj.pairId) ?? 0) + 1);
    }
  }
  for (const [pairId, count] of pairCounts) {
    if (count !== 2) {
      problems.push(`monolith pair '${pairId}': expected exactly 2 monoliths, found ${n(count)}`);
    }
  }
}

function validatePlayers(source: MapSource, data: GameData, problems: string[]): void {
  const seenColors = new Set<string>();
  const startHeroes = new Set<string>();
  source.players.forEach((player, i) => {
    const label = `players[${n(i)}] (${player.color})`;
    if (seenColors.has(player.color)) {
      problems.push(`${label}: duplicate player color`);
    }
    seenColors.add(player.color);

    const heroTemplate = data.heroes[player.startHero];
    if (!heroTemplate) {
      problems.push(`${label}: unknown start hero '${player.startHero}'`);
    } else {
      if (startHeroes.has(player.startHero)) {
        problems.push(`${label}: start hero '${player.startHero}' is already taken`);
      }
      startHeroes.add(player.startHero);
      const heroClass = data.heroClasses[heroTemplate.class];
      if (heroClass && heroClass.faction !== player.faction) {
        problems.push(
          `${label}: start hero '${player.startHero}' belongs to ${heroClass.faction}, player faction is ${player.faction}`,
        );
      }
    }

    const [tx, ty] = player.startTownAt;
    const town = source.objects.find((o) => o.type === 'town' && o.at[0] === tx && o.at[1] === ty);
    if (!town) {
      problems.push(`${label}: no town object at startTownAt ${at(tx, ty)}`);
    } else if (town.owner !== player.color) {
      problems.push(`${label}: town at ${at(tx, ty)} is not owned by ${player.color}`);
    }
  });

  source.objects.forEach((obj, i) => {
    if (
      obj.type === 'town' &&
      obj.owner !== undefined &&
      !source.players.some((p) => p.color === obj.owner)
    ) {
      problems.push(`objects[${n(i)}]: town owner '${obj.owner}' is not a player color`);
    }
    if (obj.type === 'prison' && obj.hero !== undefined && startHeroes.has(obj.hero)) {
      problems.push(`objects[${n(i)}]: prison hero '${obj.hero}' is already a player's start hero`);
    }
  });
}

export function compileMap(source: MapSource, data: GameData): GameMap {
  const size = source.terrain.length;
  if (size < 8 || size > 96) {
    throw new MapCompileError(source.id, [`map size ${n(size)} is out of range 8..96`]);
  }

  const problems: string[] = [];
  const terrainByChar = new Map(Object.values(data.terrains).map((t) => [t.char, t]));
  const roadChars = new Set(Object.values(data.roads).map((r) => r.char));
  const terrainAt = ([x, y]: Pos): Terrain | undefined => {
    const ch = source.terrain[y]?.[x];
    return ch === undefined ? undefined : terrainByChar.get(ch);
  };

  validateTerrainLayer(source, size, terrainByChar, problems);
  const roadRows: readonly string[] =
    source.roads ?? Array.from({ length: size }, () => NO_ROAD_CHAR.repeat(size));
  validateRoadLayer(roadRows, size, roadChars, terrainAt, problems);
  validateObjects(source, size, data, terrainAt, problems);
  validatePlayers(source, data, problems);

  if (problems.length > 0) {
    throw new MapCompileError(source.id, problems);
  }

  return GameMapSchema.parse({
    id: source.id,
    name: source.name,
    size,
    players: source.players,
    terrain: source.terrain.join(''),
    roads: roadRows.join(''),
    objects: source.objects,
    victory: source.victory ?? { type: 'defeatAll' },
    loss: source.loss ?? { type: 'loseAll' },
  });
}
