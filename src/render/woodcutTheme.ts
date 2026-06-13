import { woodcutSprites } from '../assets/themes/woodcut';
import type { Painter } from './painter';
import { rasterizeSvg, SpriteAtlas } from './spriteAtlas';
import { SpritePainter } from './spritePainter';

// One shared atlas: rasterized bitmaps survive screen re-creation (new game,
// load game) instead of being redone and abandoned on every screen, and the
// adventure and combat screens reuse the same bitmaps (no second
// rasterization, no cross-screen import).
let sharedAtlas: SpriteAtlas | null = null;

export function woodcutAtlas(): SpriteAtlas {
  sharedAtlas ??= new SpriteAtlas(woodcutSprites, rasterizeSvg);
  return sharedAtlas;
}

export function woodcutSpritePainter(fallback: Painter): SpritePainter {
  return new SpritePainter(woodcutAtlas(), fallback);
}
