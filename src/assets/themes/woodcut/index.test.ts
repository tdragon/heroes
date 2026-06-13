import { describe, expect, it } from 'vitest';
import { loadGameData } from '../../../data';
import { woodcutSprites } from './index';

const data = loadGameData();

describe('woodcut theme coverage', () => {
  it('has a sprite for every terrain id in GameData', () => {
    const terrainIds = Object.keys(data.terrains);
    expect(terrainIds.length).toBeGreaterThan(0);
    for (const id of terrainIds) {
      expect(woodcutSprites, `missing sprite terrain/${id}`).toHaveProperty(`terrain/${id}`);
    }
  });

  it('has a road and a rounded end-tile sprite for every road id in GameData', () => {
    const roadIds = Object.keys(data.roads);
    expect(roadIds.length).toBeGreaterThan(0);
    for (const id of roadIds) {
      expect(woodcutSprites, `missing sprite road/${id}`).toHaveProperty(`road/${id}`);
      expect(woodcutSprites, `missing sprite roadend/${id}`).toHaveProperty(`roadend/${id}`);
    }
  });

  it('contains no sprite keys outside terrain/, road/ and roadend/', () => {
    for (const key of Object.keys(woodcutSprites)) {
      expect(key).toMatch(/^(terrain|road|roadend)\/[a-z][a-z0-9_]*$/);
    }
  });
});

describe('woodcut sprite sanity (string-based, node env)', () => {
  const entries = Object.entries(woodcutSprites);

  it('loaded at least the 11 phase-1 sprites', () => {
    expect(entries.length).toBeGreaterThanOrEqual(11);
  });

  it.each(entries)('%s is a standalone 64x64 SVG without classes', (_key, svg) => {
    const trimmed = svg.trim();
    expect(trimmed.startsWith('<svg')).toBe(true);
    expect(trimmed.endsWith('</svg>')).toBe(true);
    expect(trimmed).toContain('viewBox="0 0 64 64"');
    expect(trimmed).not.toContain('class=');
  });
});
