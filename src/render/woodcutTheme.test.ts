import { describe, expect, it } from 'vitest';
import { SpriteAtlas } from './spriteAtlas';
import { woodcutAtlas } from './woodcutTheme';

// node env: never call atlas.load() here (the real rasterizer needs the DOM).
// The behavior under test is the shared singleton, not load() memoization.
describe('woodcutTheme', () => {
  it('returns the same shared atlas instance across calls', () => {
    const first = woodcutAtlas();
    const second = woodcutAtlas();
    expect(first).toBeInstanceOf(SpriteAtlas);
    expect(second).toBe(first);
  });
});
