import type { EdgeId, HexId, PlayerId, Resource, ResourceCount, VertexId } from './types.js';

/**
 * Toda interaccion con el motor pasa por una de estas acciones. Cada una lleva
 * el jugador que la ejecuta, de modo que el reducer puede validar la autoria
 * sin depender de quien la haya enviado. Es justo la forma que necesitara el
 * dia de manana un bot (elige de la lista de acciones legales) o un servidor
 * (recibe la accion del cliente y la valida antes de aplicarla).
 */
export type Action =
  // --- Colocacion inicial ---
  | { type: 'setupSettlement'; player: PlayerId; vertex: VertexId }
  | { type: 'setupRoad'; player: PlayerId; edge: EdgeId }
  // --- Dados y ladron ---
  | { type: 'rollDice'; player: PlayerId }
  | { type: 'discard'; player: PlayerId; resources: Partial<ResourceCount> }
  | { type: 'moveRobber'; player: PlayerId; hex: HexId }
  | { type: 'steal'; player: PlayerId; target: PlayerId | null }
  // --- Construccion ---
  | { type: 'buildRoad'; player: PlayerId; edge: EdgeId }
  | { type: 'buildSettlement'; player: PlayerId; vertex: VertexId }
  | { type: 'buildCity'; player: PlayerId; vertex: VertexId }
  | { type: 'buyDevCard'; player: PlayerId }
  // --- Cartas de desarrollo ---
  | { type: 'playKnight'; player: PlayerId }
  | { type: 'playRoadBuilding'; player: PlayerId }
  | { type: 'playYearOfPlenty'; player: PlayerId; resources: [Resource, Resource] }
  | { type: 'playMonopoly'; player: PlayerId; resource: Resource }
  // --- Comercio ---
  | { type: 'bankTrade'; player: PlayerId; give: Resource; want: Resource }
  | {
      type: 'offerTrade';
      player: PlayerId;
      give: Partial<ResourceCount>;
      want: Partial<ResourceCount>;
    }
  | { type: 'respondTrade'; player: PlayerId; accept: boolean }
  | { type: 'confirmTrade'; player: PlayerId; with: PlayerId }
  | { type: 'cancelTrade'; player: PlayerId }
  // --- Flujo de turno ---
  | { type: 'endTurn'; player: PlayerId };

export type ActionType = Action['type'];

/** Resultado de validar una accion antes de aplicarla. */
export type Validation = { ok: true } | { ok: false; reason: string };

export const OK: Validation = { ok: true };

export function fail(reason: string): Validation {
  return { ok: false, reason };
}
