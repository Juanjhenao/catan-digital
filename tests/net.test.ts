import { describe, expect, it } from 'vitest';
import {
  applyAction,
  applyOrThrow,
  createGame,
  discardAmount,
  getLegalActions,
  playersToAct,
  handSize,
  devCardCount,
  devDeckSize,
  totalResources,
  type GameState,
  type PlayerConfig,
  type Resource,
} from '../src/engine/index.js';
import { findLeaks, redactFor } from '../src/net/redact.js';
import {
  CHAT_MAX_LENGTH,
  makeRoomCode,
  normalizeRoomCode,
  parseClientMessage,
} from '../src/net/protocol.js';
import { Room } from '../server/room.js';

/**
 * Partida en red.
 *
 * Lo que se prueba aqui son las dos cosas que separan «jugar en red» de «jugar
 * en red mal»: que el servidor no manda a nadie informacion que no le toca, y
 * que no deja que un jugador actue por otro. Las dos son silenciosas -- una
 * partida con las manos filtradas funciona perfectamente y nadie se entera
 * hasta que alguien mira los mensajes.
 */

const CONFIGS: PlayerConfig[] = [
  { name: 'Ana', color: 'red', kind: 'human' },
  { name: 'Bruno', color: 'blue', kind: 'human' },
  { name: 'Carmen', color: 'white', kind: 'human' },
];

/** Una partida con la colocacion inicial hecha y cartas repartidas. */
function playedGame(seed = 42): GameState {
  let state = createGame(CONFIGS, { seed });
  while (state.phase === 'setupSettlement' || state.phase === 'setupRoad') {
    const legal = getLegalActions(state, state.currentPlayer);
    state = applyOrThrow(state, legal[Math.floor(legal.length * 0.37)]!);
  }
  return state;
}

/** Deja en la mano de un jugador exactamente lo que se le pasa. */
function setHand(
  state: GameState,
  player: number,
  hand: Partial<Record<Resource, number>>,
): GameState {
  return {
    ...state,
    players: state.players.map((p) =>
      p.id === player
        ? {
            ...p,
            resources: {
              lumber: hand.lumber ?? 0,
              brick: hand.brick ?? 0,
              wool: hand.wool ?? 0,
              grain: hand.grain ?? 0,
              ore: hand.ore ?? 0,
            },
          }
        : p,
    ),
  };
}

describe('censura del estado', () => {
  it('no deja pasar ninguna carta ajena, ni el mazo, ni el azar', () => {
    const state = playedGame();
    for (const viewer of [0, 1, 2]) {
      expect(findLeaks(redactFor(state, viewer), viewer)).toEqual([]);
    }
  });

  it('quien mira si ve su propia mano entera', () => {
    const state = playedGame();
    const mine = redactFor(state, 1).players[1]!;
    expect(mine.resources).toEqual(state.players[1]!.resources);
    expect(totalResources(mine.resources)).toBeGreaterThan(0);
  });

  it('los recuentos publicos se conservan', () => {
    // Cuantas cartas tiene cada uno SI es publico; cuales, no. Si al tapar la
    // mano se perdiera tambien el numero, la mesa dejaria de poder jugar: no se
    // sabria a quien robar ni quien esta a punto de descartar.
    let state = playedGame();
    // Se le dan cartas de desarrollo a alguien para que el recuento no sea cero.
    state = {
      ...state,
      players: state.players.map((p) =>
        p.id === 2 ? { ...p, devCards: [{ kind: 'knight' as const, boughtOnTurn: 0 }] } : p,
      ),
    };

    const view = redactFor(state, 0);
    for (const player of state.players) {
      expect(handSize(view, player.id), player.name).toBe(totalResources(player.resources));
      expect(devCardCount(view, player.id), player.name).toBe(player.devCards.length);
    }
    expect(devDeckSize(view)).toBe(state.devDeck.length);
  });

  it('un estado sin censurar responde igual a los mismos accesores', () => {
    // Es lo que permite que la interfaz sea una sola: no hay dos caminos de
    // lectura, uno para local y otro para red.
    const state = playedGame();
    for (const player of state.players) {
      expect(handSize(state, player.id)).toBe(totalResources(player.resources));
      expect(devCardCount(state, player.id)).toBe(player.devCards.length);
    }
    expect(devDeckSize(state)).toBe(state.devDeck.length);
  });

  it('censurar no toca el estado original', () => {
    const state = playedGame();
    const antes = JSON.stringify(state);
    redactFor(state, 0);
    expect(JSON.stringify(state)).toBe(antes);
  });

  it('findLeaks caza una fuga de verdad', () => {
    // El detector no vale de nada si no salta nunca: aqui se le da un estado
    // «censurado» al que se le ha colado la mano de un rival.
    const state = playedGame();
    const view = redactFor(state, 0);
    const leaky: GameState = {
      ...view,
      players: view.players.map((p) => (p.id === 1 ? state.players[1]! : p)),
    };
    expect(findLeaks(leaky, 0).length).toBeGreaterThan(0);
  });
});

describe('sala', () => {
  it('sienta a la gente y le da al primero el mando', () => {
    const room = new Room('TEST');
    const ana = room.join('Ana');
    const bruno = room.join('Bruno');
    expect('error' in ana).toBe(false);
    expect('error' in bruno).toBe(false);
    const lobby = room.lobby();
    expect(lobby.hostSeat).toBe(0);
    expect(lobby.seats[0]!.occupantName).toBe('Ana');
    expect(lobby.seats[1]!.occupantName).toBe('Bruno');
  });

  it('devuelve a su asiento a quien se reconecta con su ficha', () => {
    const room = new Room('TEST');
    room.join('Ana');
    const bruno = room.join('Bruno');
    if ('error' in bruno) throw new Error(bruno.error);
    room.join('Carmen');
    room.start(0);

    room.disconnect(bruno.seat);
    const back = room.join('Bruno', bruno.token);
    if ('error' in back) throw new Error(back.error);
    // El mismo asiento, no uno cualquiera: volver con las cartas de otro seria
    // peor que no dejarle volver.
    expect(back.seat).toBe(bruno.seat);
  });

  it('no deja jugar por otro', () => {
    const room = new Room('TEST');
    room.join('Ana');
    room.join('Bruno');
    room.join('Carmen');
    expect(room.start(0)).toBeNull();

    const state = room.state!;
    const actor = state.currentPlayer;
    const impostor = (actor + 1) % 3;
    const legal = getLegalActions(state, actor);
    expect(legal.length).toBeGreaterThan(0);

    // La jugada es LEGAL, y aun asi debe rechazarse: la manda quien no es.
    const error = room.play(impostor, legal[0]!);
    expect(error).toBe('Esa jugada no es tuya.');
    expect(room.state).toBe(state);

    // El mismo movimiento, mandado por quien toca, si entra.
    expect(room.play(actor, legal[0]!)).toBeNull();
    expect(room.state).not.toBe(state);
  });

  it('solo el anfitrion empieza la partida y cambia las opciones', () => {
    const room = new Room('TEST');
    room.join('Ana');
    room.join('Bruno');
    expect(room.start(1)).toBe('Solo el anfitrion empieza la partida.');
    expect(room.configure(1, { variant: 'large' })).toBe('Solo el anfitrion cambia las opciones.');
    expect(room.started).toBe(false);
    expect(room.start(0)).toBeNull();
    expect(room.started).toBe(true);
  });

  it('no admite a nadie nuevo con la partida empezada', () => {
    const room = new Room('TEST');
    room.join('Ana');
    room.join('Bruno');
    room.start(0);
    const tarde = room.join('Carmen');
    expect('error' in tarde).toBe(true);
  });

  it('un asiento humano vacio pasa a bot al empezar', () => {
    // Si no, la partida llega a su turno y se queda esperando a alguien que no
    // existe: no hay nadie que mande la jugada y no hay nada en pantalla que
    // explique por que se ha parado todo.
    const room = new Room('TEST', 3);
    room.join('Ana');
    room.setSeatKind(0, 1, 'human');
    room.setSeatKind(0, 2, 'human');
    expect(room.start(0)).toBeNull();

    const players = room.state!.players;
    expect(players[0]!.kind).toBe('human');
    expect(players[1]!.kind).toBe('bot');
    expect(players[2]!.kind).toBe('bot');

    // Y la partida avanza sola hasta que le toca a la unica persona.
    let steps = 0;
    while (room.botPending() && steps++ < 4000) room.stepBots();
    expect(steps).toBeLessThan(4000);
  });

  it('los bots de la sala juegan solos hasta que le toca a una persona', () => {
    const room = new Room('TEST', 3);
    room.join('Ana');
    room.setSeatKind(0, 1, 'bot', 'normal');
    room.setSeatKind(0, 2, 'bot', 'normal');
    expect(room.start(0)).toBeNull();

    // Se le da cuerda hasta que la partida espere a la persona o acabe.
    let steps = 0;
    while (room.botPending() && steps++ < 4000) room.stepBots();
    expect(steps).toBeLessThan(4000);
    expect(room.state!.players).toHaveLength(3);
  });
});

/**
 * Lo que el cliente puede DECIDIR con un estado censurado.
 *
 * El cliente comprueba la legalidad antes de mandar nada al servidor -- para no
 * molestarlo con jugadas que ya se sabe que no valen -- pero lo hace sobre el
 * estado que le han mandado, al que le faltan a proposito las manos ajenas y el
 * mazo de desarrollo. Toda regla que se apoye en lo que esta tapado dice que no
 * SIEMPRE, y la jugada no llega a salir del navegador: en red se quedaba uno
 * sin poder comprar cartas y sin poder cerrar un intercambio, que es justo lo
 * que pasaba jugando por LAN.
 */
describe('jugar con el estado censurado', () => {
  it('se puede comprar una carta de desarrollo aunque el mazo venga tapado', () => {
    let state = playedGame(7);
    state = { ...state, phase: 'main', dice: [3, 4] };
    const me = state.currentPlayer;
    state = setHand(state, me, { wool: 1, grain: 1, ore: 1 });

    const view = redactFor(state, me);
    expect(view.devDeck).toHaveLength(0);
    expect(devDeckSize(view)).toBe(state.devDeck.length);
    expect(applyAction(view, { type: 'buyDevCard', player: me }).ok).toBe(true);
    expect(applyAction(state, { type: 'buyDevCard', player: me }).ok).toBe(true);
  });

  it('el mazo agotado si impide comprar, tambien en la vista censurada', () => {
    let state = playedGame(8);
    state = { ...state, phase: 'main', dice: [3, 4], devDeck: [] };
    const me = state.currentPlayer;
    state = setHand(state, me, { wool: 1, grain: 1, ore: 1 });
    const view = redactFor(state, me);
    expect(applyAction(view, { type: 'buyDevCard', player: me }).ok).toBe(false);
  });

  it('se puede cerrar un trato con alguien cuya mano no se ve', () => {
    let state = playedGame(9);
    state = { ...state, phase: 'main', dice: [3, 4] };
    const me = state.currentPlayer;
    const other = state.players.find((p) => p.id !== me)!.id;
    state = setHand(state, me, { lumber: 2 });
    state = setHand(state, other, { ore: 2 });
    state = applyOrThrow(state, {
      type: 'offerTrade',
      player: me,
      give: { lumber: 1 },
      want: { ore: 1 },
    });
    state = applyOrThrow(state, { type: 'respondTrade', player: other, accept: true });

    const view = redactFor(state, me);
    expect(totalResources(view.players[other]!.resources)).toBe(0);
    expect(applyAction(view, { type: 'confirmTrade', player: me, with: other }).ok).toBe(true);
    expect(applyAction(state, { type: 'confirmTrade', player: me, with: other }).ok).toBe(true);
  });

  it('pero el servidor sigue rechazando el trato que ya no se puede pagar', () => {
    // La comprobacion que el cliente no puede hacer no desaparece: se hace
    // donde estan las cartas de verdad, que es el unico sitio donde vale.
    let state = playedGame(10);
    state = { ...state, phase: 'main', dice: [3, 4] };
    const me = state.currentPlayer;
    const other = state.players.find((p) => p.id !== me)!.id;
    state = setHand(state, me, { lumber: 2 });
    state = setHand(state, other, { ore: 2 });
    state = applyOrThrow(state, {
      type: 'offerTrade',
      player: me,
      give: { lumber: 1 },
      want: { ore: 1 },
    });
    state = applyOrThrow(state, { type: 'respondTrade', player: other, accept: true });
    state = setHand(state, other, {});
    expect(applyAction(state, { type: 'confirmTrade', player: me, with: other }).ok).toBe(false);
  });

  it('un bot de la sala responde a la oferta de una persona', () => {
    const room = new Room('TEST', 3);
    room.join('Ana');
    room.setSeatKind(0, 1, 'bot', 'normal');
    room.setSeatKind(0, 2, 'bot', 'normal');
    room.start(0);

    // Se avanza hasta el turno de la persona.
    let steps = 0;
    while (steps++ < 4000) {
      const s = room.state!;
      if (s.phase === 'main' && s.currentPlayer === 0) break;
      const actor = playersToAct(s)[0]!;
      if (actor === 0) room.play(0, getLegalActions(s, 0)[0]!);
      else if (!room.stepBots()) break;
    }
    const s = room.state!;
    expect(s.phase).toBe('main');
    for (const p of s.players) p.resources = { lumber: 3, brick: 3, wool: 3, grain: 3, ore: 3 };

    expect(
      room.play(0, { type: 'offerTrade', player: 0, give: { lumber: 1 }, want: { ore: 1 } }),
    ).toBeNull();
    expect(room.botPending()).toBe(true);
    let turns = 0;
    while (room.botPending() && turns++ < 10) room.stepBots();

    const trade = room.state!.activeTrade!;
    expect(trade.responses[1]).not.toBe('pending');
    expect(trade.responses[2]).not.toBe('pending');
    // Contestados todos, la pelota vuelve a quien ofrecio.
    expect(playersToAct(room.state!)).toEqual([0]);
  });
});

describe('los bots de la sala descartan con el 7', () => {
  /** Una sala con la colocacion inicial hecha y dos bots. */
  function started(): Room {
    const room = new Room('TEST', 3);
    room.join('Ana');
    room.setSeatKind(0, 1, 'bot', 'normal');
    room.setSeatKind(0, 2, 'bot', 'normal');
    room.start(0);
    let guard = 0;
    while (guard++ < 500) {
      const s = room.state!;
      if (s.phase !== 'setupSettlement' && s.phase !== 'setupRoad') break;
      const actor = playersToAct(s)[0]!;
      if (actor === 0) room.play(0, getLegalActions(s, 0)[0]!);
      else if (!room.stepBots()) break;
    }
    return room;
  }

  it('un bot con la mano llena descarta en vez de bloquear la sala', () => {
    // `getLegalActions` no enumera los descartes -- son demasiadas
    // combinaciones -- asi que hay que construirlos con `chooseDiscard`. La
    // sala no lo hacia: al bot le salia la lista vacia, no movia nunca, y la
    // partida en red se quedaba clavada en la fase de descarte.
    const room = started();
    const s = room.state!;
    s.phase = 'discard';
    s.mustDiscard = [1];
    s.players[1]!.resources = { lumber: 3, brick: 3, wool: 3, grain: 3, ore: 3 };
    const antes = totalResources(s.players[1]!.resources);
    expect(discardAmount(s, 1)).toBe(7);
    expect(room.botPending()).toBe(true);

    expect(room.stepBots()).toBe(true);
    expect(room.state!.mustDiscard).toEqual([]);
    expect(totalResources(room.state!.players[1]!.resources)).toBe(antes - 7);
  });

  it('con varios bots cargados, la fase se resuelve entera sola', () => {
    const room = started();
    const s = room.state!;
    s.phase = 'discard';
    s.mustDiscard = [1, 2];
    for (const id of [1, 2]) {
      s.players[id]!.resources = { lumber: 2, brick: 2, wool: 2, grain: 2, ore: 2 };
    }
    let steps = 0;
    while (room.botPending() && steps++ < 20) room.stepBots();
    expect(room.state!.mustDiscard).toEqual([]);
    expect(room.state!.phase).not.toBe('discard');
  });

  it('a la persona no se le descarta sola: sigue esperandola', () => {
    const room = started();
    const s = room.state!;
    s.phase = 'discard';
    s.mustDiscard = [0];
    s.players[0]!.resources = { lumber: 3, brick: 3, wool: 3, grain: 3, ore: 3 };
    expect(room.botPending()).toBe(false);
    expect(room.stepBots()).toBe(false);
    expect(room.state!.mustDiscard).toEqual([0]);
  });
});

describe('volver a la sala al terminar', () => {
  /** Una sala de dos con la partida ya acabada. */
  function finished(): Room {
    const room = new Room('TEST', 2);
    room.join('Ana');
    room.setSeatKind(0, 1, 'bot', 'normal');
    room.start(0);
    const s = room.state!;
    s.phase = 'gameOver';
    s.winner = 0;
    return room;
  }

  it('con la partida en marcha no se puede tirar la mesa', () => {
    const room = new Room('TEST', 2);
    room.join('Ana');
    room.setSeatKind(0, 1, 'bot', 'normal');
    room.start(0);
    expect(room.returnToLobby(0)).toBe('La partida aun no ha terminado.');
    expect(room.started).toBe(true);
  });

  it('terminada, la sala vuelve a la espera con la misma gente dentro', () => {
    const room = finished();
    expect(room.returnToLobby(0)).toBeNull();
    expect(room.started).toBe(false);
    expect(room.state).toBeNull();
    const lobby = room.lobby();
    expect(lobby.code).toBe('TEST');
    expect(lobby.started).toBe(false);
    expect(lobby.hostSeat).toBe(0);
    expect(lobby.seats[0]!.occupied).toBe(true);
    expect(lobby.seats[0]!.occupantName).toBe('Ana');
  });

  it('no hace falta volver a entrar: la ficha de asiento sigue valiendo', () => {
    const room = new Room('TEST', 2);
    const seated = room.join('Ana');
    if ('error' in seated) throw new Error(seated.error);
    room.setSeatKind(0, 1, 'bot', 'normal');
    room.start(0);
    room.state!.phase = 'gameOver';
    room.returnToLobby(0);

    const again = room.join('Ana', seated.token);
    expect('error' in again).toBe(false);
    expect((again as { seat: number }).seat).toBe(0);
  });

  it('y desde ahi se puede empezar otra', () => {
    const room = finished();
    room.returnToLobby(0);
    expect(room.start(0)).toBeNull();
    expect(room.started).toBe(true);
    expect(room.state!.phase).toBe('setupSettlement');
  });

  it('la conversacion no se pierde al volver', () => {
    const room = finished();
    room.say(0, 'buena partida');
    room.returnToLobby(0);
    expect(room.chat().some((e) => e.text === 'buena partida')).toBe(true);
  });

  it('el asiento de quien se fue a media partida queda libre', () => {
    const room = new Room('TEST', 3);
    room.join('Ana');
    const bruno = room.join('Bruno');
    if ('error' in bruno) throw new Error(bruno.error);
    room.start(0);
    room.disconnect(bruno.seat);
    // Con la partida viva el asiento se le guarda por si vuelve.
    expect(room.lobby().seats[bruno.seat]!.occupantName).toBe('Bruno');

    room.state!.phase = 'gameOver';
    room.returnToLobby(0);
    expect(room.lobby().seats[bruno.seat]!.occupantName).toBeNull();
    expect(room.lobby().seats[bruno.seat]!.occupied).toBe(false);
  });
});

describe('chat', () => {
  it('guarda lo que dice cada uno con el nombre de SU asiento', () => {
    const room = new Room('TEST', 2);
    const ana = room.join('Ana');
    const bruno = room.join('Bruno');
    if ('error' in ana || 'error' in bruno) throw new Error('no ha entrado');

    room.say(ana.seat, 'hola');
    room.say(bruno.seat, 'que tal');

    const dicho = room.chat().filter((e) => e.seat !== null);
    // El nombre lo pone la sala a partir del asiento, no el mensaje: si viniera
    // en el mensaje cualquiera podria firmar como otro.
    expect(dicho.map((e) => [e.name, e.text])).toEqual([
      ['Ana', 'hola'],
      ['Bruno', 'que tal'],
    ]);
    expect(dicho[0]!.seat).toBe(ana.seat);
    expect(dicho[1]!.seat).toBe(bruno.seat);
  });

  it('anota los avisos del juego sin autor', () => {
    const room = new Room('TEST', 2);
    room.join('Ana');
    const avisos = room.chat().filter((e) => e.seat === null);
    expect(avisos.length).toBeGreaterThan(0);
    expect(avisos[0]!.text).toContain('se ha unido');
  });

  it('descarta los mensajes vacios y recorta los larguisimos', () => {
    const room = new Room('TEST', 2);
    const ana = room.join('Ana');
    if ('error' in ana) throw new Error(ana.error);
    const antes = room.chat().length;

    room.say(ana.seat, '   ');
    expect(room.chat()).toHaveLength(antes);

    room.say(ana.seat, 'x'.repeat(5000));
    const ultimo = room.chat().at(-1)!;
    expect(ultimo.text.length).toBeLessThanOrEqual(CHAT_MAX_LENGTH);
  });

  it('la conversacion tiene tope y no crece sin fin', () => {
    // La sala vive en memoria hasta que se vacia: sin tope, una partida larga
    // con gente habladora ocuparia lo que le diera la gana.
    const room = new Room('TEST', 2);
    const ana = room.join('Ana');
    if ('error' in ana) throw new Error(ana.error);
    for (let i = 0; i < 500; i++) room.say(ana.seat, `mensaje ${i}`);
    expect(room.chat().length).toBeLessThanOrEqual(200);
    // Lo que se guarda es lo ULTIMO, que es lo que interesa leer.
    expect(room.chat().at(-1)!.text).toBe('mensaje 499');
  });

  it('los mensajes vacios ni siquiera llegan a la sala', () => {
    expect(parseClientMessage({ type: 'chat', text: '   ' })).toBeNull();
    expect(parseClientMessage({ type: 'chat' })).toBeNull();
    expect(parseClientMessage({ type: 'chat', text: 42 })).toBeNull();
    expect(parseClientMessage({ type: 'chat', text: '  hola  ' })).toEqual({
      type: 'chat',
      text: 'hola',
    });
  });
});

describe('mensajes que llegan de fuera', () => {
  /**
   * Lo que entra por el socket no es de fiar, aunque venga del propio juego.
   *
   * Este bloque existe por un fallo de verdad: un `{type:'action'}` sin accion
   * -- que es lo que produce `JSON.stringify` cuando la accion es `undefined`,
   * sin que nadie tenga mala intencion -- reventaba al leer `action.player`, y
   * al saltar dentro del manejador del socket se llevaba por delante el proceso
   * entero. Un cliente cualquiera podia tumbar la partida de todos los demas.
   */
  const BASURA: unknown[] = [
    null,
    undefined,
    42,
    'hola',
    [],
    {},
    { type: 'desconocido' },
    // El caso que tumbaba el servidor.
    { type: 'action' },
    { type: 'action', action: null },
    { type: 'action', action: 'endTurn' },
    { type: 'action', action: {} },
    { type: 'action', action: { type: 'endTurn' } },
    { type: 'action', action: { player: 0 } },
    { type: 'action', action: { type: 'endTurn', player: 'yo' } },
    { type: 'action', action: { type: 'endTurn', player: -1 } },
    { type: 'action', action: { type: 'endTurn', player: 1.5 } },
    { type: 'join' },
    { type: 'join', version: '1', room: '', name: 'Ana' },
    { type: 'join', version: 1, room: 5, name: 'Ana' },
    { type: 'takeSeat' },
    { type: 'takeSeat', seat: 'dos' },
    { type: 'setSeatKind', seat: 1, kind: 'perro' },
  ];

  it('la basura se rechaza sin excepciones', () => {
    for (const raw of BASURA) {
      expect(() => parseClientMessage(raw), JSON.stringify(raw) ?? 'undefined').not.toThrow();
      expect(parseClientMessage(raw), JSON.stringify(raw) ?? 'undefined').toBeNull();
    }
  });

  it('los mensajes buenos pasan', () => {
    expect(parseClientMessage({ type: 'ping' })).toEqual({ type: 'ping' });
    expect(parseClientMessage({ type: 'start' })).toEqual({ type: 'start' });
    expect(parseClientMessage({ type: 'takeSeat', seat: 2 })).toEqual({ type: 'takeSeat', seat: 2 });
    expect(
      parseClientMessage({ type: 'action', action: { type: 'endTurn', player: 0 } }),
    ).toEqual({ type: 'action', action: { type: 'endTurn', player: 0 } });
  });

  it('recorta el nombre y el codigo por si vienen enormes', () => {
    const parsed = parseClientMessage({
      type: 'join',
      version: 1,
      room: 'X'.repeat(500),
      name: 'A'.repeat(500),
    });
    expect(parsed).not.toBeNull();
    if (parsed?.type !== 'join') throw new Error('deberia ser join');
    // El recorte va en el servidor porque la interfaz es del cliente y puede
    // mandar lo que quiera, por mucho maxlength que lleve el campo.
    expect(parsed.name.length).toBeLessThanOrEqual(16);
    expect(parsed.room.length).toBeLessThanOrEqual(12);
  });

  it('una jugada bien formada pero de un asiento que no existe no rompe la sala', () => {
    const room = new Room('TEST', 2);
    room.join('Ana');
    room.join('Bruno');
    room.start(0);
    const before = room.state;
    // Asiento 9 en una sala de 2: la forma es valida, el contenido no.
    expect(() => room.play(9, { type: 'endTurn', player: 9 })).not.toThrow();
    expect(room.state).toBe(before);
  });
});

describe('codigos de sala', () => {
  it('son de cuatro caracteres sin letras que se confundan', () => {
    for (let i = 0; i < 200; i++) {
      const code = makeRoomCode();
      expect(code).toHaveLength(4);
      // Ni O/0 ni I/1/L: el codigo se dicta en voz alta por encima de la mesa.
      expect(code).not.toMatch(/[OI1L0AEU]/);
    }
  });

  it('acepta el codigo escrito de cualquier manera', () => {
    expect(normalizeRoomCode(' bc-df ')).toBe('BCDF');
    expect(normalizeRoomCode('BCDF')).toBe('BCDF');
  });
});
