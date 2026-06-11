import type { GameData } from '../data';
import { skillValue, type CreatureStack, type Hero } from './state';

export const BASE_MOVEMENT_POINTS = 1500;

export function maxMovementPoints(hero: Hero, data: GameData): number {
  const speeds = hero.army
    .filter((stack): stack is CreatureStack => stack !== null)
    .map((stack) => {
      const creature = data.creatures[stack.creature];
      if (!creature) {
        throw new Error(`unknown creature: ${stack.creature}`);
      }
      return creature.speed;
    });
  const slowest = speeds.length > 0 ? Math.min(...speeds) : 0;
  const logistics = skillValue(hero, 'logistics', data);
  return Math.floor((BASE_MOVEMENT_POINTS + 50 * slowest) * (1 + logistics / 100));
}
