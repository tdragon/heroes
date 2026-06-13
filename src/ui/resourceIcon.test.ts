import { describe, expect, it } from 'vitest';
import { RESOURCE_IDS } from '../data/schema';
import { buildingIconMarkup, resourceIconMarkup } from './resourceIcon';

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
  for (const id of ['tavern', 'castle_dwelling_1']) {
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
