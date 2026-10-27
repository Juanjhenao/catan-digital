import type { Action, GameState, PlayerId, ResourceCount } from '../engine/index.js';

/**
 * Contrato de un bot.
 *
 * El MVP se juega entre humanos, pero el motor ya esta preparado para esto: un
 * bot no es mas que una funcion que, dado el estado y su identidad, devuelve
 * una accion legal. No necesita acceso privilegiado a nada; ve el mismo estado
 * que vera un cliente en red, asi que la misma implementacion sirve local o
 * remota.
 *
 * Las dos decisiones que `getLegalActions` no enumera (por tener un espacio
 * combinatorio enorme) tienen su propio metodo:
 *   - `chooseDiscard`: que cartas tirar cuando sale un 7.
 *   - `proposeTrade`: que oferta poner sobre la mesa, si es que quiere.
 */
export interface Bot {
  readonly id: string;
  readonly difficulty: BotDifficulty;
  /** Elige una accion entre las legales. Debe devolver siempre una de ellas. */
  decide(state: GameState, player: PlayerId, legal: Action[]): Action;
  /** Reparto de descarte. Debe sumar exactamente `amount` cartas de la mano. */
  chooseDiscard(state: GameState, player: PlayerId, amount: number): Partial<ResourceCount>;
  /** Oferta opcional a los demas jugadores durante la fase principal. */
  proposeTrade?(
    state: GameState,
    player: PlayerId,
  ): { give: Partial<ResourceCount>; want: Partial<ResourceCount> } | null;
  /** Respuesta a una oferta ajena. */
  respondToTrade?(state: GameState, player: PlayerId): boolean;
}

export type BotDifficulty = 'easy' | 'normal' | 'hard';

export interface BotFactory {
  (difficulty: BotDifficulty, seed: number): Bot;
}
