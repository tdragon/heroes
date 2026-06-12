import type { ArmyDest } from '../core/commands';
import { getPlayer } from '../core/state';
import type { TownId } from '../core/state';
import { openCountDialog, type UiContext } from './components';
import { costText, recruitMax, scaledCost } from './helpers';

export function openRecruitDialog(
  host: HTMLElement,
  ctx: UiContext,
  townId: TownId,
  creatureId: string,
  dest: ArmyDest,
  onDone: (error: string | null) => void,
): void {
  const state = ctx.getState();
  const town = state.towns[townId];
  const creature = ctx.data.creatures[creatureId];
  if (!town || !creature) return;
  const available = town.availableCreatures[creatureId] ?? 0;
  const player = getPlayer(state, ctx.playerId);
  const max = recruitMax(available, creature.cost, player.resources);
  if (max < 1) {
    onDone(`cannot afford any ${creature.name}`);
    return;
  }
  openCountDialog(host, {
    title: `Recruit ${creature.name} (${String(available)} available)`,
    min: 1,
    max,
    initial: 1,
    describe: (count) => `Cost: ${costText(scaledCost(creature.cost, count))}`,
    onConfirm: (count) => {
      onDone(
        ctx.run({
          type: 'recruit',
          player: ctx.playerId,
          town: townId,
          dest,
          creature: creatureId,
          count,
        }),
      );
    },
  });
}
