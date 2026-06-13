import { RESOURCE_IDS, type Building, type Cost, type ResourceId } from '../data/schema';
import type { ArmyDest, ArmyLocation } from '../core/commands';
import { getPlayer, type ArmySlots, type Hero, type Town, type TownId } from '../core/state';
import { SPELLBOOK_COST } from '../core/magic';
import { townBuildingCatalog, HERO_HIRE_COST, SKELETON_CREATURE } from '../core/town';
import { button, el, type UiContext } from './components';
import { InfoPopup } from './hud';
import {
  buildAvailability,
  buildingHelp,
  builtStatusText,
  capitalize,
  costParts,
  costText,
  maxTrades,
  stackUpgradeOffer,
  tradeModel,
} from './helpers';
import { resourceIcon } from './icons';
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
  private readonly help: InfoPopup;
  private helpPinnedFor: HTMLElement | null = null;
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
    // the building help popup reuses the shared InfoPopup (clamped to this overlay)
    this.help = new InfoPopup(this.root, 'building-tooltip');
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) this.onClose();
      else this.hideHelp();
    });
    this.update();
  }

  private showHelp(anchor: HTMLElement, text: string): void {
    const a = anchor.getBoundingClientRect();
    const c = this.root.getBoundingClientRect();
    this.help.show(text, a.left - c.left, a.bottom - c.top + 4);
  }

  private hideHelp(): void {
    this.help.hide();
    this.helpPinnedFor = null;
  }

  // hover shows the help; a click pins it so touch users can read it too
  private wireHelp(anchor: HTMLElement, text: string): void {
    anchor.addEventListener('mouseenter', () => {
      if (this.helpPinnedFor === null) this.showHelp(anchor, text);
    });
    anchor.addEventListener('mouseleave', () => {
      if (this.helpPinnedFor === null) this.hideHelp();
    });
    anchor.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.helpPinnedFor === anchor) {
        this.hideHelp();
      } else {
        this.showHelp(anchor, text);
        this.helpPinnedFor = anchor;
      }
    });
  }

  update(): void {
    const town = this.ctx.getState().towns[this.townId];
    if (town?.owner !== this.ctx.playerId) {
      this.onClose();
      return;
    }
    this.hideHelp();
    this.panel.replaceChildren();
    const sections = [
      this.header(town),
      this.buildingGrid(town),
      this.recruitSection(town),
      this.armySection(town),
    ];
    const transformer = this.transformerSection(town);
    if (transformer) sections.push(transformer);
    sections.push(this.guildSection(town), this.tavernSection(town), this.marketSection(town));
    this.panel.append(...sections, this.status);
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
    card.type = 'button';

    const head = el('div', 'building-head');
    const name = el('div', 'building-name');
    name.textContent = building.name;
    const help = el('span', 'building-help', `building-help-${building.id}`);
    help.textContent = 'ⓘ';
    help.setAttribute('aria-label', 'Building info');
    this.wireHelp(help, buildingHelp(building, town.faction, this.ctx.data));
    head.append(name, help);
    card.appendChild(head);

    if (availability.status === 'built') {
      const info = el('div', 'building-info');
      info.textContent = builtStatusText(town, building, this.ctx.data);
      card.appendChild(info);
    } else {
      const cost = this.costRow(building.cost);
      if (cost) card.appendChild(cost);
      if (availability.status !== 'available') {
        const reason = el('div', 'building-info building-reason');
        reason.textContent = availability.reason;
        card.appendChild(reason);
      }
    }

    // the card is never `disabled` (that would also swallow help-icon hover and
    // click events); non-buildable cards simply carry no build handler
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
      card.setAttribute('aria-disabled', 'true');
      card.tabIndex = -1;
    }
    return card;
  }

  // resource icons with amounts, e.g. [🪙] 400 [🪵] 5
  private costRow(cost: Cost): HTMLElement | null {
    const parts = costParts(cost);
    if (parts.length === 0) return null;
    const row = el('div', 'building-cost');
    for (const part of parts) {
      const item = el('span', 'res-cost', `cost-${part.id}`);
      item.title = capitalize(part.id);
      const value = el('span', 'res-cost-value');
      value.textContent = String(part.amount);
      item.append(resourceIcon(part.id), value);
      row.appendChild(item);
    }
    return row;
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
    this.appendUpgradeButtons(section, town, town.garrison, 'garrison');
    const visiting =
      town.visitingHero === null ? null : this.ctx.getState().heroes[town.visitingHero];
    if (visiting?.owner === this.ctx.playerId) {
      section.appendChild(this.armyRow(visiting.army, 'visiting', visiting.name));
      this.appendUpgradeButtons(section, town, visiting.army, 'visiting');
    }
    return section;
  }

  // an "Upgrade" button per stack whose upgraded dwelling is built here
  // (spec §5.2: upgrade already-recruited creatures for the cost difference)
  private appendUpgradeButtons(
    section: HTMLElement,
    town: Town,
    slots: ArmySlots,
    row: ArmyRow,
  ): void {
    const dest: ArmyDest = row === 'garrison' ? 'garrison' : 'visitingHero';
    const list = el('div', 'upgrade-list');
    slots.forEach((stack, i) => {
      if (!stack) return;
      const offer = stackUpgradeOffer(town, stack, this.ctx.data);
      if (!offer) return;
      const baseName = this.ctx.data.creatures[stack.creature]?.name ?? stack.creature;
      list.appendChild(
        button(
          `Upgrade ${String(stack.count)} ${baseName} → ${offer.to.name} (${costText(offer.cost)})`,
          `upgrade-${row}-${String(i)}`,
          () => {
            this.run(
              this.ctx.run({
                type: 'upgradeStack',
                player: this.ctx.playerId,
                town: this.townId,
                dest,
                slot: i,
              }),
            );
            this.update();
          },
        ),
      );
    });
    if (list.childElementCount > 0) section.appendChild(list);
  }

  // Necropolis Skeleton Transformer (spec §5.3): convert a visiting hero's
  // stack into the same number of skeletons
  private transformerSection(town: Town): HTMLElement | null {
    if (!town.buildings.includes('skeleton_transformer')) return null;
    const section = el('div', 'panel-section');
    section.appendChild(this.sectionTitle('Skeleton Transformer'));
    const list = el('div', 'transformer-list', 'transformer-list');
    const visiting = this.ownVisitingHero(town);
    if (!visiting) {
      list.textContent = 'A visiting hero is required.';
    } else {
      visiting.army.forEach((stack, i) => {
        if (!stack || stack.creature === SKELETON_CREATURE) return;
        const name = this.ctx.data.creatures[stack.creature]?.name ?? stack.creature;
        list.appendChild(
          button(
            `Transform ${String(stack.count)} ${name} → Skeletons`,
            `transform-${String(i)}`,
            () => {
              this.run(
                this.ctx.run({
                  type: 'transformToSkeletons',
                  player: this.ctx.playerId,
                  town: this.townId,
                  slot: i,
                }),
              );
              this.update();
            },
          ),
        );
      });
      if (list.childElementCount === 0) list.textContent = 'No stacks to transform.';
    }
    section.appendChild(list);
    return section;
  }

  private ownVisitingHero(town: Town): Hero | null {
    const hero = town.visitingHero === null ? null : this.ctx.getState().heroes[town.visitingHero];
    return hero?.owner === this.ctx.playerId ? hero : null;
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
