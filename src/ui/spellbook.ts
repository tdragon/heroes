// Combat spellbook overlay: lists the hero's combat spells with mana costs and
// school-tier descriptions, filterable by school and level. Picking a castable
// spell hands it back to the combat screen, which runs the targeting.

import type { GameData } from '../data';
import type { Spell, SpellSchool } from '../data/schema';
import { schoolTier, spellCost } from '../core/magic';
import { heroInfoFor, type CombatSideId, type CombatState } from '../core/combat/state';
import { el } from './components';

export type TargetNeed = 'none' | 'stack' | 'hex';

export interface SpellbookEntry {
  spell: Spell;
  cost: number;
  tier: number;
  description: string;
  need: TargetNeed;
  castable: boolean;
  reason: string | null;
}

export function targetNeed(spell: Spell, mass: boolean): TargetNeed {
  if (spell.target === 'battlefield') return 'none';
  if (spell.target === 'area') return 'hex';
  return mass ? 'none' : 'stack';
}

export function spellbookEntries(
  combat: CombatState,
  side: CombatSideId,
  data: GameData,
): SpellbookEntry[] {
  const hero = heroInfoFor(combat, side);
  const entries: SpellbookEntry[] = [];
  for (const id of hero.spells) {
    const spell = data.spells[id];
    if (!spell || spell.kind === 'adventure') continue;
    const tier = schoolTier(hero, spell);
    const tierData = spell.tiers[tier];
    const cost = spellCost(combat, side, spell, data);
    let reason: string | null = null;
    if (combat.castThisRound[side]) {
      reason = 'already cast this round';
    } else if (hero.mana < cost) {
      reason = 'not enough mana';
    }
    entries.push({
      spell,
      cost,
      tier,
      description: tierData?.description ?? '',
      need: targetNeed(spell, tierData?.mass ?? false),
      castable: reason === null,
      reason,
    });
  }
  entries.sort((a, b) => a.spell.level - b.spell.level || a.spell.name.localeCompare(b.spell.name));
  return entries;
}

const SCHOOL_OPTIONS: readonly (SpellSchool | 'any')[] = ['any', 'air', 'earth', 'fire', 'water'];

export class SpellbookOverlay {
  readonly root: HTMLElement;
  private school: SpellSchool | 'any' = 'any';
  private level = 0; // 0 = all levels
  private readonly list: HTMLElement;

  constructor(
    private readonly entries: SpellbookEntry[],
    private readonly onPick: (entry: SpellbookEntry) => void,
    onClose: () => void,
  ) {
    this.root = el('div', 'spellbook-overlay', 'spellbook-overlay');
    const box = el('div', 'spellbook-box');

    const header = el('div', 'panel-header');
    const title = el('div', 'panel-title');
    title.textContent = 'Spellbook';
    const close = el('button', 'ui-button', 'spellbook-close');
    close.textContent = 'Close';
    close.addEventListener('click', onClose);
    header.append(title, close);

    const filters = el('div', 'spellbook-filters');
    const schoolSelect = el('select', 'trade-select', 'spell-filter-school');
    for (const school of SCHOOL_OPTIONS) {
      const option = document.createElement('option');
      option.value = school;
      option.textContent = school === 'any' ? 'All schools' : school;
      schoolSelect.appendChild(option);
    }
    schoolSelect.addEventListener('change', () => {
      const value = schoolSelect.value;
      this.school = SCHOOL_OPTIONS.find((s) => s === value) ?? 'any';
      this.renderList();
    });
    const levelSelect = el('select', 'trade-select', 'spell-filter-level');
    for (let level = 0; level <= 5; level++) {
      const option = document.createElement('option');
      option.value = String(level);
      option.textContent = level === 0 ? 'All levels' : `Level ${String(level)}`;
      levelSelect.appendChild(option);
    }
    levelSelect.addEventListener('change', () => {
      this.level = Number(levelSelect.value);
      this.renderList();
    });
    filters.append(schoolSelect, levelSelect);

    this.list = el('div', 'spellbook-list', 'spellbook-list');
    box.append(header, filters, this.list);
    this.root.appendChild(box);
    this.renderList();
  }

  private renderList(): void {
    this.list.replaceChildren();
    const shown = this.entries.filter(
      (entry) =>
        (this.school === 'any' ||
          entry.spell.school === this.school ||
          entry.spell.school === 'all') &&
        (this.level === 0 || entry.spell.level === this.level),
    );
    if (shown.length === 0) {
      const empty = el('div', 'spellbook-empty', 'spellbook-empty');
      empty.textContent = 'No spells match';
      this.list.appendChild(empty);
      return;
    }
    for (const entry of shown) {
      const row = el('div', 'spellbook-row', `spell-row-${entry.spell.id}`);
      const info = el('div', 'spellbook-info');
      const name = el('div', 'spellbook-name');
      name.textContent = `${entry.spell.name} (L${String(entry.spell.level)} ${entry.spell.school}, ${String(entry.cost)} mana)`;
      const desc = el('div', 'spellbook-desc');
      desc.textContent = entry.reason ?? entry.description;
      info.append(name, desc);
      const cast = el('button', 'ui-button', `spell-cast-${entry.spell.id}`);
      cast.textContent = 'Cast';
      cast.disabled = !entry.castable;
      cast.addEventListener('click', () => {
        this.onPick(entry);
      });
      row.append(info, cast);
      this.list.appendChild(row);
    }
  }
}
