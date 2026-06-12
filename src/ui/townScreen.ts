import { RESOURCE_IDS, type Building, type ResourceId } from '../data/schema';
import type { ArmyDest, ArmyLocation } from '../core/commands';
import { getPlayer, type ArmySlots, type Town, type TownId } from '../core/state';
import { SPELLBOOK_COST } from '../core/magic';
import { townBuildingCatalog, HERO_HIRE_COST } from '../core/town';
import { button, el, type UiContext } from './components';
import { buildAvailability, costText, maxTrades, tradeModel } from './helpers';
import { openRecruitDialog } from './recruitDialog';

type ArmyRow = 'garrison' | 'visiting';

interface SlotPick {
  row: ArmyRow;
  slot: number;
}

// Town screen overlay (spec §5.4): building grid with lock reasons, recruit
// dialogs, garrison/visiting army rows with click-click swap, mage guild
// viewer, tavern hiring, and marketplace trading.
export class TownScreen {
  readonly root: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly status: HTMLElement;
  private selected: SlotPick | null = null;
  private tradeGive: ResourceId = 'wood';
  private tradeReceive: ResourceId = 'gold';

  constructor(
    private readonly ctx: UiContext,
    private readonly townId: TownId,
    private readonly onClose: () => void,
  ) {
    this.root = el('div', 'panel-overlay', 'town-screen');
    this.panel = el('div', 'panel town-panel');
    this.status = el('div', 'panel-status', 'town-status');
    this.root.appendChild(this.panel);
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) this.onClose();
    });
    this.update();
  }

  update(): void {
    const town = this.ctx.getState().towns[this.townId];
    if (town?.owner !== this.ctx.playerId) {
      this.onClose();
      return;
    }
    this.panel.replaceChildren();
    this.panel.append(
      this.header(town),
      this.buildingGrid(town),
      this.recruitSection(town),
      this.armySection(town),
      this.guildSection(town),
      this.tavernSection(town),
      this.marketSection(town),
      this.status,
    );
  }

  private run(commandError: string | null): void {
    this.status.textContent = commandError ?? '';
  }

  private header(town: Town): HTMLElement {
    const header = el('div', 'panel-header');
    const name = el('div', 'panel-title', 'town-name');
    name.textContent = `${town.name} (${town.faction})`;
    header.append(name, button('Close', 'town-close', this.onClose));
    return header;
  }

  private buildingGrid(town: Town): HTMLElement {
    const section = el('div', 'panel-section');
    section.appendChild(this.sectionTitle('Buildings'));
    const grid = el('div', 'building-grid', 'building-grid');
    for (const building of townBuildingCatalog(town.faction, this.ctx.data).values()) {
      grid.appendChild(this.buildingCard(town, building));
    }
    section.appendChild(grid);
    return section;
  }

  private buildingCard(town: Town, building: Building): HTMLElement {
    const state = this.ctx.getState();
    const availability = buildAvailability(state, town, building, this.ctx.data);
    const card = el('button', `building-card ${availability.status}`, `building-${building.id}`);
    const name = el('div', 'building-name');
    name.textContent = building.name;
    const info = el('div', 'building-info');
    if (availability.status === 'built') {
      info.textContent = 'Built';
    } else if (availability.status === 'available') {
      info.textContent = costText(building.cost);
    } else {
      info.textContent = availability.reason;
      card.title = availability.reason;
    }
    card.append(name, info);
    if (availability.status === 'available') {
      card.addEventListener('click', () => {
        this.run(
          this.ctx.run({
            type: 'build',
            player: this.ctx.playerId,
            town: this.townId,
            building: building.id,
          }),
        );
      });
    } else {
      card.disabled = availability.status !== 'unaffordable';
    }
    return card;
  }

  private recruitSection(town: Town): HTMLElement {
    const section = el('div', 'panel-section');
    section.appendChild(this.sectionTitle('Recruit'));
    const list = el('div', 'recruit-list', 'recruit-list');
    const catalog = townBuildingCatalog(town.faction, this.ctx.data);
    const recruitable = new Set<string>();
    for (const id of town.buildings) {
      const creature = catalog.get(id)?.creature;
      if (creature !== undefined) recruitable.add(creature);
    }
    for (const creatureId of recruitable) {
      const creature = this.ctx.data.creatures[creatureId];
      if (!creature) continue;
      const pool = town.availableCreatures[creatureId] ?? 0;
      const row = el('div', 'recruit-row');
      const label = el('span', 'recruit-label', `recruit-pool-${creatureId}`);
      label.textContent = `${creature.name} — ${String(pool)} available`;
      row.appendChild(label);
      row.appendChild(
        button('Recruit', `recruit-${creatureId}`, () => {
          this.openRecruit(creatureId);
        }),
      );
      list.appendChild(row);
    }
    if (recruitable.size === 0) {
      list.textContent = 'No dwellings built yet.';
    }
    section.appendChild(list);
    return section;
  }

  private openRecruit(creatureId: string): void {
    const town = this.ctx.getState().towns[this.townId];
    const dest: ArmyDest = 'garrison';
    if (!town) return;
    openRecruitDialog(this.root, this.ctx, this.townId, creatureId, dest, (error) => {
      this.run(error);
    });
  }

  private armySection(town: Town): HTMLElement {
    const section = el('div', 'panel-section');
    section.appendChild(this.sectionTitle('Garrison and visiting hero'));
    section.appendChild(this.armyRow(town.garrison, 'garrison', 'Garrison'));
    const visiting =
      town.visitingHero === null ? null : this.ctx.getState().heroes[town.visitingHero];
    if (visiting?.owner === this.ctx.playerId) {
      section.appendChild(this.armyRow(visiting.army, 'visiting', visiting.name));
    }
    return section;
  }

  private armyRow(slots: ArmySlots, row: ArmyRow, label: string): HTMLElement {
    const wrap = el('div', 'army-row-wrap');
    const caption = el('span', 'army-row-label');
    caption.textContent = label;
    wrap.appendChild(caption);
    const rowEl = el('div', 'army-row');
    slots.forEach((stack, i) => {
      const cell = el('button', 'army-slot', `${row}-slot-${String(i)}`);
      if (stack) {
        const creature = this.ctx.data.creatures[stack.creature];
        cell.textContent = `${String(stack.count)} ${creature?.name ?? stack.creature}`;
      } else {
        cell.textContent = '—';
      }
      if (this.selected?.row === row && this.selected.slot === i) {
        cell.classList.add('selected');
      }
      cell.addEventListener('click', () => {
        this.slotClicked(row, i);
      });
      rowEl.appendChild(cell);
    });
    wrap.appendChild(rowEl);
    return wrap;
  }

  private location(row: ArmyRow): ArmyLocation | null {
    if (row === 'garrison') return { kind: 'garrison', town: this.townId };
    const visiting = this.ctx.getState().towns[this.townId]?.visitingHero;
    if (visiting === null || visiting === undefined) return null;
    return { kind: 'hero', hero: visiting };
  }

  private slotClicked(row: ArmyRow, slot: number): void {
    const state = this.ctx.getState();
    const town = state.towns[this.townId];
    if (!town) return;
    const slots = row === 'garrison' ? town.garrison : this.visitingArmy(town);
    if (!this.selected) {
      if (slots?.[slot]) {
        this.selected = { row, slot };
        this.update();
      }
      return;
    }
    const from = this.location(this.selected.row);
    const to = this.location(row);
    const picked = this.selected;
    this.selected = null;
    if (!from || !to || (picked.row === row && picked.slot === slot)) {
      this.update();
      return;
    }
    this.run(
      this.ctx.run({
        type: 'moveStack',
        player: this.ctx.playerId,
        from,
        fromSlot: picked.slot,
        to,
        toSlot: slot,
      }),
    );
    this.update();
  }

  private visitingArmy(town: Town): ArmySlots | null {
    const hero = town.visitingHero === null ? null : this.ctx.getState().heroes[town.visitingHero];
    return hero?.owner === this.ctx.playerId ? hero.army : null;
  }

  private guildSection(town: Town): HTMLElement {
    const section = el('div', 'panel-section');
    section.appendChild(this.sectionTitle('Mage guild'));
    // might-class visiting heroes can buy a spellbook here (spec §6)
    const visiting =
      town.visitingHero === null ? null : this.ctx.getState().heroes[town.visitingHero];
    if (
      visiting?.owner === this.ctx.playerId &&
      !visiting.hasSpellbook &&
      town.buildings.includes('mage_guild_1')
    ) {
      const row = el('div', 'recruit-row');
      const label = el('span', 'recruit-label');
      label.textContent = `${visiting.name} has no spellbook — ${String(SPELLBOOK_COST)} gold`;
      row.append(
        label,
        button('Buy Spellbook', 'buy-spellbook', () => {
          this.run(
            this.ctx.run({
              type: 'buySpellbook',
              player: this.ctx.playerId,
              hero: visiting.id,
              town: this.townId,
            }),
          );
          this.update();
        }),
      );
      section.appendChild(row);
    }
    const list = el('div', 'guild-spells', 'guild-spells');
    if (town.guildSpells.length === 0) {
      list.textContent = 'No spells taught here.';
    } else {
      const spells = [...town.guildSpells]
        .map((id) => this.ctx.data.spells[id])
        .filter((spell) => spell !== undefined)
        .sort((a, b) => a.level - b.level);
      for (const spell of spells) {
        const entry = el('div', 'guild-spell');
        entry.textContent = `L${String(spell.level)} ${spell.name} (${spell.school}, ${String(spell.manaCost)} mana)`;
        list.appendChild(entry);
      }
    }
    section.appendChild(list);
    return section;
  }

  private tavernSection(town: Town): HTMLElement {
    const section = el('div', 'panel-section');
    section.appendChild(this.sectionTitle('Tavern'));
    const list = el('div', 'tavern-list', 'tavern-list');
    if (!town.buildings.includes('tavern')) {
      list.textContent = 'No tavern built.';
    } else if (town.tavernHeroes.length === 0) {
      list.textContent = 'No heroes for hire this week.';
    } else {
      for (const templateId of town.tavernHeroes) {
        const template = this.ctx.data.heroes[templateId];
        if (!template) continue;
        const row = el('div', 'recruit-row');
        const label = el('span', 'recruit-label');
        label.textContent = `${template.name} (${template.class}) — ${String(HERO_HIRE_COST)} gold`;
        row.append(
          label,
          button('Hire', `tavern-hire-${templateId}`, () => {
            this.run(
              this.ctx.run({
                type: 'hireHero',
                player: this.ctx.playerId,
                town: this.townId,
                hero: templateId,
              }),
            );
          }),
        );
        list.appendChild(row);
      }
    }
    section.appendChild(list);
    return section;
  }

  private marketSection(town: Town): HTMLElement {
    const section = el('div', 'panel-section');
    section.appendChild(this.sectionTitle('Marketplace'));
    if (!town.buildings.includes('marketplace')) {
      const note = el('div', 'market-note', 'market-note');
      note.textContent = 'No marketplace built.';
      section.appendChild(note);
      return section;
    }
    const state = this.ctx.getState();
    const player = getPlayer(state, this.ctx.playerId);
    const markets = Object.values(state.towns).filter(
      (t) => t.owner === this.ctx.playerId && t.buildings.includes('marketplace'),
    ).length;

    const give = this.resourceSelect('trade-give', this.tradeGive, (value) => {
      this.tradeGive = value;
      this.update();
    });
    const receive = this.resourceSelect('trade-receive', this.tradeReceive, (value) => {
      this.tradeReceive = value;
      this.update();
    });

    const row = el('div', 'trade-row');
    const preview = el('span', 'trade-preview', 'trade-preview');
    const arrow = el('span', 'trade-arrow');
    arrow.textContent = '→';
    row.append(give, arrow, receive, preview);

    if (this.tradeGive === this.tradeReceive) {
      preview.textContent = 'pick two different resources';
      section.append(row);
      return section;
    }
    const model = tradeModel(this.tradeGive, this.tradeReceive, markets);
    const affordable = maxTrades(model, player.resources[this.tradeGive]);
    preview.textContent = `${String(model.giveStep)} ${this.tradeGive} → ${String(model.receiveStep)} ${this.tradeReceive}`;
    row.appendChild(
      button('Trade 1 unit', 'trade-confirm', () => {
        this.run(
          this.ctx.run({
            type: 'trade',
            player: this.ctx.playerId,
            give: this.tradeGive,
            receive: this.tradeReceive,
            amount: model.giveStep,
          }),
        );
      }),
    );
    const limit = el('span', 'trade-limit', 'trade-limit');
    limit.textContent = `(${String(affordable)} affordable)`;
    row.appendChild(limit);
    section.append(row);
    return section;
  }

  private resourceSelect(
    testId: string,
    value: ResourceId,
    onChange: (value: ResourceId) => void,
  ): HTMLSelectElement {
    const select = el('select', 'trade-select', testId);
    for (const id of RESOURCE_IDS) {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = id;
      option.selected = id === value;
      select.appendChild(option);
    }
    select.addEventListener('change', () => {
      const picked = RESOURCE_IDS.find((id) => id === select.value);
      if (picked !== undefined) onChange(picked);
    });
    return select;
  }

  private sectionTitle(text: string): HTMLElement {
    const title = el('div', 'section-title');
    title.textContent = text;
    return title;
  }
}
