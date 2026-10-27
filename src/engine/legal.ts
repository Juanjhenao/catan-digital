import { fail, OK, type Action, type ActionType, type Validation } from './actions.js';
import { COSTS } from './constants.js';
import { parseEdgeId } from './hex.js';
import {
  countPartial,
  devDeckSize,
  handVisible,
  hasResources,
  totalResources,
} from './state.js';
import type {
  EdgeId,
  GameState,
  HexId,
  PlayerId,
  Resource,
  ResourceCount,
  VertexId,
} from './types.js';
import { RESOURCES } from './types.js';

// ---------------------------------------------------------------------------
// Consultas de tablero
// ---------------------------------------------------------------------------

/** Regla de distancia: no puede haber otro edificio en un cruce contiguo. */
export function respectsDistanceRule(state: GameState, vertex: VertexId): boolean {
  if (state.buildings[vertex]) return false;
  for (const neighbor of state.board.vertexNeighbors[vertex] ?? []) {
    if (state.buildings[neighbor]) return false;
  }
  return true;
}

/**
 * Un camino puede salir de un cruce si el jugador tiene alli un edificio, o si
 * tiene un camino que llega al cruce y ningun rival lo ha bloqueado con un
 * poblado o ciudad (no se puede atravesar un asentamiento enemigo).
 */
function canExtendFrom(state: GameState, player: PlayerId, vertex: VertexId): boolean {
  const building = state.buildings[vertex];
  if (building) return building.owner === player;
  return (state.board.vertexEdges[vertex] ?? []).some(
    (e) => state.roads[e]?.owner === player,
  );
}

export function canPlaceRoad(
  state: GameState,
  player: PlayerId,
  edge: EdgeId,
): Validation {
  if (!state.board.edgeVertices[edge]) return fail('Esa arista no existe en el tablero');
  if (state.roads[edge]) return fail('Ya hay un camino ahi');
  if (state.players[player]!.piecesLeft.road <= 0) return fail('No te quedan caminos');
  const [a, b] = parseEdgeId(edge);
  if (!canExtendFrom(state, player, a) && !canExtendFrom(state, player, b)) {
    return fail('El camino debe conectar con otro camino o edificio tuyo');
  }
  return OK;
}

/** Hay al menos una arista donde el jugador podria poner un camino. */
export function hasLegalRoadPlacement(state: GameState, player: PlayerId): boolean {
  return Object.keys(state.board.edgeVertices).some(
    (edge) => canPlaceRoad(state, player, edge).ok,
  );
}

export function canPlaceSettlement(
  state: GameState,
  player: PlayerId,
  vertex: VertexId,
  duringSetup: boolean,
): Validation {
  if (!state.board.vertexHexes[vertex]) return fail('Ese cruce no existe en el tablero');
  if (state.buildings[vertex]) return fail('El cruce ya esta ocupado');
  if (!respectsDistanceRule(state, vertex)) {
    return fail('Debe haber al menos dos cruces de distancia con otro poblado');
  }
  if (state.players[player]!.piecesLeft.settlement <= 0) return fail('No te quedan poblados');
  if (!duringSetup) {
    const connected = (state.board.vertexEdges[vertex] ?? []).some(
      (e) => state.roads[e]?.owner === player,
    );
    if (!connected) return fail('El poblado debe tocar uno de tus caminos');
  }
  return OK;
}

export function canBuildCity(
  state: GameState,
  player: PlayerId,
  vertex: VertexId,
): Validation {
  const building = state.buildings[vertex];
  if (!building) return fail('Ahi no hay ningun poblado');
  if (building.owner !== player) return fail('Ese poblado no es tuyo');
  if (building.kind === 'city') return fail('Ya es una ciudad');
  if (state.players[player]!.piecesLeft.city <= 0) return fail('No te quedan ciudades');
  return OK;
}

// ---------------------------------------------------------------------------
// Comercio con el banco
// ---------------------------------------------------------------------------

/** Mejor ratio disponible para vender un recurso: 2 (puerto propio), 3 o 4. */
export function tradeRatio(state: GameState, player: PlayerId, give: Resource): number {
  const ports = state.players[player]!.ports;
  if (ports.includes(give)) return 2;
  if (ports.includes('generic')) return 3;
  return 4;
}

export function canBankTrade(
  state: GameState,
  player: PlayerId,
  give: Resource,
  want: Resource,
): Validation {
  if (give === want) return fail('No tiene sentido cambiar un recurso por si mismo');
  const ratio = tradeRatio(state, player, give);
  if (state.players[player]!.resources[give] < ratio) {
    return fail(`Necesitas ${ratio} de ese recurso para el cambio`);
  }
  if (state.bank[want] < 1) return fail('El banco no tiene ese recurso');
  return OK;
}

// ---------------------------------------------------------------------------
// Fases: en que fase puede actuar cada quien
// ---------------------------------------------------------------------------

/** Fase en la que se puede construir/comprar: la principal, y en tu turno. */
function isBuildingPhase(state: GameState, player: PlayerId): boolean {
  return state.phase === 'main' && state.currentPlayer === player;
}

function canAfford(state: GameState, player: PlayerId, cost: ResourceCount): boolean {
  return hasResources(state.players[player]!.resources, cost);
}

/** Casillas validas para el ladron: cualquiera distinta de la actual. */
export function robberTargets(state: GameState): HexId[] {
  return state.board.hexOrder.filter((id) => id !== state.robber);
}

/**
 * Jugadores a los que se puede robar tras colocar el ladron: los que tienen un
 * edificio tocando la casilla, no son el ladron y tienen alguna carta.
 */
export function stealCandidates(
  state: GameState,
  hex: HexId,
  thief: PlayerId,
): PlayerId[] {
  const targets = new Set<PlayerId>();
  for (const vertex of state.board.hexes[hex]!.vertices) {
    const building = state.buildings[vertex];
    if (!building || building.owner === thief) continue;
    if (totalResources(state.players[building.owner]!.resources) > 0) {
      targets.add(building.owner);
    }
  }
  return [...targets].sort((a, b) => a - b);
}

/**
 * Si el jugador esta en condiciones de abrir una negociacion.
 *
 * `getLegalActions` no enumera ofertas a proposito: el espacio de
 * combinaciones posibles es enorme. Por eso hace falta esta consulta aparte,
 * que es la que usa la interfaz para decidir si el boton de ofrecer esta
 * disponible, y la que un bot usara para saber si tiene sentido proponer algo.
 * `validate` la reutiliza, de modo que la condicion vive en un unico sitio y
 * no puede desincronizarse de lo que se ofrece al jugador.
 */
export function canOfferTrade(state: GameState, player: PlayerId): boolean {
  if (!state.rules.playerTrade) return false;
  if (state.phase !== 'main') return false;
  if (state.currentPlayer !== player) return false;
  if (state.pending) return false;
  if (state.activeTrade) return false;
  // Sin nada en la mano no hay nada que ofrecer.
  return totalResources(state.players[player]!.resources) > 0;
}

/** Cuantas cartas debe descartar un jugador con un 7 (la mitad, redondeando abajo). */
export function discardAmount(state: GameState, player: PlayerId): number {
  const total = totalResources(state.players[player]!.resources);
  return total > state.rules.discardLimit ? Math.floor(total / 2) : 0;
}

// ---------------------------------------------------------------------------
// Validacion general
// ---------------------------------------------------------------------------

/** Lo unico que se puede hacer mientras hay una oferta sobre la mesa. */
const TRADE_ACTIONS = new Set<ActionType>(['respondTrade', 'confirmTrade', 'cancelTrade']);

export function validate(state: GameState, action: Action): Validation {
  if (state.phase === 'gameOver') return fail('La partida ya termino');
  const player = state.players[action.player];
  if (!player) return fail('Jugador inexistente');

  // La carta de carreteras deja el turno a medias. Hasta colocar los caminos
  // pendientes no se puede hacer ninguna otra cosa: si no, jugarla y tirar los
  // dados a continuacion arrastraria el pendiente hasta la fase de descarte, y
  // el jugador acabaria construyendo gratis en mitad de la resolucion del 7.
  if (state.pending?.type === 'roadBuilding' && action.type !== 'buildRoad') {
    return fail('Coloca primero los caminos de la carta');
  }

  // Una oferta sobre la mesa congela el turno igual: hasta cerrarla o
  // retirarla no se hace nada mas. Sin esto se puede, por ejemplo, jugar un
  // caballero con la oferta viva y acabar con la ventana de negociacion
  // tapando el tablero justo cuando toca mover el ladron.
  if (state.activeTrade && !TRADE_ACTIONS.has(action.type)) {
    return fail('Resuelve primero la oferta que hay sobre la mesa');
  }

  switch (action.type) {
    // --- Colocacion inicial -------------------------------------------------
    case 'setupSettlement': {
      if (state.phase !== 'setupSettlement') return fail('No toca colocar poblado');
      if (state.currentPlayer !== action.player) return fail('No es tu turno');
      return canPlaceSettlement(state, action.player, action.vertex, true);
    }
    case 'setupRoad': {
      if (state.phase !== 'setupRoad') return fail('No toca colocar camino');
      if (state.currentPlayer !== action.player) return fail('No es tu turno');
      if (state.roads[action.edge]) return fail('Ya hay un camino ahi');
      const anchor = state.lastSetupVertex;
      if (!anchor) return fail('Falta el poblado de referencia');
      const [a, b] = parseEdgeId(action.edge);
      if (a !== anchor && b !== anchor) {
        return fail('El primer camino debe salir del poblado recien colocado');
      }
      return OK;
    }

    // --- Dados --------------------------------------------------------------
    case 'rollDice': {
      if (state.phase !== 'roll') return fail('No toca tirar los dados');
      if (state.currentPlayer !== action.player) return fail('No es tu turno');
      return OK;
    }

    // --- Ladron -------------------------------------------------------------
    case 'discard': {
      if (state.phase !== 'discard') return fail('No toca descartar');
      if (!state.mustDiscard.includes(action.player)) return fail('Tu no tienes que descartar');
      const need = discardAmount(state, action.player);
      if (countPartial(action.resources) !== need) {
        return fail(`Debes descartar exactamente ${need} cartas`);
      }
      if (!hasResources(player.resources, action.resources)) {
        return fail('No tienes esas cartas');
      }
      return OK;
    }
    case 'moveRobber': {
      if (state.phase !== 'moveRobber') return fail('No toca mover el ladron');
      if (state.currentPlayer !== action.player) return fail('No es tu turno');
      if (!state.board.hexes[action.hex]) return fail('Esa casilla no existe');
      if (action.hex === state.robber) return fail('El ladron debe cambiar de casilla');
      return OK;
    }
    case 'steal': {
      if (state.phase !== 'steal') return fail('No toca robar');
      if (state.currentPlayer !== action.player) return fail('No es tu turno');
      if (action.target === null) {
        return state.stealTargets.length === 0 ? OK : fail('Debes elegir a quien robar');
      }
      if (!state.stealTargets.includes(action.target)) return fail('Ese jugador no es valido');
      return OK;
    }

    // --- Construccion -------------------------------------------------------
    case 'buildRoad': {
      // Los caminos de la carta "construccion de carreteras" son gratis.
      const free = state.pending?.type === 'roadBuilding';
      if (free) {
        if (state.currentPlayer !== action.player) return fail('No es tu turno');
      } else {
        if (!isBuildingPhase(state, action.player)) return fail('No puedes construir ahora');
        if (!canAfford(state, action.player, COSTS.road)) return fail('Te faltan recursos');
      }
      return canPlaceRoad(state, action.player, action.edge);
    }
    case 'buildSettlement': {
      if (!isBuildingPhase(state, action.player)) return fail('No puedes construir ahora');
      if (!canAfford(state, action.player, COSTS.settlement)) return fail('Te faltan recursos');
      return canPlaceSettlement(state, action.player, action.vertex, false);
    }
    case 'buildCity': {
      if (!isBuildingPhase(state, action.player)) return fail('No puedes construir ahora');
      if (!canAfford(state, action.player, COSTS.city)) return fail('Te faltan recursos');
      return canBuildCity(state, action.player, action.vertex);
    }
    case 'buyDevCard': {
      if (!isBuildingPhase(state, action.player)) return fail('No puedes comprar ahora');
      // Por el TAMANO, no por el array: en red el mazo llega vacio a cada
      // cliente (su orden es la proxima carta de todo el mundo) y mirar
      // `devDeck.length` dejaba el boton de comprar apagado para siempre.
      if (devDeckSize(state) === 0) return fail('El mazo de desarrollo esta vacio');
      if (!canAfford(state, action.player, COSTS.devCard)) return fail('Te faltan recursos');
      return OK;
    }

    // --- Cartas de desarrollo ----------------------------------------------
    case 'playKnight':
    case 'playRoadBuilding':
    case 'playYearOfPlenty':
    case 'playMonopoly': {
      const kind = (
        {
          playKnight: 'knight',
          playRoadBuilding: 'roadBuilding',
          playYearOfPlenty: 'yearOfPlenty',
          playMonopoly: 'monopoly',
        } as const
      )[action.type];
      // Se puede jugar antes o despues de tirar, pero solo una por turno.
      if (state.phase !== 'main' && state.phase !== 'roll') {
        return fail('No puedes jugar cartas ahora');
      }
      if (state.currentPlayer !== action.player) return fail('No es tu turno');
      if (player.playedDevCardThisTurn) return fail('Ya jugaste una carta este turno');
      if (state.pending) return fail('Termina primero la carta en curso');
      const usable = player.devCards.some(
        (c) => c.kind === kind && c.boughtOnTurn < state.turn,
      );
      if (!usable) return fail('No tienes esa carta disponible este turno');
      if (action.type === 'playYearOfPlenty') {
        for (const r of action.resources) {
          if (state.bank[r] < 1) return fail('El banco no tiene ese recurso');
        }
        const [first, second] = action.resources;
        if (first === second && state.bank[first] < 2) {
          return fail('El banco no tiene suficientes cartas');
        }
      }
      return OK;
    }

    // --- Comercio -----------------------------------------------------------
    case 'bankTrade': {
      if (state.phase !== 'main' || state.currentPlayer !== action.player) {
        return fail('No puedes comerciar ahora');
      }
      return canBankTrade(state, action.player, action.give, action.want);
    }
    case 'offerTrade': {
      if (!canOfferTrade(state, action.player)) {
        return fail('No puedes proponer un intercambio ahora');
      }
      if (countPartial(action.give) === 0 || countPartial(action.want) === 0) {
        return fail('La oferta debe tener algo a cada lado');
      }
      if (!hasResources(player.resources, action.give)) return fail('No tienes lo que ofreces');
      return OK;
    }
    case 'respondTrade': {
      const trade = state.activeTrade;
      if (!trade) return fail('No hay ninguna oferta activa');
      if (action.player === trade.from) return fail('No puedes responder a tu propia oferta');
      if (trade.responses[action.player] !== 'pending') return fail('Ya respondiste');
      if (action.accept && !hasResources(player.resources, trade.want)) {
        return fail('No tienes lo que se pide');
      }
      return OK;
    }
    case 'confirmTrade': {
      const trade = state.activeTrade;
      if (!trade) return fail('No hay ninguna oferta activa');
      if (trade.from !== action.player) return fail('Solo quien ofrece puede cerrar el trato');
      if (trade.responses[action.with] !== 'accepted') return fail('Ese jugador no acepto');
      // La mano del otro solo se juzga si se ve. En red no se ve: llega vacia,
      // y darla por buena aqui hacia que «Cerrar trato» se rechazara SIEMPRE
      // en el propio cliente, sin llegar a salir a la red. El servidor tiene el
      // estado entero y esta misma comprobacion, que es la que decide.
      if (
        handVisible(state, action.with) &&
        !hasResources(state.players[action.with]!.resources, trade.want)
      ) {
        return fail('El otro jugador ya no tiene lo pactado');
      }
      if (!hasResources(player.resources, trade.give)) return fail('Ya no tienes lo ofrecido');
      return OK;
    }
    case 'cancelTrade': {
      if (!state.activeTrade) return fail('No hay ninguna oferta activa');
      if (state.activeTrade.from !== action.player) return fail('No es tu oferta');
      return OK;
    }

    // --- Flujo --------------------------------------------------------------
    case 'endTurn': {
      if (state.phase !== 'main') return fail('Aun no puedes terminar el turno');
      if (state.currentPlayer !== action.player) return fail('No es tu turno');
      if (state.pending) return fail('Termina primero la carta en curso');
      return OK;
    }
  }
}

export function isLegal(state: GameState, action: Action): boolean {
  return validate(state, action).ok;
}

/**
 * Quien tiene que actuar ahora mismo. Casi siempre es un solo jugador, pero
 * hay dos momentos con varios a la vez: el descarte tras un 7 y la respuesta a
 * una oferta de comercio. Tanto la interfaz como el bucle de bots usan esto
 * para saber a quien pedirle una decision.
 */
export function playersToAct(state: GameState): PlayerId[] {
  switch (state.phase) {
    case 'discard':
      return [...state.mustDiscard];
    case 'gameOver':
      return [];
    case 'main': {
      const trade = state.activeTrade;
      if (trade) {
        const pending = Object.entries(trade.responses)
          .filter(([, r]) => r === 'pending')
          .map(([id]) => Number(id));
        // Mientras queden respuestas pendientes deciden ellos; cuando todos han
        // contestado vuelve a decidir quien hizo la oferta.
        return pending.length > 0 ? pending : [trade.from];
      }
      return [state.currentPlayer];
    }
    default:
      return [state.currentPlayer];
  }
}

// ---------------------------------------------------------------------------
// Enumeracion de acciones legales (base para los bots)
// ---------------------------------------------------------------------------

/**
 * Devuelve todas las acciones legales *completamente especificadas* de un
 * jugador. Se excluyen a proposito dos familias de espacio combinatorio
 * enorme, que un bot debe construir con sus propios heuristicos y validar con
 * `validate()`:
 *   - `discard`: repartos posibles de la mitad de la mano.
 *   - `offerTrade`: cualquier combinacion de oferta a otros jugadores.
 */
export function getLegalActions(state: GameState, player: PlayerId): Action[] {
  const actions: Action[] = [];
  const push = (action: Action) => {
    if (validate(state, action).ok) actions.push(action);
  };

  // La carta de carreteras puede jugarse antes de tirar los dados, asi que su
  // pendiente manda sobre la fase en curso.
  if (state.pending?.type === 'roadBuilding') {
    if (state.currentPlayer === player) pushRoads(state, player, push);
    return actions;
  }

  switch (state.phase) {
    case 'setupSettlement': {
      if (state.currentPlayer !== player) break;
      for (const vertex of Object.keys(state.board.vertexHexes)) {
        push({ type: 'setupSettlement', player, vertex });
      }
      break;
    }
    case 'setupRoad': {
      if (state.currentPlayer !== player) break;
      const anchor = state.lastSetupVertex;
      if (anchor) {
        for (const edge of state.board.vertexEdges[anchor] ?? []) {
          push({ type: 'setupRoad', player, edge });
        }
      }
      break;
    }
    case 'roll': {
      if (state.currentPlayer !== player) break;
      push({ type: 'rollDice', player });
      pushDevCardPlays(state, player, push);
      break;
    }
    case 'moveRobber': {
      if (state.currentPlayer !== player) break;
      for (const hex of robberTargets(state)) push({ type: 'moveRobber', player, hex });
      break;
    }
    case 'steal': {
      if (state.currentPlayer !== player) break;
      if (state.stealTargets.length === 0) push({ type: 'steal', player, target: null });
      for (const target of state.stealTargets) push({ type: 'steal', player, target });
      break;
    }
    case 'main': {
      if (state.activeTrade) {
        if (state.activeTrade.from === player) {
          for (const [id, response] of Object.entries(state.activeTrade.responses)) {
            if (response === 'accepted') push({ type: 'confirmTrade', player, with: Number(id) });
          }
          push({ type: 'cancelTrade', player });
        } else {
          push({ type: 'respondTrade', player, accept: true });
          push({ type: 'respondTrade', player, accept: false });
        }
        break;
      }
      if (state.currentPlayer !== player) break;
      pushBuilds(state, player, push);
      pushBankTrades(state, player, push);
      pushDevCardPlays(state, player, push);
      push({ type: 'endTurn', player });
      break;
    }
    case 'discard': {
      // Espacio combinatorio: lo construye el llamante (ver doc arriba).
      break;
    }
    default:
      break;
  }

  return actions;
}

function pushRoads(state: GameState, player: PlayerId, push: (a: Action) => void): void {
  for (const edge of Object.keys(state.board.edgeVertices)) {
    push({ type: 'buildRoad', player, edge });
  }
}

function pushBuilds(state: GameState, player: PlayerId, push: (a: Action) => void): void {
  pushRoads(state, player, push);
  for (const vertex of Object.keys(state.board.vertexHexes)) {
    push({ type: 'buildSettlement', player, vertex });
    push({ type: 'buildCity', player, vertex });
  }
  push({ type: 'buyDevCard', player });
}

function pushBankTrades(state: GameState, player: PlayerId, push: (a: Action) => void): void {
  for (const give of RESOURCES) {
    for (const want of RESOURCES) {
      if (give !== want) push({ type: 'bankTrade', player, give, want });
    }
  }
}

function pushDevCardPlays(
  state: GameState,
  player: PlayerId,
  push: (a: Action) => void,
): void {
  push({ type: 'playKnight', player });
  push({ type: 'playRoadBuilding', player });
  for (const resource of RESOURCES) push({ type: 'playMonopoly', player, resource });
  for (let i = 0; i < RESOURCES.length; i++) {
    for (let j = i; j < RESOURCES.length; j++) {
      push({
        type: 'playYearOfPlenty',
        player,
        resources: [RESOURCES[i]!, RESOURCES[j]!],
      });
    }
  }
}

/** Reparto de descarte valido mas simple: quita las cartas mas abundantes. */
export function defaultDiscard(
  resources: ResourceCount,
  amount: number,
): Partial<ResourceCount> {
  const remaining = { ...resources };
  const out: Partial<ResourceCount> = {};
  for (let i = 0; i < amount; i++) {
    let pick: Resource | null = null;
    for (const r of RESOURCES) {
      if (remaining[r] > 0 && (pick === null || remaining[r] > remaining[pick])) pick = r;
    }
    if (!pick) break;
    remaining[pick]--;
    out[pick] = (out[pick] ?? 0) + 1;
  }
  return out;
}
