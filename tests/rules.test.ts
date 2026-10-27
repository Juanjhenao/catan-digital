import { beforeEach, describe, expect, it } from 'vitest';
import { RandomBot } from '../src/ai/random-bot.js';
import { playOut } from '../src/ai/self-play.js';
import {
  applyAction,
  applyOrThrow,
  createGame,
  createRng,
  discardAmount,
  getLegalActions,
  longestRoadFor,
  playersToAct,
  rollDie,
  totalResources,
  tradeRatio,
  victoryPoints,
  type Action,
  type GameState,
  type PlayerConfig,
  type Resource,
  TERRAIN_YIELD,
} from '../src/engine/index.js';

function players(count: number): PlayerConfig[] {
  const colors = ['red', 'blue', 'white', 'orange', 'green', 'brown'] as const;
  return Array.from({ length: count }, (_, i) => ({
    name: `J${i + 1}`,
    color: colors[i]!,
    kind: 'human' as const,
  }));
}

/** Ejecuta la colocacion inicial completa eligiendo siempre la primera opcion legal. */
function runSetup(state: GameState): GameState {
  let s = state;
  let guard = 0;
  while (s.phase === 'setupSettlement' || s.phase === 'setupRoad') {
    if (guard++ > 200) throw new Error('la colocacion inicial no termina');
    const legal = getLegalActions(s, s.currentPlayer);
    expect(legal.length).toBeGreaterThan(0);
    s = applyOrThrow(s, legal[Math.floor(legal.length / 3)]!);
  }
  return s;
}

/** Da recursos a un jugador sin pasar por el reducer (solo para preparar tests). */
function give(state: GameState, player: number, delta: Partial<Record<Resource, number>>) {
  for (const [resource, amount] of Object.entries(delta)) {
    state.players[player]!.resources[resource as Resource] += amount!;
    state.bank[resource as Resource] -= amount!;
  }
}

/**
 * Deja la mano de un jugador exactamente como se indica. La colocacion inicial
 * ya reparte recursos por el segundo poblado, asi que casi todos los tests que
 * miden cantidades necesitan partir de una mano conocida.
 */
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

/**
 * Ajusta la semilla del generador para que la siguiente tirada de dados sume
 * `target`. Evita depender del azar en los tests de produccion.
 */
function forceRoll(state: GameState, target: number): GameState {
  for (let seed = 1; seed < 200000; seed++) {
    const rng = createRng(seed);
    const [d1, afterFirst] = rollDie(rng);
    const [d2] = rollDie(afterFirst);
    if (d1 + d2 === target) return { ...state, rng: createRng(seed) };
  }
  throw new Error(`no se encontro semilla para una tirada de ${target}`);
}

describe('creacion de partida', () => {
  it('rechaza menos de 2 y mas de 6 jugadores', () => {
    expect(() => createGame(players(1), { seed: 1 })).toThrow();
    expect(() => createGame(players(7 as 6), { seed: 1 })).toThrow();
  });

  it('elige el tablero clasico hasta 4 jugadores y el ampliado a partir de 5', () => {
    expect(createGame(players(4), { seed: 1 }).board.variant).toBe('base');
    expect(createGame(players(5), { seed: 1 }).board.variant).toBe('extended');
    expect(createGame(players(6), { seed: 1 }).board.variant).toBe('extended');
  });

  it('reparte las piezas y el banco correctos', () => {
    const base = createGame(players(4), { seed: 1 });
    expect(base.players[0]!.piecesLeft).toEqual({ road: 15, settlement: 5, city: 4 });
    expect(base.bank.lumber).toBe(19);
    expect(base.devDeck).toHaveLength(25);

    const ext = createGame(players(6), { seed: 1 });
    expect(ext.bank.ore).toBe(24);
    expect(ext.devDeck).toHaveLength(34);
  });

  it('el orden de colocacion es en serpiente', () => {
    const state = createGame(players(4), { seed: 42 });
    const forward = state.setupOrder.slice(0, 4);
    const backward = state.setupOrder.slice(4);
    expect(backward).toEqual([...forward].reverse());
  });

  it('la misma semilla reproduce la misma partida', () => {
    const a = createGame(players(3), { seed: 999 });
    const b = createGame(players(3), { seed: 999 });
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });
});

describe('colocacion inicial', () => {
  let state: GameState;
  beforeEach(() => {
    state = createGame(players(4), { seed: 2024 });
  });

  it('respeta la regla de distancia', () => {
    const first = getLegalActions(state, state.currentPlayer)[0]! as Extract<
      Action,
      { type: 'setupSettlement' }
    >;
    const after = applyOrThrow(state, first);
    for (const neighbor of after.board.vertexNeighbors[first.vertex]!) {
      const result = applyAction(after, {
        type: 'setupSettlement',
        player: after.currentPlayer,
        vertex: neighbor,
      });
      expect(result.ok).toBe(false);
    }
  });

  it('obliga a que el camino salga del poblado recien colocado', () => {
    const settlement = getLegalActions(state, state.currentPlayer)[0]! as Extract<
      Action,
      { type: 'setupSettlement' }
    >;
    let s = applyOrThrow(state, settlement);
    expect(s.phase).toBe('setupRoad');
    const legalEdges = new Set(
      getLegalActions(s, s.currentPlayer).map((a) => (a as { edge: string }).edge),
    );
    expect(legalEdges).toEqual(new Set(s.board.vertexEdges[settlement.vertex]!));
    s = applyOrThrow(s, getLegalActions(s, s.currentPlayer)[0]!);
    expect(s.phase).toBe('setupSettlement');
  });

  it('el segundo poblado reparte recursos y el primero no', () => {
    let s = state;
    const firstPlayer = s.currentPlayer;
    // Primera vuelta.
    for (let i = 0; i < 4; i++) {
      s = applyOrThrow(s, getLegalActions(s, s.currentPlayer)[0]!); // poblado
      s = applyOrThrow(s, getLegalActions(s, s.currentPlayer)[0]!); // camino
    }
    expect(totalResources(s.players[firstPlayer]!.resources)).toBe(0);

    // Segunda vuelta: el primero en colocar es el ultimo de la ronda anterior.
    const secondRoundPlayer = s.currentPlayer;
    s = applyOrThrow(s, getLegalActions(s, s.currentPlayer)[0]!);
    expect(totalResources(s.players[secondRoundPlayer]!.resources)).toBeGreaterThan(0);
  });

  it('al terminar la colocacion arranca el turno 1 del primer jugador', () => {
    const s = runSetup(state);
    expect(s.phase).toBe('roll');
    expect(s.turn).toBe(1);
    expect(s.currentPlayer).toBe(s.turnOrder[0]);
    expect(Object.keys(s.buildings)).toHaveLength(8);
    expect(Object.keys(s.roads)).toHaveLength(8);
  });
});

describe('produccion de recursos', () => {
  /**
   * Escenario minimo y controlado: se vacia el tablero de edificios y se deja
   * un unico poblado del jugador 0 sobre la casilla que nos interesa, de forma
   * que cualquier recurso que gane venga necesariamente de ella.
   */
  function isolate(seed: number) {
    const base = runSetup(createGame(players(4), { seed }));
    const hexId = base.board.hexOrder.find(
      (id) => base.board.hexes[id]!.terrain !== 'desert' && id !== base.robber,
    )!;
    const hex = base.board.hexes[hexId]!;
    const vertex = hex.vertices[0]!;
    const state: GameState = {
      ...base,
      phase: 'roll',
      dice: null,
      buildings: { [vertex]: { kind: 'settlement', owner: 0, vertex } },
      roads: {},
      currentPlayer: 0,
      players: base.players.map((p) => ({
        ...p,
        buildings: p.id === 0 ? [vertex] : [],
        roads: [],
        resources: { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 },
      })),
    };
    return { state, hexId, hex, vertex };
  }

  it('un poblado produce 1 carta y una ciudad 2', () => {
    const { state, hex, vertex } = isolate(31337);
    const rolled = applyOrThrow(forceRoll(state, hex.number!), {
      type: 'rollDice',
      player: 0,
    });
    expect(totalResources(rolled.players[0]!.resources)).toBe(1);

    const asCity: GameState = {
      ...state,
      buildings: { [vertex]: { kind: 'city', owner: 0, vertex } },
    };
    const rolledCity = applyOrThrow(forceRoll(asCity, hex.number!), {
      type: 'rollDice',
      player: 0,
    });
    expect(totalResources(rolledCity.players[0]!.resources)).toBe(2);
  });

  it('produce el recurso propio del terreno', () => {
    const { state, hex } = isolate(31337);
    const rolled = applyOrThrow(forceRoll(state, hex.number!), {
      type: 'rollDice',
      player: 0,
    });
    expect(rolled.players[0]!.resources[TERRAIN_YIELD[hex.terrain]!]).toBe(1);
  });

  it('el ladron bloquea la produccion de su casilla', () => {
    const { state, hexId, hex } = isolate(4242);
    const blocked: GameState = { ...state, robber: hexId };
    const rolled = applyOrThrow(forceRoll(blocked, hex.number!), {
      type: 'rollDice',
      player: 0,
    });
    expect(totalResources(rolled.players[0]!.resources)).toBe(0);
  });

  it('si el banco no llega para todos los que producen, nadie recibe', () => {
    const { state, hex } = isolate(31337);
    const resource = TERRAIN_YIELD[hex.terrain]!;
    // Dos jugadores esperando el mismo recurso y un banco con una sola carta.
    const second = hex.vertices[3]!;
    const contested: GameState = {
      ...state,
      bank: { ...state.bank, [resource]: 1 },
      buildings: {
        ...state.buildings,
        [second]: { kind: 'settlement', owner: 1, vertex: second },
      },
    };
    const rolled = applyOrThrow(forceRoll(contested, hex.number!), {
      type: 'rollDice',
      player: 0,
    });
    expect(rolled.players[0]!.resources[resource]).toBe(0);
    expect(rolled.players[1]!.resources[resource]).toBe(0);
    expect(rolled.bank[resource]).toBe(1);
  });

  it('si solo hay un beneficiario, se lleva lo que quede en el banco', () => {
    const { state, hex } = isolate(31337);
    const resource = TERRAIN_YIELD[hex.terrain]!;
    const scarce: GameState = { ...state, bank: { ...state.bank, [resource]: 1 } };
    const rolled = applyOrThrow(forceRoll(scarce, hex.number!), {
      type: 'rollDice',
      player: 0,
    });
    expect(rolled.players[0]!.resources[resource]).toBe(1);
    expect(rolled.bank[resource]).toBe(0);
  });
});

describe('ruta comercial mas larga', () => {
  it('cuenta el recorrido mas largo sin repetir tramos', () => {
    // Cadena simple de 5 tramos: 0-1-2-3-4-5
    const chain = ['a|b', 'b|c', 'c|d', 'd|e', 'e|f'];
    expect(longestRoadFor(chain, {}, 0)).toBe(5);
  });

  it('las bifurcaciones no suman, solo la rama mas larga', () => {
    // Tronco a-b-c-d mas una rama c-x. Hay 4 tramos, pero ningun recorrido
    // continuo los usa todos: el maximo es 3 (a-b-c-d o a-b-c-x).
    const roads = ['a|b', 'b|c', 'c|d', 'c|x'];
    expect(longestRoadFor(roads, {}, 0)).toBe(3);
  });

  it('un anillo cerrado cuenta todos sus tramos', () => {
    const ring = ['a|b', 'b|c', 'c|d', 'd|e', 'e|f', 'a|f'];
    expect(longestRoadFor(ring, {}, 0)).toBe(6);
  });

  it('un edificio rival corta el camino', () => {
    const chain = ['a|b', 'b|c', 'c|d', 'd|e'];
    const blocked = longestRoadFor(chain, {
      c: { kind: 'settlement', owner: 1, vertex: 'c' },
    }, 0);
    expect(blocked).toBe(2);
  });

  it('un edificio propio no corta nada', () => {
    const chain = ['a|b', 'b|c', 'c|d', 'd|e'];
    expect(
      longestRoadFor(chain, { c: { kind: 'city', owner: 0, vertex: 'c' } }, 0),
    ).toBe(4);
  });
});

describe('comercio', () => {
  it('el ratio con el banco es 4:1 sin puerto, 3:1 con generico y 2:1 con especifico', () => {
    const s = runSetup(createGame(players(4), { seed: 88 }));
    expect(tradeRatio(s, 0, 'ore')).toBe(4);

    const withGeneric: GameState = {
      ...s,
      players: s.players.map((p) => (p.id === 0 ? { ...p, ports: ['generic'] } : p)),
    };
    expect(tradeRatio(withGeneric, 0, 'ore')).toBe(3);

    const withSpecific: GameState = {
      ...s,
      players: s.players.map((p) => (p.id === 0 ? { ...p, ports: ['generic', 'ore'] } : p)),
    };
    expect(tradeRatio(withSpecific, 0, 'ore')).toBe(2);
    expect(tradeRatio(withSpecific, 0, 'wool')).toBe(3);
  });

  it('el cambio con el banco mueve las cartas en ambos sentidos', () => {
    let s = runSetup(createGame(players(4), { seed: 51 }));
    s = { ...s, phase: 'main', dice: [3, 4] };
    const me = s.currentPlayer;
    s = setResources(s, me, { ore: 4 });
    const before = s.bank.wool;
    s = applyOrThrow(s, { type: 'bankTrade', player: me, give: 'ore', want: 'wool' });
    expect(s.players[me]!.resources.ore).toBe(0);
    expect(s.players[me]!.resources.wool).toBe(1);
    expect(s.bank.wool).toBe(before - 1);
  });

  it('una oferta entre jugadores solo se cierra si el otro acepta', () => {
    let s = runSetup(createGame(players(4), { seed: 61 }));
    s = { ...s, phase: 'main', dice: [3, 4] };
    const me = s.currentPlayer;
    const other = s.players.find((p) => p.id !== me)!.id;
    s = setResources(s, me, { ore: 1 });
    s = setResources(s, other, { wool: 1 });

    s = applyOrThrow(s, {
      type: 'offerTrade',
      player: me,
      give: { ore: 1 },
      want: { wool: 1 },
    });
    expect(s.activeTrade).not.toBeNull();
    expect(applyAction(s, { type: 'confirmTrade', player: me, with: other }).ok).toBe(false);

    s = applyOrThrow(s, { type: 'respondTrade', player: other, accept: true });
    s = applyOrThrow(s, { type: 'confirmTrade', player: me, with: other });
    expect(s.players[me]!.resources.wool).toBe(1);
    expect(s.players[me]!.resources.ore).toBe(0);
    expect(s.players[other]!.resources.ore).toBe(1);
    expect(s.activeTrade).toBeNull();
  });
});

describe('cartas de desarrollo', () => {
  it('no se pueden jugar el mismo turno en que se compran', () => {
    let s = runSetup(createGame(players(4), { seed: 71 }));
    s = { ...s, phase: 'main', dice: [3, 4] };
    const me = s.currentPlayer;
    s = setResources(s, me, { wool: 1, grain: 1, ore: 1 });
    // Fuerza que la carta comprada sea un caballero.
    s = { ...s, devDeck: [...s.devDeck.slice(0, -1), 'knight'] };
    s = applyOrThrow(s, { type: 'buyDevCard', player: me });
    expect(s.players[me]!.devCards).toHaveLength(1);
    expect(applyAction(s, { type: 'playKnight', player: me }).ok).toBe(false);
  });

  it('solo se puede jugar una carta de desarrollo por turno', () => {
    let s = runSetup(createGame(players(4), { seed: 72 }));
    s = {
      ...s,
      phase: 'main',
      dice: [3, 4],
      players: s.players.map((p) =>
        p.id === s.currentPlayer
          ? {
              ...p,
              devCards: [
                { kind: 'monopoly', boughtOnTurn: 0 },
                { kind: 'monopoly', boughtOnTurn: 0 },
              ],
            }
          : p,
      ),
    };
    const me = s.currentPlayer;
    s = applyOrThrow(s, { type: 'playMonopoly', player: me, resource: 'ore' });
    expect(applyAction(s, { type: 'playMonopoly', player: me, resource: 'wool' }).ok).toBe(
      false,
    );
  });

  it('el monopolio se lleva ese recurso de todos los demas', () => {
    let s = runSetup(createGame(players(4), { seed: 73 }));
    s = {
      ...s,
      phase: 'main',
      dice: [3, 4],
      players: s.players.map((p) =>
        p.id === s.currentPlayer
          ? { ...p, devCards: [{ kind: 'monopoly', boughtOnTurn: 0 }] }
          : p,
      ),
    };
    const me = s.currentPlayer;
    s = setResources(s, me, {});
    for (const p of s.players) if (p.id !== me) s = setResources(s, p.id, { wool: 2 });
    const expected = (s.players.length - 1) * 2;
    s = applyOrThrow(s, { type: 'playMonopoly', player: me, resource: 'wool' });
    expect(s.players[me]!.resources.wool).toBe(expected);
    for (const p of s.players) if (p.id !== me) expect(p.resources.wool).toBe(0);
  });

  it('el caballero manda a mover el ladron y cuenta para el mayor ejercito', () => {
    let s = runSetup(createGame(players(4), { seed: 74 }));
    s = {
      ...s,
      phase: 'main',
      dice: [3, 4],
      players: s.players.map((p) =>
        p.id === s.currentPlayer
          ? {
              ...p,
              knightsPlayed: 2,
              devCards: [{ kind: 'knight', boughtOnTurn: 0 }],
            }
          : p,
      ),
    };
    const me = s.currentPlayer;
    s = applyOrThrow(s, { type: 'playKnight', player: me });
    expect(s.phase).toBe('moveRobber');
    expect(s.players[me]!.knightsPlayed).toBe(3);
    expect(s.largestArmyHolder).toBe(me);
  });

  it('el ano de la abundancia toma dos cartas del banco', () => {
    let s = runSetup(createGame(players(4), { seed: 75 }));
    s = {
      ...s,
      phase: 'main',
      dice: [3, 4],
      players: s.players.map((p) =>
        p.id === s.currentPlayer
          ? { ...p, devCards: [{ kind: 'yearOfPlenty', boughtOnTurn: 0 }] }
          : p,
      ),
    };
    const me = s.currentPlayer;
    s = setResources(s, me, {});
    const bankBefore = s.bank.ore;
    s = applyOrThrow(s, { type: 'playYearOfPlenty', player: me, resources: ['ore', 'ore'] });
    expect(s.players[me]!.resources.ore).toBe(2);
    expect(s.bank.ore).toBe(bankBefore - 2);
  });

  it('la carreteras deja poner dos caminos gratis', () => {
    let s = runSetup(createGame(players(4), { seed: 76 }));
    s = {
      ...s,
      phase: 'main',
      dice: [3, 4],
      players: s.players.map((p) =>
        p.id === s.currentPlayer
          ? { ...p, devCards: [{ kind: 'roadBuilding', boughtOnTurn: 0 }] }
          : p,
      ),
    };
    const me = s.currentPlayer;
    s = setResources(s, me, {});
    const roadsBefore = s.players[me]!.roads.length;
    s = applyOrThrow(s, { type: 'playRoadBuilding', player: me });
    expect(s.pending).toEqual({ type: 'roadBuilding', roadsLeft: 2 });
    s = applyOrThrow(s, getLegalActions(s, me)[0]!);
    s = applyOrThrow(s, getLegalActions(s, me)[0]!);
    expect(s.pending).toBeNull();
    expect(s.players[me]!.roads).toHaveLength(roadsBefore + 2);
    // Y sin gastar recursos.
    expect(totalResources(s.players[me]!.resources)).toBe(0);
  });
});

describe('el 7 y el ladron', () => {
  it('obliga a descartar la mitad a quien tiene mas de 7 cartas', () => {
    const s = runSetup(createGame(players(4), { seed: 81 }));
    const loaded: GameState = {
      ...s,
      players: s.players.map((p) =>
        p.id === 0
          ? { ...p, resources: { lumber: 4, brick: 4, wool: 1, grain: 0, ore: 0 } }
          : p,
      ),
    };
    expect(discardAmount(loaded, 0)).toBe(4);
    expect(discardAmount(loaded, 1)).toBe(0);
  });

  it('el descarte tiene que sumar exactamente lo pedido', () => {
    const s = runSetup(createGame(players(4), { seed: 82 }));
    const loaded: GameState = {
      ...s,
      phase: 'discard',
      mustDiscard: [0],
      players: s.players.map((p) =>
        p.id === 0
          ? { ...p, resources: { lumber: 5, brick: 5, wool: 0, grain: 0, ore: 0 } }
          : p,
      ),
    };
    expect(applyAction(loaded, { type: 'discard', player: 0, resources: { lumber: 4 } }).ok).toBe(
      false,
    );
    const ok = applyAction(loaded, {
      type: 'discard',
      player: 0,
      resources: { lumber: 3, brick: 2 },
    });
    expect(ok.ok).toBe(true);
    expect(ok.state.phase).toBe('moveRobber');
  });

  it('el ladron no puede quedarse en la misma casilla', () => {
    const s = runSetup(createGame(players(4), { seed: 83 }));
    const moving: GameState = { ...s, phase: 'moveRobber', dice: [3, 4] };
    expect(
      applyAction(moving, { type: 'moveRobber', player: s.currentPlayer, hex: s.robber }).ok,
    ).toBe(false);
  });
});

describe('victoria', () => {
  it('se gana al alcanzar los puntos objetivo', () => {
    let s = runSetup(createGame(players(4), { seed: 91 }));
    const me = s.currentPlayer;
    // 4 poblados colocados (2 de cada jugador) + forzamos puntos con cartas.
    s = {
      ...s,
      phase: 'main',
      dice: [3, 4],
      players: s.players.map((p) =>
        p.id === me
          ? {
              ...p,
              devCards: Array.from({ length: 7 }, () => ({
                kind: 'victoryPoint' as const,
                boughtOnTurn: 0,
              })),
              resources: { lumber: 0, brick: 0, wool: 1, grain: 1, ore: 1 },
            }
          : p,
      ),
      devDeck: [...s.devDeck.slice(0, -1), 'victoryPoint'],
    };
    expect(victoryPoints(s, me)).toBe(9);
    s = applyOrThrow(s, { type: 'buyDevCard', player: me });
    expect(s.winner).toBe(me);
    expect(s.phase).toBe('gameOver');
  });
});

describe('la construccion especial no existe', () => {
  // La fase de la extension 5-6 se quito del juego entero. Terminar un turno
  // pasa siempre al siguiente jugador, juegue quien juegue y sea cual sea el
  // mapa: no hay cola intermedia ni un boton mas que pulsar para salir de ella.
  for (const count of [2, 3, 4, 5, 6]) {
    it(`con ${count} jugadores, terminar turno pasa directo al siguiente`, () => {
      let s = runSetup(createGame(players(count), { seed: 100 + count }));
      s = { ...s, phase: 'main', dice: [3, 4] };
      const first = s.currentPlayer;
      s = applyOrThrow(s, { type: 'endTurn', player: first });
      expect(s.phase).toBe('roll');
      expect(s.currentPlayer).not.toBe(first);
    });
  }

  it('tampoco en los mapas grandes, que eran de donde salia antes', () => {
    for (const variant of ['large', 'huge'] as const) {
      let s = runSetup(createGame(players(6), { seed: 104, variant }));
      s = { ...s, phase: 'main', dice: [3, 4] };
      s = applyOrThrow(s, { type: 'endTurn', player: s.currentPlayer });
      expect(s.phase).toBe('roll');
    }
  });

  it('el estado no guarda ni la regla ni la cola', () => {
    const s = createGame(players(6), { seed: 105 });
    expect('specialBuildPhase' in s.rules).toBe(false);
    expect('specialBuildQueue' in s).toBe(false);
  });
});

describe('partidas completas con bots aleatorios', () => {
  for (const count of [2, 3, 4, 5, 6]) {
    it(`${count} jugadores: la partida llega al final sin bloquearse`, () => {
      const state = createGame(players(count), { seed: count * 1000 + 7 });
      const bots = Array.from({ length: count }, (_, i) => new RandomBot('easy', i + 1));
      const result = playOut(state, bots, { maxSteps: 40000 });

      expect(result.reason).not.toBe('stuck');
      expect(result.reason).toBe('victory');
      expect(result.state.winner).not.toBeNull();
      expect(victoryPoints(result.state, result.state.winner!)).toBeGreaterThanOrEqual(10);
    });
  }

  it('el invariante de cartas se mantiene: banco + manos = total inicial', () => {
    const count = 4;
    const state = createGame(players(count), { seed: 5150 });
    const bots = Array.from({ length: count }, (_, i) => new RandomBot('easy', i + 3));
    const totalPerResource = state.bank.lumber;

    const check = (s: GameState) => {
      for (const resource of ['lumber', 'brick', 'wool', 'grain', 'ore'] as const) {
        const inHands = s.players.reduce((sum, p) => sum + p.resources[resource], 0);
        expect(s.bank[resource] + inHands).toBe(totalPerResource);
        expect(s.bank[resource]).toBeGreaterThanOrEqual(0);
      }
      for (const p of s.players) {
        for (const resource of ['lumber', 'brick', 'wool', 'grain', 'ore'] as const) {
          expect(p.resources[resource]).toBeGreaterThanOrEqual(0);
        }
        expect(p.piecesLeft.road).toBeGreaterThanOrEqual(0);
        expect(p.piecesLeft.settlement).toBeGreaterThanOrEqual(0);
        expect(p.piecesLeft.city).toBeGreaterThanOrEqual(0);
      }
    };

    const result = playOut(state, bots, { maxSteps: 40000, onStep: check });
    expect(result.reason).toBe('victory');
  });

  it('nunca se colocan dos edificios en cruces contiguos', () => {
    const count = 6;
    const state = createGame(players(count), { seed: 24680 });
    const bots = Array.from({ length: count }, (_, i) => new RandomBot('easy', i + 11));
    const result = playOut(state, bots, {
      maxSteps: 40000,
      onStep: (s) => {
        for (const vertex of Object.keys(s.buildings)) {
          for (const neighbor of s.board.vertexNeighbors[vertex]!) {
            expect(s.buildings[neighbor]).toBeUndefined();
          }
        }
      },
    });
    expect(result.reason).toBe('victory');
  });

  it('20 partidas seguidas terminan siempre', () => {
    for (let seed = 0; seed < 20; seed++) {
      const count = 2 + (seed % 5);
      const state = createGame(players(count), { seed: seed * 7919 + 13 });
      const bots = Array.from({ length: count }, (_, i) => new RandomBot('easy', seed * 10 + i));
      const result = playOut(state, bots, { maxSteps: 60000 });
      expect(result.reason, `semilla ${seed}: ${result.lastAction?.type}`).toBe('victory');
    }
  }, 60000);
});
