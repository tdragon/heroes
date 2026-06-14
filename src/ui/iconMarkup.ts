import { woodcutSprites } from '../assets/themes/woodcut';

// Pure string transform: take the `<category>/<id>` raw woodcut SVG and add a
// CSS class plus presentational aria attributes to its opening <svg> tag, so it
// can be inlined into the DOM and sized via CSS. No DOM access — node-env unit
// tests assert on the returned string; the actual injection is covered by e2e.
function iconMarkup(category: string, id: string, cls: string): string {
  const svg = woodcutSprites[`${category}/${id}`];
  if (svg === undefined) return '';
  return svg.replace(
    /^<svg\b/,
    `<svg class="${cls}" aria-hidden="true" focusable="false"`,
  );
}

export function resourceIconMarkup(id: string): string {
  return iconMarkup('resource', id, 'resource-icon');
}

export function buildingIconMarkup(id: string): string {
  return iconMarkup('building', id, 'building-icon');
}
