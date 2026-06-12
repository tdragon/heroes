import { buildRoadLayer, type MapSource } from './dsl';
import type { Pos } from './schema';

const SIZE = 36;
const grassRow = 'g'.repeat(SIZE);
const riverRow = 'g'.repeat(17) + 'ww' + 'g'.repeat(17);
const snowRow = 'g'.repeat(17) + 'ww' + 'g'.repeat(9) + 'n'.repeat(8);
const sandRow = 's'.repeat(6) + 'g'.repeat(11) + 'ww' + 'g'.repeat(17);

const rows = (n: number, row: string): string[] => Array.from({ length: n }, () => row);

const roadTiles: Pos[] = [];
for (let x = 4; x <= 31; x++) roadTiles.push([x, 17]);
for (let y = 6; y < 17; y++) roadTiles.push([4, y]);
for (let y = 18; y <= 29; y++) roadTiles.push([31, y]);

export const tutorialValleySource: MapSource = {
  id: 'tutorial-valley',
  name: 'Tutorial Valley',
  terrain: [
    ...rows(4, snowRow), // y 0..3: north with a snowy ridge in the east
    ...rows(13, riverRow), // y 4..16: river splits west/east
    ...rows(1, grassRow), // y 17: the single-row river crossing, guarded
    ...rows(12, riverRow), // y 18..29
    ...rows(6, sandRow), // y 30..35: sandy south-west shore
  ],
  roads: buildRoadLayer(SIZE, 'D', roadTiles),
  players: [
    { color: 'red', faction: 'castle', isHuman: true, startTownAt: [4, 5], startHero: 'edric' },
    {
      color: 'blue',
      faction: 'necropolis',
      isHuman: false,
      startTownAt: [31, 30],
      startHero: 'mortus',
    },
  ],
  objects: [
    { type: 'town', at: [4, 5], owner: 'red' },
    { type: 'town', at: [31, 30], owner: 'blue' },
    // west (red) side
    { type: 'mine', subtype: 'sawmill', at: [8, 3] },
    { type: 'mine', subtype: 'ore_pit', at: [3, 10], guard: { creature: 'wolf', count: 8 } },
    { type: 'mine', subtype: 'gold_mine', at: [12, 14], guard: { creature: 'rogue', count: 15 } },
    {
      type: 'mine',
      subtype: 'crystal_cavern',
      at: [9, 26],
      guard: { creature: 'ogre', count: 4 },
    },
    { type: 'resource', subtype: 'wood', amount: 6, at: [6, 8] },
    { type: 'resource', subtype: 'ore', amount: 6, at: [10, 6] },
    { type: 'resource', subtype: 'gold', amount: 800, at: [14, 4] },
    { type: 'treasure_chest', at: [13, 9] },
    {
      type: 'sign',
      at: [5, 8],
      message: 'Welcome to Tutorial Valley. Capture mines to grow your economy.',
    },
    { type: 'learning_stone', at: [7, 18] },
    { type: 'magic_well', at: [11, 20] },
    { type: 'dwelling', creature: 'peasant', at: [9, 22] },
    {
      type: 'artifact',
      artifact: 'iron_sword',
      at: [14, 25],
      guard: { creature: 'wolf', count: 6 },
    },
    { type: 'rally_flag', at: [15, 30] },
    { type: 'school_of_war', at: [5, 28] },
    // river crossing guard: the crossing is one row (y 17) and every path
    // through it funnels into the boar tile, so the guard actually gates it
    { type: 'monster', creature: 'boar', count: 10, at: [17, 17] },
    // east (blue) side
    { type: 'mine', subtype: 'sawmill', at: [28, 33] },
    { type: 'mine', subtype: 'ore_pit', at: [33, 25] },
    { type: 'mine', subtype: 'gold_mine', at: [24, 22], guard: { creature: 'rogue', count: 15 } },
    { type: 'resource', subtype: 'gems', amount: 4, at: [20, 28] },
    { type: 'resource', subtype: 'wood', amount: 7, at: [26, 28] },
    { type: 'resource', subtype: 'gold', amount: 700, at: [22, 32] },
    { type: 'treasure_chest', at: [25, 18] },
    { type: 'treasure_chest', at: [30, 20] },
    { type: 'windmill', at: [22, 8] },
    { type: 'water_wheel', at: [20, 12] },
    { type: 'mystical_garden', at: [29, 8] },
    { type: 'observatory', at: [32, 5] },
    { type: 'fountain_of_fortune', at: [24, 14] },
  ],
};
