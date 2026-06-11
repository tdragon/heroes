import { describe, expect, it } from 'vitest';
import { loadGameData } from '../data';
import { compileMap } from './dsl';
import { tinyMapSource } from './fixtures/tiny.dsl';
import { getMap, loadMaps } from './index';
import { GameMapSchema } from './schema';

const data = loadGameData();

describe('tiny fixture map', () => {
  const map = compileMap(tinyMapSource, data);

  it('matches the snapshot', () => {
    expect(map).toMatchSnapshot();
  });

  it('has the expected layout basics', () => {
    expect(map.size).toBe(12);
    expect(map.terrain).toHaveLength(144);
    expect(map.roads).toHaveLength(144);
    expect(map.terrain[5 * 12]).toBe('w');
    expect(map.terrain[4 * 12 + 4]).toBe('d');
    expect(map.roads[4 * 12 + 4]).toBe('D');
    expect(map.victory).toEqual({ type: 'defeatAll' });
    expect(map.loss).toEqual({ type: 'loseAll' });
  });

  it('contains a hero+town per player, a guarded mine, a guard, and resources', () => {
    expect(map.players).toHaveLength(2);
    expect(map.players.filter((p) => p.isHuman)).toHaveLength(1);
    expect(map.objects.filter((o) => o.type === 'town')).toHaveLength(2);
    const mine = map.objects.find((o) => o.type === 'mine');
    expect(mine?.subtype).toBe('sawmill');
    expect(mine?.guard).toEqual({ creature: 'wolf', count: 4 });
    expect(map.objects.filter((o) => o.type === 'resource')).toHaveLength(2);
    expect(map.objects.some((o) => o.type === 'monster')).toBe(true);
  });
});

describe('map registry', () => {
  it('compiles tutorial-valley as a 36x36 two-player map', () => {
    const map = getMap('tutorial-valley');
    expect(map.size).toBe(36);
    expect(map.players).toHaveLength(2);
    expect(map.players[0]?.startHero).toBe('edric');
    expect(map.players[0]?.startTownAt).toEqual([4, 5]);
  });

  it('compiles contested-river as a 48x48 three-player map', () => {
    const map = getMap('contested-river');
    expect(map.size).toBe(48);
    expect(map.players).toHaveLength(3);
    expect(new Set(map.players.map((p) => p.faction)).size).toBe(3);
  });

  it('contested-river has chokepoint guards and a monolith pair', () => {
    const map = getMap('contested-river');
    const monoliths = map.objects.filter((o) => o.type === 'monolith');
    expect(monoliths).toHaveLength(2);
    expect(new Set(monoliths.map((o) => o.pairId)).size).toBe(1);
    expect(map.objects.filter((o) => o.type === 'monster').length).toBeGreaterThanOrEqual(2);
  });

  it('every registry map validates against the map schema', () => {
    const maps = loadMaps();
    expect(maps.map((m) => m.id)).toEqual(['tutorial-valley', 'contested-river']);
    for (const map of [...maps, compileMap(tinyMapSource, data)]) {
      const result = GameMapSchema.safeParse(map);
      expect(result.success, map.id).toBe(true);
    }
  });

  it('throws for an unknown map id', () => {
    expect(() => getMap('atlantis')).toThrow('unknown map: atlantis');
  });
});
