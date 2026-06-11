// e2e fixture: a cleric with a spellbook next to a small wolf pack, used by
// the combat-screen Playwright tests (spell casting and battle controls).

import type { MapSource } from '../dsl';

const SIZE = 12;
const grass = 'g'.repeat(SIZE);

export const combatArenaSource: MapSource = {
  id: 'combat-arena',
  name: 'Combat Arena',
  terrain: Array.from({ length: SIZE }, () => grass),
  players: [
    { color: 'red', faction: 'castle', isHuman: true, startTownAt: [2, 2], startHero: 'beatrice' },
    {
      color: 'blue',
      faction: 'necropolis',
      isHuman: false,
      startTownAt: [9, 9],
      startHero: 'mortus',
    },
  ],
  objects: [
    { type: 'town', at: [2, 2], owner: 'red' },
    { type: 'town', at: [9, 9], owner: 'blue' },
    { type: 'monster', creature: 'wolf', count: 4, at: [5, 2] },
  ],
};
