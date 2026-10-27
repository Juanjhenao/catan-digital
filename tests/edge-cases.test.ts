import { describe, expect, it } from 'vitest';
import {
  applyAction,
  applyOrThrow,
  createGame,
  createRng,
  getLegalActions,
  longestRoadFor,
  playersToAct,
  rollDie,
  victoryPoints,
  type Building,
  type GameState,
  type PlayerConfig,
  type Resource,
  type VertexId,
} from '../src/engine/index.js';

function players(count: number): PlayerConfig[] {
  const colors = ['red', 'blue', 'white', 'orange', 'green', 'brown'] as const;
  return Array.from({ length: count }, (_, i) => ({
    name: `J${i + 1}`,
    color: colors[i]!,
    kind: 'human' as const,
  }));
}

function runSetup(state: GameState): GameState {
  let s = state;
  while (s.phase === 'setupSettlement' || s.phase === 'setupRoad') {
    const legal = getLegalActions(s, s.currentPlayer);
    s = applyOrThrow(s, legal[Math.floor(legal.length / 3)]!);
  }
  return s;
}

function setResources(
  state: GameState,
  player: number,
  hand: Partial<Record<Resource, number>>,
): GameState {
  const full = { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0, ...hand };
  const bank = { ...state.bank };
  const previous = state.players[player]!.resources;
  for (const r of ['lumber', 'brick', 'wool', 'grain', 'ore'] as const) {
    bank[r] += previous[r] - full[r];
  }
  return {
    ...state,
    bank,
    players: state.players.map((p) => (p.id === player ? { ...p, resources: full } : p)),
  };
}

/** Ajusta la semilla para que la siguiente tirada sume `target`. */
function forceRoll(state: GameState, target: number): GameState {
  for (let seed = 1; seed < 200000; seed++) {
    const rng = createRng(seed);
    const [d1, afterFirst] = rollDie(rng);
    const [d2] = rollDie(afterFirst);
    if (d1 + d2 === target) return { ...state, rng: createRng(seed) };
  }
  throw new Error(`no se encontro semilla para ${target}`);
}

function enemy(vertex: VertexId): Building {
  return { kind: 'settlement', owner: 1, vertex };
}

// ---------------------------------------------------------------------------

describe('ruta comercial mas larga: casos limite', () => {
  it('un edificio rival en un extremo no acorta el camino', () => {
    // a-b-c-d-e-f son 5 tramos; el rival esta en el extremo 'a'.
    const chain = ['a|b', 'b|c', 'c|d', 'd|e', 'e|f'];
    expect(longestRoadFor(chain, { a: enemy('a') }, 0)).toBe(5);
  });

  it('rivales en LOS DOS extremos tampoco acortan el camino', () => {
    // Cortar en un cruce interior si rompe el camino, pero un edificio en la
    // punta no quita nada: el recorrido sigue teniendo 5 tramos.
    const chain = ['a|b', 'b|c', 'c|d', 'd|e', 'e|f'];
    expect(longestRoadFor(chain, { a: enemy('a'), f: enemy('f') }, 0)).toBe(5);
  });

  it('un tramo de dos caminos bloqueado por ambos lados sigue valiendo 2', () => {
    expect(longestRoadFor(['b|c', 'c|d'], { b: enemy('b'), d: enemy('d') }, 0)).toBe(2);
  });

  it('el corte interior sigue partiendo el camino en dos', () => {
    const chain = ['a|b', 'b|c', 'c|d', 'd|e'];
    expect(longestRoadFor(chain, { c: enemy('c') }, 0)).toBe(2);
  });

  it('un camino suelto vale 1 aunque tenga rivales en las dos puntas', () => {
    expect(longestRoadFor(['b|c'], { b: enemy('b'), c: enemy('c') }, 0)).toBe(1);
  });

  it('anillo con una salida: cuenta el anillo entero mas la cola', () => {
    const roads = ['a|b', 'b|c', 'c|d', 'd|e', 'e|f', 'a|f', 'a|z'];
    expect(longestRoadFor(roads, {}, 0)).toBe(7);
  });
});

describe('carta de construccion de carreteras', () => {
  function withRoadBuilding(seed: number) {
    let s = runSetup(createGame(players(4), { seed }));
    s = {
      ...s,
      phase: 'roll',
      dice: null,
      players: s.players.map((p) =>
        p.id === s.currentPlayer
          ? { ...p, devCards: [{ kind: 'roadBuilding', boughtOnTurn: 0 }] }
          : p,
      ),
    };
    return s;
  }

  it('deja el turno bloqueado hasta colocar los caminos pendientes', () => {
    let s = withRoadBuilding(1234);
    const me = s.currentPlayer;
    s = applyOrThrow(s, { type: 'playRoadBuilding', player: me });
    expect(s.pending).toEqual({ type: 'roadBuilding', roadsLeft: 2 });

    // Con caminos pendientes no se puede tirar los dados: si se pudiera, un 7
    // arrastraria el pendiente hasta la fase de descarte y el jugador acabaria
    // colocando caminos gratis en mitad del robo.
    expect(applyAction(s, { type: 'rollDice', player: me }).ok).toBe(false);
    expect(applyAction(s, { type: 'endTurn', player: me }).ok).toBe(false);

    // Solo se ofrecen caminos.
    const legal = getLegalActions(s, me);
    expect(legal.every((a) => a.type === 'buildRoad')).toBe(true);

    s = applyOrThrow(s, legal[0]!);
    s = applyOrThrow(s, getLegalActions(s, me)[0]!);
    expect(s.pending).toBeNull();
    // Y ahora si se puede tirar.
    expect(applyAction(s, { type: 'rollDice', player: me }).ok).toBe(true);
  });

  it('se agota sola si el jugador solo tiene un camino en la reserva', () => {
    let s = withRoadBuilding(4321);
    const me = s.currentPlayer;
    s = {
      ...s,
      players: s.players.map((p) =>
        p.id === me ? { ...p, piecesLeft: { ...p.piecesLeft, road: 1 } } : p,
      ),
    };
    s = applyOrThrow(s, { type: 'playRoadBuilding', player: me });
    expect(s.pending).toEqual({ type: 'roadBuilding', roadsLeft: 1 });
    s = applyOrThrow(s, getLegalActions(s, me)[0]!);
    expect(s.pending).toBeNull();
    expect(s.players[me]!.piecesLeft.road).toBe(0);
  });

  it('no se activa si no queda ningun hueco legal para construir', () => {
    let s = withRoadBuilding(999);
    const me = s.currentPlayer;
    s = {
      ...s,
      players: s.players.map((p) =>
        p.id === me ? { ...p, piecesLeft: { ...p.piecesLeft, road: 0 } } : p,
      ),
    };
    s = applyOrThrow(s, { type: 'playRoadBuilding', player: me });
    expect(s.pending).toBeNull();
    // La carta se ha gastado igualmente.
    expect(s.players[me]!.devCards).toHaveLength(0);
    expect(s.players[me]!.playedDevCardThisTurn).toBe(true);
  });

  it('los caminos de la carta no cuestan recursos', () => {
    let s = withRoadBuilding(555);
    const me = s.currentPlayer;
    s = setResources(s, me, { lumber: 1, brick: 1 });
    s = applyOrThrow(s, { type: 'playRoadBuilding', player: me });
    s = applyOrThrow(s, getLegalActions(s, me)[0]!);
    s = applyOrThrow(s, getLegalActions(s, me)[0]!);
    expect(s.players[me]!.resources.lumber).toBe(1);
    expect(s.players[me]!.resources.brick).toBe(1);
  });
});

describe('victoria', () => {
  it('se gana al empezar el turno si ya se tienen los puntos', () => {
    // Un jugador puede alcanzar los 10 puntos durante el turno de otro, si le
    // arrebatan la ruta mas larga a un tercero. La victoria debe reconocerse
    // en cuanto le llega su turno, sin obligarle a construir algo antes.
    let s = runSetup(createGame(players(3), { seed: 31415 }));
    const next = s.turnOrder[1]!;
    s = {
      ...s,
      phase: 'main',
      dice: [3, 4],
      players: s.players.map((p) =>
        p.id === next
          ? {
              ...p,
              devCards: Array.from({ length: 8 }, () => ({
                kind: 'victoryPoint' as const,
                boughtOnTurn: 0,
              })),
            }
          : p,
      ),
    };
    expect(victoryPoints(s, next)).toBeGreaterThanOrEqual(10);
    expect(s.winner).toBeNull();

    s = applyOrThrow(s, { type: 'endTurn', player: s.currentPlayer });
    expect(s.winner).toBe(next);
    expect(s.phase).toBe('gameOver');
  });

  it('no se gana en el turno de otro jugador', () => {
    let s = runSetup(createGame(players(3), { seed: 27182 }));
    const other = s.turnOrder[1]!;
    s = {
      ...s,
      phase: 'main',
      dice: [3, 4],
      players: s.players.map((p) =>
        p.id === other
          ? {
              ...p,
              devCards: Array.from({ length: 8 }, () => ({
                kind: 'victoryPoint' as const,
                boughtOnTurn: 0,
              })),
            }
          : p,
      ),
    };
    // El jugador en turno hace algo suyo: la partida no termina todavia.
    s = setResources(s, s.currentPlayer, { ore: 4 });
    s = applyOrThrow(s, {
      type: 'bankTrade',
      player: s.currentPlayer,
      give: 'ore',
      want: 'wool',
    });
    expect(s.winner).toBeNull();
  });
});

describe('el ladron', () => {
  it('robar deja al ladron y a la victima con el mismo total de cartas', () => {
    let s = runSetup(createGame(players(4), { seed: 606 }));
    const thief = s.currentPlayer;
    const victim = s.players.find((p) => p.id !== thief)!.id;
    s = setResources(s, thief, {});
    s = setResources(s, victim, { ore: 3 });
    s = { ...s, phase: 'steal', dice: [3, 4], stealTargets: [victim] };

    s = applyOrThrow(s, { type: 'steal', player: thief, target: victim });
    expect(s.players[thief]!.resources.ore).toBe(1);
    expect(s.players[victim]!.resources.ore).toBe(2);
    expect(s.phase).toBe('main');
  });

  it('un caballero jugado antes de tirar devuelve a la fase de dados', () => {
    let s = runSetup(createGame(players(4), { seed: 707 }));
    const me = s.currentPlayer;
    s = {
      ...s,
      phase: 'roll',
      dice: null,
      players: s.players.map((p) =>
        p.id === me ? { ...p, devCards: [{ kind: 'knight', boughtOnTurn: 0 }] } : p,
      ),
    };
    s = applyOrThrow(s, { type: 'playKnight', player: me });
    expect(s.phase).toBe('moveRobber');
    const hex = s.board.hexOrder.find((id) => id !== s.robber)!;
    s = applyOrThrow(s, { type: 'moveRobber', player: me, hex });
    if (s.phase === 'steal') {
      s = applyOrThrow(s, { type: 'steal', player: me, target: s.stealTargets[0]! });
    }
    // Aun no habia tirado: le toca hacerlo ahora.
    expect(s.phase).toBe('roll');
    expect(applyAction(s, { type: 'rollDice', player: me }).ok).toBe(true);
  });

  it('la casilla del ladron no produce pero las demas del mismo numero si', () => {
    let s = runSetup(createGame(players(4), { seed: 808 }));
    // Dos casillas con el mismo numero, un poblado del jugador 0 en cada una.
    const groups = new Map<number, string[]>();
    for (const id of s.board.hexOrder) {
      const n = s.board.hexes[id]!.number;
      if (n === null) continue;
      groups.set(n, [...(groups.get(n) ?? []), id]);
    }
    const pair = [...groups.entries()].find(([, ids]) => ids.length >= 2)!;
    const [number, ids] = pair;
    const [hexA, hexB] = ids as [string, string];
    const vA = s.board.hexes[hexA]!.vertices[0]!;
    const vB = s.board.hexes[hexB]!.vertices[0]!;

    s = {
      ...s,
      phase: 'roll',
      dice: null,
      currentPlayer: 0,
      robber: hexA,
      buildings: {
        [vA]: { kind: 'settlement', owner: 0, vertex: vA },
        [vB]: { kind: 'settlement', owner: 0, vertex: vB },
      },
      players: s.players.map((p) => ({
        ...p,
        resources: { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 },
      })),
    };

    const rolled = applyOrThrow(forceRoll(s, number), { type: 'rollDice', player: 0 });
    const total = Object.values(rolled.players[0]!.resources).reduce((a, b) => a + b, 0);
    // Solo la casilla libre produce.
    expect(total).toBe(1);
  });
});

describe('construccion', () => {
  it('un camino no puede atravesar un poblado rival', () => {
    let s = runSetup(createGame(players(4), { seed: 909 }));
    const me = s.currentPlayer;
    // Cruce con un camino propio y un edificio rival encima.
    const myRoad = s.players[me]!.roads[0]!;
    const [a, b] = myRoad.split('|') as [string, string];
    const blockedVertex = s.buildings[a]?.owner === me ? b : a;
    const rival = s.players.find((p) => p.id !== me)!.id;

    s = {
      ...s,
      phase: 'main',
      dice: [3, 4],
      buildings: {
        ...s.buildings,
        [blockedVertex]: { kind: 'settlement', owner: rival, vertex: blockedVertex },
      },
    };
    s = setResources(s, me, { lumber: 5, brick: 5 });

    // Ninguna de las aristas que salen del cruce bloqueado es construible,
    // salvo que el jugador llegue a ellas por otro lado.
    for (const edge of s.board.vertexEdges[blockedVertex]!) {
      if (edge === myRoad || s.roads[edge]) continue;
      const [x, y] = edge.split('|') as [string, string];
      const far = x === blockedVertex ? y : x;
      const reachableOtherwise = (s.board.vertexEdges[far] ?? []).some(
        (e) => e !== edge && s.roads[e]?.owner === me,
      );
      const result = applyAction(s, { type: 'buildRoad', player: me, edge });
      expect(result.ok, `arista ${edge}`).toBe(reachableOtherwise);
    }
  });

  it('mejorar a ciudad devuelve el poblado a la reserva', () => {
    let s = runSetup(createGame(players(4), { seed: 1010 }));
    const me = s.currentPlayer;
    const vertex = s.players[me]!.buildings[0]!;
    s = { ...s, phase: 'main', dice: [3, 4] };
    s = setResources(s, me, { grain: 2, ore: 3 });
    const before = s.players[me]!.piecesLeft;

    s = applyOrThrow(s, { type: 'buildCity', player: me, vertex });
    expect(s.players[me]!.piecesLeft.city).toBe(before.city - 1);
    expect(s.players[me]!.piecesLeft.settlement).toBe(before.settlement + 1);
    expect(s.buildings[vertex]!.kind).toBe('city');
    // La ciudad sigue contando como un unico edificio del jugador.
    expect(s.players[me]!.buildings.filter((v) => v === vertex)).toHaveLength(1);
  });

  it('sin piezas en la reserva no se puede construir', () => {
    let s = runSetup(createGame(players(4), { seed: 1111 }));
    const me = s.currentPlayer;
    s = { ...s, phase: 'main', dice: [3, 4] };
    s = setResources(s, me, { lumber: 5, brick: 5, wool: 5, grain: 5, ore: 5 });
    s = {
      ...s,
      players: s.players.map((p) =>
        p.id === me ? { ...p, piecesLeft: { road: 0, settlement: 0, city: 0 } } : p,
      ),
    };
    const legal = getLegalActions(s, me);
    expect(legal.some((a) => a.type === 'buildRoad')).toBe(false);
    expect(legal.some((a) => a.type === 'buildSettlement')).toBe(false);
    expect(legal.some((a) => a.type === 'buildCity')).toBe(false);
    // Comprar cartas si sigue siendo posible.
    expect(legal.some((a) => a.type === 'buyDevCard')).toBe(true);
  });
});

describe('mayor ejercito', () => {
  it('solo cambia de manos superando estrictamente al titular', () => {
    let s = runSetup(createGame(players(4), { seed: 1212 }));
    const first = s.turnOrder[0]!;
    const second = s.turnOrder[1]!;

    // El primero llega a 3 caballeros y se lleva el titulo.
    s = {
      ...s,
      phase: 'main',
      dice: [3, 4],
      currentPlayer: first,
      players: s.players.map((p) =>
        p.id === first
          ? { ...p, knightsPlayed: 2, devCards: [{ kind: 'knight', boughtOnTurn: 0 }] }
          : p,
      ),
    };
    s = applyOrThrow(s, { type: 'playKnight', player: first });
    expect(s.largestArmyHolder).toBe(first);

    // El segundo empata a 3: el titulo NO se mueve.
    s = {
      ...s,
      phase: 'main',
      dice: [3, 4],
      currentPlayer: second,
      players: s.players.map((p) =>
        p.id === second
          ? { ...p, knightsPlayed: 2, devCards: [{ kind: 'knight', boughtOnTurn: 0 }] }
          : p,
      ),
    };
    s = applyOrThrow(s, { type: 'playKnight', player: second });
    expect(s.largestArmyHolder).toBe(first);

    // Con 4 si lo arrebata.
    s = {
      ...s,
      phase: 'main',
      players: s.players.map((p) =>
        p.id === second
          ? {
              ...p,
              playedDevCardThisTurn: false,
              devCards: [{ kind: 'knight', boughtOnTurn: 0 }],
            }
          : p,
      ),
    };
    s = applyOrThrow(s, { type: 'playKnight', player: second });
    expect(s.players[second]!.knightsPlayed).toBe(4);
    expect(s.largestArmyHolder).toBe(second);
  });
});

describe('cartas de desarrollo compradas en el turno', () => {
  it('una carta comprada no se juega hasta el turno siguiente', () => {
    let s = runSetup(createGame(players(5), { seed: 1313 }));
    const buyer = s.currentPlayer;
    s = { ...s, phase: 'main', dice: [3, 4] };
    s = setResources(s, buyer, { wool: 1, grain: 1, ore: 1 });
    s = { ...s, devDeck: [...s.devDeck.slice(0, -1), 'knight'] };
    s = applyOrThrow(s, { type: 'buyDevCard', player: buyer });
    const boughtOn = s.players[buyer]!.devCards[0]!.boughtOnTurn;
    expect(applyAction(s, { type: 'playKnight', player: buyer }).ok).toBe(false);

    // Se avanza hasta que le vuelva a tocar al comprador.
    let guard = 0;
    s = applyOrThrow(s, { type: 'endTurn', player: buyer });
    while (s.currentPlayer !== buyer && guard++ < 60) {
      if (s.phase === 'roll') {
        s = applyOrThrow(s, { type: 'rollDice', player: s.currentPlayer });
      } else if (s.phase === 'main') {
        s = applyOrThrow(s, { type: 'endTurn', player: s.currentPlayer });
      } else {
        const actor = playersToAct(s)[0]!;
        s = applyOrThrow(s, getLegalActions(s, actor)[0]!);
      }
    }
    expect(s.currentPlayer).toBe(buyer);
    expect(s.turn).toBeGreaterThan(boughtOn);
    expect(applyAction(s, { type: 'playKnight', player: buyer }).ok).toBe(true);
  });
});
