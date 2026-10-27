import {
  applyAction,
  COSTS,
  createRng,
  LARGEST_ARMY_MIN,
  nextFloat,
  parseEdgeId,
  pipsFor,
  publicVictoryPoints,
  RESOURCES,
  TERRAIN_YIELD,
  type Action,
  type GameState,
  type PlayerId,
  type Resource,
  type ResourceCount,
  totalResources,
  tradeRatio,
  victoryPoints,
  type RngState,
  type VertexId,
} from '../engine/index.js';
import {
  affordable,
  bankTradeTowards,
  deduceOpponentPool,
  handSize,
  leader,
  missingFor,
  productionProfile,
  resourceWeights,
  vertexScore,
  type VertexWeights,
} from './evaluate.js';
import type { Bot, BotDifficulty } from './types.js';

/**
 * Bot heuristico con tres niveles.
 *
 * Los tres comparten el mismo cerebro: puntuar todas las acciones legales y
 * quedarse con la mejor. Lo que cambia entre dificultades no son reglas
 * distintas sino el "caracter", y eso importa: un bot facil no es uno que
 * juegue al azar, sino uno que ve el tablero de forma mas tosca y con la mano
 * temblorosa. Asi los tres resultan reconocibles jugando contra ellos, y el
 * facil sigue haciendo jugadas con sentido de vez en cuando.
 */

export interface Personality {
  /** Ruido sobre cada puntuacion. Cuanto mas alto, mas errores comete. */
  noise: number;
  /** Cuanto le importa estorbar al lider frente a mirar solo su juego. */
  aggression: number;
  /** Apetito por las cartas de desarrollo. */
  devCards: number;
  /** Si tiene en cuenta los puertos al valorar un cruce. */
  usesPorts: boolean;
  /** Si comercia con el banco para completar una construccion concreta. */
  planahead: boolean;
  /** Margen que exige para aceptar un intercambio (1 = solo si sale ganando). */
  tradeGreed: number;
  /**
   * Cuanto protege una construccion casi pagada. Un jugador flojo se gasta el
   * mineral en una carta de desarrollo cuando le faltaba uno para la ciudad;
   * uno bueno no. Es la diferencia de criterio mas rentable del juego.
   */
  patience: number;
  /**
   * Cuanto penaliza repetir recursos que ya produce. Alto = busca cubrir los
   * cinco; bajo = se conforma con plantarse donde haya muchos puntos.
   */
  diversityPressure: number;
  /**
   * Vision de final de partida: dejar de "desarrollarse" y empezar a contar
   * puntos, tanto los propios como los del que va ganando. Es una capacidad,
   * no un ajuste: un bot sin esto juega el turno 90 igual que el turno 3, y
   * pierde partidas que tenia ganadas por seguir poniendo caminos.
   */
  endgame: number;
  /**
   * Cuantas jugadas candidatas se comprueban de verdad aplicandolas y mirando
   * como queda el tablero. 0 = se decide solo con la puntuacion heuristica.
   *
   * Esto no es un ajuste mas: es otro procedimiento de decision. Las constantes
   * escritas a mano ("una ciudad vale 90") son una aproximacion; aplicar la
   * jugada y valorar la posicion resultante mide lo que de verdad cambia.
   */
  lookahead: number;
}

const PERSONALITIES: Record<BotDifficulty, Personality> = {
  easy: {
    noise: 9,
    aggression: 0,
    devCards: 0.35,
    usesPorts: false,
    planahead: false,
    tradeGreed: 0.6,
    patience: 0,
    diversityPressure: 0.06,
    endgame: 0,
    lookahead: 0,
  },
  normal: {
    noise: 3,
    aggression: 0.55,
    devCards: 0.85,
    usesPorts: true,
    planahead: true,
    tradeGreed: 1,
    patience: 0.5,
    diversityPressure: 0.14,
    endgame: 0.3,
    lookahead: 0,
  },
  // Los valores del nivel dificil no estan puestos a ojo: salen de un barrido
  // midiendo victorias contra el nivel normal (tools/tournament.ts). Dos
  // hallazgos que no eran evidentes: dejarle un pelin de ruido (0.4) le costaba
  // trece puntos porcentuales, y sin la comprobacion de jugadas el resto de
  // ajustes no lo separaban de normal en absoluto.
  hard: {
    noise: 0,
    aggression: 1,
    devCards: 1,
    usesPorts: true,
    planahead: true,
    tradeGreed: 1.15,
    patience: 1,
    diversityPressure: 0.4,
    endgame: 1,
    lookahead: 10,
  },
};

/** Valor aproximado de una carta suelta, para tasar intercambios. */
const CARD_VALUE = 1;

/** Jugadas cuyo resultado depende del azar: no se pueden "probar" sin hacer trampa. */
const STOCHASTIC = new Set<Action['type']>(['rollDice', 'steal', 'buyDevCard']);

export class HeuristicBot implements Bot {
  readonly id: string;
  readonly difficulty: BotDifficulty;
  private readonly traits: Personality;
  private rng: RngState;

  /**
   * @param overrides retoques sobre el caracter de la dificultad. Sirven para
   * experimentar (el barrido de parametros los usa) y para que alguien pueda
   * definir un rival a medida sin tocar esta clase.
   */
  constructor(
    difficulty: BotDifficulty = 'normal',
    seed = 1,
    overrides: Partial<Personality> = {},
  ) {
    this.difficulty = difficulty;
    this.traits = { ...PERSONALITIES[difficulty], ...overrides };
    this.id = `${difficulty}-${seed}`;
    this.rng = createRng(seed >>> 0);
  }

  private random(): number {
    const [value, next] = nextFloat(this.rng);
    this.rng = next;
    return value;
  }

  // -------------------------------------------------------------------------
  // Decision principal
  // -------------------------------------------------------------------------

  decide(state: GameState, player: PlayerId, legal: Action[]): Action {
    const scored = legal.map((action) => ({
      action,
      score: this.score(state, player, action) + this.endgameBonus(state, player, action),
    }));

    if (this.traits.lookahead > 0) {
      this.applyLookahead(state, player, scored);
    }

    let best = scored[0]!;
    let bestScore = -Infinity;
    for (const entry of scored) {
      const score = entry.score + (this.random() - 0.5) * 2 * this.traits.noise;
      if (score > bestScore) {
        bestScore = score;
        best = entry;
      }
    }
    return best.action;
  }

  /**
   * Reordena las mejores candidatas comprobando como queda la posicion tras
   * aplicarlas. Solo se revisan las primeras: aplicar las doscientas jugadas
   * legales de un turno costaria mas de lo que aporta, y las malas ya las ha
   * descartado la heuristica.
   */
  private applyLookahead(
    state: GameState,
    player: PlayerId,
    scored: { action: Action; score: number }[],
  ): void {
    const shortlist = [...scored]
      .sort((a, b) => b.score - a.score)
      .slice(0, this.traits.lookahead);
    const before = this.positionValue(state, player);

    for (const entry of shortlist) {
      // Las jugadas con azar quedan fuera a proposito: aplicarlas revelaria el
      // resultado del dado o la carta robada, y el bot estaria mirando el
      // futuro en vez de decidir con lo que sabe.
      if (STOCHASTIC.has(entry.action.type)) continue;
      const result = applyAction(state, entry.action);
      if (!result.ok) continue;
      entry.score += this.positionValue(result.state, player) - before;
    }
  }

  /**
   * Lo que vale una posicion para este jugador. Solo mira lo suyo: puntos,
   * produccion, puertos, piezas en juego y cartas en mano.
   */
  private positionValue(state: GameState, player: PlayerId): number {
    const me = state.players[player]!;
    const weights = resourceWeights(state, player, this.traits.diversityPressure);
    const production = productionProfile(state, player);

    let value = victoryPoints(state, player) * 34;
    for (const resource of RESOURCES) {
      value += production[resource] * weights[resource] * 1.6;
    }
    value += me.ports.length * 2.5;
    value += me.longestRoadLength * 1.2;
    value += me.knightsPlayed * 2;
    // Las cartas en mano valen algo, pero mucho menos que estar en el tablero.
    value += totalResources(me.resources) * 0.35;
    // Pasarse del limite de descarte es un riesgo real cada vez que sale un 7.
    if (totalResources(me.resources) > state.rules.discardLimit) {
      value -= (totalResources(me.resources) - state.rules.discardLimit) * 1.2;
    }
    return value;
  }

  private weights(state: GameState, player: PlayerId): VertexWeights {
    return {
      resource: resourceWeights(state, player, this.traits.diversityPressure),
      diversity: this.traits.usesPorts ? 2.5 : 1.2,
      ports: this.traits.usesPorts,
    };
  }

  private score(state: GameState, player: PlayerId, action: Action): number {
    switch (action.type) {
      case 'setupSettlement':
        return 100 + vertexScore(state, action.vertex, this.weights(state, player)) * 3;

      case 'setupRoad':
        return 100 + this.roadDirectionScore(state, player, action.edge);

      case 'rollDice':
        return 100;

      case 'buildCity': {
        // Duplicar produccion en el mejor cruce propio es casi siempre la
        // jugada mas rentable del juego.
        const gain = vertexScore(state, action.vertex, this.weights(state, player));
        return 90 + gain * 2;
      }

      case 'buildSettlement':
        return 80 + vertexScore(state, action.vertex, this.weights(state, player)) * 2;

      case 'buildRoad':
        return this.buildRoadScore(state, player, action.edge);

      case 'buyDevCard':
        return this.devCardScore(state, player);

      case 'playKnight':
        return this.knightScore(state, player);

      case 'playRoadBuilding':
        // Dos caminos gratis valen lo que valgan los dos mejores huecos.
        return 45 + this.traits.devCards * 10;

      case 'playMonopoly':
        return this.monopolyScore(state, player, action.resource);

      case 'playYearOfPlenty':
        return this.yearOfPlentyScore(state, player, action.resources);

      case 'moveRobber':
        return this.robberScore(state, player, action.hex);

      case 'steal':
        return action.target === null ? 0 : 10 + this.victimScore(state, player, action.target);

      case 'bankTrade':
        return this.bankTradeScore(state, player, action.give, action.want);

      case 'respondTrade':
        return this.tradeResponseScore(state, player, action.accept);

      case 'confirmTrade':
        return 60;

      case 'cancelTrade':
        return 5;

      case 'endTurn':
        // Ultimo recurso: cualquier jugada util puntua mas.
        return 2;

      default:
        return 0;
    }
  }

  // -------------------------------------------------------------------------
  // Final de partida
  // -------------------------------------------------------------------------

  /**
   * Ajuste por cercania al final, en las dos direcciones.
   *
   * Hacia delante: a tres puntos de ganar deja de importar el desarrollo y
   * pasa a importar solo lo que suma puntos ya.
   * Hacia atras: si alguien esta a punto de ganar, estorbarle vale mas que
   * cualquier plan propio a largo plazo.
   *
   * El bot cuenta sus propias cartas de punto de victoria (las tiene en la
   * mano) pero de los rivales solo ve los puntos publicos, igual que un humano.
   */
  private endgameBonus(state: GameState, player: PlayerId, action: Action): number {
    const push = this.traits.endgame;
    if (push <= 0) return 0;

    const target = state.rules.victoryPoints;
    const mine = victoryPoints(state, player);
    const myGap = target - mine;

    let threat = 0;
    let threatId: PlayerId | null = null;
    for (const other of state.players) {
      if (other.id === player) continue;
      const gap = target - publicVictoryPoints(state, other.id);
      if (threatId === null || gap < threat) {
        threat = gap;
        threatId = other.id;
      }
    }

    let bonus = 0;

    // --- rematar ---
    if (myGap <= 3) {
      const urgency = (4 - myGap) * push;
      switch (action.type) {
        case 'buildSettlement':
        case 'buildCity':
          bonus += 22 * urgency;
          break;
        case 'buyDevCard':
          // Con el mazo cargado de puntos, comprar es una loteria que vale la
          // pena cuando falta poco.
          bonus += 10 * urgency;
          break;
        case 'playKnight':
          if (
            state.largestArmyHolder !== player &&
            state.players[player]!.knightsPlayed + 1 >= LARGEST_ARMY_MIN
          ) {
            bonus += 25 * urgency;
          }
          break;
        case 'buildRoad':
          // Solo si la ruta mas larga esta al alcance de verdad.
          if (
            state.longestRoadHolder !== player &&
            state.players[player]!.longestRoadLength >= 4
          ) {
            bonus += 14 * urgency;
          }
          break;
        default:
          break;
      }
    }

    // --- frenar al que va a ganar ---
    if (threatId !== null && threat <= 2) {
      const alarm = (3 - threat) * push;
      if (action.type === 'playKnight') bonus += 18 * alarm;
      if (action.type === 'moveRobber') {
        const hurts = state.board.hexes[action.hex]!.vertices.some(
          (v) => state.buildings[v]?.owner === threatId,
        );
        bonus += hurts ? 20 * alarm : -6 * alarm;
      }
      if (action.type === 'steal' && action.target === threatId) bonus += 12 * alarm;
      // Nada de regalarle cartas al lider.
      if (action.type === 'respondTrade' && state.activeTrade?.from === threatId) {
        bonus += action.accept ? -30 * alarm : 30 * alarm;
      }
    }

    return bonus;
  }

  // -------------------------------------------------------------------------
  // Construccion
  // -------------------------------------------------------------------------

  /**
   * Un camino no vale por si mismo: vale por adonde lleva. Se puntua por el
   * mejor cruce libre que abre, mas un extra si acerca la ruta comercial.
   */
  private roadDirectionScore(state: GameState, player: PlayerId, edge: string): number {
    const weights = this.weights(state, player);
    const [a, b] = parseEdgeId(edge);
    let best = 0;
    for (const end of [a, b]) {
      if (state.buildings[end]) continue;
      // El propio cruce y los que quedan a un paso mas.
      best = Math.max(best, this.reachableValue(state, end, weights, 1));
    }
    return best;
  }

  /** Mejor valor de cruce alcanzable desde `vertex` en `depth` pasos. */
  private reachableValue(
    state: GameState,
    vertex: VertexId,
    weights: VertexWeights,
    depth: number,
  ): number {
    const buildable = !state.buildings[vertex] && this.respectsDistance(state, vertex);
    let best = buildable ? vertexScore(state, vertex, weights) : 0;
    if (depth > 0) {
      for (const next of state.board.vertexNeighbors[vertex] ?? []) {
        // Un cruce mas lejos vale menos: cuesta otro camino llegar.
        best = Math.max(best, this.reachableValue(state, next, weights, depth - 1) * 0.65);
      }
    }
    return best;
  }

  private respectsDistance(state: GameState, vertex: VertexId): boolean {
    return (state.board.vertexNeighbors[vertex] ?? []).every((n) => !state.buildings[n]);
  }

  private buildRoadScore(state: GameState, player: PlayerId, edge: string): number {
    const free = state.pending?.type === 'roadBuilding';
    const direction = this.roadDirectionScore(state, player, edge);
    // Con la carta jugada hay que colocarlos si o si; en un turno normal el
    // camino compite con construir algo que puntue.
    const base = free ? 70 : 26;
    const longestRoadPush =
      state.longestRoadHolder !== player &&
      state.players[player]!.longestRoadLength >= 3 &&
      this.traits.aggression > 0
        ? 6
        : 0;
    return base + direction * 1.5 + longestRoadPush;
  }

  private devCardScore(state: GameState, player: PlayerId): number {
    const me = state.players[player]!;
    const can = affordable(state, player);
    // Si se puede construir algo de verdad, la carta espera.
    if (can.city || can.settlement) return 20 * this.traits.devCards;
    // Sin sitio donde crecer, el mazo es la unica via de puntos.
    const cramped = me.piecesLeft.settlement === 0 || me.piecesLeft.road === 0;
    const armyPush =
      me.knightsPlayed >= LARGEST_ARMY_MIN - 2 && state.largestArmyHolder !== player ? 12 : 0;
    const base = (48 + armyPush + (cramped ? 20 : 0)) * this.traits.devCards;
    return base - this.spendingPenalty(state, player, COSTS.devCard);
  }

  /**
   * Cuanto aleja un gasto de la construccion que ya estaba casi pagada.
   *
   * La carta de desarrollo cuesta lana, trigo y mineral: comprarla teniendo dos
   * mineral y un trigo tira por la borda la ciudad que venia de camino. Los
   * bots pacientes lo tienen en cuenta; los flojos, no.
   */
  private spendingPenalty(
    state: GameState,
    player: PlayerId,
    spend: ResourceCount,
  ): number {
    if (this.traits.patience <= 0) return 0;
    const hand = state.players[player]!.resources;
    const after = { ...hand };
    for (const resource of RESOURCES) after[resource] -= spend[resource];

    let penalty = 0;
    for (const [cost, weight] of [
      [COSTS.city, 26],
      [COSTS.settlement, 22],
    ] as const) {
      const before = totalMissing(missingFor(hand, cost));
      const now = totalMissing(missingFor(after, cost));
      // Solo importa si estaba a punto de conseguirse.
      if (before <= 2 && now > before) penalty += (now - before) * weight;
    }
    return penalty * this.traits.patience;
  }

  // -------------------------------------------------------------------------
  // Ladron y caballeros
  // -------------------------------------------------------------------------

  private knightScore(state: GameState, player: PlayerId): number {
    const me = state.players[player]!;
    // Quitarse el ladron de encima es urgente.
    const blocksMe = state.board.hexes[state.robber]!.vertices.some(
      (v) => state.buildings[v]?.owner === player,
    );
    const takesArmy =
      me.knightsPlayed + 1 >= LARGEST_ARMY_MIN &&
      state.largestArmyHolder !== player &&
      me.knightsPlayed + 1 >
        (state.largestArmyHolder !== null
          ? state.players[state.largestArmyHolder]!.knightsPlayed
          : 0);
    return 30 + (blocksMe ? 35 : 0) + (takesArmy ? 45 : 0);
  }

  /**
   * Donde poner el ladron: sobre la mejor casilla del rival mas peligroso, y
   * nunca sobre una propia. Los bots faciles se conforman con molestar a
   * cualquiera.
   */
  private robberScore(state: GameState, player: PlayerId, hex: string): number {
    const target = leader(state, player);
    let score = 0;
    let touchesMe = false;

    const hexData = state.board.hexes[hex]!;
    const pips = hexData.number === null ? 0 : pipsFor(hexData.number);
    const seen = new Set<PlayerId>();

    for (const vertex of hexData.vertices) {
      const building = state.buildings[vertex];
      if (!building) continue;
      if (building.owner === player) {
        touchesMe = true;
        continue;
      }
      const multiplier = building.kind === 'city' ? 2 : 1;
      const isTarget = building.owner === target;
      score += pips * multiplier * (isTarget ? 1 + this.traits.aggression : 1);
      if (!seen.has(building.owner)) {
        seen.add(building.owner);
        // Robar a quien tiene cartas es mejor que robar a quien no tiene.
        score += Math.min(handSize(state, building.owner), 5) * 0.6;
        score += publicVictoryPoints(state, building.owner) * this.traits.aggression;
      }
    }

    // Bloquearse a uno mismo es el error clasico del bot malo.
    if (touchesMe) score -= 40 * (1 - this.traits.noise / 20);
    // Una casilla sin nadie alrededor no sirve de nada.
    if (seen.size === 0) score -= 8;
    return score;
  }

  private victimScore(state: GameState, player: PlayerId, target: PlayerId): number {
    return (
      handSize(state, target) * 1.5 +
      publicVictoryPoints(state, target) * 2 * this.traits.aggression
    );
  }

  // -------------------------------------------------------------------------
  // Cartas con eleccion
  // -------------------------------------------------------------------------

  /**
   * El monopolio se elige contando cartas: el banco esta a la vista y el total
   * es fijo, asi que se sabe cuanto hay repartido de cada recurso sin mirar
   * ninguna mano.
   */
  private monopolyScore(state: GameState, player: PlayerId, resource: Resource): number {
    const pool = deduceOpponentPool(state, player);
    const weights = resourceWeights(state, player, this.traits.diversityPressure);
    return 15 + pool[resource] * 8 * weights[resource];
  }

  private yearOfPlentyScore(
    state: GameState,
    player: PlayerId,
    picked: readonly [Resource, Resource],
  ): number {
    const hand = state.players[player]!.resources;
    // Se valora por lo cerca que deja de la mejor construccion posible.
    const after = { ...hand };
    for (const resource of picked) after[resource]++;

    let best = 0;
    for (const [cost, value] of [
      [COSTS.city, 60],
      [COSTS.settlement, 55],
      [COSTS.devCard, 30],
      [COSTS.road, 15],
    ] as const) {
      const before = totalMissing(missingFor(hand, cost));
      const now = totalMissing(missingFor(after, cost));
      if (now === 0 && before > 0) best = Math.max(best, value);
      else best = Math.max(best, (before - now) * value * 0.2);
    }
    return 20 + best;
  }

  // -------------------------------------------------------------------------
  // Comercio
  // -------------------------------------------------------------------------

  private bankTradeScore(
    state: GameState,
    player: PlayerId,
    give: Resource,
    want: Resource,
  ): number {
    if (!this.traits.planahead) return 4;
    // Solo interesa si completa una construccion concreta.
    for (const [cost, value] of [
      [COSTS.city, 62],
      [COSTS.settlement, 58],
      [COSTS.devCard, 28],
    ] as const) {
      const move = bankTradeTowards(state, player, cost);
      if (move && move.give === give && move.want === want) return value;
    }
    // Deshacerse de un excedente grande tampoco esta mal, siempre que no se
    // este vendiendo justo lo que falta para construir.
    const hand = state.players[player]!.resources;
    const weights = resourceWeights(state, player, this.traits.diversityPressure);
    if (hand[give] >= 6 && weights[want] > weights[give]) {
      const spend = { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 };
      spend[give] = tradeRatio(state, player, give);
      return 12 - this.spendingPenalty(state, player, spend);
    }
    return 3;
  }

  private tradeResponseScore(state: GameState, player: PlayerId, accept: boolean): number {
    const trade = state.activeTrade;
    if (!trade) return 0;
    const weights = resourceWeights(state, player, this.traits.diversityPressure);
    // El bot valora lo que recibe frente a lo que entrega, con su margen.
    const gain = weighted(trade.give, weights);
    const cost = weighted(trade.want, weights) * this.traits.tradeGreed;
    const worthIt = gain > cost;
    return accept === worthIt ? 50 : 10;
  }

  // -------------------------------------------------------------------------
  // Descarte
  // -------------------------------------------------------------------------

  /**
   * Al descartar por un 7 se conserva lo que hace falta para la mejor
   * construccion al alcance y se suelta lo demas, empezando por lo que mas
   * sobra.
   */
  chooseDiscard(
    state: GameState,
    player: PlayerId,
    amount: number,
  ): Partial<ResourceCount> {
    const hand = { ...state.players[player]!.resources };
    const weights = resourceWeights(state, player, this.traits.diversityPressure);

    // Objetivo: lo mas caro que casi se puede pagar.
    const goal = this.traits.planahead ? this.bestGoal(hand) : COSTS.road;
    const keep = { ...goal };

    const discard: Partial<ResourceCount> = {};
    for (let i = 0; i < amount; i++) {
      let choice: Resource | null = null;
      let worst = -Infinity;
      for (const resource of RESOURCES) {
        if (hand[resource] <= 0) continue;
        const protectedCards = Math.min(keep[resource], hand[resource]);
        const spare = hand[resource] - protectedCards;
        // Tirar primero lo que sobra, y dentro de eso lo que menos vale.
        const penalty = spare > 0 ? 0 : 10;
        const value = spare * 2 - weights[resource] - penalty;
        if (value > worst) {
          worst = value;
          choice = resource;
        }
      }
      if (!choice) break;
      hand[choice]--;
      discard[choice] = (discard[choice] ?? 0) + 1;
    }
    return discard;
  }

  /** La construccion mas valiosa a la que la mano se acerca. */
  private bestGoal(hand: ResourceCount): ResourceCount {
    const options = [COSTS.city, COSTS.settlement, COSTS.devCard, COSTS.road] as const;
    let best: ResourceCount = COSTS.road;
    let bestGap = Infinity;
    for (const cost of options) {
      const gap = totalMissing(missingFor(hand, cost));
      if (gap < bestGap) {
        bestGap = gap;
        best = cost;
      }
    }
    return best;
  }

  respondToTrade(state: GameState, player: PlayerId): boolean {
    const trade = state.activeTrade;
    if (!trade) return false;
    const weights = resourceWeights(state, player, this.traits.diversityPressure);
    return (
      weighted(trade.give, weights) > weighted(trade.want, weights) * this.traits.tradeGreed
    );
  }
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function totalMissing(missing: ResourceCount): number {
  return RESOURCES.reduce((sum, r) => sum + missing[r], 0);
}

function weighted(
  delta: Partial<ResourceCount>,
  weights: Record<Resource, number>,
): number {
  return RESOURCES.reduce((sum, r) => sum + (delta[r] ?? 0) * weights[r] * CARD_VALUE, 0);
}

/** Fabrica de bots por dificultad. */
export function createBot(difficulty: BotDifficulty, seed: number): Bot {
  return new HeuristicBot(difficulty, seed);
}

/** Reexportado por comodidad para quien solo quiera el perfil de produccion. */
export { productionProfile, TERRAIN_YIELD };
