import type { MapSource } from './dsl';

const SIZE = 48;
const grassRow = 'g'.repeat(SIZE);
const roughRow = 'g'.repeat(20) + 'r'.repeat(9) + 'g'.repeat(19);
const riverRow = 'w'.repeat(11) + 'g' + 'w'.repeat(23) + 'g' + 'w'.repeat(12);
const swampRow = 'g'.repeat(20) + 'S'.repeat(8) + 'g'.repeat(20);

const rows = (n: number, row: string): string[] => Array.from({ length: n }, () => row);

export const contestedRiverSource: MapSource = {
  id: 'contested-river',
  name: 'Contested River',
  terrain: [
    ...rows(8, grassRow), // y 0..7: north plains
    ...rows(5, roughRow), // y 8..12: rough highlands
    ...rows(9, grassRow), // y 13..21
    ...rows(4, riverRow), // y 22..25: river, fords at x=11 and x=35
    ...rows(14, grassRow), // y 26..39: south plains
    ...rows(6, swampRow), // y 40..45: swamp in the south middle
    ...rows(2, grassRow), // y 46..47
  ],
  players: [
    { color: 'red', faction: 'castle', isHuman: true, startTownAt: [8, 40], startHero: 'marcus' },
    {
      color: 'blue',
      faction: 'rampart',
      isHuman: false,
      startTownAt: [40, 40],
      startHero: 'faelan',
    },
    {
      color: 'tan',
      faction: 'necropolis',
      isHuman: false,
      startTownAt: [24, 8],
      startHero: 'ravenna',
    },
  ],
  objects: [
    { type: 'town', at: [8, 40], owner: 'red' },
    { type: 'town', at: [40, 40], owner: 'blue' },
    { type: 'town', at: [24, 8], owner: 'tan' },
    // river fords are chokepoints guarded by monsters
    { type: 'monster', creature: 'troll', count: 8, at: [11, 23] },
    { type: 'monster', creature: 'ogre', count: 10, at: [35, 24] },
    // monolith pair bypasses the fords
    { type: 'monolith', pairId: 'river-gate', at: [4, 30] },
    { type: 'monolith', pairId: 'river-gate', at: [4, 16] },
    // red economy
    { type: 'mine', subtype: 'sawmill', at: [13, 38] },
    { type: 'mine', subtype: 'ore_pit', at: [4, 35] },
    // blue economy
    { type: 'mine', subtype: 'sawmill', at: [44, 36] },
    { type: 'mine', subtype: 'ore_pit', at: [42, 30] },
    // tan economy
    { type: 'mine', subtype: 'sawmill', at: [30, 5] },
    { type: 'mine', subtype: 'ore_pit', at: [18, 4] },
    // contested mines
    {
      type: 'mine',
      subtype: 'gold_mine',
      at: [24, 30],
      guard: { creature: 'gargantuan', count: 3 },
    },
    { type: 'mine', subtype: 'gold_mine', at: [24, 16], guard: { creature: 'troll', count: 10 } },
    {
      type: 'mine',
      subtype: 'crystal_cavern',
      at: [38, 8],
      guard: { creature: 'wolf', count: 12 },
    },
    { type: 'mine', subtype: 'gem_pond', at: [8, 8], guard: { creature: 'boar', count: 12 } },
    { type: 'mine', subtype: 'sulfur_dune', at: [44, 14], guard: { creature: 'rogue', count: 10 } },
    { type: 'mine', subtype: 'alchemist_lab', at: [3, 20], guard: { creature: 'rogue', count: 8 } },
    // resources
    { type: 'resource', subtype: 'wood', amount: 8, at: [10, 34] },
    { type: 'resource', subtype: 'ore', amount: 8, at: [38, 34] },
    { type: 'resource', subtype: 'gold', amount: 900, at: [22, 36] },
    { type: 'resource', subtype: 'gold', amount: 1000, at: [26, 12] },
    { type: 'resource', subtype: 'gems', amount: 5, at: [30, 14] },
    { type: 'resource', subtype: 'mercury', amount: 4, at: [6, 12] },
    { type: 'resource', subtype: 'crystal', amount: 4, at: [42, 20] },
    { type: 'resource', subtype: 'sulfur', amount: 4, at: [16, 30] },
    // chests and artifacts
    { type: 'treasure_chest', at: [14, 30] },
    { type: 'treasure_chest', at: [34, 32] },
    { type: 'treasure_chest', at: [20, 10] },
    { type: 'treasure_chest', at: [40, 18] },
    {
      type: 'artifact',
      artifact: 'travelers_boots',
      at: [28, 36],
      guard: { creature: 'wolf', count: 10 },
    },
    {
      type: 'artifact',
      artifact: 'mystic_orb',
      at: [12, 14],
      guard: { creature: 'boar', count: 8 },
    },
    // visitables and specials
    { type: 'prison', hero: 'gareth', at: [44, 44] },
    { type: 'learning_stone', at: [18, 42] },
    { type: 'school_of_war', at: [36, 42] },
    { type: 'magic_well', at: [10, 26] },
    { type: 'magic_well', at: [38, 26] },
    { type: 'water_wheel', at: [14, 26] },
    { type: 'windmill', at: [30, 28] },
    { type: 'mystical_garden', at: [44, 6] },
    { type: 'observatory', at: [24, 20] },
    { type: 'fountain_of_fortune', at: [6, 44] },
    { type: 'rally_flag', at: [32, 44] },
    { type: 'sign', at: [8, 38], message: 'The river crossings are guarded. Seek the monoliths.' },
    { type: 'dwelling', creature: 'wolf', at: [16, 18] },
    { type: 'dwelling', creature: 'rogue', at: [32, 38] },
  ],
};
