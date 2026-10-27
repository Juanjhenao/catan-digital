// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameState, PlayerConfig, Resource } from '../src/engine/index.js';

/**
 * Pruebas de la interfaz pulsando de verdad.
 *
 * El otro archivo de interfaz comprueba que la partida avanza; este comprueba
 * el cableado: que los botones existen, que abren la ventana que toca, que los
 * selectores dentro de ella modifican el estado correcto y que el resultado
 * llega al motor. Es donde aparecen los fallos de conexion entre capas, que no
 * detecta ningun test del motor.
 */

function fakeContext(): CanvasRenderingContext2D {
  const gradient = { addColorStop: () => {} };
  const store: Record<string, unknown> = {};
  return new Proxy(store, {
    get(target, prop: string) {
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
        return () => gradient;
      }
      if (prop === 'measureText') return () => ({ width: 10 });
      if (prop === 'canvas') return { width: 1200, height: 800 };
      if (prop in target) return target[prop];
      return () => undefined;
    },
    set(target, prop: string, value) {
      target[prop] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

function installDomShims(): void {
  HTMLCanvasElement.prototype.getContext = (() => fakeContext()) as never;
  Element.prototype.getBoundingClientRect = function (): DOMRect {
    return {
      x: 0,
      y: 0,
      width: 1200,
      height: 800,
      top: 0,
      left: 0,
      right: 1200,
      bottom: 800,
      toJSON: () => ({}),
    } as DOMRect;
  };
  let depth = 0;
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    if (depth > 2) return 0;
    depth++;
    try {
      cb(performance.now());
    } finally {
      depth--;
    }
    return 1;
  }) as never;
  window.cancelAnimationFrame = () => {};
}

const SHELL = `
  <div id="app">
    <section id="setup" class="screen setup"></section>
    <section id="game" class="screen game hidden">
      <header class="topbar">
        <div id="turn-banner" class="turn-banner"></div>
        <button id="btn-sound" type="button">Sonido</button>
        <button id="btn-rules" type="button">Reglas</button>
        <button id="btn-new" type="button">Nueva partida</button>
      </header>
      <main class="table">
        <div class="board-wrap">
          <canvas id="board"></canvas>
          <div id="board-hint" class="board-hint"></div>
          <aside id="chat" class="chat"></aside>
        </div>
        <aside class="sidebar">
          <div id="players" class="players"></div>
          <ol id="log-list" class="log__list"></ol>
        </aside>
      </main>
      <footer id="handbar" class="handbar"></footer>
    </section>
    <div id="overlay" class="overlay hidden"></div>
  </div>
`;

function players(count: number): PlayerConfig[] {
  const colors = ['red', 'blue', 'white', 'orange', 'green', 'brown'] as const;
  return Array.from({ length: count }, (_, i) => ({
    name: `J${i + 1}`,
    color: colors[i]!,
    kind: 'human' as const,
  }));
}

interface AppInternals {
  state: GameState;
  handOwner: number;
  revealedFor: number | null;
  render(): void;
  computeHighlight(): {
    vertices?: Set<string>;
    edges?: Set<string>;
    hexes?: Set<string>;
    cities?: Set<string>;
    color?: string;
  };
  handlePick(pick: unknown): void;
  view: {
    diceBox: { x: number; y: number; w: number; h: number };
    reserve: {
      color: string;
      road: number;
      settlement: number;
      city: number;
      capacity: { road: number; settlement: number; city: number };
    } | null;
  };
  deadline: number | null;
  clockOn: boolean;
  clockKeyNow(): string | null;
  tickClock(): void;
  applyRemoteState(state: GameState): void;
  isNetworked: boolean;
  destroy(): void;
}

/** Fuerza el vencimiento del reloj de jugada sin esperar treinta segundos. */
function expireClock(app: AppInternals): void {
  expect(app.deadline, 'el reloj no estaba en marcha').not.toBeNull();
  app.deadline = Date.now() - 1;
  app.tickClock();
}

async function makeApp(count = 4, seed = 2024) {
  document.body.innerHTML = SHELL;
  installDomShims();
  const { GameApp } = await import('../src/ui/app.js');
  const app = new GameApp(players(count), seed, 10, vi.fn()) as unknown as AppInternals;
  return app;
}

/**
 * La aplicacion en modo red, con un cliente de mentira que solo apunta lo que
 * se le manda.
 *
 * Hace falta porque en red desaparece el escudo de privacidad -- cada uno tiene
 * su pantalla -- y con el desaparece lo que tapaba de casualidad las ventanas
 * que la fase impone. Sin una aplicacion en red no hay forma de comprobar a
 * quien se le ensenan.
 */
async function makeNetApp(seat = 0, count = 4, seed = 2024, onFinish?: () => void) {
  document.body.innerHTML = SHELL;
  installDomShims();
  const engine = await import('../src/engine/index.js');
  const { GameApp } = await import('../src/ui/app.js');
  const configs = players(count);
  const state = engine.createGame(configs, { seed });
  const sent: unknown[] = [];
  const messages: unknown[] = [];
  const client = {
    play: (action: unknown) => sent.push(action),
    send: (message: unknown) => messages.push(message),
  };
  const onExit = vi.fn();
  const app = new GameApp(configs, 0, 10, onExit, {
    net: { client: client as never, seat, state },
    ...(onFinish ? { onFinish } : {}),
  }) as unknown as AppInternals;
  return { app, sent, messages, engine, onExit };
}

// --- utilidades de interaccion ---------------------------------------------

const overlay = () => document.getElementById('overlay')!;
const hint = () => document.getElementById('board-hint')!.textContent ?? '';
const handbar = () => document.getElementById('handbar')!;

function buttons(root: Element): HTMLButtonElement[] {
  return [...root.querySelectorAll('button')] as HTMLButtonElement[];
}

function findButton(root: Element, label: string): HTMLButtonElement | undefined {
  return buttons(root).find((b) => (b.textContent ?? '').trim().startsWith(label));
}

function click(root: Element, label: string): void {
  const button = findButton(root, label);
  if (!button) {
    throw new Error(
      `no hay boton "${label}". Hay: ${buttons(root)
        .map((b) => JSON.stringify((b.textContent ?? '').trim()))
        .join(', ')}`,
    );
  }
  if (button.disabled) throw new Error(`el boton "${label}" esta deshabilitado`);
  button.dispatchEvent(new window.Event('click'));
}

/**
 * Pulsa la carta de un recurso dentro de uno de los raíles de una ventana de
 * comercio. `rail` es 0 para el de arriba (lo que entregas u ofreces) y 1 para
 * el de abajo (lo que recibes o pides).
 */
function pickCard(rail: number, resource: string): void {
  const rails = [...overlay().querySelectorAll('.card-rail')];
  const target = rails[rail];
  if (!target) throw new Error(`no hay rail ${rail}; hay ${rails.length}`);
  const button = target.querySelector(
    `button[data-resource="${resource}"]`,
  ) as HTMLButtonElement | null;
  if (!button) throw new Error(`no hay carta de ${resource} en el rail ${rail}`);
  if (button.disabled) throw new Error(`la carta de ${resource} esta deshabilitada`);
  button.dispatchEvent(new window.Event('click'));
}

/**
 * Abre la ventana de comercio en una de sus dos pestanas. Banco y jugadores
 * comparten ventana, asi que hay que decir cual se quiere.
 */
function openTrade(tab: 'bank' | 'players'): void {
  click(handbar(), 'Comerciar');
  const tabs = [...overlay().querySelectorAll('.trade-tab')] as HTMLButtonElement[];
  const target = tabs[tab === 'bank' ? 0 : 1];
  if (!target) throw new Error(`no hay pestana ${tab}; hay ${tabs.length}`);
  target.dispatchEvent(new window.Event('click'));
}

/** Juega una carta de desarrollo pulsandola directamente en la mano. */
function playDev(kind: string): void {
  const card = handbar().querySelector(
    `button[data-dev="${kind}"]`,
  ) as HTMLButtonElement | null;
  if (!card) throw new Error(`no hay carta ${kind} en la mano`);
  if (card.disabled) throw new Error(`la carta ${kind} no se puede jugar ahora`);
  card.dispatchEvent(new window.Event('click'));
}

/** Recursos de las cartas puestas en una fila de la mesa de intercambio. */
function rowCards(row: number): string[] {
  const rows = [...overlay().querySelectorAll('.trade-row')];
  const target = rows[row];
  if (!target) throw new Error(`no hay fila ${row}; hay ${rows.length}`);
  return [...target.querySelectorAll('.trade-row__slots .rcard')].map(
    (c) => c.getAttribute('data-resource') ?? '?',
  );
}

/**
 * Clic sobre el lienzo del tablero, en pixeles de pantalla. Es la unica via
 * para probar lo que se dibuja dentro del canvas (los dados), porque ahi no hay
 * DOM que consultar.
 */
function clickBoard(x: number, y: number): void {
  document
    .getElementById('board')!
    .dispatchEvent(new window.MouseEvent('click', { clientX: x, clientY: y }));
}

/** Centro del rectangulo sensible de los dados, tal como lo situo la vista. */
function diceCenter(app: AppInternals): [number, number] {
  const box = app.view.diceBox;
  expect(box.w, 'la vista no ha situado los dados').toBeGreaterThan(0);
  return [box.x + box.w / 2, box.y + box.h / 2];
}

/** Sube el escudo de privacidad del jugador que toque. */
function reveal(app: AppInternals): void {
  const shield = findButton(overlay(), 'Soy ');
  if (shield) shield.dispatchEvent(new window.Event('click'));
  else {
    app.revealedFor = app.handOwner;
    app.render();
  }
}

/** Coloca la partida en un punto concreto sin pasar por la interfaz. */
function setState(app: AppInternals, patch: Partial<GameState>): void {
  app.state = { ...app.state, ...patch } as GameState;
  app.revealedFor = app.handOwner;
  app.render();
}

function setResources(
  app: AppInternals,
  player: number,
  hand: Partial<Record<Resource, number>>,
): void {
  const full = { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0, ...hand };
  const bank = { ...app.state.bank };
  const previous = app.state.players[player]!.resources;
  for (const r of ['lumber', 'brick', 'wool', 'grain', 'ore'] as const) {
    bank[r] += previous[r] - full[r];
  }
  setState(app, {
    bank,
    players: app.state.players.map((p) => (p.id === player ? { ...p, resources: full } : p)),
  });
}

/** Completa la colocacion inicial pulsando en el tablero. */
function playSetup(app: AppInternals): void {
  let guard = 0;
  while (
    (app.state.phase === 'setupSettlement' || app.state.phase === 'setupRoad') &&
    guard++ < 200
  ) {
    reveal(app);
    const highlight = app.computeHighlight();
    if (app.state.phase === 'setupSettlement') {
      app.handlePick({ kind: 'vertex', id: [...highlight.vertices!][guard % highlight.vertices!.size] });
    } else {
      app.handlePick({ kind: 'edge', id: [...highlight.edges!][0] });
    }
  }
}

// ---------------------------------------------------------------------------

describe('interfaz: acciones desde los botones', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('el boton de tirar dados llega al motor', async () => {
    const app = await makeApp();
    playSetup(app);
    reveal(app);
    expect(app.state.phase).toBe('roll');
    click(handbar(), 'Tirar dados');
    expect(app.state.dice).not.toBeNull();
    expect(['main', 'discard', 'moveRobber']).toContain(app.state.phase);
  });

  it('el panel de cada jugador ensena sus cifras publicas', async () => {
    const app = await makeApp();
    playSetup(app);
    reveal(app);
    const me = app.handOwner;
    setResources(app, me, { lumber: 2, brick: 1, ore: 3 });

    const card = document.querySelectorAll('#players .player-card')[me] as HTMLElement;
    const stats = [...card.querySelectorAll('.pstat')].map((el) => el.textContent?.trim());

    const player = app.state.players[me]!;
    let settlements = 0;
    let cities = 0;
    for (const vertex of player.buildings) {
      if (app.state.buildings[vertex]!.kind === 'city') cities++;
      else settlements++;
    }

    // Orden: cartas, desarrollo, poblados, ciudades, ruta, caballeros. Los
    // caminos construidos no salen: no dan puntos y solo anadian ruido.
    expect(stats).toEqual([
      '6',
      String(player.devCards.length),
      String(settlements),
      String(cities),
      String(player.longestRoadLength),
      String(player.knightsPlayed),
    ]);
    // La colocacion inicial deja dos poblados y dos caminos por jugador.
    expect(settlements).toBe(2);
    expect(player.roads).toHaveLength(2);
  });

  it('las piezas sin colocar se pasan al tablero para dibujarlas', async () => {
    const app = await makeApp();
    playSetup(app);
    reveal(app);
    setState(app, { phase: 'main', dice: [3, 4] });
    const me = app.handOwner;
    const player = app.state.players[me]!;

    // Lo que se dibuja al lado del tablero es lo que QUEDA, y la bandeja se
    // dimensiona con la dotacion completa para que no cambie al construir.
    expect(app.view.reserve).toEqual({
      color: player.color,
      road: player.piecesLeft.road,
      settlement: player.piecesLeft.settlement,
      city: player.piecesLeft.city,
      capacity: { road: 15, settlement: 5, city: 4 },
    });
    // Tras la salida ya se han gastado dos caminos y dos poblados.
    expect(player.piecesLeft.road).toBe(13);
    expect(player.piecesLeft.settlement).toBe(3);

    // Con el escudo puesto no se ensenan las piezas de nadie.
    app.revealedFor = null;
    app.render();
    expect(app.view.reserve).toBeNull();
  });

  it('las cartas de desarrollo estan en la mano, sin ventana intermedia', async () => {
    const app = await makeApp();
    playSetup(app);
    reveal(app);
    const me = app.state.currentPlayer;
    setState(app, {
      phase: 'main',
      dice: [3, 4],
      players: app.state.players.map((p) =>
        p.id === me
          ? {
              ...p,
              devCards: [
                { kind: 'knight' as const, boughtOnTurn: 0 },
                { kind: 'knight' as const, boughtOnTurn: 0 },
                { kind: 'victoryPoint' as const, boughtOnTurn: 0 },
              ],
            }
          : p,
      ),
    });

    const cards = [...handbar().querySelectorAll('button[data-dev]')] as HTMLButtonElement[];
    // Dos tipos distintos, no tres cartas: las iguales se agrupan.
    expect(cards.map((c) => c.getAttribute('data-dev'))).toEqual(['knight', 'victoryPoint']);
    expect(cards[0]!.textContent).toContain('x2');
    // El punto de victoria se ve pero no se juega.
    expect(cards[1]!.disabled).toBe(true);

    playDev('knight');
    expect(app.state.players[me]!.knightsPlayed).toBe(1);
  });

  it('el boton de sonido enciende y apaga, y sin Web Audio no revienta nada', async () => {
    const app = await makeApp();
    playSetup(app);
    reveal(app);

    // jsdom no trae Web Audio: la comprobacion vale doble, porque es
    // exactamente el caso «este navegador no puede» que no debe romper nada.
    expect('AudioContext' in window).toBe(false);

    const button = document.getElementById('btn-sound') as HTMLButtonElement;
    expect(button.textContent).toBe('Sonido');
    button.click();
    expect(button.textContent).toBe('Sin sonido');
    button.click();
    expect(button.textContent).toBe('Sonido');

    // Y la partida sigue jugandose igual con o sin altavoces: la jugada pasa
    // por el mismo `dispatch` que intenta sonar.
    expect(app.state.phase).toBe('roll');
    click(handbar(), 'Tirar dados');
    expect(app.state.dice).not.toBeNull();
  });

  it('el reloj de jugada corre para el humano y se para con el escudo puesto', async () => {
    const app = await makeApp();
    playSetup(app);
    reveal(app);
    setState(app, { phase: 'main', dice: [3, 4] });

    expect(app.clockKeyNow()).not.toBeNull();
    expect(app.deadline).not.toBeNull();
    // Quedan treinta segundos, con holgura para lo que tarde el test.
    expect(app.deadline! - Date.now()).toBeGreaterThan(28_000);

    // Con el escudo bajado el reloj no cuenta: aun no han cogido el aparato.
    app.revealedFor = null;
    app.render();
    expect(app.clockKeyNow()).toBeNull();
    expect(app.deadline).toBeNull();
  });

  it('al agotarse el tiempo en la fase principal se pasa el turno', async () => {
    const app = await makeApp();
    playSetup(app);
    reveal(app);
    setState(app, { phase: 'main', dice: [3, 4] });
    const me = app.state.currentPlayer;
    setResources(app, me, { lumber: 4, brick: 4, wool: 4, grain: 4 });

    expireClock(app);

    expect(app.state.currentPlayer).not.toBe(me);
    // El reloj nunca gasta recursos: solo cierra el turno.
    expect(app.state.players[me]!.resources).toEqual({
      lumber: 4,
      brick: 4,
      wool: 4,
      grain: 4,
      ore: 0,
    });
  });

  it('al agotarse el tiempo en la fase de tirada se tira solo', async () => {
    const app = await makeApp();
    playSetup(app);
    reveal(app);
    expect(app.state.phase).toBe('roll');

    expireClock(app);

    expect(app.state.dice).not.toBeNull();
  });

  it('el reloj se puede desactivar', async () => {
    const app = await makeApp();
    playSetup(app);
    reveal(app);
    setState(app, { phase: 'main', dice: [3, 4] });
    expect(app.deadline).not.toBeNull();

    app.clockOn = false;
    app.render();

    expect(app.clockKeyNow()).toBeNull();
    expect(app.deadline).toBeNull();
  });

  it('un clic en los dados del tablero tira igual que el boton', async () => {
    const app = await makeApp();
    playSetup(app);
    reveal(app);
    expect(app.state.phase).toBe('roll');

    clickBoard(...diceCenter(app));

    expect(app.state.dice).not.toBeNull();
    expect(['main', 'discard', 'moveRobber']).toContain(app.state.phase);
  });

  it('en red, el ladron y el descarte solo se le ensenan a quien le toca', async () => {
    // Este test existe por un fallo de verdad: bastaba con que la fase fuera
    // `steal` para taparle el tablero a TODO el mundo. En el sofa no se veia
    // porque el escudo de privacidad llegaba primero; en red no hay escudo, y
    // a los demas les aparecia el ladron encima sin ser su turno.
    const { app } = await makeNetApp(0);
    const me = 0;
    const otro = 1;

    setState(app, { phase: 'steal', currentPlayer: otro, stealTargets: [me] });
    expect(overlay().classList.contains('hidden')).toBe(true);

    setState(app, { phase: 'steal', currentPlayer: me, stealTargets: [otro] });
    expect(overlay().classList.contains('hidden')).toBe(false);

    // Y el descarte, igual: solo lo ve quien tiene que descartar.
    setState(app, { phase: 'discard', currentPlayer: otro, mustDiscard: [otro] });
    expect(overlay().classList.contains('hidden')).toBe(true);

    setState(app, { phase: 'discard', currentPlayer: otro, mustDiscard: [otro, me] });
    expect(overlay().classList.contains('hidden')).toBe(false);
  });

  it('el descarte de otro no te habla a ti', async () => {
    // Mismo error que el del ladron, en el cartel de estado en vez de en una
    // ventana: el texto se sacaba de `handOwner` -- la mano de abajo, que en
    // red es SIEMPRE la propia -- asi que a todo el mundo le salia en segunda
    // persona una orden que era de otro.
    const { app } = await makeNetApp(0, 6, 7);
    reveal(app);

    setState(app, { phase: 'discard', currentPlayer: 1, mustDiscard: [1, 2] });
    expect(hint()).toContain('debe descartar');
    expect(hint()).not.toContain('Te toca');

    // Cuando de verdad te toca a ti, si te lo dice.
    setState(app, { phase: 'discard', currentPlayer: 1, mustDiscard: [0, 1] });
    expect(hint()).toContain('Te toca descartar');
  });

  it('el ladron de otro tampoco te habla a ti', async () => {
    const { app } = await makeNetApp(0, 4, 7);
    reveal(app);

    setState(app, { phase: 'moveRobber', currentPlayer: 2 });
    expect(hint()).toContain('J3 esta moviendo el ladron');

    setState(app, { phase: 'moveRobber', currentPlayer: 0 });
    expect(hint()).toContain('elige la casilla del ladron');
  });

  it('el ladron de un bot no asoma en la pantalla de nadie', async () => {
    // El otro fallo del mismo sitio, y el que se veia jugando en el sofa: un
    // bot juega un caballero, la fase pasa a `steal` con el bot como jugador en
    // turno, y como un bot no dispara el escudo de privacidad el selector de
    // victima se colaba en pantalla el medio segundo que el bot tarda en
    // decidir. Salia una eleccion que no era de nadie que estuviera mirando.
    const app = await makeApp();
    playSetup(app);
    reveal(app);

    const bot = 1;
    const conBot = app.state.players.map((p, i) =>
      i === bot ? { ...p, kind: 'bot' as const } : p,
    );

    setState(app, {
      players: conBot,
      phase: 'steal',
      currentPlayer: bot,
      stealTargets: [0],
    });
    expect(app.handOwner).toBe(bot);
    expect(overlay().classList.contains('hidden')).toBe(true);

    // Y el descarte de un bot, igual: se resuelve solo, sin ventana.
    setState(app, {
      players: conBot,
      phase: 'discard',
      currentPlayer: bot,
      mustDiscard: [bot],
    });
    expect(overlay().classList.contains('hidden')).toBe(true);

    // Pero cuando le toca a la persona que tiene el aparato delante, sale.
    setState(app, { phase: 'steal', currentPlayer: 0, stealTargets: [1] });
    expect(overlay().classList.contains('hidden')).toBe(false);
  });

  it('en red se ensena siempre la mano propia y las jugadas se mandan', async () => {
    const { app, sent } = await makeNetApp(2);
    // La mano de abajo es la del asiento propio, tambien mientras juegan otros:
    // cada uno tiene su pantalla y no hay dispositivo que pasarse.
    expect(app.handOwner).toBe(2);
    setState(app, { phase: 'main', currentPlayer: 0, dice: [3, 4] });
    expect(app.handOwner).toBe(2);
    expect(app.isNetworked).toBe(true);

    // Y una jugada propia se manda al servidor en vez de aplicarse aqui.
    setState(app, { phase: 'main', currentPlayer: 2, dice: [3, 4] });
    const antes = app.state;
    click(handbar(), 'Terminar turno');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'endTurn', player: 2 });
    // El cliente NO aplica nada: espera a que el servidor le devuelva el estado.
    expect(app.state).toBe(antes);
  });

  it('los dados pasan el turno una vez tirados', async () => {
    const app = await makeApp();
    playSetup(app);
    reveal(app);
    setState(app, { phase: 'main', dice: [3, 4] });
    const antes = app.state.currentPlayer;

    // El mismo sitio hace las dos cosas que enmarcan una jugada: al principio
    // del turno tira, y despues pasa. No hay que cruzar la pantalla para
    // buscar el boton de pasar.
    clickBoard(...diceCenter(app));

    expect(app.state.currentPlayer).not.toBe(antes);
    // No se ha vuelto a tirar por el camino.
    expect(app.state.phase).toBe('roll');
  });

  it('los dados no hacen nada cuando no hay jugada que ofrecer', async () => {
    const app = await makeApp();
    playSetup(app);
    reveal(app);
    // Con el ladron por colocar no se puede ni tirar ni pasar: el turno esta a
    // medias y el dado tiene que quedarse callado.
    setState(app, { phase: 'moveRobber', dice: [3, 4] });
    const antes = JSON.stringify(app.state);

    clickBoard(...diceCenter(app));

    expect(JSON.stringify(app.state)).toBe(antes);
  });

  it('los botones de construir se deshabilitan si faltan recursos', async () => {
    const app = await makeApp();
    playSetup(app);
    reveal(app);
    setState(app, { phase: 'main', dice: [3, 4] });
    setResources(app, app.handOwner, {});

    expect(findButton(handbar(), 'Camino')!.disabled).toBe(true);
    expect(findButton(handbar(), 'Poblado')!.disabled).toBe(true);
    expect(findButton(handbar(), 'Ciudad')!.disabled).toBe(true);

    setResources(app, app.handOwner, { lumber: 1, brick: 1 });
    expect(findButton(handbar(), 'Camino')!.disabled).toBe(false);
    expect(findButton(handbar(), 'Poblado')!.disabled).toBe(true);
  });

  it('el tablero construye con un clic, sin pasar por los botones', async () => {
    const app = await makeApp();
    playSetup(app);
    reveal(app);
    setState(app, { phase: 'main', dice: [3, 4] });
    const me = app.handOwner;
    setResources(app, me, { lumber: 1, brick: 1 });

    // Sin tocar ningun boton, el tablero ya marca donde cabe un camino.
    const edges = app.computeHighlight().edges!;
    expect(edges.size).toBeGreaterThan(0);

    const before = app.state.players[me]!.roads.length;
    app.handlePick({ kind: 'edge', id: [...edges][0] });
    expect(app.state.players[me]!.roads).toHaveLength(before + 1);
    expect(app.state.players[me]!.resources.lumber).toBe(0);

    // Gastada la arcilla, ya no queda nada que marcar.
    expect(app.computeHighlight().edges!.size).toBe(0);
  });

  it('un clic sobre tu propio poblado lo mejora a ciudad', async () => {
    const app = await makeApp();
    playSetup(app);
    reveal(app);
    setState(app, { phase: 'main', dice: [3, 4] });
    const me = app.handOwner;
    setResources(app, me, { grain: 2, ore: 3 });

    const highlight = app.computeHighlight();
    const vertex = [...highlight.cities!][0]!;
    // El cruce marcado es uno de tus poblados, y la vista sabe que ahi va ciudad.
    expect(highlight.vertices!.has(vertex)).toBe(true);
    expect(app.state.buildings[vertex]!.kind).toBe('settlement');

    app.handlePick({ kind: 'vertex', id: vertex });

    expect(app.state.buildings[vertex]!.kind).toBe('city');
    expect(app.state.players[me]!.resources.ore).toBe(0);
  });

  it('los botones de construir filtran el tablero en vez de habilitarlo', async () => {
    const app = await makeApp();
    playSetup(app);
    reveal(app);
    setState(app, { phase: 'main', dice: [3, 4] });
    const me = app.handOwner;
    // Recien salidos de la colocacion inicial no hay cruce legal para un
    // poblado nuevo (la regla de distancia los bloquea todos), asi que se
    // comprueba con una mejora a ciudad, que si esta disponible.
    setResources(app, me, { lumber: 1, brick: 1, grain: 2, ore: 3 });

    // De partida se ve todo lo construible a la vez.
    const free = app.computeHighlight();
    expect(free.edges!.size).toBeGreaterThan(0);
    expect(free.vertices!.size).toBeGreaterThan(0);

    click(handbar(), 'Camino');
    const onlyRoads = app.computeHighlight();
    expect(onlyRoads.edges!.size).toBeGreaterThan(0);
    expect(onlyRoads.vertices!.size).toBe(0);
  });

  it('el cambio con el banco se completa desde su ventana', async () => {
    const app = await makeApp();
    playSetup(app);
    reveal(app);
    setState(app, { phase: 'main', dice: [3, 4] });
    const me = app.handOwner;
    setResources(app, me, { ore: 4 });

    openTrade('bank');
    expect(overlay().textContent).toContain('Sin puerto el cambio es 4:1');

    // Elegir que se entrega y que se recibe pulsando las cartas.
    pickCard(0, 'ore');
    pickCard(1, 'wool');

    // La mesa ensena el cambio: sin puerto son cuatro minerales por una lana.
    expect(rowCards(0)).toEqual(['ore', 'ore', 'ore', 'ore']);
    expect(rowCards(1)).toEqual(['wool']);

    click(overlay(), 'Cambiar');
    expect(app.state.players[me]!.resources.ore).toBe(0);
    expect(app.state.players[me]!.resources.wool).toBe(1);
    // La ventana se cierra sola tras el cambio.
    expect(overlay().classList.contains('hidden')).toBe(true);
  });

  it('el descarte por un 7 exige la cantidad exacta antes de dejar confirmar', async () => {
    const app = await makeApp();
    playSetup(app);
    reveal(app);
    const victim = app.state.currentPlayer;
    setResources(app, victim, { lumber: 5, brick: 5 });
    setState(app, { phase: 'discard', dice: [3, 4], mustDiscard: [victim] });

    expect(overlay().textContent).toContain('Descarta la mitad');
    const confirm = findButton(overlay(), 'Descartar')!;
    // El reparto propuesto por defecto ya suma lo pedido.
    expect(confirm.disabled).toBe(false);
    expect(overlay().textContent).toContain('5 / 5');

    // Quitar una carta lo deja incompleto.
    const minus = buttons(overlay()).find((b) => b.textContent === '-' && !b.disabled)!;
    minus.dispatchEvent(new window.Event('click'));
    expect(overlay().textContent).toContain('4 / 5');
    expect(findButton(overlay(), 'Descartar')!.disabled).toBe(true);

    // Devolverla y confirmar.
    const plus = buttons(overlay()).find((b) => b.textContent === '+' && !b.disabled)!;
    plus.dispatchEvent(new window.Event('click'));
    click(overlay(), 'Descartar');
    const total = Object.values(app.state.players[victim]!.resources).reduce((a, b) => a + b, 0);
    expect(total).toBe(5);
    expect(app.state.phase).toBe('moveRobber');
  });

  it('el monopolio se juega eligiendo recurso en su ventana', async () => {
    const app = await makeApp();
    playSetup(app);
    reveal(app);
    const me = app.state.currentPlayer;
    setState(app, {
      phase: 'main',
      dice: [3, 4],
      players: app.state.players.map((p) =>
        p.id === me ? { ...p, devCards: [{ kind: 'monopoly', boughtOnTurn: 0 }] } : p,
      ),
    });
    setResources(app, me, {});
    for (const p of app.state.players) if (p.id !== me) setResources(app, p.id, { wool: 2 });

    // La carta esta en la mano, sin ventana intermedia.
    playDev('monopoly');
    expect(overlay().textContent).toContain('Nombra un recurso');

    const plus = [...overlay().querySelectorAll('.res-picker__item')]
      .find((item) => item.textContent?.includes('Lana'))!
      .querySelectorAll('button')[1] as HTMLButtonElement;
    plus.dispatchEvent(new window.Event('click'));
    click(overlay(), 'Confirmar');

    expect(app.state.players[me]!.resources.wool).toBe(6);
    expect(overlay().classList.contains('hidden')).toBe(true);
  });

  it('una oferta entre jugadores se propone, se acepta y se cierra', async () => {
    const app = await makeApp();
    playSetup(app);
    reveal(app);
    setState(app, { phase: 'main', dice: [3, 4] });
    const me = app.state.currentPlayer;
    const other = app.state.players.find((p) => p.id !== me)!.id;
    setResources(app, me, { ore: 1 });
    setResources(app, other, { wool: 1 });

    openTrade('players');
    expect(overlay().textContent).toContain('Pon sobre la mesa lo que ofreces');

    pickCard(0, 'ore');
    pickCard(1, 'wool');
    expect(rowCards(0)).toEqual(['ore']);
    expect(rowCards(1)).toEqual(['wool']);

    click(overlay(), 'Poner la oferta');
    expect(app.state.activeTrade).not.toBeNull();
    expect(overlay().textContent).toContain('Oferta de');

    click(overlay(), 'Acepto');
    click(overlay(), 'Cerrar trato');

    expect(app.state.players[me]!.resources.wool).toBe(1);
    expect(app.state.players[me]!.resources.ore).toBe(0);
    expect(app.state.players[other]!.resources.ore).toBe(1);
    expect(app.state.activeTrade).toBeNull();
  });

  it('quien no puede pagar la oferta no puede aceptarla', async () => {
    const app = await makeApp();
    playSetup(app);
    reveal(app);
    setState(app, { phase: 'main', dice: [3, 4] });
    const me = app.state.currentPlayer;
    setResources(app, me, { ore: 1 });
    for (const p of app.state.players) if (p.id !== me) setResources(app, p.id, {});

    openTrade('players');
    pickCard(0, 'ore');
    pickCard(1, 'wool');
    click(overlay(), 'Poner la oferta');

    for (const button of buttons(overlay())) {
      if ((button.textContent ?? '').trim() === 'Acepto') expect(button.disabled).toBe(true);
    }
    // Se puede retirar la oferta.
    click(overlay(), 'Retirar oferta');
    expect(app.state.activeTrade).toBeNull();
  });

  it('la carta de carreteras deja construir dos caminos gratis y bloquea el resto', async () => {
    const app = await makeApp();
    playSetup(app);
    reveal(app);
    const me = app.state.currentPlayer;
    setState(app, {
      phase: 'main',
      dice: [3, 4],
      players: app.state.players.map((p) =>
        p.id === me ? { ...p, devCards: [{ kind: 'roadBuilding', boughtOnTurn: 0 }] } : p,
      ),
    });
    setResources(app, me, {});

    playDev('roadBuilding');
    expect(app.state.pending).toEqual({ type: 'roadBuilding', roadsLeft: 2 });
    // La barra de acciones solo indica lo que falta: no hay botones activos.
    expect(handbar().textContent).toContain('Coloca 2 camino');
    expect(findButton(handbar(), 'Terminar turno')).toBeUndefined();

    const before = app.state.players[me]!.roads.length;
    for (let i = 0; i < 2; i++) {
      const edges = app.computeHighlight().edges!;
      expect(edges.size).toBeGreaterThan(0);
      app.handlePick({ kind: 'edge', id: [...edges][0] });
    }
    expect(app.state.pending).toBeNull();
    expect(app.state.players[me]!.roads).toHaveLength(before + 2);
    expect(findButton(handbar(), 'Terminar turno')).toBeDefined();
  });

  it('el ladron se coloca pulsando una casilla y se roba desde la ventana', async () => {
    const app = await makeApp();
    playSetup(app);
    reveal(app);
    const me = app.state.currentPlayer;
    setState(app, { phase: 'moveRobber', dice: [3, 4] });

    const hexes = app.computeHighlight().hexes!;
    expect(hexes.size).toBe(app.state.board.hexOrder.length - 1);

    // Se elige una casilla donde haya un edificio rival con cartas.
    let target: string | null = null;
    for (const id of hexes) {
      const owners = app.state.board.hexes[id]!.vertices
        .map((v) => app.state.buildings[v]?.owner)
        .filter((o): o is number => o !== undefined && o !== me);
      if (owners.length > 0) {
        for (const owner of owners) setResources(app, owner, { grain: 2 });
        target = id;
        break;
      }
    }
    expect(target).not.toBeNull();

    app.handlePick({ kind: 'hex', id: target });
    expect(app.state.robber).toBe(target);
    expect(app.state.phase).toBe('steal');
    expect(overlay().textContent).toContain('Roba una carta');

    click(overlay(), 'Robar');
    expect(app.state.phase).toBe('main');
    expect(app.state.players[me]!.resources.grain).toBeGreaterThan(0);
  });

  it('el marcador final ordena a los jugadores por puntos', async () => {
    const app = await makeApp(3, 4242);
    playSetup(app);
    reveal(app);
    const me = app.state.currentPlayer;
    setState(app, {
      phase: 'main',
      dice: [3, 4],
      players: app.state.players.map((p) =>
        p.id === me
          ? {
              ...p,
              devCards: Array.from({ length: 8 }, () => ({
                kind: 'victoryPoint' as const,
                boughtOnTurn: 0,
              })),
              resources: { lumber: 0, brick: 0, wool: 1, grain: 1, ore: 1 },
            }
          : p,
      ),
      devDeck: [...app.state.devDeck.slice(0, -1), 'victoryPoint'],
    });

    click(handbar(), 'Comprar carta');
    expect(app.state.phase).toBe('gameOver');
    expect(overlay().textContent).toContain('Gana');
    expect(overlay().textContent).toContain('puntos');
    // Con la partida terminada ya no hay botones de accion.
    expect(buttons(handbar())).toHaveLength(0);
  });
});

/**
 * Terminar una partida en red no es irse del servidor.
 *
 * Antes el boton de la pantalla de victoria cerraba la conexion y recargaba la
 * pagina: acabar una partida echaba de la sala a todo el que estaba en ella y
 * habia que volver a dictar el codigo. Ahora se pide volver a la sala, y quien
 * desmonta la partida es el mensaje de sala que devuelve el servidor.
 */
describe('final de partida en red', () => {
  const victoryButton = () =>
    [...overlay().querySelectorAll('button')].find(
      (b) => b.textContent === 'Volver a la sala' || b.textContent === 'Nueva partida',
    );

  it('el boton de la victoria pide volver a la sala en vez de salir', async () => {
    const onFinish = vi.fn();
    const { app, onExit } = await makeNetApp(0, 4, 7, onFinish);
    setState(app, { phase: 'gameOver', winner: 0 });

    const button = victoryButton();
    expect(button?.textContent).toBe('Volver a la sala');
    button!.dispatchEvent(new window.Event('click'));
    expect(onFinish).toHaveBeenCalledTimes(1);
    // Y NO se abandona: eso cerraria la conexion de todos.
    expect(onExit).not.toHaveBeenCalled();
  });

  it('sin sala a la que volver, el boton sigue siendo el de partida nueva', async () => {
    const app = await makeApp(4, 7);
    setState(app, { phase: 'gameOver', winner: 0 });
    expect(victoryButton()?.textContent).toBe('Nueva partida');
  });

  it('al desmontarla suelta la pantalla y deja de escuchar los botones', async () => {
    // Volver a la sala y empezar otra crea un GameApp nuevo sobre los MISMOS
    // elementos del documento. Si el anterior siguiera escuchando, cada clic de
    // la barra de arriba haria dos cosas a la vez.
    const { app } = await makeNetApp(0, 4, 7);
    app.destroy();

    expect(document.getElementById('game')!.classList.contains('hidden')).toBe(true);
    expect(document.getElementById('setup')!.classList.contains('hidden')).toBe(false);
    expect(overlay().classList.contains('hidden')).toBe(true);

    // El boton de reglas ya no le habla: no abre nada.
    document.getElementById('btn-rules')!.dispatchEvent(new window.Event('click'));
    expect(overlay().classList.contains('hidden')).toBe(true);
  });
});
