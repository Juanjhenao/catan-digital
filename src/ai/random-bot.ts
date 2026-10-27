import {
  createRng,
  defaultDiscard,
  nextInt,
  type Action,
  type GameState,
  type PlayerId,
  type ResourceCount,
  type RngState,
} from '../engine/index.js';
import type { Bot, BotDifficulty } from './types.js';

/**
 * Bot de referencia: elige al azar entre las acciones legales.
 *
 * No pretende jugar bien. Existe por dos razones concretas:
 *  1. Es la prueba de que el contrato `Bot` basta para jugar una partida
 *     completa sin ningun acceso especial al motor.
 *  2. Sirve de "fuzzer": miles de partidas de bots aleatorios recorren
 *     combinaciones de reglas que ningun test escrito a mano cubriria, y
 *     detectan bloqueos o estados imposibles en el motor.
 *
 * Los bots con dificultad real se construiran sobre esta misma interfaz.
 */
export class RandomBot implements Bot {
  readonly id: string;
  readonly difficulty: BotDifficulty;
  private rng: RngState;

  constructor(difficulty: BotDifficulty = 'easy', seed = 1) {
    this.id = `random-${seed}`;
    this.difficulty = difficulty;
    this.rng = createRng(seed);
  }

  private pick<T>(items: T[]): T {
    const [index, next] = nextInt(this.rng, items.length);
    this.rng = next;
    return items[index]!;
  }

  decide(_state: GameState, _player: PlayerId, legal: Action[]): Action {
    return this.pick(legal);
  }

  chooseDiscard(
    state: GameState,
    player: PlayerId,
    amount: number,
  ): Partial<ResourceCount> {
    return defaultDiscard(state.players[player]!.resources, amount);
  }

  respondToTrade(): boolean {
    const [value, next] = nextInt(this.rng, 2);
    this.rng = next;
    return value === 1;
  }
}
