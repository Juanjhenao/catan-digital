/**
 * Renderiza el tablero a un PNG sin navegador.
 *
 * A diferencia de la version anterior, esta herramienta NO reimplementa el
 * dibujo: monta un lienzo de node-canvas, se lo da a la misma `BoardView` que
 * usa el juego y le pide un fotograma. Asi lo que sale por aqui es exactamente
 * lo que se ve en pantalla, y la captura sirve de verdad para revisar el arte.
 *
 *   npx tsx tools/render-board.ts [semilla] [jugadores] [salida.png] [pitch] [yaw]
 */
import { createCanvas, type CanvasRenderingContext2D as NodeCtx } from 'canvas';
import { writeFileSync } from 'node:fs';
import {
  applyOrThrow,
  createGame,
  getLegalActions,
  type GameState,
  type PlayerConfig,
} from '../src/engine/index.js';

const W = 1400;
const H = 940;

// El modulo de dibujo solo necesita un contexto 2D, `document` para las
// texturas memoizadas y un puñado de globales del navegador.
const globals = globalThis as unknown as Record<string, unknown>;
globals.document = {
  createElement: (tag: string) => {
    if (tag !== 'canvas') throw new Error(`elemento no soportado: ${tag}`);
    return createCanvas(1, 1);
  },
};
globals.window = {
  devicePixelRatio: 1,
  addEventListener: () => {},
};
globals.requestAnimationFrame = () => 0;
if (!globals.performance) globals.performance = { now: () => Date.now() };

const { BoardView } = await import('../src/ui/board-view.js');

const seed = Number(process.argv[2] ?? 20250820);
const playerCount = Number(process.argv[3] ?? 4);
const output = process.argv[4] ?? 'board.png';
const pitchDeg = process.argv[5] ? Number(process.argv[5]) : null;
const yawDeg = process.argv[6] ? Number(process.argv[6]) : null;

const colors = ['red', 'blue', 'white', 'orange', 'green', 'brown'] as const;
const configs: PlayerConfig[] = Array.from({ length: playerCount }, (_, i) => ({
  name: `J${i + 1}`,
  color: colors[i]!,
  kind: 'human',
}));

// Partida con la colocacion inicial ya hecha, para que se vean las piezas.
let state: GameState = createGame(configs, { seed });
while (state.phase === 'setupSettlement' || state.phase === 'setupRoad') {
  const legal = getLegalActions(state, state.currentPlayer);
  state = applyOrThrow(state, legal[Math.floor(legal.length * 0.37)]!);
}

// Una ciudad y unos dados puestos a mano: son los dos elementos que mas
// conviene revisar y no aparecen en la apertura.
const owned = Object.entries(state.buildings).find(([, b]) => b.kind === 'settlement');
if (owned) {
  state = {
    ...state,
    buildings: { ...state.buildings, [owned[0]]: { ...owned[1]!, kind: 'city' } },
  };
}
const numbered = state.board.hexOrder.find((id) => state.board.hexes[id]!.number !== null)!;
state = { ...state, robber: numbered, dice: [4, 5] };

const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d') as unknown as NodeCtx & CanvasRenderingContext2D;

// Lienzo falso con lo justo que BoardView le pide a un <canvas> del DOM.
const fakeCanvas = {
  width: W,
  height: H,
  style: {},
  getContext: () => ctx,
  addEventListener: () => {},
  getBoundingClientRect: () => ({ width: W, height: H, left: 0, top: 0 }),
} as unknown as HTMLCanvasElement;

const view = new BoardView(fakeCanvas, () => {}, () => {});
view.setState(state);
view.setDiceAction(process.argv[7] === 'end' ? 'end' : 'roll');
if (pitchDeg !== null || yawDeg !== null) {
  const cam = (view as unknown as { cam: { setAngles(p: number, y: number): number } }).cam;
  const rad = (d: number) => (d * Math.PI) / 180;
  cam.setAngles(rad(pitchDeg ?? 54), rad(yawDeg ?? 0));
  view.resize();
}
view.render();

writeFileSync(output, canvas.toBuffer('image/png'));
console.log(
  `Escrito ${output} (${W}x${H}) - tablero ${state.board.variant}, semilla ${seed}` +
    (pitchDeg !== null ? `, pitch ${pitchDeg}` : '') +
    (yawDeg !== null ? `, yaw ${yawDeg}` : ''),
);
