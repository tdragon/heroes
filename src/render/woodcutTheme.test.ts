import { describe, expect, it } from 'vitest';
import { SpriteAtlas } from './spriteAtlas';
import { atlasSources, woodcutAtlas } from './woodcutTheme';

// node env: never call atlas.load() here (the real rasterizer needs the DOM).
// The behavior under test is the shared singleton, not load() memoization.
describe('woodcutTheme', () => {
  it('returns the same shared atlas instance across calls', () => {
    const first = woodcutAtlas();
    const second = woodcutAtlas();
    expect(first).toBeInstanceOf(SpriteAtlas);
    expect(second).toBe(first);
  });

  describe('atlasSources', () => {
    it('excludes DOM-only building/* sprites from the canvas atlas', () => {
      const buildingKeys = Object.keys(atlasSources).filter((key) =>
        key.startsWith('building/'),
      );
      expect(buildingKeys).toEqual([]);
    });

    it('still includes the canvas sprite categories the painter requests', () => {
      expect(atlasSources).toHaveProperty('terrain/grass');
      expect(atlasSources).toHaveProperty('creature/pikeman');
      expect(atlasSources).toHaveProperty('resource/gold');
      expect(atlasSources).toHaveProperty('object/town');
    });
  });
});
