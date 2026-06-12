import { ARTIFACT_SLOTS } from '../data/schema';
import { ARTIFACT_SLOT_CAPACITY, effectiveStats } from '../core/hero';
import { maxMana, type Hero, type HeroId } from '../core/state';
import { button, el, openCountDialog, type UiContext } from './components';
import { capitalize, xpProgressText } from './helpers';

interface SlotPick {
  hero: HeroId;
  slot: number;
}

// Hero screen overlay: stats, skills, army (click-click move with split
// dialog), artifact paper-doll and backpack. With a second hero it becomes
// the two-hero exchange screen — army and artifact transfers across columns.
export class HeroScreen {
  readonly root: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly status: HTMLElement;
  private selected: SlotPick | null = null;
  // confirm gate: the first Dismiss click arms the button, the second fires
  private confirmingDismiss: HeroId | null = null;

  constructor(
    private readonly ctx: UiContext,
    private readonly heroId: HeroId,
    private readonly secondHeroId: HeroId | null,
    private readonly onClose: () => void,
  ) {
    this.root = el('div', 'panel-overlay', 'hero-screen');
    this.panel = el('div', 'panel hero-panel-screen');
    this.status = el('div', 'panel-status', 'hero-status');
    this.root.appendChild(this.panel);
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) this.onClose();
    });
    this.update();
  }

  update(): void {
    const state = this.ctx.getState();
    const hero = state.heroes[this.heroId];
    if (hero?.owner !== this.ctx.playerId) {
      this.onClose();
      return;
    }
    const second = this.secondHeroId === null ? null : state.heroes[this.secondHeroId];
    this.panel.replaceChildren();

    const header = el('div', 'panel-header');
    const title = el('div', 'panel-title', 'hero-screen-title');
    title.textContent = second ? `${hero.name} ↔ ${second.name}` : hero.name;
    header.append(title, button('Close', 'hero-close', this.onClose));
    this.panel.appendChild(header);

    const columns = el('div', 'hero-columns');
    columns.appendChild(this.heroColumn(hero, second !== null));
    if (second?.owner === this.ctx.playerId) {
      columns.appendChild(this.heroColumn(second, true));
    }
    this.panel.append(columns, this.status);
  }

  private run(error: string | null): void {
    this.status.textContent = error ?? '';
  }

  private heroColumn(hero: Hero, exchange: boolean): HTMLElement {
    const column = el('div', 'hero-column', `hero-column-${hero.id}`);
    column.append(
      this.statsBlock(hero),
      this.skillsBlock(hero),
      this.armyBlock(hero),
      this.artifactBlock(hero, exchange),
      this.dismissBlock(hero),
    );
    return column;
  }

  // dismiss the hero (spec §10.4): like fleeing a battle, the template
  // returns to the tavern pool for rehire; the army and artifacts are lost
  private dismissBlock(hero: Hero): HTMLElement {
    const block = el('div', 'panel-section');
    const arming = this.confirmingDismiss === hero.id;
    const label = arming ? 'Confirm dismiss — army and artifacts are lost' : 'Dismiss hero';
    block.appendChild(
      button(label, `dismiss-hero-${hero.id}`, () => {
        if (this.confirmingDismiss !== hero.id) {
          this.confirmingDismiss = hero.id;
          this.update();
          return;
        }
        this.confirmingDismiss = null;
        this.run(this.ctx.run({ type: 'dismissHero', player: this.ctx.playerId, hero: hero.id }));
        this.update();
      }),
    );
    return block;
  }

  private statsBlock(hero: Hero): HTMLElement {
    const block = el('div', 'panel-section');
    const name = el('div', 'section-title', `hero-title-${hero.id}`);
    name.textContent = `${hero.name} — level ${String(hero.level)} ${hero.class}`;
    const xp = el('div', 'hero-xp', `hero-xp-${hero.id}`);
    xp.textContent = xpProgressText(hero, this.ctx.data);
    const stats = effectiveStats(hero, this.ctx.data);
    const grid = el('div', 'stat-grid');
    const entries: [string, number, number][] = [
      ['attack', hero.attack, stats.attack],
      ['defense', hero.defense, stats.defense],
      ['spellPower', hero.spellPower, stats.spellPower],
      ['knowledge', hero.knowledge, stats.knowledge],
    ];
    for (const [key, base, effective] of entries) {
      const cell = el('div', 'stat-cell', `hero-stat-${key}-${hero.id}`);
      const bonus = effective - base;
      cell.textContent = `${capitalize(key)}: ${String(base)}${bonus !== 0 ? ` (+${String(bonus)})` : ''}`;
      grid.appendChild(cell);
    }
    const mana = el('div', 'hero-mana');
    mana.textContent = `Mana ${String(hero.mana)}/${String(maxMana(hero, this.ctx.data))} | MP ${String(hero.movementPoints)}`;
    block.append(name, xp, grid, mana);
    return block;
  }

  private skillsBlock(hero: Hero): HTMLElement {
    const block = el('div', 'panel-section');
    block.appendChild(this.sectionTitle('Skills'));
    const list = el('div', 'skill-list', `hero-skills-${hero.id}`);
    if (hero.skills.length === 0) {
      list.textContent = 'No skills learned.';
    }
    for (const entry of hero.skills) {
      const skill = this.ctx.data.skills[entry.skill];
      const item = el('div', 'skill-item', `hero-skill-${entry.skill}-${hero.id}`);
      item.textContent = `${skill?.name ?? entry.skill} (${entry.rank})`;
      list.appendChild(item);
    }
    block.appendChild(list);
    return block;
  }

  private armyBlock(hero: Hero): HTMLElement {
    const block = el('div', 'panel-section');
    block.appendChild(this.sectionTitle('Army'));
    const row = el('div', 'army-row');
    hero.army.forEach((stack, i) => {
      const cell = el('button', 'army-slot', `army-slot-${hero.id}-${String(i)}`);
      if (stack) {
        const creature = this.ctx.data.creatures[stack.creature];
        cell.textContent = `${String(stack.count)} ${creature?.name ?? stack.creature}`;
      } else {
        cell.textContent = '—';
      }
      if (this.selected?.hero === hero.id && this.selected.slot === i) {
        cell.classList.add('selected');
      }
      cell.addEventListener('click', () => {
        this.slotClicked(hero.id, i);
      });
      row.appendChild(cell);
    });
    block.appendChild(row);
    return block;
  }

  private slotClicked(heroId: HeroId, slot: number): void {
    const state = this.ctx.getState();
    const hero = state.heroes[heroId];
    if (!hero) return;
    if (!this.selected) {
      if (hero.army[slot]) {
        this.selected = { hero: heroId, slot };
        this.update();
      }
      return;
    }
    const picked = this.selected;
    this.selected = null;
    if (picked.hero === heroId && picked.slot === slot) {
      this.update();
      return;
    }
    const source = state.heroes[picked.hero]?.army[picked.slot];
    const target = hero.army[slot];
    if (!source) {
      this.update();
      return;
    }
    const move = (count?: number): void => {
      const command = {
        type: 'moveStack' as const,
        player: this.ctx.playerId,
        from: { kind: 'hero' as const, hero: picked.hero },
        fromSlot: picked.slot,
        to: { kind: 'hero' as const, hero: heroId },
        toSlot: slot,
        ...(count !== undefined ? { count } : {}),
      };
      this.run(this.ctx.run(command));
      this.update();
    };
    if (!target && source.count > 1) {
      // split dialog: choose how many to move (max = whole stack)
      openCountDialog(this.root, {
        title: `Move how many ${this.ctx.data.creatures[source.creature]?.name ?? source.creature}?`,
        min: 1,
        max: source.count,
        initial: source.count,
        onConfirm: (count) => {
          move(count);
        },
      });
      this.update();
      return;
    }
    move();
  }

  private artifactBlock(hero: Hero, exchange: boolean): HTMLElement {
    const block = el('div', 'panel-section');
    block.appendChild(this.sectionTitle('Artifacts'));

    const doll = el('div', 'doll-grid', `doll-${hero.id}`);
    const equipped = [...hero.artifacts];
    for (const slot of ARTIFACT_SLOTS) {
      for (let i = 0; i < ARTIFACT_SLOT_CAPACITY[slot]; i++) {
        const cell = el('button', 'doll-cell', `doll-${slot}-${String(i)}-${hero.id}`);
        const index = equipped.findIndex((id) => this.ctx.data.artifacts[id]?.slot === slot);
        if (index !== -1) {
          const artifactId = equipped.splice(index, 1)[0];
          if (artifactId !== undefined) {
            cell.textContent = this.ctx.data.artifacts[artifactId]?.name ?? artifactId;
            cell.classList.add('filled');
            cell.addEventListener('click', () => {
              this.run(
                this.ctx.run({
                  type: 'unequipArtifact',
                  player: this.ctx.playerId,
                  hero: hero.id,
                  artifact: artifactId,
                }),
              );
            });
          }
        } else {
          cell.textContent = slot;
          cell.disabled = true;
        }
        doll.appendChild(cell);
      }
    }
    block.appendChild(doll);

    const backpack = el('div', 'backpack-list', `backpack-${hero.id}`);
    if (hero.backpack.length === 0) {
      backpack.textContent = 'Backpack is empty.';
    }
    hero.backpack.forEach((artifactId, i) => {
      const row = el('div', 'backpack-row');
      row.appendChild(
        button(
          this.ctx.data.artifacts[artifactId]?.name ?? artifactId,
          `backpack-${artifactId}-${String(i)}-${hero.id}`,
          () => {
            this.run(
              this.ctx.run({
                type: 'equipArtifact',
                player: this.ctx.playerId,
                hero: hero.id,
                artifact: artifactId,
              }),
            );
          },
        ),
      );
      if (exchange) {
        const other = this.otherHero(hero.id);
        if (other !== null) {
          row.appendChild(
            button('Give', `artifact-give-${artifactId}-${String(i)}-${hero.id}`, () => {
              this.run(
                this.ctx.run({
                  type: 'transferArtifact',
                  player: this.ctx.playerId,
                  from: hero.id,
                  to: other,
                  artifact: artifactId,
                }),
              );
            }),
          );
        }
      }
      backpack.appendChild(row);
    });
    block.appendChild(backpack);
    return block;
  }

  private otherHero(heroId: HeroId): HeroId | null {
    if (this.secondHeroId === null) return null;
    return heroId === this.heroId ? this.secondHeroId : this.heroId;
  }

  private sectionTitle(text: string): HTMLElement {
    const title = el('div', 'section-title');
    title.textContent = text;
    return title;
  }
}
