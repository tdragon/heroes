import { woodcutSprites } from '../assets/themes/woodcut';

// Pure string transform: take the `resource/<id>` raw woodcut SVG and add a CSS
// class plus presentational aria attributes to its opening <svg> tag, so it can
// be inlined into a DOM resource cell and sized via CSS. No DOM access — the
// node-env unit tests assert on the returned string; the actual injection is
// covered by e2e.
export function resourceIconMarkup(id: string): string {
  const svg = woodcutSprites[`resource/${id}`];
  if (svg === undefined) return '';
  return svg.replace(
    /^<svg\b/,
    '<svg class="resource-icon" aria-hidden="true" focusable="false"',
  );
}

// Same pure-string transform for `building/<id>` sprites, sized via the
// `.building-icon` CSS rule. The building card keeps its name text, so the icon
// is purely decorative (aria-hidden); injected via innerHTML on the card.
export function buildingIconMarkup(id: string): string {
  const svg = woodcutSprites[`building/${id}`];
  if (svg === undefined) return '';
  return svg.replace(
    /^<svg\b/,
    '<svg class="building-icon" aria-hidden="true" focusable="false"',
  );
}
