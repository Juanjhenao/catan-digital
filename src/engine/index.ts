/**
 * Punto de entrada del motor de reglas.
 *
 * Todo lo que hay debajo de `engine/` es TypeScript puro: no toca el DOM, no
 * usa `Math.random` ni relojes, y no sabe nada de como se dibuja el juego. Un
 * bot, un servidor o un test consumen exactamente la misma interfaz:
 *
 *     const state  = createGame(players, { seed });
 *     const moves  = getLegalActions(state, id);
 *     const result = applyAction(state, moves[0]);
 */
export * from './types.js';
export * from './actions.js';
export * from './constants.js';
export * from './hex.js';
export * from './board.js';
export * from './state.js';
export * from './legal.js';
export * from './reducer.js';
export * from './longest-road.js';
export { createRng, nextFloat, nextInt, randomSeed, rollDie, shuffle } from './rng.js';
export type { RngState } from './rng.js';
