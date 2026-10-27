import { generateBoard } from './board.js';
import {
  DISCARD_LIMIT,
  LARGEST_ARMY_MIN,
  piecesFor,
  PLAYER_COLORS,
  VARIANT_SETUP,
  ZERO_RESOURCES,
  variantForPlayers,
} from './constants.js';
import { createRng, shuffle, type RngState } from './rng.js';
import type {
  BoardVariant,
  DevCardKind,
  GameState,
  PlayerConfig,
  PlayerId,
  PlayerState,
  Resource,
  ResourceCount,
} from './types.js';
import { RESOURCES } from './types.js';

export interface NewGameOptions {
  seed: number;
  /** Por defecto se elige segun el numero de jugadores (5+ -> ampliado). */
  variant?: BoardVariant;
  /** Puntos para ganar. Por defecto 10. */
  victoryPoints?: number;
  playerTrade?: boolean;
}

export function createGame(configs: PlayerConfig[], options: NewGameOptions): GameState {
  if (configs.length < 2 || configs.length > 6) {
    throw new Error('Catan admite entre 2 y 6 jugadores');
  }

  const variant = options.variant ?? variantForPlayers(configs.length);
  const setup = VARIANT_SETUP[variant];

  let rng: RngState = createRng(options.seed);
  const [board, afterBoard] = generateBoard(variant, rng);
  rng = afterBoard;

  // Mazo de desarrollo barajado.
  const deckCards: DevCardKind[] = [];
  for (const [kind, count] of Object.entries(setup.devDeck) as [DevCardKind, number][]) {
    for (let i = 0; i < count; i++) deckCards.push(kind);
  }
  const [devDeck, afterDeck] = shuffle(deckCards, rng);
  rng = afterDeck;

  // Orden de juego aleatorio, como sortear quien empieza.
  const [order, afterOrder] = shuffle(
    configs.map((_, i) => i),
    rng,
  );
  rng = afterOrder;

  const players: PlayerState[] = configs.map((config, id) => ({
    id,
    name: config.name,
    color: config.color ?? PLAYER_COLORS[id]!,
    kind: config.kind,
    difficulty: config.difficulty,
    resources: { ...ZERO_RESOURCES },
    devCards: [],
    knightsPlayed: 0,
    piecesLeft: piecesFor(variant),
    buildings: [],
    roads: [],
    ports: [],
    playedDevCardThisTurn: false,
    longestRoadLength: 0,
  }));

  // Serpiente: ida en orden, vuelta en orden inverso.
  const setupOrder = [...order, ...[...order].reverse()];

  const bank: ResourceCount = {
    lumber: setup.bankPerResource,
    brick: setup.bankPerResource,
    wool: setup.bankPerResource,
    grain: setup.bankPerResource,
    ore: setup.bankPerResource,
  };

  return {
    rules: {
      victoryPoints: options.victoryPoints ?? setup.victoryPoints,
      discardLimit: DISCARD_LIMIT,
      playerTrade: options.playerTrade ?? true,
    },
    board,
    players,
    bank,
    devDeck,
    buildings: {},
    roads: {},
    robber: board.robberStart,
    currentPlayer: setupOrder[0]!,
    phase: 'setupSettlement',
    turn: 0,
    dice: null,
    pending: null,
    mustDiscard: [],
    stealTargets: [],
    activeTrade: null,
    nextTradeId: 1,
    longestRoadHolder: null,
    largestArmyHolder: null,
    turnOrder: order,
    setupOrder,
    setupIndex: 0,
    lastSetupVertex: null,
    winner: null,
    rng,
    // Una partida recien creada no esconde nada: la censura la aplica el
    // servidor al mandarla por la red, no el motor al fabricarla.
    redacted: null,
    log: [
      {
        turn: 0,
        player: null,
        text: `Partida creada: ${configs.length} jugadores, tablero ${
          variant === 'extended' ? '5-6 jugadores' : 'clasico'
        }.`,
        tone: 'info',
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Utilidades de recursos (puras)
// ---------------------------------------------------------------------------

/**
 * Cuantas cartas de recurso tiene un jugador.
 *
 * Pasa por aqui y no por `totalResources(p.resources)` porque en una partida en
 * red las manos ajenas llegan vacias: el numero real esta en `redacted`. Tener
 * un solo sitio que lo sepa es lo que evita que una pantalla cualquiera acabe
 * ensenando «0 cartas» a todos los rivales.
 */
export function handSize(state: GameState, player: PlayerId): number {
  if (state.redacted) return state.redacted.hands[player] ?? 0;
  return totalResources(state.players[player]!.resources);
}

/** Cuantas cartas de desarrollo tiene un jugador. Ver `handSize`. */
export function devCardCount(state: GameState, player: PlayerId): number {
  if (state.redacted) return state.redacted.devCards[player] ?? 0;
  return state.players[player]!.devCards.length;
}

/** Cuantas cartas quedan en el mazo de desarrollo. Ver `handSize`. */
export function devDeckSize(state: GameState): number {
  return state.redacted ? state.redacted.devDeck : state.devDeck.length;
}

/**
 * Si en ESTE estado se ven de verdad las cartas concretas de una mano.
 *
 * En una partida local siempre; en red, solo la propia -- las demas llegan
 * vacias y con el numero aparte en `redacted`. Lo usa la validacion para no
 * dictar sentencia sobre una mano que no tiene delante: en el servidor, que
 * tiene el estado entero, la comprobacion se hace igual, y es la unica que
 * cuenta.
 *
 * El caso de la mano vacia sale bien solo: si el recuento publico es cero, no
 * hay nada tapado y las dos lecturas coinciden.
 */
export function handVisible(state: GameState, player: PlayerId): boolean {
  if (!state.redacted) return true;
  return totalResources(state.players[player]!.resources) === state.redacted.hands[player];
}

export function totalResources(count: ResourceCount): number {
  return RESOURCES.reduce((sum, r) => sum + count[r], 0);
}

export function hasResources(have: ResourceCount, need: Partial<ResourceCount>): boolean {
  return RESOURCES.every((r) => have[r] >= (need[r] ?? 0));
}

export function addResources(
  base: ResourceCount,
  delta: Partial<ResourceCount>,
): ResourceCount {
  const out = { ...base };
  for (const r of RESOURCES) out[r] += delta[r] ?? 0;
  return out;
}

export function subtractResources(
  base: ResourceCount,
  delta: Partial<ResourceCount>,
): ResourceCount {
  const out = { ...base };
  for (const r of RESOURCES) out[r] -= delta[r] ?? 0;
  return out;
}

export function countPartial(delta: Partial<ResourceCount>): number {
  return RESOURCES.reduce((sum, r) => sum + (delta[r] ?? 0), 0);
}

/** Lista plana de cartas, util para robar al azar de una mano. */
export function handAsList(count: ResourceCount): Resource[] {
  const out: Resource[] = [];
  for (const r of RESOURCES) for (let i = 0; i < count[r]; i++) out.push(r);
  return out;
}

// ---------------------------------------------------------------------------
// Puntuacion
// ---------------------------------------------------------------------------

/** Puntos visibles para el resto: edificios y cartas de bonificacion. */
export function publicVictoryPoints(state: GameState, id: PlayerId): number {
  const player = state.players[id]!;
  let points = 0;
  for (const vertex of player.buildings) {
    points += state.buildings[vertex]!.kind === 'city' ? 2 : 1;
  }
  if (state.longestRoadHolder === id) points += 2;
  if (state.largestArmyHolder === id) points += 2;
  return points;
}

/** Puntos reales, incluyendo las cartas de punto de victoria ocultas. */
export function victoryPoints(state: GameState, id: PlayerId): number {
  const hidden = state.players[id]!.devCards.filter((c) => c.kind === 'victoryPoint').length;
  return publicVictoryPoints(state, id) + hidden;
}

/** Recalcula el mayor ejercito. Requiere superar estrictamente al titular. */
export function recomputeLargestArmy(state: GameState): PlayerId | null {
  const current = state.largestArmyHolder;
  const currentCount = current !== null ? state.players[current]!.knightsPlayed : 0;
  let holder = current;
  let best = Math.max(currentCount, LARGEST_ARMY_MIN - 1);

  for (const player of state.players) {
    if (player.knightsPlayed > best) {
      best = player.knightsPlayed;
      holder = player.id;
    }
  }
  return best >= LARGEST_ARMY_MIN ? holder : null;
}
