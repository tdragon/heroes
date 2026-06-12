import { describe, expect, it } from 'vitest';
import { loadGameData } from '../data';
import {
  buildRoadLayer,
  compileMap,
  MapCompileError,
  objectFootprint,
  type MapSource,
} from './dsl';
import type { MapObject, Pos } from './schema';

const data = loadGameData();

function baseSource(): MapSource {
  return {
    id: 'test-map',
    name: 'Test Map',
    terrain: [
      'wwwggggggggg',
      'gggggggggggg',
      'gggggggggggg',
      'gggggggggggg',
      'gggggggggggg',
      'gggggggggggg',
      'gggggggggggg',
      'gggggggggggg',
      'gggggggggggg',
      'gggggggggggg',
      'gggggggggggg',
      'gggggggggggg',
    ],
    players: [
      { color: 'red', faction: 'castle', isHuman: true, startTownAt: [2, 3], startHero: 'edric' },
      {
        color: 'blue',
        faction: 'necropolis',
        isHuman: false,
        startTownAt: [9, 9],
        startHero: 'mortus',
      },
    ],
    objects: [
      { type: 'town', at: [2, 3], owner: 'red' },
      { type: 'town', at: [9, 9], owner: 'blue' },
    ],
  };
}

function withObjects(extra: MapObject[]): MapSource {
  const base = baseSource();
  return { ...base, objects: [...base.objects, ...extra] };
}

function compileProblems(source: MapSource): string[] {
  try {
    compileMap(source, data);
    return [];
  } catch (error) {
    if (error instanceof MapCompileError) return [...error.problems];
    throw error;
  }
}

describe('compileMap', () => {
  it('compiles a minimal valid map with defaults', () => {
    const map = compileMap(baseSource(), data);
    expect(map.size).toBe(12);
    expect(map.terrain).toHaveLength(144);
    expect(map.roads).toBe('.'.repeat(144));
    expect(map.victory).toEqual({ type: 'defeatAll' });
    expect(map.loss).toEqual({ type: 'loseAll' });
  });

  it('rejects an out-of-range map size', () => {
    const source = { ...baseSource(), terrain: ['ggg', 'ggg', 'ggg'] };
    expect(() => compileMap(source, data)).toThrow(/size 3 is out of range/);
  });

  it('reports unknown terrain chars with row and col', () => {
    const base = baseSource();
    const terrain = base.terrain.map((row, y) =>
      y === 5 ? row.slice(0, 7) + 'x' + row.slice(8) : row,
    );
    const problems = compileProblems({ ...base, terrain });
    expect(problems).toContain("terrain row 5 col 7: unknown terrain char 'x'");
  });

  it('reports a ragged terrain grid with the bad row', () => {
    const base = baseSource();
    const terrain = base.terrain.map((row, y) => (y === 4 ? row.slice(0, 11) : row));
    const problems = compileProblems({ ...base, terrain });
    expect(problems).toContain('terrain row 4: expected 12 chars, got 11');
  });

  it('reports road layer problems: row count, ragged row, unknown char, road on water', () => {
    const base = baseSource();
    expect(compileProblems({ ...base, roads: ['............'] })).toContain(
      'road layer: expected 12 rows, got 1',
    );

    const roads = buildRoadLayer(12, 'D', [[5, 5]]);
    expect(compileMap({ ...base, roads }, data).roads[5 * 12 + 5]).toBe('D');

    const ragged = roads.map((row, y) => (y === 2 ? row.slice(0, 5) : row));
    expect(compileProblems({ ...base, roads: ragged })).toContain(
      'road row 2: expected 12 chars, got 5',
    );

    const badChar = roads.map((row, y) => (y === 6 ? 'Z' + row.slice(1) : row));
    expect(compileProblems({ ...base, roads: badChar })).toContain(
      "road row 6 col 0: unknown road char 'Z'",
    );

    const onWater = buildRoadLayer(12, 'D', [[0, 0]]);
    expect(compileProblems({ ...base, roads: onWater })).toContain(
      "road row 0 col 0: road on impassable terrain 'water'",
    );
  });

  it('rejects objects out of bounds, including partial town footprints', () => {
    const monster: MapObject = { type: 'monster', creature: 'wolf', count: 3, at: [12, 5] };
    expect(compileProblems(withObjects([monster]))).toContain(
      'objects[2] (monster at 12,5): footprint tile (12,5) is out of bounds',
    );

    const town: MapObject = { type: 'town', at: [0, 0] };
    const problems = compileProblems(withObjects([town]));
    expect(problems.some((p) => p.includes('footprint tile (-1,-1) is out of bounds'))).toBe(true);
  });

  it('rejects overlapping object footprints', () => {
    const chest: MapObject = { type: 'treasure_chest', at: [1, 2] };
    const problems = compileProblems(withObjects([chest]));
    expect(
      problems.some((p) => p.includes('footprint overlaps objects[0] (town at 2,3) at (1,2)')),
    ).toBe(true);
  });

  it('rejects objects placed on impassable terrain', () => {
    const chest: MapObject = { type: 'treasure_chest', at: [1, 0] };
    expect(compileProblems(withObjects([chest]))).toContain(
      "objects[2] (treasure_chest at 1,0): footprint tile (1,0) is on impassable 'water'",
    );
  });

  it('rejects unknown object types', () => {
    const bad: MapObject = { type: 'volcano', at: [5, 5] };
    expect(compileProblems(withObjects([bad]))).toContain(
      "objects[2] (volcano at 5,5): unknown object type 'volcano'",
    );
  });

  it('validates per-type required fields and references', () => {
    const cases: [MapObject, string][] = [
      [{ type: 'mine', at: [5, 5] }, 'mine requires a subtype'],
      [{ type: 'mine', subtype: 'diamond_pit', at: [5, 5] }, "unknown mine subtype 'diamond_pit'"],
      [{ type: 'resource', at: [5, 5] }, 'resource requires a subtype'],
      [{ type: 'resource', subtype: 'oil', at: [5, 5] }, "unknown resource subtype 'oil'"],
      [{ type: 'monster', count: 5, at: [5, 5] }, 'monster requires a creature'],
      [{ type: 'monster', creature: 'wolf', at: [5, 5] }, 'monster requires a count'],
      [{ type: 'monster', creature: 'dodo', count: 5, at: [5, 5] }, "unknown creature 'dodo'"],
      [{ type: 'dwelling', at: [5, 5] }, 'dwelling requires a creature'],
      [{ type: 'artifact', at: [5, 5] }, 'artifact object requires an artifact id'],
      [{ type: 'artifact', artifact: 'excalibur', at: [5, 5] }, "unknown artifact 'excalibur'"],
      [{ type: 'sign', at: [5, 5] }, 'sign requires a message'],
      [{ type: 'monolith', at: [5, 5] }, 'monolith requires a pairId'],
      [{ type: 'prison', at: [5, 5] }, 'prison requires a hero'],
      [{ type: 'prison', hero: 'merlin', at: [5, 5] }, "unknown hero 'merlin'"],
      [
        { type: 'treasure_chest', at: [5, 5], guard: { creature: 'gryphon', count: 2 } },
        "unknown guard creature 'gryphon'",
      ],
    ];
    for (const [obj, expected] of cases) {
      const problems = compileProblems(withObjects([obj]));
      expect(
        problems.some((p) => p.includes(expected)),
        expected,
      ).toBe(true);
    }
  });

  it('rejects unpaired monoliths', () => {
    const one: MapObject = { type: 'monolith', pairId: 'gate', at: [5, 5] };
    expect(compileProblems(withObjects([one]))).toContain(
      "monolith pair 'gate': expected exactly 2 monoliths, found 1",
    );

    const three = withObjects([
      { type: 'monolith', pairId: 'gate', at: [5, 5] },
      { type: 'monolith', pairId: 'gate', at: [6, 5] },
      { type: 'monolith', pairId: 'gate', at: [7, 5] },
    ]);
    expect(compileProblems(three)).toContain(
      "monolith pair 'gate': expected exactly 2 monoliths, found 3",
    );

    const paired = withObjects([
      { type: 'monolith', pairId: 'gate', at: [5, 5] },
      { type: 'monolith', pairId: 'gate', at: [6, 5] },
    ]);
    expect(compileProblems(paired)).toEqual([]);
  });

  it('validates players: unknown hero, faction mismatch, duplicates, missing start town', () => {
    const base = baseSource();
    const [red, blue] = base.players;
    if (!red || !blue) throw new Error('fixture missing');

    expect(
      compileProblems({ ...base, players: [{ ...red, startHero: 'merlin' }, blue] }),
    ).toContain("players[0] (red): unknown start hero 'merlin'");

    expect(
      compileProblems({ ...base, players: [{ ...red, startHero: 'mortus' }, blue] }).join('\n'),
    ).toContain("start hero 'mortus' belongs to necropolis, player faction is castle");

    const dupHero = compileProblems({
      ...base,
      players: [red, { ...blue, faction: 'castle', startHero: 'edric' }],
    });
    expect(dupHero).toContain("players[1] (blue): start hero 'edric' is already taken");

    const dupColor = compileProblems({ ...base, players: [red, { ...blue, color: 'red' }] });
    expect(dupColor.some((p) => p.includes('duplicate player color'))).toBe(true);

    const noTown = compileProblems({ ...base, players: [{ ...red, startTownAt: [7, 7] }, blue] });
    expect(noTown).toContain('players[0] (red): no town object at startTownAt (7,7)');
  });

  it('rejects a start town owned by another player and an unknown town owner', () => {
    const base = baseSource();
    const objects: MapObject[] = [
      { type: 'town', at: [2, 3], owner: 'blue' },
      { type: 'town', at: [9, 9], owner: 'blue' },
    ];
    const problems = compileProblems({ ...base, objects });
    expect(problems).toContain('players[0] (red): town at (2,3) is not owned by red');

    const stray = withObjects([{ type: 'town', at: [6, 6], owner: 'green' }]);
    expect(compileProblems(stray)).toContain(
      "objects[2]: town owner 'green' is not a player color",
    );
  });

  it("rejects a prison holding a player's start hero", () => {
    const prison: MapObject = { type: 'prison', hero: 'edric', at: [5, 5] };
    expect(compileProblems(withObjects([prison]))).toContain(
      "objects[2]: prison hero 'edric' is already a player's start hero",
    );
  });

  it('aggregates multiple problems into one error', () => {
    const base = baseSource();
    const terrain = base.terrain.map((row, y) => (y === 1 ? 'x' + row.slice(1) : row));
    const source = withObjects([{ type: 'sign', at: [5, 5] }]);
    const problems = compileProblems({ ...source, terrain });
    expect(problems.length).toBeGreaterThanOrEqual(2);
  });

  it('puts all problems into the error message', () => {
    const bad = withObjects([{ type: 'sign', at: [5, 5] }]);
    expect(() => compileMap(bad, data)).toThrow(/sign requires a message/);
  });
});

describe('objectFootprint', () => {
  it('towns occupy a 3x2 block with the trigger at bottom-center', () => {
    const tiles = objectFootprint('town', [5, 5]);
    expect(tiles).toHaveLength(6);
    expect(tiles).toContainEqual([5, 5]);
    expect(tiles).toContainEqual([4, 4]);
    expect(tiles).toContainEqual([6, 5]);
  });

  it('other objects occupy a single tile', () => {
    expect(objectFootprint('mine', [3, 7])).toEqual([[3, 7]]);
  });
});

describe('buildRoadLayer', () => {
  it('builds rows with road chars at the given tiles', () => {
    const rows = buildRoadLayer(4, 'D', [
      [0, 0],
      [1, 0],
      [3, 3],
    ]);
    expect(rows).toEqual(['DD..', '....', '....', '...D']);
  });

  it('throws on out-of-bounds tiles', () => {
    expect(() => buildRoadLayer(4, 'D', [[4, 0] as Pos])).toThrow(/out of bounds/);
    expect(() => buildRoadLayer(4, 'D', [[0, 9] as Pos])).toThrow(/out of bounds/);
  });
});
