// Fog of war: per-player explored masks (shroud = unexplored), current
// visibility circles around heroes and towns, and last-seen object snapshots
// that back the dimmed "explored but out of sight" render layer.

import type { GameData } from '../data';
import type { Pos } from '../maps/schema';
import {
  artifactBonus,
  skillValue,
  type GameState,
  type Hero,
  type MapObjectState,
  type Player,
  type SeenObject,
} from './state';

export const BASE_SIGHT_RADIUS = 5;
export const TOWN_SIGHT_RADIUS = 5;

export function sightRadius(hero: Hero, data: GameData): number {
  return (
    BASE_SIGHT_RADIUS + skillValue(hero, 'scouting', data) + artifactBonus(hero, 'sightRadius', data)
  );
}

export function revealCircle(explored: boolean[], size: number, center: Pos, radius: number): void {
  const [cx, cy] = center;
  const r2 = radius * radius;
  const minY = Math.max(0, cy - radius);
  const maxY = Math.min(size - 1, cy + radius);
  const minX = Math.max(0, cx - radius);
  const maxX = Math.min(size - 1, cx + radius);
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) {
        explored[y * size + x] = true;
      }
    }
  }
}

export function isExplored(player: Player, size: number, pos: Pos): boolean {
  return player.explored[pos[1] * size + pos[0]] ?? false;
}

function inCircle(center: Pos, radius: number, pos: Pos): boolean {
  const dx = pos[0] - center[0];
  const dy = pos[1] - center[1];
  return dx * dx + dy * dy <= radius * radius;
}

export function snapshotObject(obj: MapObjectState): SeenObject {
  const seen: SeenObject = {
    type: obj.type,
    at: [...obj.at],
    owner: obj.owner,
    removed: obj.removed,
  };
  if (obj.subtype !== undefined) seen.subtype = obj.subtype;
  return seen;
}

// reveal tiles and snapshot every object inside the circle at its current state
export function revealFor(state: GameState, player: Player, center: Pos, radius: number): void {
  revealCircle(player.explored, state.map.size, center, radius);
  for (const obj of state.map.objects) {
    if (inCircle(center, radius, obj.at)) {
      player.seenObjects[obj.id] = snapshotObject(obj);
    }
  }
}

// tiles currently in bright view: union of sight circles of own heroes and towns
export function visibleTiles(state: GameState, player: Player, data: GameData): boolean[] {
  const size = state.map.size;
  const visible = Array.from({ length: size * size }, () => false);
  for (const heroId of player.heroes) {
    const hero = state.heroes[heroId];
    if (!hero) continue;
    revealCircle(visible, size, hero.pos, sightRadius(hero, data));
  }
  for (const townId of player.towns) {
    const town = state.towns[townId];
    if (!town) continue;
    revealCircle(visible, size, town.pos, TOWN_SIGHT_RADIUS);
  }
  return visible;
}

export function isVisible(visible: boolean[], size: number, pos: Pos): boolean {
  return visible[pos[1] * size + pos[0]] ?? false;
}
