import {
  applyAction,
  discardAmount,
  getLegalActions,
  playersToAct,
  type Action,
  type GameState,
} from '../engine/index.js';
import type { Bot } from './types.js';

export interface SelfPlayResult {
  state: GameState;
  steps: number;
  /** Motivo por el que se detuvo el bucle. */
  reason: 'victory' | 'stepLimit' | 'stuck';
  /** Ultima accion aplicada, util para depurar un bloqueo. */
  lastAction: Action | null;
}

export interface SelfPlayOptions {
  /** Corta la partida si se pasa de aqui (evita bucles infinitos en tests). */
  maxSteps?: number;
  /** Se llama tras cada accion aplicada. */
  onStep?: (state: GameState, action: Action) => void;
}

/**
 * Hace avanzar la partida pidiendo decisiones a los bots hasta que alguien gana.
 *
 * Es el mismo bucle que usara la interfaz cuando haya bots en la mesa: mira
 * quien tiene que actuar, le pide una accion legal y la aplica.
 */
export function playOut(
  initial: GameState,
  bots: Bot[],
  options: SelfPlayOptions = {},
): SelfPlayResult {
  const maxSteps = options.maxSteps ?? 20000;
  let state = initial;
  let steps = 0;
  let lastAction: Action | null = null;

  while (state.phase !== 'gameOver' && steps < maxSteps) {
    const actors = playersToAct(state);
    if (actors.length === 0) return { state, steps, reason: 'stuck', lastAction };

    const player = actors[0]!;
    const bot = bots[player]!;

    // El descarte no se enumera (demasiadas combinaciones): lo decide el bot.
    const action: Action =
      state.phase === 'discard'
        ? {
            type: 'discard',
            player,
            resources: bot.chooseDiscard(state, player, discardAmount(state, player)),
          }
        : (() => {
            const legal = getLegalActions(state, player);
            return legal.length > 0 ? bot.decide(state, player, legal) : null;
          })() ?? { type: 'endTurn', player };

    const result = applyAction(state, action);
    if (!result.ok) return { state, steps, reason: 'stuck', lastAction: action };

    state = result.state;
    lastAction = action;
    steps++;
    options.onStep?.(state, action);
  }

  return {
    state,
    steps,
    reason: state.phase === 'gameOver' ? 'victory' : 'stepLimit',
    lastAction,
  };
}
