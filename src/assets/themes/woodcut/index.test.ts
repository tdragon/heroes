import { describe, expect, it } from 'vitest';
import { loadGameData } from '../../../data';
import { RESOURCE_IDS } from '../../../data/schema';
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

  it('has a sprite for every creature id in GameData', () => {
    const creatureIds = Object.keys(data.creatures);
    expect(creatureIds.length).toBeGreaterThan(0);
    for (const id of creatureIds) {
      expect(woodcutSprites, `missing sprite creature/${id}`).toHaveProperty(`creature/${id}`);
    }
  });

  it('has the horseman hero marker', () => {
    expect(woodcutSprites).toHaveProperty('hero/horseman');
  });

  it('has a sprite for every resource id', () => {
    expect(RESOURCE_IDS.length).toBeGreaterThan(0);
    for (const id of RESOURCE_IDS) {
      expect(woodcutSprites, `missing sprite resource/${id}`).toHaveProperty(`resource/${id}`);
    }
  });

  it('has a sprite for the 6 core object types', () => {
    const coreObjectTypes = ['town', 'mine', 'dwelling', 'resource', 'treasure_chest', 'artifact'];
    for (const type of coreObjectTypes) {
      expect(woodcutSprites, `missing sprite object/${type}`).toHaveProperty(`object/${type}`);
    }
  });

  it('maps every creature/* key to a real GameData creature id', () => {
    const creatureKeys = Object.keys(woodcutSprites).filter((k) => k.startsWith('creature/'));
    expect(creatureKeys.length).toBeGreaterThan(0);
    for (const key of creatureKeys) {
      const id = key.slice('creature/'.length);
      expect(data.creatures, `creature sprite for unknown id ${id}`).toHaveProperty(id);
    }
  });

  it('contains only valid sprite keys', () => {
    for (const key of Object.keys(woodcutSprites)) {
      expect(key).toMatch(/^(terrain|road|roadend|creature|hero|resource|object)\/[a-z][a-z0-9_]*$/);
    }
  });
});

describe('woodcut sprite key-format spot checks', () => {
  it.each(['hero/horseman', 'creature/wood_elf', 'creature/gold_dragon', 'creature/bone_dragon'])(
    '%s matches the key-format regex',
    (key) => {
      expect(key).toMatch(
        /^(terrain|road|roadend|creature|hero|resource|object)\/[a-z][a-z0-9_]*$/,
      );
    },
  );
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
