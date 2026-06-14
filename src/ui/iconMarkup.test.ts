import { describe, expect, it } from 'vitest';
import { woodcutSprites } from '../assets/themes/woodcut';
import { loadGameData } from '../data';
import { RESOURCE_IDS } from '../data/schema';
import { townBuildingCatalog } from '../core/town';
import { buildingIconMarkup, resourceIconMarkup } from './iconMarkup';

const data = loadGameData();

// Every building id reachable on a town screen, across all faction catalogs
// (shared structures + dwellings + specials). De-duped so each markup case
// runs once even when factions share a shared-building id.
const ALL_BUILDING_IDS = [
  ...new Set(
    Object.values(data.factions).flatMap((faction) => [
      ...townBuildingCatalog(faction.id, data).keys(),
    ]),
  ),
];

describe('resourceIconMarkup', () => {
  for (const id of RESOURCE_IDS) {
    it(`returns icon markup for ${id}`, () => {
      const markup = resourceIconMarkup(id);
      expect(markup).not.toBe('');
      expect(markup).toContain('<svg');
      expect(markup).toContain('</svg>');
      expect(markup).toContain('class="resource-icon"');
      expect(markup).toContain('aria-hidden="true"');
    });
  }

  it('returns an empty string for an unknown resource id', () => {
    expect(resourceIconMarkup('not-a-resource')).toBe('');
  });
});

describe('buildingIconMarkup', () => {
  it('drives every building id in every faction catalog', () => {
    expect(ALL_BUILDING_IDS.length).toBeGreaterThan(0);
  });

  for (const id of ALL_BUILDING_IDS) {
    it(`returns icon markup for ${id}`, () => {
      const markup = buildingIconMarkup(id);
      expect(markup).not.toBe('');
      expect(markup).toContain('<svg');
      expect(markup).toContain('</svg>');
      expect(markup).toContain('class="building-icon"');
      expect(markup).toContain('aria-hidden="true"');
    });
  }

  it('returns an empty string for an unknown building id', () => {
    expect(buildingIconMarkup('not-a-building')).toBe('');
  });
});

// The markup helpers anchor class injection with `/^<svg\b/` on the raw,
// untrimmed sprite text — a leading newline or XML prolog would silently yield
// class-less markup. Guard that anchor assumption at byte 0 (the sanity test in
// the woodcut suite only checks the trimmed string, which would not catch it).
describe('raw sprite <svg anchor', () => {
  const iconKeys = Object.keys(woodcutSprites).filter(
    (k) => k.startsWith('building/') || k.startsWith('resource/'),
  );

  it('covers every building and resource sprite', () => {
    expect(iconKeys.length).toBeGreaterThan(0);
  });

  for (const key of iconKeys) {
    it(`${key} raw SVG starts with <svg at byte 0`, () => {
      expect(woodcutSprites[key]?.startsWith('<svg')).toBe(true);
    });
  }
});
