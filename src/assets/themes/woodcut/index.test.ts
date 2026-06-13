import { describe, expect, it } from 'vitest';
import { loadGameData } from '../../../data';
import { RESOURCE_IDS } from '../../../data/schema';
import { woodcutSprites } from './index';

const data = loadGameData();

describe('woodcut theme coverage', () => {
  it('has a sprite for every terrain id in GameData', () => {
    const terrainIds = Object.keys(data.terrains);
    expect(terrainIds.length).toBeGreaterThan(0);
    for (const id of terrainIds) {
      expect(woodcutSprites, `missing sprite terrain/${id}`).toHaveProperty(`terrain/${id}`);
    }
  });

  it('has a road and a rounded end-tile sprite for every road id in GameData', () => {
    const roadIds = Object.keys(data.roads);
    expect(roadIds.length).toBeGreaterThan(0);
    for (const id of roadIds) {
      expect(woodcutSprites, `missing sprite road/${id}`).toHaveProperty(`road/${id}`);
      expect(woodcutSprites, `missing sprite roadend/${id}`).toHaveProperty(`roadend/${id}`);
    }
  });

  it('has a sprite for every creature id in GameData', () => {
    const creatureIds = Object.keys(data.creatures);
    expect(creatureIds.length).toBeGreaterThan(0);
    for (const id of creatureIds) {
      expect(woodcutSprites, `missing sprite creature/${id}`).toHaveProperty(`creature/${id}`);
    }
  });

  it('has the horseman hero marker', () => {
    expect(woodcutSprites).toHaveProperty('hero/horseman');
  });

  it('has a sprite for every resource id', () => {
    expect(RESOURCE_IDS.length).toBeGreaterThan(0);
    for (const id of RESOURCE_IDS) {
      expect(woodcutSprites, `missing sprite resource/${id}`).toHaveProperty(`resource/${id}`);
    }
  });

  it('has a sprite for every object type id except monster', () => {
    const objectTypeIds = Object.keys(data.objectTypes);
    expect(objectTypeIds.length).toBeGreaterThan(0);
    for (const type of objectTypeIds) {
      if (type === 'monster') continue;
      expect(woodcutSprites, `missing sprite object/${type}`).toHaveProperty(`object/${type}`);
    }
  });

  it('maps every object/* key to a real GameData object type id', () => {
    const objectKeys = Object.keys(woodcutSprites).filter((k) => k.startsWith('object/'));
    expect(objectKeys.length).toBeGreaterThan(0);
    for (const key of objectKeys) {
      const id = key.slice('object/'.length);
      expect(data.objectTypes, `object sprite for unknown id ${id}`).toHaveProperty(id);
    }
  });

  it('maps every creature/* key to a real GameData creature id', () => {
    const creatureKeys = Object.keys(woodcutSprites).filter((k) => k.startsWith('creature/'));
    expect(creatureKeys.length).toBeGreaterThan(0);
    for (const key of creatureKeys) {
      const id = key.slice('creature/'.length);
      expect(data.creatures, `creature sprite for unknown id ${id}`).toHaveProperty(id);
    }
  });

  it('maps every resource/* key to a real RESOURCE_ID', () => {
    const resourceKeys = Object.keys(woodcutSprites).filter((k) => k.startsWith('resource/'));
    expect(resourceKeys.length).toBeGreaterThan(0);
    const ids = new Set<string>(RESOURCE_IDS);
    for (const key of resourceKeys) {
      const id = key.slice('resource/'.length);
      expect(ids.has(id), `resource sprite for unknown id ${id}`).toBe(true);
    }
  });

  it('contains only valid sprite keys', () => {
    for (const key of Object.keys(woodcutSprites)) {
      expect(key).toMatch(/^(terrain|road|roadend|creature|hero|resource|object)\/[a-z][a-z0-9_]*$/);
    }
  });
});

describe('woodcut sprite key-format spot checks', () => {
  it.each(['hero/horseman', 'creature/wood_elf', 'creature/gold_dragon', 'creature/bone_dragon'])(
    '%s matches the key-format regex',
    (key) => {
      expect(key).toMatch(
        /^(terrain|road|roadend|creature|hero|resource|object)\/[a-z][a-z0-9_]*$/,
      );
    },
  );
});

describe('woodcut sprite sanity (string-based, node env)', () => {
  const entries = Object.entries(woodcutSprites);

  it('loaded at least the 11 phase-1 sprites', () => {
    expect(entries.length).toBeGreaterThanOrEqual(11);
  });

  it.each(entries)('%s is a standalone 64x64 SVG without classes', (_key, svg) => {
    const trimmed = svg.trim();
    expect(trimmed.startsWith('<svg')).toBe(true);
    expect(trimmed.endsWith('</svg>')).toBe(true);
    expect(trimmed).toContain('viewBox="0 0 64 64"');
    expect(trimmed).not.toContain('class=');
  });

  // node env has no DOMParser, so this is a dependency-free, stack-based
  // well-formedness scan: every opening tag must be matched by a close in the
  // right order, every attribute value must be quote-balanced, and the stack
  // must end empty. It is not a full XML validator (it assumes no comments /
  // CDATA / processing instructions, which these authored sprites never use)
  // but it catches the failures a surface string check misses: an unclosed
  // <g>, a stray </rect>, mismatched nesting, or a dropped attribute quote.
  // The e2e data-sprites-ready gate remains the real rasterization safety net.
  it.each(entries)('%s parses as well-formed tag-balanced XML', (_key, svg) => {
    expect(checkWellFormed(svg.trim())).toBeNull();
  });
});

// Returns null when the markup is tag-balanced, otherwise a description of the
// first defect. Tokenizes on `<...>` (attribute values here never contain `>`)
// and walks a tag stack; self-closing tags are never pushed.
function checkWellFormed(svg: string): string | null {
  const tagRe = /<(\/?)([a-zA-Z][\w:.-]*)([^>]*?)(\/?)>/g;
  const stack: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(svg)) !== null) {
    // any text between the previous tag and this one must not contain a '<'
    // (a '<' there means a malformed/unterminated tag)
    if (svg.slice(lastIndex, match.index).includes('<')) {
      return `stray '<' before ${match[0]}`;
    }
    lastIndex = tagRe.lastIndex;
    const [whole, closing, name, attrs, selfClose] = match;
    // every attribute value must have balanced double quotes
    if (((attrs ?? '').match(/"/g)?.length ?? 0) % 2 !== 0) {
      return `unbalanced quote in ${whole}`;
    }
    if (closing === '/') {
      const top = stack.pop();
      if (top !== name) return `</${name ?? ''}> closes <${top ?? '∅'}>`;
    } else if (selfClose !== '/') {
      stack.push(name ?? '');
    }
  }
  if (svg.slice(lastIndex).includes('<')) return 'trailing unterminated tag';
  if (stack.length > 0) return `unclosed <${stack.join('>, <')}>`;
  return null;
}
