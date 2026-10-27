// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlayerConfig } from '../src/engine/index.js';

/**
 * Prueba de humo de la interfaz.
 *
 * jsdom no implementa canvas, asi que se sustituye el contexto 2D por un doble
 * que acepta cualquier llamada de dibujo. Lo que se comprueba no es el aspecto
 * (eso no se puede automatizar aqui) sino que toda la maquinaria de la vista
 * funciona: que el DOM se construye, que las ventanas se abren, que un clic en
 * el tablero se traduce en una accion legal y que una partida entera se puede
 * jugar a traves de la interfaz sin que nada reviente.
 */

/** Contexto 2D falso: todo metodo existe y devuelve algo razonable. */
function fakeContext(): CanvasRenderingContext2D {
  const gradient = { addColorStop: () => {} };
  const target: Record<string, unknown> = {};
  return new Proxy(target, {
    get(store, prop: string) {
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
        return () => gradient;
      }
      if (prop === 'measureText') return () => ({ width: 10 });
      if (prop === 'canvas') return { width: 1200, height: 800 };
      if (prop in store) return store[prop];
      return () => undefined;
    },
    set(store, prop: string, value) {
      store[prop] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

function installDomShims(): void {
  HTMLCanvasElement.prototype.getContext = (() => fakeContext()) as never;
  // jsdom no da tamano a los elementos: se finge un lienzo de escritorio.
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
  // El bucle de dibujo se reprograma a si mismo, asi que se ejecuta de forma
  // sincrona pero con un tope de profundidad: suficiente para que el tablero se
  // pinte, sin caer en una recursion infinita.
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
  if (!('performance' in window)) {
    (window as unknown as { performance: Performance }).performance = {
      now: () => Date.now(),
    } as Performance;
  }
}

const SHELL = `
  <div id="app">
    <section id="setup" class="screen setup"></section>
    <section id="game" class="screen game hidden">
      <header class="topbar">
        <div id="turn-banner" class="turn-banner"></div>
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

/** Acceso controlado a los interiores de la app para poder pilotarla. */
interface AppInternals {
  state: import('../src/engine/index.js').GameState;
  handOwner: number;
  revealedFor: number | null;
  render(): void;
  handlePick(pick: unknown): void;
  computeHighlight(): {
    vertices?: Set<string>;
    edges?: Set<string>;
    hexes?: Set<string>;
  };
  dispatch(action: unknown): void;
}

async function makeApp(count = 4, seed = 4242) {
  document.body.innerHTML = SHELL;
  installDomShims();
  const { GameApp } = await import('../src/ui/app.js');
  const onExit = vi.fn();
  const app = new GameApp(players(count), seed, 10, onExit) as unknown as AppInternals;
  return { app, onExit };
}

/** Levanta el escudo de privacidad del jugador que toque. */
function reveal(app: AppInternals): void {
  app.revealedFor = app.handOwner;
  app.render();
}

describe('interfaz', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('arranca mostrando el escudo de privacidad y oculta la mano', async () => {
    const { app } = await makeApp();
    const overlay = document.getElementById('overlay')!;
    expect(overlay.classList.contains('hidden')).toBe(false);
    expect(overlay.textContent).toContain('Le toca a');
    expect(document.getElementById('handbar')!.textContent).toContain('Mano oculta');
  });

  it('al levantar el escudo aparecen los cruces donde se puede fundar', async () => {
    const { app } = await makeApp();
    reveal(app);
    expect(document.getElementById('overlay')!.classList.contains('hidden')).toBe(true);
    const highlight = app.computeHighlight();
    expect(highlight.vertices!.size).toBeGreaterThan(20);
    expect(highlight.edges!.size).toBe(0);
    expect(document.getElementById('board-hint')!.textContent).toContain('poblado');
  });

  it('un clic en un cruce coloca el poblado y pasa a pedir el camino', async () => {
    const { app } = await makeApp();
    reveal(app);
    const vertex = [...app.computeHighlight().vertices!][0]!;
    app.handlePick({ kind: 'vertex', id: vertex });
    expect(app.state.buildings[vertex]).toBeDefined();
    expect(app.state.phase).toBe('setupRoad');
    const highlight = app.computeHighlight();
    expect(highlight.edges!.size).toBeGreaterThan(0);
    expect(highlight.vertices!.size).toBe(0);
  });

  it('el escudo vuelve a bajar cuando cambia de jugador', async () => {
    const { app } = await makeApp();
    reveal(app);
    const first = app.handOwner;
    app.handlePick({ kind: 'vertex', id: [...app.computeHighlight().vertices!][0]! });
    app.handlePick({ kind: 'edge', id: [...app.computeHighlight().edges!][0]! });
    expect(app.handOwner).not.toBe(first);
    expect(document.getElementById('overlay')!.textContent).toContain('Le toca a');
  });

  it('pinta una tarjeta por jugador con sus puntos publicos', async () => {
    const { app } = await makeApp(6, 99);
    reveal(app);
    const cards = document.querySelectorAll('#players .player-card');
    expect(cards).toHaveLength(6);
    expect(document.getElementById('players')!.textContent).toContain('J1');
  });

  it('la ventana de reglas se abre y se cierra', async () => {
    const { app } = await makeApp();
    reveal(app);
    document.getElementById('btn-rules')!.dispatchEvent(new window.Event('click'));
    const overlay = document.getElementById('overlay')!;
    expect(overlay.textContent).toContain('Recordatorio de reglas');
    const close = [...overlay.querySelectorAll('button')].find(
      (b) => b.textContent === 'Entendido',
    )!;
    close.dispatchEvent(new window.Event('click'));
    expect(overlay.classList.contains('hidden')).toBe(true);
  });

  it('las reglas no mencionan la construccion especial con ningun numero de jugadores', async () => {
    // La fase se quito del juego: si el recordatorio la siguiera nombrando,
    // estaria explicando algo que no se puede hacer.
    for (const count of [4, 6]) {
      vi.resetModules();
      const { app } = await makeApp(count, 7);
      reveal(app);
      document.getElementById('btn-rules')!.dispatchEvent(new window.Event('click'));
      expect(document.getElementById('overlay')!.textContent).not.toContain(
        'onstruccion especial',
      );
    }
  });

  it('una partida entera se puede jugar a traves de la interfaz', async () => {
    const { app } = await makeApp(4, 20250820);
    const { getLegalActions, discardAmount, defaultDiscard } = await import(
      '../src/engine/index.js'
    );

    let steps = 0;
    while (app.state.phase !== 'gameOver' && steps < 40000) {
      // Cada jugador levanta su escudo cuando le toca.
      reveal(app);
      const player = app.handOwner;

      if (app.state.phase === 'discard') {
        app.dispatch({
          type: 'discard',
          player,
          resources: defaultDiscard(
            app.state.players[player]!.resources,
            discardAmount(app.state, player),
          ),
        });
      } else {
        const legal = getLegalActions(app.state, player);
        expect(legal.length, `sin acciones legales en ${app.state.phase}`).toBeGreaterThan(0);
        app.dispatch(legal[steps % legal.length]!);
      }
      steps++;
    }

    expect(app.state.phase).toBe('gameOver');
    // Al terminar, la interfaz muestra el marcador final.
    expect(document.getElementById('overlay')!.textContent).toContain('Gana');
  }, 60000);
});
