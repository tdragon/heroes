import { woodcutSprites } from '../assets/themes/woodcut';
import { rasterizeSvg, SpriteAtlas } from './spriteAtlas';

// Sprite categories that exist only in the DOM and must never enter the canvas
// atlas. `building/*` icons are injected as town-card innerHTML via
// buildingIconMarkup; no SpritePainter ever requests them. Rasterizing them
// would be pure preload waste and would couple the atlas's failure state
// (data-sprites-ready='failed') to unrelated town UI art. Resource icons are
// dual-use (canvas mine/pile pips + DOM HUD), so they stay in the atlas.
const DOM_ONLY_PREFIXES = ['building/'] as const;

// Atlas source: woodcutSprites minus the DOM-only categories. woodcutSprites
// itself stays whole for the DOM helpers (buildingIconMarkup et al.).
export const atlasSources: Record<string, string> = Object.fromEntries(
  Object.entries(woodcutSprites).filter(
    ([key]) => !DOM_ONLY_PREFIXES.some((prefix) => key.startsWith(prefix)),
  ),
);

// One shared atlas: rasterized bitmaps survive screen re-creation (new game,
// load game) instead of being redone and abandoned on every screen, and the
// adventure and combat screens reuse the same bitmaps (no second
// rasterization, no cross-screen import). Each screen wraps it in its own
// `SpritePainter(woodcutAtlas(), new TokenPainter())`.
let sharedAtlas: SpriteAtlas | null = null;

export function woodcutAtlas(): SpriteAtlas {
  sharedAtlas ??= new SpriteAtlas(atlasSources, rasterizeSvg);
  return sharedAtlas;
}
