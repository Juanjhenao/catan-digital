import type { Action } from './actions.js';
import { COSTS } from './constants.js';
import { parseEdgeId } from './hex.js';
import { hasLegalRoadPlacement, stealCandidates, tradeRatio, validate } from './legal.js';
import { recomputeLongestRoad } from './longest-road.js';
import { nextInt, rollDie } from './rng.js';
import {
  handAsList,
  recomputeLargestArmy,
  totalResources,
  victoryPoints,
} from './state.js';
import type {
  DevCardKind,
  GameState,
  LogEntry,
  PlayerId,
  PlayerState,
  Resource,
  ResourceCount,
  VertexId,
} from './types.js';
import { RESOURCES, TERRAIN_YIELD } from './types.js';

// ---------------------------------------------------------------------------
// Clonado
// ---------------------------------------------------------------------------

/**
 * El reducer trabaja sobre una copia y la muta libremente: mucho mas legible
 * que encadenar actualizaciones inmutables, y desde fuera el comportamiento es
 * el mismo (el estado de entrada nunca cambia). El tablero es inmutable una vez
 * generado, asi que se comparte por referencia en lugar de copiarse.
 */
function clone(state: GameState): GameState {
  return {
    ...state,
    rules: { ...state.rules },
    board: state.board,
    players: state.players.map((p) => ({
      ...p,
      resources: { ...p.resources },
      devCards: p.devCards.map((c) => ({ ...c })),
      piecesLeft: { ...p.piecesLeft },
      buildings: [...p.buildings],
      roads: [...p.roads],
      ports: [...p.ports],
    })),
    bank: { ...state.bank },
    devDeck: [...state.devDeck],
    buildings: { ...state.buildings },
    roads: { ...state.roads },
    mustDiscard: [...state.mustDiscard],
    stealTargets: [...state.stealTargets],
    activeTrade: state.activeTrade
      ? {
          ...state.activeTrade,
          give: { ...state.activeTrade.give },
          want: { ...state.activeTrade.want },
          responses: { ...state.activeTrade.responses },
        }
      : null,
    turnOrder: [...state.turnOrder],
    setupOrder: [...state.setupOrder],
    rng: { ...state.rng },
    log: [...state.log],
    pending: state.pending ? { ...state.pending } : null,
    dice: state.dice ? [state.dice[0], state.dice[1]] : null,
  };
}

const RESOURCE_NAMES: Record<Resource, string> = {
  lumber: 'madera',
  brick: 'arcilla',
  wool: 'lana',
  grain: 'trigo',
  ore: 'mineral',
};

function describeResources(delta: Partial<ResourceCount>): string {
  const parts = RESOURCES.filter((r) => (delta[r] ?? 0) > 0).map(
    (r) => `${delta[r]} ${RESOURCE_NAMES[r]}`,
  );
  return parts.length ? parts.join(', ') : 'nada';
}

function log(state: GameState, player: PlayerId | null, text: string, tone: LogEntry['tone']) {
  state.log.push({ turn: state.turn, player, text, tone });
  // El registro completo no aporta nada mas alla de unos cientos de lineas.
  if (state.log.length > 400) state.log.splice(0, state.log.length - 400);
}

function pay(state: GameState, player: PlayerState, cost: ResourceCount) {
  for (const r of RESOURCES) {
    player.resources[r] -= cost[r];
    state.bank[r] += cost[r];
  }
}

/** Entrega recursos del banco, limitando a lo que realmente queda. */
function grant(state: GameState, player: PlayerState, resource: Resource, amount: number) {
  const given = Math.min(amount, state.bank[resource]);
  state.bank[resource] -= given;
  player.resources[resource] += given;
  return given;
}

// ---------------------------------------------------------------------------
// Punto de entrada
// ---------------------------------------------------------------------------

export interface ApplyResult {
  state: GameState;
  ok: boolean;
  error?: string;
}

/** Aplica una accion si es legal. Nunca lanza por acciones invalidas. */
export function applyAction(state: GameState, action: Action): ApplyResult {
  const check = validate(state, action);
  if (!check.ok) return { state, ok: false, error: check.reason };

  const next = clone(state);
  reduce(next, action);
  return { state: next, ok: true };
}

/** Variante estricta: lanza si la accion es ilegal. Comoda en tests. */
export function applyOrThrow(state: GameState, action: Action): GameState {
  const result = applyAction(state, action);
  if (!result.ok) throw new Error(`Accion ilegal (${action.type}): ${result.error}`);
  return result.state;
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function reduce(s: GameState, action: Action): void {
  const player = s.players[action.player]!;

  switch (action.type) {
    case 'setupSettlement': {
      placeSettlement(s, player, action.vertex, 'settlement');
      const secondRound = s.setupIndex >= s.players.length;
      if (secondRound) {
        // El segundo poblado reparte los recursos de sus casillas.
        const gained: Partial<ResourceCount> = {};
        for (const hexId of s.board.vertexHexes[action.vertex] ?? []) {
          const resource = TERRAIN_YIELD[s.board.hexes[hexId]!.terrain];
          if (!resource) continue;
          grant(s, player, resource, 1);
          gained[resource] = (gained[resource] ?? 0) + 1;
        }
        log(s, player.id, `recibe ${describeResources(gained)} de su segundo poblado`, 'build');
      } else {
        log(s, player.id, 'coloca su primer poblado', 'build');
      }
      s.lastSetupVertex = action.vertex;
      s.phase = 'setupRoad';
      break;
    }

    case 'setupRoad': {
      placeRoad(s, player, action.edge);
      log(s, player.id, 'coloca un camino', 'build');
      s.lastSetupVertex = null;
      s.setupIndex++;
      if (s.setupIndex < s.setupOrder.length) {
        s.currentPlayer = s.setupOrder[s.setupIndex]!;
        s.phase = 'setupSettlement';
      } else {
        // Fin de la colocacion: empieza la partida.
        s.turn = 1;
        s.currentPlayer = s.turnOrder[0]!;
        s.phase = 'roll';
        log(s, null, 'Comienza la partida', 'info');
      }
      refreshLongestRoad(s);
      break;
    }

    case 'rollDice': {
      const [d1, afterFirst] = rollDie(s.rng);
      const [d2, afterSecond] = rollDie(afterFirst);
      s.rng = afterSecond;
      s.dice = [d1, d2];
      const sum = d1 + d2;
      log(s, player.id, `tira los dados: ${d1} + ${d2} = ${sum}`, 'dice');

      if (sum === 7) {
        s.mustDiscard = s.players
          .filter((p) => totalResources(p.resources) > s.rules.discardLimit)
          .map((p) => p.id);
        if (s.mustDiscard.length > 0) {
          s.phase = 'discard';
          log(s, null, 'Sale un 7: hay que descartar', 'robber');
        } else {
          s.phase = 'moveRobber';
          log(s, player.id, 'mueve el ladron', 'robber');
        }
      } else {
        distributeResources(s, sum);
        s.phase = 'main';
      }
      break;
    }

    case 'discard': {
      for (const r of RESOURCES) {
        const amount = action.resources[r] ?? 0;
        player.resources[r] -= amount;
        s.bank[r] += amount;
      }
      log(s, player.id, `descarta ${describeResources(action.resources)}`, 'robber');
      s.mustDiscard = s.mustDiscard.filter((id) => id !== action.player);
      if (s.mustDiscard.length === 0) s.phase = 'moveRobber';
      break;
    }

    case 'moveRobber': {
      s.robber = action.hex;
      s.stealTargets = stealCandidates(s, action.hex, action.player);
      log(s, player.id, 'mueve el ladron', 'robber');
      if (s.stealTargets.length > 0) {
        s.phase = 'steal';
      } else {
        finishRobber(s);
      }
      break;
    }

    case 'steal': {
      if (action.target !== null) {
        const victim = s.players[action.target]!;
        const hand = handAsList(victim.resources);
        if (hand.length > 0) {
          const [index, rng] = nextInt(s.rng, hand.length);
          s.rng = rng;
          const stolen = hand[index]!;
          victim.resources[stolen]--;
          player.resources[stolen]++;
          log(s, player.id, `roba una carta a ${victim.name}`, 'robber');
        }
      }
      s.stealTargets = [];
      finishRobber(s);
      break;
    }

    case 'buildRoad': {
      const free = s.pending?.type === 'roadBuilding';
      if (!free) pay(s, player, COSTS.road);
      placeRoad(s, player, action.edge);
      log(s, player.id, free ? 'construye un camino gratis' : 'construye un camino', 'build');
      if (s.pending?.type === 'roadBuilding') {
        const left = s.pending.roadsLeft - 1;
        // Si no queda camino que colocar (sin piezas o sin hueco legal), la
        // carta se agota aqui: si no, el jugador se quedaria bloqueado.
        const canContinue =
          left > 0 && player.piecesLeft.road > 0 && hasLegalRoadPlacement(s, player.id);
        s.pending = canContinue ? { type: 'roadBuilding', roadsLeft: left } : null;
      }
      refreshLongestRoad(s);
      checkVictory(s, player.id);
      break;
    }

    case 'buildSettlement': {
      pay(s, player, COSTS.settlement);
      placeSettlement(s, player, action.vertex, 'settlement');
      log(s, player.id, 'construye un poblado', 'build');
      // Un poblado nuevo puede partir en dos el camino de un rival.
      refreshLongestRoad(s);
      checkVictory(s, player.id);
      break;
    }

    case 'buildCity': {
      pay(s, player, COSTS.city);
      const building = s.buildings[action.vertex]!;
      s.buildings[action.vertex] = { ...building, kind: 'city' };
      player.piecesLeft.city--;
      player.piecesLeft.settlement++; // el poblado vuelve a la reserva
      log(s, player.id, 'mejora un poblado a ciudad', 'build');
      checkVictory(s, player.id);
      break;
    }

    case 'buyDevCard': {
      pay(s, player, COSTS.devCard);
      const card = s.devDeck.pop() as DevCardKind;
      player.devCards.push({ kind: card, boughtOnTurn: s.turn });
      log(s, player.id, 'compra una carta de desarrollo', 'card');
      checkVictory(s, player.id);
      break;
    }

    case 'playKnight': {
      consumeDevCard(s, player, 'knight');
      player.knightsPlayed++;
      log(s, player.id, 'juega un caballero', 'card');
      const holder = recomputeLargestArmy(s);
      if (holder !== s.largestArmyHolder) {
        s.largestArmyHolder = holder;
        if (holder !== null) {
          log(s, holder, 'se lleva el mayor ejercito (+2)', 'victory');
        }
      }
      s.phase = 'moveRobber';
      checkVictory(s, player.id);
      break;
    }

    case 'playRoadBuilding': {
      consumeDevCard(s, player, 'roadBuilding');
      const available = Math.min(2, player.piecesLeft.road);
      const usable = available > 0 && hasLegalRoadPlacement(s, player.id);
      s.pending = usable ? { type: 'roadBuilding', roadsLeft: available } : null;
      log(s, player.id, 'juega construccion de carreteras', 'card');
      break;
    }

    case 'playYearOfPlenty': {
      consumeDevCard(s, player, 'yearOfPlenty');
      const gained: Partial<ResourceCount> = {};
      for (const r of action.resources) {
        grant(s, player, r, 1);
        gained[r] = (gained[r] ?? 0) + 1;
      }
      log(s, player.id, `juega ano de la abundancia y toma ${describeResources(gained)}`, 'card');
      break;
    }

    case 'playMonopoly': {
      consumeDevCard(s, player, 'monopoly');
      let taken = 0;
      for (const other of s.players) {
        if (other.id === player.id) continue;
        taken += other.resources[action.resource];
        other.resources[action.resource] = 0;
      }
      player.resources[action.resource] += taken;
      log(
        s,
        player.id,
        `juega monopolio y se lleva ${taken} de ${RESOURCE_NAMES[action.resource]}`,
        'card',
      );
      break;
    }

    case 'bankTrade': {
      const ratio = tradeRatio(s, player.id, action.give);
      player.resources[action.give] -= ratio;
      s.bank[action.give] += ratio;
      grant(s, player, action.want, 1);
      log(
        s,
        player.id,
        `cambia ${ratio} ${RESOURCE_NAMES[action.give]} por 1 ${RESOURCE_NAMES[action.want]}`,
        'trade',
      );
      break;
    }

    case 'offerTrade': {
      const responses: Record<PlayerId, 'accepted' | 'rejected' | 'pending'> = {};
      for (const other of s.players) {
        if (other.id !== player.id) responses[other.id] = 'pending';
      }
      s.activeTrade = {
        id: s.nextTradeId++,
        from: player.id,
        give: { ...action.give },
        want: { ...action.want },
        responses,
      };
      log(
        s,
        player.id,
        `ofrece ${describeResources(action.give)} a cambio de ${describeResources(action.want)}`,
        'trade',
      );
      break;
    }

    case 'respondTrade': {
      s.activeTrade!.responses[action.player] = action.accept ? 'accepted' : 'rejected';
      break;
    }

    case 'confirmTrade': {
      const trade = s.activeTrade!;
      const other = s.players[action.with]!;
      for (const r of RESOURCES) {
        const give = trade.give[r] ?? 0;
        const want = trade.want[r] ?? 0;
        player.resources[r] += want - give;
        other.resources[r] += give - want;
      }
      log(s, player.id, `cierra el trato con ${other.name}`, 'trade');
      s.activeTrade = null;
      break;
    }

    case 'cancelTrade': {
      s.activeTrade = null;
      log(s, player.id, 'retira su oferta', 'trade');
      break;
    }

    case 'endTurn': {
      endTurn(s);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Operaciones de tablero
// ---------------------------------------------------------------------------

function placeSettlement(
  s: GameState,
  player: PlayerState,
  vertex: VertexId,
  kind: 'settlement',
): void {
  s.buildings[vertex] = { kind, owner: player.id, vertex };
  player.buildings.push(vertex);
  player.piecesLeft.settlement--;
  // Los puertos que toca el nuevo poblado quedan disponibles para comerciar.
  for (const port of s.board.vertexPorts[vertex] ?? []) {
    if (!player.ports.includes(port)) player.ports.push(port);
  }
}

function placeRoad(s: GameState, player: PlayerState, edge: string): void {
  s.roads[edge] = { owner: player.id, edge };
  player.roads.push(edge);
  player.piecesLeft.road--;
}

function consumeDevCard(s: GameState, player: PlayerState, kind: DevCardKind): void {
  // Se gasta la carta mas antigua que ya sea jugable este turno.
  const index = player.devCards.findIndex(
    (c) => c.kind === kind && c.boughtOnTurn < s.turn,
  );
  if (index >= 0) player.devCards.splice(index, 1);
  player.playedDevCardThisTurn = true;
}

function refreshLongestRoad(s: GameState): void {
  const { holder, lengths } = recomputeLongestRoad(s);
  s.players.forEach((p, i) => {
    p.longestRoadLength = lengths[i] ?? 0;
  });
  if (holder !== s.longestRoadHolder) {
    s.longestRoadHolder = holder;
    if (holder !== null) {
      log(s, holder, 'se lleva la ruta comercial mas larga (+2)', 'victory');
    } else {
      log(s, null, 'la ruta comercial mas larga queda vacante', 'victory');
    }
  }
}

/**
 * Reparto tras una tirada. Si el banco no tiene suficientes cartas de un
 * recurso para todos los que deben recibirlo, nadie lo recibe; la excepcion
 * oficial es que haya un unico beneficiario, que se lleva lo que quede.
 */
function distributeResources(s: GameState, roll: number): void {
  const claims: Record<Resource, Map<PlayerId, number>> = {
    lumber: new Map(),
    brick: new Map(),
    wool: new Map(),
    grain: new Map(),
    ore: new Map(),
  };

  for (const hexId of s.board.hexOrder) {
    const hex = s.board.hexes[hexId]!;
    if (hex.number !== roll) continue;
    if (hexId === s.robber) continue;
    const resource = TERRAIN_YIELD[hex.terrain];
    if (!resource) continue;
    for (const vertex of hex.vertices) {
      const building = s.buildings[vertex];
      if (!building) continue;
      const amount = building.kind === 'city' ? 2 : 1;
      const map = claims[resource];
      map.set(building.owner, (map.get(building.owner) ?? 0) + amount);
    }
  }

  const summary: string[] = [];
  for (const resource of RESOURCES) {
    const map = claims[resource];
    if (map.size === 0) continue;
    const demand = [...map.values()].reduce((a, b) => a + b, 0);

    if (demand > s.bank[resource] && map.size > 1) {
      log(
        s,
        null,
        `El banco se queda sin ${RESOURCE_NAMES[resource]}: nadie la recibe este turno`,
        'info',
      );
      continue;
    }
    for (const [playerId, amount] of map) {
      const given = grant(s, s.players[playerId]!, resource, amount);
      if (given > 0) {
        summary.push(`${s.players[playerId]!.name} +${given} ${RESOURCE_NAMES[resource]}`);
      }
    }
  }

  if (summary.length > 0) log(s, null, summary.join(' · '), 'info');
  else log(s, null, 'Nadie produce con esta tirada', 'info');
}

/** Devuelve al flujo normal tras resolver el ladron. */
function finishRobber(s: GameState): void {
  // Si aun no se han tirado los dados, el ladron venia de un caballero jugado
  // antes de la tirada: hay que volver a la fase de tirar.
  s.phase = s.dice === null ? 'roll' : 'main';
}

// ---------------------------------------------------------------------------
// Flujo de turnos
// ---------------------------------------------------------------------------

function endTurn(s: GameState): void {
  const current = s.players[s.currentPlayer]!;
  current.playedDevCardThisTurn = false;
  s.activeTrade = null;
  s.pending = null;
  s.dice = null;

  nextPlayer(s);
}

function nextPlayer(s: GameState): void {
  const index = s.turnOrder.indexOf(s.currentPlayer);
  const next = s.turnOrder[(index + 1) % s.turnOrder.length]!;
  s.currentPlayer = next;
  s.turn++;
  s.phase = 'roll';
  s.players[next]!.playedDevCardThisTurn = false;
  log(s, next, 'empieza su turno', 'info');
  // Se pueden alcanzar los puntos durante el turno de otro: basta con que un
  // tercero pierda la ruta comercial mas larga y el titulo cambie de manos.
  // Como solo se gana en el turno propio, el momento de comprobarlo es aqui.
  checkVictory(s, next);
}

function checkVictory(s: GameState, playerId: PlayerId): void {
  if (victoryPoints(s, playerId) >= s.rules.victoryPoints) {
    s.winner = playerId;
    s.phase = 'gameOver';
    log(s, playerId, `gana la partida con ${victoryPoints(s, playerId)} puntos`, 'victory');
  }
}
