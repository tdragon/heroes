// Drives AI player turns from the adventure screen: runs AI commands until it
// is a human's turn again, the game ends, or a battle / pending choice needs
// the human's attention. Also contains the stuck-AI recovery paths (forced
// endTurn, fleeing a stalemated off-screen battle).

import type { GameData } from '../data';
import { chooseAICommand } from '../core/ai/adventureAI';
import { activeCombatStack } from '../core/combat/engine';
import { heroInfoFor } from '../core/combat/state';
import type { Command } from '../core/commands';
import type { GameState } from '../core/state';

const AI_COMMAND_LIMIT = 2000;
// off-screen AI-vs-AI battles are force-resolved past this many rounds so a
// stalemate cannot eat the whole AI command budget
const AI_COMBAT_ROUND_CAP = 200;

export interface AiDriverHost {
  getState: () => GameState;
  // dispatches a command; returns true on success
  runCommand: (command: Command) => boolean;
  // a battle that needs the human's combat screen halts the driver
  humanInCombat: () => boolean;
  setStatus: (text: string) => void;
}

export class AiDriver {
  private running = false;

  constructor(
    private readonly host: AiDriverHost,
    private readonly data: GameData,
  ) {}

  // run AI players until it is a human's turn again, the game ends, or a
  // battle / pending choice needs the human's attention; also resolves
  // choices owned by AI players that arise off-turn (e.g. an AI defender's
  // level-up after surviving the human's attack)
  maybeResumeAiTurns(): void {
    if (this.running) return;
    this.running = true;
    try {
      // per-AI-turn command budget plus an absolute stop; both recovery paths
      // (rejected command, exhausted budget) force endTurn for the stuck AI
      // instead of freezing the game on "Enemy turn"
      let total = 0;
      let turnCommands = 0;
      let turnOf = this.host.getState().currentPlayer;
      while (total++ < AI_COMMAND_LIMIT * 4 && this.host.getState().status === 'running') {
        const state = this.host.getState();
        if (state.currentPlayer !== turnOf) {
          turnOf = state.currentPlayer;
          turnCommands = 0;
        }
        if (state.combat !== null && this.host.humanInCombat()) break;
        if (state.combat !== null && state.combat.combat.round > AI_COMBAT_ROUND_CAP) {
          // stalemated off-screen battle: the attacker withdraws (flee), so
          // the round cap acts as an auto-resolve rule
          console.warn(
            `off-screen combat exceeded ${String(AI_COMBAT_ROUND_CAP)} rounds — attacker flees`,
          );
          if (!this.fleeAiAttacker()) break;
          continue;
        }
        const aiChoice = state.pendingChoices.find(
          (c) => state.players.find((p) => p.id === c.player)?.isHuman === false,
        );
        if (aiChoice) {
          const resolve: Command = {
            type: 'resolveChoice',
            player: aiChoice.player,
            choiceId: aiChoice.id,
            option: 0,
          };
          if (!this.host.runCommand(resolve)) break;
          continue;
        }
        if (state.pendingChoices.length > 0) break;
        const player = state.players.find((p) => p.id === state.currentPlayer);
        if (!player || player.isHuman || player.defeated) break;
        this.host.setStatus(`Enemy turn — ${player.id}…`);
        const exhausted = turnCommands++ >= AI_COMMAND_LIMIT;
        if (exhausted || !this.host.runCommand(chooseAICommand(state, this.data))) {
          console.warn(
            exhausted
              ? `AI command limit exhausted for ${player.id} — forcing endTurn`
              : `AI command rejected for ${player.id} — forcing endTurn`,
          );
          // a stuck battle is abandoned first (the turn cannot end mid-combat)
          if (this.host.getState().combat !== null) {
            if (!this.fleeAiAttacker()) break;
            continue;
          }
          if (!this.forceEndAiTurn()) break;
        }
      }
    } finally {
      this.running = false;
    }
  }

  // dispatch rejects endTurn while pending choices exist, so the forced
  // endTurn recovery must clear AI-owned choices first (option 0); a
  // human-owned choice is a clean stop — the dialog queue will surface it
  private forceEndAiTurn(): boolean {
    while (this.host.getState().status === 'running') {
      const state = this.host.getState();
      const choice = state.pendingChoices[0];
      if (!choice) break;
      if (state.players.find((p) => p.id === choice.player)?.isHuman !== false) return false;
      const resolve: Command = {
        type: 'resolveChoice',
        player: choice.player,
        choiceId: choice.id,
        option: 0,
      };
      if (!this.host.runCommand(resolve)) return false;
      // resolving a choice can start a battle (e.g. guardAttack "fight"):
      // hand control back to the main loop, which drives/aborts combats
      if (this.host.getState().combat !== null) return true;
    }
    if (this.host.getState().status !== 'running') return true;
    return this.host.runCommand({ type: 'endTurn', player: this.host.getState().currentPlayer });
  }

  // withdraw the attacker from an off-screen AI battle (recovery/auto-resolve);
  // flee is only legal on the fleeing side's own turn, so when another side's
  // stack is active this defends it to advance the queue — the caller loops
  // until the attacker's turn comes up and the flee goes through
  private fleeAiAttacker(): boolean {
    const state = this.host.getState();
    const combat = state.combat;
    if (!combat) return false;
    const active = activeCombatStack(combat.combat);
    if (!active) return false;
    if (active.side !== 'attacker') {
      const sideOwner = heroInfoFor(combat.combat, active.side).player;
      const actor = state.players.find((p) => p.id === sideOwner)?.id ?? state.currentPlayer;
      return this.host.runCommand({
        type: 'combatAction',
        player: actor,
        action: { type: 'defend' },
      });
    }
    const owner = combat.combat.attackerHero.player;
    const actor = state.players.find((p) => p.id === owner)?.id ?? state.currentPlayer;
    return this.host.runCommand({ type: 'combatAction', player: actor, action: { type: 'flee' } });
  }
}
