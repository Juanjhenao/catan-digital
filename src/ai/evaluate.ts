import {
  COSTS,
  hasResources,
  pipsFor,
  publicVictoryPoints,
  RESOURCES,
  TERRAIN_YIELD,
  totalResources,
  tradeRatio,
  VARIANT_SETUP,
  type GameState,
  type PlayerId,
  type Resource,
  type ResourceCount,
  type VertexId,
} from '../engine/index.js';

/**
 * Valoracion de posiciones para los bots.
 *
 * Regla de la casa: aqui NO se mira la mano de ningun rival. El estado
 * completo la contiene (hace falta para pintar y para el motor), pero un bot
 * que la leyera estaria haciendo trampa, y ademas dejaria de funcionar el dia
 * que la partida sea en red y cada cliente solo vea lo suyo. Todo lo que se usa
 * es publico: el tablero, los edificios, los puertos, cuantas cartas tiene cada
 * uno y el contenido del banco.
 */

// ---------------------------------------------------------------------------
// Informacion publica
// ---------------------------------------------------------------------------

/**
 * Cuantas cartas de cada recurso estan repartidas entre los demas jugadores.
 *
 * No es adivinar: el banco esta a la vista y el total de cartas de cada tipo es
 * fijo, asi que restando la propia mano sale exactamente lo que hay en las
 * manos ajenas *en conjunto* (no de quien). Es la misma cuenta que hace un
 * jugador humano atento, y es lo que permite elegir bien un monopolio.
 */
export function deduceOpponentPool(state: GameState, player: PlayerId): ResourceCount {
  const perResource = VARIANT_SETUP[state.board.variant].bankPerResource;
  const mine = state.players[player]!.resources;
  const pool = { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 };
  for (const resource of RESOURCES) {
    pool[resource] = Math.max(0, perResource - state.bank[resource] - mine[resource]);
  }
  return pool;
}

/**
 * Cuantas cartas tiene un jugador en la mano: publico, aunque no cuales.
 *
 * Se reexporta la del motor en vez de repetirla aqui. La copia que habia hacia
 * `totalResources(p.resources)` a pelo, y eso deja de ser cierto en cuanto el
 * estado llega censurado desde un servidor: las manos ajenas vienen vacias y el
 * numero de verdad esta en `redacted`.
 */
export { handSize } from '../engine/index.js';

/** El rival mas peligroso ahora mismo, por puntos visibles y desarrollo. */
export function leader(state: GameState, player: PlayerId): PlayerId | null {
  let best: PlayerId | null = null;
  let bestScore = -Infinity;
  for (const other of state.players) {
    if (other.id === player) continue;
    const score =
      publicVictoryPoints(state, other.id) * 10 +
      other.knightsPlayed * 2 +
      other.longestRoadLength;
    if (score > bestScore) {
      bestScore = score;
      best = other.id;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Valor de un cruce
// ---------------------------------------------------------------------------

export interface VertexWeights {
  /** Cuanto vale cada recurso para este bot en este momento. */
  resource: Record<Resource, number>;
  /** Premio por cada recurso distinto que toca el cruce. */
  diversity: number;
  /** Si se tienen en cuenta los puertos. */
  ports: boolean;
}

/**
 * Escasez relativa de cada recurso en el juego inicial.
 *
 * Arcilla y madera son el cuello de botella de la expansion (todo camino y
 * todo poblado las necesita), asi que valen mas de lo que sugiere su
 * frecuencia. La lana es la mas facil de conseguir y la que menos limita.
 */
const EARLY_VALUE: Record<Resource, number> = {
  brick: 1.25,
  lumber: 1.2,
  grain: 1.05,
  ore: 0.95,
  wool: 0.8,
};

/** Ya con ciudades en el horizonte, el mineral y el trigo mandan. */
const LATE_VALUE: Record<Resource, number> = {
  ore: 1.3,
  grain: 1.2,
  brick: 0.9,
  lumber: 0.9,
  wool: 0.85,
};

/**
 * @param diversityPressure cuanto se devalua lo que ya se produce. Es el
 * mando que separa a un bot que busca cubrir los cinco recursos de otro que
 * se planta donde haya muchos puntos sin mirar si repite.
 */
export function resourceWeights(
  state: GameState,
  player: PlayerId,
  diversityPressure = 0.12,
): Record<Resource, number> {
  // A partir del tercer edificio propio se empieza a pensar en ciudades.
  const buildings = state.players[player]!.buildings.length;
  const late = buildings >= 3 || state.turn > state.players.length * 8;
  const base = late ? LATE_VALUE : EARLY_VALUE;

  // Lo que ya se produce vale menos: interesa diversificar.
  const produced = productionProfile(state, player);
  const weights = { ...base };
  for (const resource of RESOURCES) {
    weights[resource] = base[resource] / (1 + produced[resource] * diversityPressure);
  }
  return weights;
}

/** Cuantos "pips" de cada recurso produce ya un jugador. */
export function productionProfile(state: GameState, player: PlayerId): ResourceCount {
  const profile = { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 };
  for (const vertex of state.players[player]!.buildings) {
    const multiplier = state.buildings[vertex]!.kind === 'city' ? 2 : 1;
    for (const hexId of state.board.vertexHexes[vertex] ?? []) {
      const hex = state.board.hexes[hexId]!;
      const resource = TERRAIN_YIELD[hex.terrain];
      if (!resource || hex.number === null) continue;
      profile[resource] += pipsFor(hex.number) * multiplier;
    }
  }
  return profile;
}

/**
 * Lo que vale plantarse en un cruce: produccion ponderada, variedad y puertos.
 */
export function vertexScore(
  state: GameState,
  vertex: VertexId,
  weights: VertexWeights,
): number {
  let score = 0;
  const touched = new Map<Resource, number>();

  for (const hexId of state.board.vertexHexes[vertex] ?? []) {
    const hex = state.board.hexes[hexId]!;
    const resource = TERRAIN_YIELD[hex.terrain];
    if (!resource || hex.number === null) continue;
    const pips = pipsFor(hex.number);
    score += pips * weights.resource[resource];
    touched.set(resource, (touched.get(resource) ?? 0) + pips);
  }

  // Tres recursos distintos valen mucho mas que tres veces el mismo: dan
  // autonomia para construir sin depender del comercio.
  score += (touched.size - 1) * weights.diversity;

  if (weights.ports) {
    for (const port of state.board.vertexPorts[vertex] ?? []) {
      if (port === 'generic') score += 1.4;
      // Un puerto 2:1 solo vale si se produce ese recurso, y mucho si se
      // produce en cantidad.
      else score += touched.has(port) ? 1.2 + (touched.get(port) ?? 0) * 0.4 : 0.3;
    }
  }

  // Un cruce que solo toca mar o desierto no vale casi nada.
  return score;
}

// ---------------------------------------------------------------------------
// Construcciones alcanzables
// ---------------------------------------------------------------------------

/** Que se puede pagar ahora mismo. */
export function affordable(state: GameState, player: PlayerId) {
  const hand = state.players[player]!.resources;
  return {
    road: hasResources(hand, COSTS.road),
    settlement: hasResources(hand, COSTS.settlement),
    city: hasResources(hand, COSTS.city),
    devCard: hasResources(hand, COSTS.devCard),
  };
}

/** Cuantas cartas faltan para pagar un coste. */
export function missingFor(hand: ResourceCount, cost: ResourceCount): ResourceCount {
  const missing = { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 };
  for (const resource of RESOURCES) {
    missing[resource] = Math.max(0, cost[resource] - hand[resource]);
  }
  return missing;
}

/**
 * Si un cambio con el banco acerca a poder pagar `cost`: hay que tener sobrante
 * suficiente de algo que no haga falta, y que falte exactamente un tipo.
 */
export function bankTradeTowards(
  state: GameState,
  player: PlayerId,
  cost: ResourceCount,
): { give: Resource; want: Resource } | null {
  const hand = state.players[player]!.resources;
  const missing = missingFor(hand, cost);
  const needed = RESOURCES.filter((r) => missing[r] > 0);
  // Con mas de un tipo pendiente, un solo cambio no resuelve nada.
  if (needed.length !== 1) return null;
  const want = needed[0]!;
  if (missing[want] > 1) return null;
  if (state.bank[want] < 1) return null;

  for (const give of RESOURCES) {
    if (give === want) continue;
    const ratio = tradeRatio(state, player, give);
    // No se puede gastar lo que el propio coste necesita.
    if (hand[give] - ratio < cost[give]) continue;
    return { give, want };
  }
  return null;
}
