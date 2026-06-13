import { describe, expect, it } from 'vitest';
import { TokenPainter } from './painter';
import { SpriteAtlas } from './spriteAtlas';
import { SpritePainter } from './spritePainter';
import { woodcutAtlas, woodcutSpritePainter } from './woodcutTheme';

// node env: never call atlas.load() here (the real rasterizer needs the DOM).
// The new behavior under test is the shared singleton, not load() memoization.
describe('woodcutTheme', () => {
  it('returns the same shared atlas instance across calls', () => {
    const first = woodcutAtlas();
    const second = woodcutAtlas();
    expect(first).toBeInstanceOf(SpriteAtlas);
    expect(second).toBe(first);
  });

  it('wraps the shared atlas in a SpritePainter with the given fallback', () => {
    const fallback = new TokenPainter();
    const painter = woodcutSpritePainter(fallback);
    expect(painter).toBeInstanceOf(SpritePainter);
  });
});
