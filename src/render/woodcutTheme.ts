import { woodcutSprites } from '../assets/themes/woodcut';
import { rasterizeSvg, SpriteAtlas } from './spriteAtlas';

// One shared atlas: rasterized bitmaps survive screen re-creation (new game,
// load game) instead of being redone and abandoned on every screen, and the
// adventure and combat screens reuse the same bitmaps (no second
// rasterization, no cross-screen import). Each screen wraps it in its own
// `SpritePainter(woodcutAtlas(), new TokenPainter())`.
let sharedAtlas: SpriteAtlas | null = null;

export function woodcutAtlas(): SpriteAtlas {
  sharedAtlas ??= new SpriteAtlas(woodcutSprites, rasterizeSvg);
  return sharedAtlas;
}
