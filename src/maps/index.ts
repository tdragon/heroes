import { loadGameData } from '../data';
import { contestedRiverSource } from './contested-river.dsl';
import { compileMap } from './dsl';
import type { GameMap } from './schema';
import { tutorialValleySource } from './tutorial-valley.dsl';

const sources = [tutorialValleySource, contestedRiverSource];

let cache: Map<string, GameMap> | null = null;

function compileAll(): Map<string, GameMap> {
  if (!cache) {
    const data = loadGameData();
    cache = new Map(
      sources.map((source) => {
        const map = compileMap(source, data);
        return [map.id, map];
      }),
    );
  }
  return cache;
}

export function loadMaps(): GameMap[] {
  return [...compileAll().values()];
}

export function getMap(id: string): GameMap {
  const map = compileAll().get(id);
  if (!map) {
    throw new Error(`unknown map: ${id}`);
  }
  return map;
}
