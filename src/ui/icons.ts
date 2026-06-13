import { woodcutSprites } from '../assets/themes/woodcut';
import type { ResourceId } from '../data/schema';

// Render the woodcut resource emblem (raw theme SVG) as an inline DOM node,
// sized for use inside cost rows and resource readouts.
export function resourceIcon(id: ResourceId, size = 16): Element {
  const svgText = woodcutSprites[`resource/${id}`];
  const doc = new DOMParser().parseFromString(svgText ?? '<svg/>', 'image/svg+xml');
  const svg = document.importNode(doc.documentElement, true);
  svg.setAttribute('class', `res-svg res-icon-${id}`);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', id);
  return svg;
}
