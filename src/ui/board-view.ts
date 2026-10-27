import {
  HEX_DIRECTIONS,
  hexCenterPixel,
  hexId,
  parseEdgeId,
  TERRAIN_YIELD,
  vertexPixel,
  type EdgeId,
  type GameState,
  type HexId,
  type PlayerColor,
  type Resource,
  type VertexId,
} from '../engine/index.js';
import { drawNumberToken, roundRect, tileSprite } from './art.js';
import {
  cityFaces,
  drawPort3D,
  groundShadow,
  paintFaces,
  roadFaces,
  robberFaces,
  settlementFaces,
  PIECE_OUTLINE,
  tableTexture,
  waterSprite,
  TILE_THICKNESS,
  type Face,
} from './art3d.js';
import { Camera, type Point3 } from './camera.js';
import { terrainProps, type Prop } from './props.js';
import { resourceArt } from './cards.js';
import { drawDie3D } from './die3d.js';
import { PLAYER_PALETTE, TERRAIN_PALETTE, TOKEN, WATER, shade } from './theme.js';

/** Que puede pulsar el jugador ahora mismo. */
export interface Highlight {
  vertices?: Set<VertexId>;
  edges?: Set<EdgeId>;
  hexes?: Set<HexId>;
  /**
   * Subconjunto de `vertices` en el que lo que se construiria es una CIUDAD y
   * no un poblado. La vista lo necesita para dibujar la pieza fantasma correcta:
   * el cruce es pulsable en los dos casos, pero no se levanta lo mismo.
   */
  cities?: Set<VertexId>;
  /** Color con el que se dibujan las piezas fantasma. */
  color?: PlayerColor;
}

export type Pick =
  | { kind: 'vertex'; id: VertexId }
  | { kind: 'edge'; id: EdgeId }
  | { kind: 'hex'; id: HexId };

interface Anim {
  kind: 'piece' | 'robber' | 'dice';
  key: string;
  start: number;
  duration: number;
  from?: [number, number];
}

/**
 * Onda de polvo que se abre bajo una pieza recien puesta.
 *
 * Dura poco y no tapa nada, pero es lo que hace que la pieza se sienta
 * APOYADA en la mesa en vez de aparecida: el ojo lee el golpe por el polvo que
 * levanta, no por la pieza en si.
 */
interface Ripple {
  x: number;
  y: number;
  start: number;
  color: string;
}

/** Cosecha que sube flotando desde una casilla que acaba de producir. */
interface Harvest {
  hex: HexId;
  resource: Resource;
  start: number;
}

/** Cuanto dura la subida de una carta de cosecha. */
const HARVEST_MS = 1500;

/** Lo que tarda en desvanecerse la onda de una pieza recien puesta. */
const RIPPLE_MS = 620;

/**
 * En que punto de la tirada dejan los dados de ensenar caras al azar.
 *
 * Antes de esto voltean numeros sueltos; despues ya se ve el resultado, aun
 * dando tumbos. Con el cambio a mitad de vuelo la transicion queda escondida
 * por el propio movimiento.
 */
const SETTLE = 0.55;

/** Piezas sin usar del jugador en turno. */
export interface Reserve {
  color: PlayerColor;
  road: number;
  settlement: number;
  city: number;
  /**
   * Dotacion completa de la partida. El hueco de la bandeja se mide con ESTA y
   * no con las piezas que quedan: si menguara al construir, el tablero entero se
   * recolocaria a cada camino puesto. Depende del mapa, asi que la pone quien
   * conoce las reglas, no la vista.
   */
  capacity: { road: number; settlement: number; city: number };
}

/**
 * Aparcadero de piezas: donde y como se apilan las que aun no estan puestas.
 *
 * Se coloca a la izquierda de la isla, en coordenadas de tablero, asi que gira
 * y se aleja con la camara igual que todo lo demas: son piezas sobre la mesa,
 * no un adorno pegado a la pantalla.
 */
const RESERVE = {
  /** Distancia desde el borde izquierdo del mar. */
  gap: 1.4,
  columns: 3,
  colStep: 0.52,
  roadStep: 0.34,
  pieceStep: 0.62,
  blockGap: 0.36,
};

/** Radio del hexagono en unidades de tablero. Todo lo demas se mide en estas. */
const HEX_UNIT = 1;

/** Angulos de las seis esquinas de un hexagono con vertice arriba. */
const CORNER_ANGLES = Array.from({ length: 6 }, (_, i) => (Math.PI / 180) * (60 * i - 30));

/** Camara por defecto, y a la que se vuelve con doble clic. */
const DEFAULT_PITCH = (44 * Math.PI) / 180;
const DEFAULT_YAW = 0;

/**
 * Altura del mar respecto a la isla. Negativa: el anillo de agua queda un
 * escalon por debajo del terreno, asi que la costa se ve como un acantilado y
 * la isla deja de parecer una pegatina sobre el agua.
 */
const SEA_LEVEL = -0.11;

/** Limites del acercamiento con la rueda. */
const MIN_ZOOM = 0.65;
const MAX_ZOOM = 3.2;

/** Cuanto se aleja de la costa el cartel de un puerto. */

/** Altura que alcanza el cartel de un puerto, para reservarle hueco al encajar. */
const PORT_SIGN_TOP = 1.25;

/**
 * Dibuja el tablero en perspectiva y traduce clics a elementos del juego.
 *
 * La escena es tridimensional de verdad: las casillas son prismas con grosor,
 * las piezas son solidos con caras iluminadas y todo pasa por la misma camara
 * (`camera.ts`). El unico lienzo del juego se pinta de atras hacia delante, que
 * con geometria convexa da el mismo resultado que un buffer de profundidad y
 * cuesta muchisimo menos.
 *
 * La vista sigue sin conocer las reglas: recibe un estado y un conjunto de
 * casillas/cruces/aristas pulsables, y avisa hacia arriba de lo que se elige.
 */
export class BoardView {
  private ctx: CanvasRenderingContext2D;
  private cam = new Camera();
  private state: GameState | null = null;
  private highlight: Highlight = {};
  private hover: Pick | null = null;
  private hoverDice = false;
  private anims: Anim[] = [];
  private diceDisplay: [number, number] = [3, 4];
  /** Solo se muestra la suma cuando la tirada es la del turno en curso. */
  private diceLive = false;
  /** Que hacen los dados si se pulsan: tirar, pasar turno, o nada. */
  private diceMode: 'roll' | 'end' | null = null;
  /**
   * Colocacion de los dados en pixeles de pantalla. Se calcula al redimensionar
   * y no al pintar: la zona sensible al raton es parte de la maquetacion, y si
   * dependiera del dibujo un clic anterior al primer fotograma no encontraria
   * nada donde ya hay dados.
   */
  private dice = { size: 0, gap: 0, left: 0, top: 0, totalW: 0, centerY: 0 };
  /** Rectangulo de los dados en pixeles, para el impacto del raton. */
  private diceBox = { x: 0, y: 0, w: 0, h: 0 };

  /** Cosechas en vuelo tras la ultima tirada. */
  private harvests: Harvest[] = [];
  private ripples: Ripple[] = [];

  /** Piezas que le quedan al jugador en turno, para el aparcadero de la mesa. */
  private reserve: Reserve | null = null;

  /** Anillo de mar alrededor de la isla, calculado al cambiar de tablero. */
  private water: { id: string; x: number; y: number }[] = [];
  /**
   * Arboles, rocas, ovejas... de cada casilla. Se calculan una vez por tablero
   * porque no se mueven jamas; por fotograma solo hay que proyectarlos.
   */
  private props = new Map<string, Prop[]>();
  /** Tamano en pixeles con el que se cachean las texturas de casilla. */
  private spriteUnit = 64;
  private needsRender = true;

  /** Acercamiento del jugador sobre el encaje automatico del tablero. */
  private zoom = 1;
  /** Desplazamiento de la vista en pixeles, para poder mirar una esquina. */
  private panX = 0;
  private panY = 0;

  // Arrastre: girar con el boton izquierdo, desplazar con el derecho o con Mayus.
  private drag: 'orbit' | 'pan' | null = null;
  private dragMoved = false;
  private dragFrom = {
    x: 0,
    y: 0,
    pitch: DEFAULT_PITCH,
    yaw: DEFAULT_YAW,
    panX: 0,
    panY: 0,
  };

  /**
   * Para soltarlo todo de golpe al cerrar la vista.
   *
   * El tablero escucha el raton del `canvas` y el tamano de la ventana, y ademas
   * se repinta solo en un bucle de animacion. Nada de eso muere porque se oculte
   * la pantalla: al volver de una partida en red a la sala y empezar otra habria
   * dos tableros escuchando el mismo raton y dos bucles dibujando.
   */
  private readonly listeners = new AbortController();
  private stopped = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private onPick: (pick: Pick) => void,
    private onRollDice: (() => void) | null = null,
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.cam.setAngles(DEFAULT_PITCH, DEFAULT_YAW);

    const on = { signal: this.listeners.signal };
    canvas.addEventListener('pointerdown', this.handleDown, on);
    canvas.addEventListener('pointermove', this.handleMove, on);
    canvas.addEventListener('pointerup', this.handleUp, on);
    canvas.addEventListener('pointercancel', this.handleUp, on);
    canvas.addEventListener('pointerleave', () => {
      this.hover = null;
      this.hoverDice = false;
      this.invalidate();
    }, on);
    canvas.addEventListener('click', this.handleClick, on);
    canvas.addEventListener('wheel', this.handleWheel, { passive: false, ...on });
    // Con el boton derecho se desplaza la vista, asi que no debe salir el menu.
    canvas.addEventListener('contextmenu', (event) => event.preventDefault(), on);
    canvas.addEventListener('dblclick', () => this.resetView(), on);
    window.addEventListener('resize', () => this.resize(), on);
    requestAnimationFrame(this.frame);
  }

  /** Suelta los escuchadores y para el bucle de dibujo. */
  destroy(): void {
    this.stopped = true;
    this.listeners.abort();
  }

  setState(state: GameState): void {
    const previous = this.state;
    this.state = state;
    if (!previous || previous.board !== state.board) {
      this.buildWaterRing();
      this.buildProps();
      this.resize();
    }

    // Animaciones derivadas del cambio de estado.
    if (previous) {
      for (const vertex of Object.keys(state.buildings)) {
        const before = previous.buildings[vertex];
        const now = state.buildings[vertex]!;
        if (!before || before.kind !== now.kind) {
          this.pop(`b:${vertex}`);
          const [x, y] = vertexPixel(vertex, HEX_UNIT);
          this.ripple(x, y, state.players[now.owner]!.color);
        }
      }
      for (const edge of Object.keys(state.roads)) {
        if (!previous.roads[edge]) {
          this.pop(`r:${edge}`);
          const [a, b] = parseEdgeId(edge);
          const [ax, ay] = vertexPixel(a, HEX_UNIT);
          const [bx, by] = vertexPixel(b, HEX_UNIT);
          this.ripple((ax + bx) / 2, (ay + by) / 2, state.players[state.roads[edge]!.owner]!.color);
        }
      }
      if (previous.robber !== state.robber) {
        this.anims.push({
          kind: 'robber',
          key: 'robber',
          start: performance.now(),
          duration: 460,
          from: this.hexBoardPoint(previous.robber),
        });
      }
      if (state.dice && (!previous.dice || previous.dice.join() !== state.dice.join())) {
        this.rollDiceAnimation(state.dice);
        this.startHarvest(state, state.dice[0] + state.dice[1]);
      }
    } else if (state.dice) {
      this.diceDisplay = state.dice;
    }
    // Los dados se quedan sobre la mesa entre turnos, pero solo se corona con
    // la suma la tirada viva.
    if (state.dice) this.diceDisplay = state.dice;
    this.diceLive = state.dice !== null;

    this.invalidate();
  }

  setHighlight(highlight: Highlight): void {
    this.highlight = highlight;
    this.invalidate();
  }

  /**
   * Piezas que le quedan al jugador en turno. Se dibujan sobre la mesa junto al
   * tablero en vez de contarse en un texto: ver las cinco casitas que te
   * quedan dice mas de un vistazo que leer «5 poblados».
   */
  setReserve(reserve: Reserve | null): void {
    const before = this.reserve;
    const same =
      before === reserve ||
      (before &&
        reserve &&
        before.color === reserve.color &&
        before.road === reserve.road &&
        before.settlement === reserve.settlement &&
        before.city === reserve.city &&
        before.capacity.road === reserve.capacity.road);
    this.reserve = reserve;
    if (!same) this.invalidate();
  }

  /** Que ofrecen los dados al pulsarlos. `null` los apaga. */
  setDiceAction(mode: 'roll' | 'end' | null): void {
    if (this.diceMode === mode) return;
    this.diceMode = mode;
    this.invalidate();
  }

  private pop(key: string): void {
    this.anims.push({ kind: 'piece', key, start: performance.now(), duration: 340 });
  }

  private ripple(x: number, y: number, color: PlayerColor): void {
    this.ripples.push({ x, y, start: performance.now(), color: PLAYER_PALETTE[color].main });
  }

  private rollDiceAnimation(dice: [number, number]): void {
    this.diceDisplay = dice;
    this.anims.push({ kind: 'dice', key: 'dice', start: performance.now(), duration: 760 });
  }

  private invalidate(): void {
    this.needsRender = true;
  }

  // -------------------------------------------------------------------------
  // Geometria del tablero
  // -------------------------------------------------------------------------

  /**
   * Calcula el anillo de casillas de mar: todos los vecinos de la isla que no
   * son isla. Es lo que hace que el tablero se apoye sobre agua en vez de
   * flotar, y donde se clavan los muelles de los puertos.
   */
  private buildWaterRing(): void {
    const state = this.state!;
    const island = new Set(state.board.hexOrder);
    const seen = new Set<string>();
    const ring: { id: string; x: number; y: number }[] = [];
    for (const id of state.board.hexOrder) {
      const { q, r } = state.board.hexes[id]!.coord;
      for (const dir of HEX_DIRECTIONS) {
        const coord = { q: q + dir.q, r: r + dir.r };
        const nid = hexId(coord);
        if (island.has(nid) || seen.has(nid)) continue;
        seen.add(nid);
        const [x, y] = hexCenterPixel(coord, HEX_UNIT);
        ring.push({ id: nid, x, y });
      }
    }
    this.water = ring;
  }

  /**
   * Levanta los objetos de cada casilla.
   *
   * El identificador del hexagono siembra el azar, asi que el mismo tablero da
   * siempre el mismo bosque: lo que cambia de casilla a casilla no es aleatorio
   * de verdad, es una funcion del sitio.
   */
  private buildProps(): void {
    const state = this.state!;
    this.props.clear();
    for (const id of state.board.hexOrder) {
      const hex = state.board.hexes[id]!;
      const [x, y] = this.hexBoardPoint(id);
      this.props.set(id, terrainProps(hex.terrain, x, y, id));
    }
  }

  /**
   * Prepara las cartas que suben de las casillas que acaban de producir.
   *
   * Se anima solo lo que alguien COBRA: una casilla con el numero de la tirada
   * pero sin nadie alrededor no produce nada, y hacerla brillar seria mentir
   * sobre lo que ha pasado. El ladron tampoco deja cobrar.
   */
  private startHarvest(state: GameState, total: number): void {
    this.harvests = [];
    if (total === 7) return;
    const now = performance.now();
    for (const id of state.board.hexOrder) {
      const hex = state.board.hexes[id]!;
      if (hex.number !== total || id === state.robber) continue;
      const resource = TERRAIN_YIELD[hex.terrain];
      if (!resource) continue;
      const collected = hex.vertices.some((vertex) => state.buildings[vertex]);
      if (!collected) continue;
      this.harvests.push({ hex: id, resource, start: now });
    }
  }

  /**
   * Sitios que ocupa cada pieza del aparcadero, en coordenadas de tablero.
   *
   * Se calcula siempre con el numero MAXIMO de piezas y no con las que quedan,
   * para que el hueco reservado no cambie de tamano segun se construye: si
   * encogiera, el tablero entero se recolocaria a cada camino puesto.
   */
  private reserveSlots(counts: { road: number; settlement: number; city: number }): {
    roads: [number, number][];
    settlements: [number, number][];
    cities: [number, number][];
    bounds: [number, number, number, number];
  } {
    let minX = Infinity;
    for (const hex of this.water) minX = Math.min(minX, hex.x - HEX_UNIT);
    if (!Number.isFinite(minX)) minX = -5;

    const x0 = minX - RESERVE.gap;
    const grid = (count: number, step: number, top: number): [number, number][] => {
      const out: [number, number][] = [];
      for (let i = 0; i < count; i++) {
        const col = i % RESERVE.columns;
        const row = Math.floor(i / RESERVE.columns);
        out.push([x0 + col * RESERVE.colStep, top + row * step]);
      }
      return out;
    };

    const roadRows = Math.ceil(counts.road / RESERVE.columns);
    const settlementRows = Math.ceil(counts.settlement / RESERVE.columns);
    const cityRows = Math.ceil(counts.city / RESERVE.columns);

    let top = -((roadRows * RESERVE.roadStep +
      settlementRows * RESERVE.pieceStep +
      cityRows * RESERVE.pieceStep +
      RESERVE.blockGap * 2) / 2);

    const roads = grid(counts.road, RESERVE.roadStep, top);
    top += roadRows * RESERVE.roadStep + RESERVE.blockGap;
    const settlements = grid(counts.settlement, RESERVE.pieceStep, top);
    top += settlementRows * RESERVE.pieceStep + RESERVE.blockGap;
    const cities = grid(counts.city, RESERVE.pieceStep, top);
    top += cityRows * RESERVE.pieceStep;

    const all = [...roads, ...settlements, ...cities];
    const xs = all.map((p) => p[0]);
    const ys = all.map((p) => p[1]);
    return {
      roads,
      settlements,
      cities,
      bounds: [
        Math.min(...xs) - 0.4,
        Math.min(...ys) - 0.4,
        Math.max(...xs) + 0.4,
        Math.max(...ys) + 0.5,
      ],
    };
  }

  /** Esquinas de un hexagono en coordenadas de tablero. */
  private hexCorners(cx: number, cy: number, radius = HEX_UNIT): [number, number][] {
    return CORNER_ANGLES.map((a): [number, number] => [
      cx + Math.cos(a) * radius,
      cy + Math.sin(a) * radius,
    ]);
  }

  /**
   * Donde va un puerto: en el centro de la casilla de MAR que toca su arista
   * costera, que es donde esta la ficha en el juego de mesa.
   *
   * Antes el cartel se empujaba en linea recta desde el centro del tablero
   * hacia fuera, y esa direccion solo coincide con la perpendicular de la
   * arista en unos pocos puntos simetricos de la isla. En el resto el puerto
   * salia ladeado, flotando a caballo entre dos casillas de mar en vez de
   * apoyado en la suya.
   *
   * La cuenta correcta es corta: el punto medio de una arista esta a mitad de
   * camino entre el centro de su casilla y el de la vecina, asi que el centro
   * de la vecina es `2 * medio - centro`. No hace falta ninguna distancia
   * ajustada a ojo.
   */
  private portSignPoint(edge: EdgeId): [number, number] {
    const [a, b] = parseEdgeId(edge);
    const [ax, ay] = vertexPixel(a, HEX_UNIT);
    const [bx, by] = vertexPixel(b, HEX_UNIT);
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    const land = this.landHexOf(a, b);
    if (!land) return [mx, my];
    return [2 * mx - land[0], 2 * my - land[1]];
  }

  /**
   * La casilla de tierra a la que pertenece una arista costera.
   *
   * Es la unica que comparten sus dos vertices: por definicion una arista de la
   * costa toca una sola casilla de la isla, y si tocara dos no seria costa y no
   * habria puerto ahi.
   */
  private landHexOf(a: VertexId, b: VertexId): [number, number] | null {
    const board = this.state!.board;
    const at = new Set(board.vertexHexes[b] ?? []);
    const shared = (board.vertexHexes[a] ?? []).find((h) => at.has(h));
    return shared ? this.hexBoardPoint(shared) : null;
  }

  private hexBoardPoint(id: HexId): [number, number] {
    const hex = this.state!.board.hexes[id]!;
    return hexCenterPixel(hex.coord, HEX_UNIT);
  }

  // -------------------------------------------------------------------------
  // Encaje en el lienzo
  // -------------------------------------------------------------------------

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.layoutDice(rect.width, rect.height);

    const state = this.state;
    if (!state) return;

    // Caja que abarca la isla, el anillo de mar y el vuelo de los muelles.
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const swallow = (x: number, y: number) => {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    };
    for (const id of state.board.hexOrder) {
      const [x, y] = this.hexBoardPoint(id);
      for (const [px, py] of this.hexCorners(x, y)) swallow(px, py);
    }
    for (const hex of this.water) {
      for (const [px, py] of this.hexCorners(hex.x, hex.y)) swallow(px, py);
    }

    this.cam.pivotX = (minX + maxX) / 2;
    this.cam.pivotY = (minY + maxY) / 2;
    // La distancia crece con el tablero para que la perspectiva se vea igual de
    // marcada en el mapa pequeno y en el grande.
    const radius = Math.max(maxX - minX, maxY - minY) / 2;
    this.cam.distance = Math.max(6, radius * 3.15);

    // Puntos de referencia para el encaje. Importa medirlos donde de verdad hay
    // algo: si se pide hueco para una pieza alta en las esquinas del mar, donde
    // nunca se construye, el tablero se encoge y sobra media pantalla de mesa.
    const samples: Point3[] = [];
    for (const hex of this.water) {
      for (const [px, py] of this.hexCorners(hex.x, hex.y)) {
        samples.push([px, py, SEA_LEVEL]);
        samples.push([px, py, SEA_LEVEL - TILE_THICKNESS * 0.6]);
      }
    }
    for (const id of state.board.hexOrder) {
      const [x, y] = this.hexBoardPoint(id);
      for (const [px, py] of this.hexCorners(x, y)) {
        samples.push([px, py, 0]);
        // Alto de una ciudad, que es la pieza mas alta del tablero.
        samples.push([px, py, 0.7]);
      }
    }
    // El aparcadero de piezas tiene que caber tambien: se mide con la dotacion
    // completa para que el encuadre no baile segun se gastan las piezas.
    if (this.reserve) {
      const [rx0, ry0, rx1, ry1] = this.reserveSlots(this.reserve.capacity).bounds;
      samples.push([rx0, ry0, 0], [rx1, ry0, 0], [rx0, ry1, 0], [rx1, ry1, 0.5]);
    }

    // Los carteles de puerto son lo que mas sobresale por arriba.
    for (const port of state.board.ports) {
      const [sx, sy] = this.portSignPoint(port.edge);
      samples.push([sx, sy, PORT_SIGN_TOP]);
    }
    this.cam.fit(rect.width, rect.height, samples, 0.98);
    this.cam.place(rect.width, rect.height, this.zoom, this.panX, this.panY);

    // Las texturas se cachean a un unico tamano de referencia: el de la escala
    // en el centro del tablero. La perspectiva las estira desde ahi.
    const unit = this.cam.project(this.cam.pivotX, this.cam.pivotY, 0).scale;
    this.spriteUnit = Math.max(24, Math.min(200, Math.round(unit)));
    this.invalidate();
  }

  // -------------------------------------------------------------------------
  // Interaccion
  // -------------------------------------------------------------------------

  /** Situa los dados en la esquina inferior derecha y fija su zona sensible. */
  private layoutDice(width: number, height: number): void {
    const size = Math.max(60, Math.min(130, Math.min(width, height) * 0.15));
    const gap = size * 0.2;
    const margin = size * 0.55;
    const totalW = size * 2 + gap;
    const left = width - margin - totalW;
    const top = height - margin - size * 1.55;
    this.dice = { size, gap, left, top, totalW, centerY: top + size / 2 };
    this.diceBox = {
      x: left - size * 0.28,
      y: top - size * 0.4,
      w: totalW + size * 0.56,
      h: size * 1.6,
    };
  }

  private pointerPosition(event: PointerEvent | MouseEvent): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  }

  private insideDice(px: number, py: number): boolean {
    const b = this.diceBox;
    return px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h;
  }

  /**
   * Busca el objetivo pulsable mas cercano. El clic se deshace primero sobre el
   * plano de la mesa, asi que las distancias se comparan en unidades de
   * tablero y siguen siendo validas con cualquier inclinacion de camara.
   *
   * Solo se consideran los elementos que la capa de juego ha marcado como
   * validos, asi que un clic nunca puede seleccionar algo ilegal.
   */
  private hitTest(px: number, py: number): Pick | null {
    if (!this.state) return null;
    const ground = this.cam.unproject(px, py);
    if (!ground) return null;
    const [bx, by] = ground;

    let best: Pick | null = null;
    let bestDistance = Infinity;

    const consider = (pick: Pick, x: number, y: number, threshold: number) => {
      const distance = Math.hypot(bx - x, by - y);
      if (distance < threshold && distance < bestDistance) {
        bestDistance = distance;
        best = pick;
      }
    };

    for (const id of this.highlight.vertices ?? []) {
      const [x, y] = vertexPixel(id, HEX_UNIT);
      consider({ kind: 'vertex', id }, x, y, 0.34);
    }
    for (const id of this.highlight.edges ?? []) {
      const [a, b] = parseEdgeId(id);
      const [ax, ay] = vertexPixel(a, HEX_UNIT);
      const [bx2, by2] = vertexPixel(b, HEX_UNIT);
      consider({ kind: 'edge', id }, (ax + bx2) / 2, (ay + by2) / 2, 0.28);
    }
    for (const id of this.highlight.hexes ?? []) {
      const [x, y] = this.hexBoardPoint(id);
      consider({ kind: 'hex', id }, x, y, 0.85);
    }

    return best;
  }

  /** Vuelve al encuadre de partida: angulos, zoom y desplazamiento de origen. */
  resetView(): void {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.cam.setAngles(DEFAULT_PITCH, DEFAULT_YAW);
    this.resize();
  }

  /**
   * Empieza un arrastre.
   *
   * Se arma SIEMPRE, tambien encima de una casilla pulsable: con el tablero
   * lleno de sitios donde construir casi no quedaria hueco libre desde el que
   * girar la vista. Lo que distingue un clic de un arrastre es el movimiento,
   * no el punto de partida.
   */
  private handleDown = (event: PointerEvent): void => {
    const [px, py] = this.pointerPosition(event);
    if (this.insideDice(px, py)) return;
    const pan = event.button === 2 || event.button === 1 || event.shiftKey;
    if (event.button !== 0 && !pan) return;
    this.drag = pan ? 'pan' : 'orbit';
    this.dragMoved = false;
    this.dragFrom = {
      x: px,
      y: py,
      pitch: this.cam.pitch,
      yaw: this.cam.yaw,
      panX: this.panX,
      panY: this.panY,
    };
    this.canvas.setPointerCapture?.(event.pointerId);
  };

  private handleUp = (event: PointerEvent): void => {
    if (!this.drag) return;
    this.drag = null;
    this.canvas.releasePointerCapture?.(event.pointerId);
  };

  private handleMove = (event: PointerEvent): void => {
    const [px, py] = this.pointerPosition(event);

    if (this.drag) {
      const dx = px - this.dragFrom.x;
      const dy = py - this.dragFrom.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) this.dragMoved = true;
      if (this.dragMoved) {
        if (this.drag === 'pan') {
          this.panX = this.dragFrom.panX + dx;
          this.panY = this.dragFrom.panY + dy;
          this.clampPan();
        } else {
          this.cam.setAngles(this.dragFrom.pitch + dy * 0.0045, this.dragFrom.yaw - dx * 0.006);
        }
        this.resize();
      }
      return;
    }

    const overDice = this.insideDice(px, py);
    const hit = overDice ? null : this.hitTest(px, py);
    const changed =
      overDice !== this.hoverDice || JSON.stringify(hit) !== JSON.stringify(this.hover);
    this.hover = hit;
    this.hoverDice = overDice;
    this.canvas.style.cursor = hit || (overDice && this.diceMode) ? 'pointer' : 'grab';
    if (changed) this.invalidate();
  };

  /**
   * Rueda del raton: acerca y aleja manteniendo quieto el punto del tablero que
   * hay bajo el cursor. Sin esa correccion, acercarse a una esquina obliga a
   * arrastrar la vista despues de cada rueda.
   */
  private handleWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;

    const before = { cx: this.cam.cx, cy: this.cam.cy, focal: this.cam.focal };
    const next = clamp(this.zoom * Math.exp(-event.deltaY * 0.0016), MIN_ZOOM, MAX_ZOOM);
    if (next === this.zoom) return;
    this.zoom = next;

    this.cam.place(rect.width, rect.height, this.zoom, this.panX, this.panY);
    const ratio = this.cam.focal / before.focal;
    // Donde tendria que quedar el punto de fuga para que el cursor no se mueva.
    this.panX += px - (px - before.cx) * ratio - this.cam.cx;
    this.panY += py - (py - before.cy) * ratio - this.cam.cy;
    this.clampPan();
    this.resize();
  };

  /** Impide que el tablero se arrastre fuera de la pantalla. */
  private clampPan(): void {
    const rect = this.canvas.getBoundingClientRect();
    const limitX = rect.width * 0.55;
    const limitY = rect.height * 0.55;
    this.panX = clamp(this.panX, -limitX, limitX);
    this.panY = clamp(this.panY, -limitY, limitY);
  }

  private handleClick = (event: MouseEvent): void => {
    if (this.dragMoved) {
      this.dragMoved = false;
      return;
    }
    const [px, py] = this.pointerPosition(event);
    if (this.insideDice(px, py)) {
      if (this.diceMode) this.onRollDice?.();
      return;
    }
    const hit = this.hitTest(px, py);
    if (hit) this.onPick(hit);
  };

  // -------------------------------------------------------------------------
  // Bucle de dibujo
  // -------------------------------------------------------------------------

  private frame = (): void => {
    if (this.stopped) return;
    const now = performance.now();
    const before = this.anims.length;
    this.anims = this.anims.filter((a) => now - a.start < a.duration);
    if (this.anims.length !== before || this.anims.length > 0) this.needsRender = true;

    if (this.needsRender) {
      this.needsRender = false;
      this.render();
    }
    requestAnimationFrame(this.frame);
  };

  private animProgress(key: string): number | null {
    const anim = this.anims.find((a) => a.key === key);
    if (!anim) return null;
    return Math.min(1, (performance.now() - anim.start) / anim.duration);
  }

  render(): void {
    const state = this.state;
    if (!state) return;
    const ctx = this.ctx;
    const rect = this.canvas.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // 1. La mesa.
    ctx.drawImage(tableTexture(width, height), 0, 0, width, height);

    // 2. La sombra que proyecta el tablero entero sobre la madera.
    this.drawBoardShadow(ctx);

    // 3. Terreno: mar primero, luego la isla, siempre de atras hacia delante.
    const tiles: { depth: number; draw: () => void }[] = [];
    for (const hex of this.water) {
      tiles.push({
        depth: this.cam.depthAt(hex.x, hex.y, SEA_LEVEL),
        draw: () =>
          this.drawTile(
            ctx,
            hex.x,
            hex.y,
            waterSprite(this.spriteUnit, hex.id),
            WATER.deep,
            SEA_LEVEL,
            SEA_LEVEL - TILE_THICKNESS * 0.6,
          ),
      });
    }
    for (const id of state.board.hexOrder) {
      const hex = state.board.hexes[id]!;
      const [x, y] = this.hexBoardPoint(id);
      const wall = shade(TERRAIN_PALETTE[hex.terrain].shade, 0.42);
      const props = this.props.get(id) ?? [];
      tiles.push({
        depth: this.cam.depthAt(x, y),
        draw: () => {
          this.drawTile(
            ctx,
            x,
            y,
            tileSprite(hex.terrain, this.spriteUnit, id),
            wall,
            0,
            -TILE_THICKNESS,
          );
          // Los objetos van pegados a SU loseta, no en la cola general: si se
          // mezclaran, los del borde de atras quedarian detras de la propia
          // casilla y el suelo los borraria. Dentro de la casilla si hay que
          // ordenarlos, que se tapan entre ellos.
          this.drawProps(ctx, props);
        },
      });
    }
    tiles.sort((a, b) => b.depth - a.depth);
    for (const tile of tiles) tile.draw();

    // 4. Cosas tumbadas sobre el terreno.
    this.drawHexHighlights(ctx);
    this.drawNumberTokens(ctx);
    this.drawGroundHighlights(ctx);

    // 5. Ondas de las piezas recien puestas, tumbadas sobre el terreno.
    this.drawRipples(ctx);

    // 6. Todo lo que se levanta de la mesa, ordenado por profundidad.
    this.drawStanding(ctx);

    // 7. Piezas sin colocar, sobre la mesa junto al tablero.
    this.drawReserve(ctx);

    // 8. Cosecha de la ultima tirada, subiendo desde sus casillas.
    this.drawHarvests(ctx);

    // 9. Los dados, ya en pixeles de pantalla.
    this.drawDice(ctx);
  }

  /**
   * Pinta los objetos de una casilla, del mas lejano al mas cercano.
   *
   * Cada uno lleva su sombrita en el suelo: sin ella los arboles parecen
   * pegatinas flotando, y la sombra cuesta un elipse por objeto.
   */
  private drawProps(ctx: CanvasRenderingContext2D, props: Prop[]): void {
    if (props.length === 0) return;
    const sorted =
      props.length === 1
        ? props
        : [...props].sort((a, b) => this.cam.depthAt(b.x, b.y) - this.cam.depthAt(a.x, a.y));
    for (const prop of sorted) {
      groundShadow(ctx, this.cam, prop.x, prop.y, prop.shadow, 0.3);
      paintFaces(ctx, this.cam, prop.faces, { pivot: [prop.x, prop.y, 0] });
    }
  }

  /**
   * Ondas de las piezas recien colocadas.
   *
   * Se dibujan aplastadas por la perspectiva, como todo lo que va tumbado en el
   * suelo: un circulo perfecto en pantalla se leeria como un aro flotando de
   * cara a la camara en vez de un anillo de polvo sobre la mesa.
   */
  private drawRipples(ctx: CanvasRenderingContext2D): void {
    const now = performance.now();
    this.ripples = this.ripples.filter((r) => now - r.start < RIPPLE_MS);
    if (this.ripples.length === 0) return;

    const squash = Math.max(0.2, this.cam.groundSquash);
    for (const ripple of this.ripples) {
      const t = (now - ripple.start) / RIPPLE_MS;
      const p = this.cam.project(ripple.x, ripple.y, 0);
      const radius = p.scale * (0.12 + t * 0.5);
      ctx.save();
      ctx.globalAlpha = (1 - t) * 0.55;
      ctx.translate(p.x, p.y);
      ctx.scale(1, squash);
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.strokeStyle = ripple.color;
      ctx.lineWidth = Math.max(1, p.scale * 0.045 * (1 - t));
      ctx.stroke();
      ctx.restore();
    }
    this.needsRender = true;
  }

  /** Halo oscuro bajo el tablero: lo separa de la madera de la mesa. */
  private drawBoardShadow(ctx: CanvasRenderingContext2D): void {
    const c = this.cam.project(this.cam.pivotX, this.cam.pivotY, -TILE_THICKNESS);
    const radius = Math.max(
      ...this.water.map((h) => Math.hypot(h.x - this.cam.pivotX, h.y - this.cam.pivotY)),
      1,
    );
    const rx = radius * c.scale * 1.1;
    const ry = rx * this.cam.groundSquash;
    const g = ctx.createRadialGradient(c.x, c.y + ry * 0.14, rx * 0.78, c.x, c.y + ry * 0.14, rx);
    g.addColorStop(0, 'rgba(0,0,0,0.34)');
    g.addColorStop(0.75, 'rgba(0,0,0,0.16)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.save();
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(c.x, c.y + ry * 0.12, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /**
   * Una casilla: primero las paredes que dan a la camara y luego la tapa, sobre
   * la que se estampa la textura con la transformacion afin local. Es lo que
   * convierte cada hexagono en una loseta con grosor de verdad.
   */
  private drawTile(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    sprite: HTMLCanvasElement,
    wallColor: string,
    topZ: number,
    bottomZ: number,
  ): void {
    const corners = this.hexCorners(cx, cy);
    const walls: Face[] = [];
    for (let i = 0; i < 6; i++) {
      const a = corners[i]!;
      const b = corners[(i + 1) % 6]!;
      const mx = (a[0] + b[0]) / 2 - cx;
      const my = (a[1] + b[1]) / 2 - cy;
      const len = Math.hypot(mx, my) || 1;
      if (!this.cam.facesCamera(mx / len, my / len)) continue;
      walls.push({
        pts: [
          [a[0], a[1], topZ],
          [b[0], b[1], topZ],
          [b[0], b[1], bottomZ],
          [a[0], a[1], bottomZ],
        ],
        color: wallColor,
      });
    }
    // El pivote es el centro del prisma: sin el, con una o dos paredes visibles
    // el centro del lote caeria en la propia pared y la normal saldria al azar.
    if (walls.length) {
      paintFaces(ctx, this.cam, walls, { pivot: [cx, cy, (topZ + bottomZ) / 2] });
    }

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const m = this.cam.groundTransform(cx, cy, topZ);
    const unit = this.spriteUnit;
    const lw = sprite.width / dpr;
    const lh = sprite.height / dpr;

    ctx.save();
    ctx.setTransform(dpr * m[0], dpr * m[1], dpr * m[2], dpr * m[3], dpr * m[4], dpr * m[5]);
    ctx.drawImage(sprite, -lw / (2 * unit), -lh / (2 * unit), lw / unit, lh / unit);
    ctx.restore();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // -------------------------------------------------------------------------
  // Resaltados
  // -------------------------------------------------------------------------

  private get pulse(): number {
    return 0.55 + Math.sin(performance.now() / 320) * 0.2;
  }

  private keepAlive(): void {
    if (
      this.highlight.vertices?.size ||
      this.highlight.edges?.size ||
      this.highlight.hexes?.size ||
      this.ripples.length ||
      this.diceMode
    ) {
      this.needsRender = true;
    }
  }

  /** Casillas pulsables: se pinta el hexagono proyectado, esquina por esquina. */
  private drawHexHighlights(ctx: CanvasRenderingContext2D): void {
    this.keepAlive();
    const ids = this.highlight.hexes;
    if (!ids?.size) return;
    const pulse = this.pulse;
    ctx.save();
    for (const id of ids) {
      const [cx, cy] = this.hexBoardPoint(id);
      const active = this.hover?.kind === 'hex' && this.hover.id === id;
      ctx.beginPath();
      this.hexCorners(cx, cy, HEX_UNIT * 0.96).forEach(([x, y], i) => {
        const p = this.cam.project(x, y, 0.006);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.closePath();
      ctx.fillStyle = `rgba(255,235,150,${active ? 0.36 : 0.14 * pulse})`;
      ctx.fill();
      ctx.strokeStyle = `rgba(255,225,120,${active ? 0.95 : 0.5})`;
      ctx.lineWidth = this.cam.project(cx, cy).scale * (active ? 0.06 : 0.035);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * Marcas en el suelo bajo cada sitio donde se puede construir.
   *
   * La pieza fantasma sola se pierde sobre un terreno con dibujo; este disco
   * palpitante es lo que hace que los sitios libres se encuentren de un vistazo
   * sin tener que barrer el tablero con el raton.
   */
  private drawGroundHighlights(ctx: CanvasRenderingContext2D): void {
    const pulse = this.pulse;
    const squash = this.cam.groundSquash;
    ctx.save();

    const spot = (x: number, y: number, active: boolean, radius: number) => {
      const p = this.cam.project(x, y, 0.012);
      const r = p.scale * radius * (active ? 1.35 : 1);
      const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, Math.max(r, 0.001));
      glow.addColorStop(0, `rgba(255,235,150,${active ? 0.8 : 0.28 * pulse + 0.24})`);
      glow.addColorStop(1, 'rgba(255,235,150,0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, r, r * squash, 0, 0, Math.PI * 2);
      ctx.fill();
    };

    for (const id of this.highlight.edges ?? []) {
      const [a, b] = parseEdgeId(id);
      const [ax, ay] = vertexPixel(a, HEX_UNIT);
      const [bx, by] = vertexPixel(b, HEX_UNIT);
      const active = this.hover?.kind === 'edge' && this.hover.id === id;
      spot((ax + bx) / 2, (ay + by) / 2, active, 0.34);
    }
    for (const id of this.highlight.vertices ?? []) {
      const [x, y] = vertexPixel(id, HEX_UNIT);
      const active = this.hover?.kind === 'vertex' && this.hover.id === id;
      spot(x, y, active, 0.34);
    }
    ctx.restore();
  }

  /**
   * Piezas fantasma: la construccion que saldria si se pulsara ahi.
   *
   * Van con el resto de solidos y no aparte para que se ordenen por profundidad
   * junto a las piezas reales. Se dibujan en el color del jugador y translucidas;
   * la que tiene el raton encima se enciende del todo, que es la confirmacion de
   * que ese clic construye eso y no otra cosa.
   */
  private ghostJobs(color: PlayerColor): { depth: number; draw: () => void }[] {
    const jobs: { depth: number; draw: () => void }[] = [];
    const pulse = 0.42 + Math.sin(performance.now() / 420) * 0.1;
    const paintGhost = (
      ctx: CanvasRenderingContext2D,
      faces: Face[],
      active: boolean,
    ) => {
      ctx.save();
      ctx.globalAlpha = active ? 0.95 : pulse;
      // El filo dorado es lo que separa una propuesta de una pieza construida:
      // sin el, un camino fantasma del mismo color que los tuyos se confunde
      // con uno que ya esta puesto.
      paintFaces(ctx, this.cam, faces, {
        outline: active ? 'rgba(255,236,180,0.95)' : 'rgba(255,226,150,0.5)',
      });
      ctx.restore();
    };

    for (const id of this.highlight.edges ?? []) {
      const [a, b] = parseEdgeId(id);
      const [ax, ay] = vertexPixel(a, HEX_UNIT);
      const [bx, by] = vertexPixel(b, HEX_UNIT);
      const active = this.hover?.kind === 'edge' && this.hover.id === id;
      jobs.push({
        depth: this.cam.depthAt((ax + bx) / 2, (ay + by) / 2),
        draw: () => paintGhost(this.ctx, roadFaces(ax, ay, bx, by, color), active),
      });
    }

    for (const id of this.highlight.vertices ?? []) {
      const [x, y] = vertexPixel(id, HEX_UNIT);
      const active = this.hover?.kind === 'vertex' && this.hover.id === id;
      const city = this.highlight.cities?.has(id) ?? false;
      jobs.push({
        depth: this.cam.depthAt(x, y),
        draw: () =>
          paintGhost(
            this.ctx,
            city ? cityFaces(x, y, color) : settlementFaces(x, y, color),
            active,
          ),
      });
    }

    return jobs;
  }

  /**
   * Fichas numericas. Se dibujan tumbadas (de ahi el aplastado vertical) pero
   * con el numero derecho: una ficha girada con la perspectiva seria mas fiel y
   * mucho menos legible.
   */
  private drawNumberTokens(ctx: CanvasRenderingContext2D): void {
    const state = this.state!;
    // Las casillas que estan cobrando ahora mismo: su ficha crece un momento,
    // que es lo que ata la carta que sube con el numero que la ha provocado.
    const now = performance.now();
    const producing = new Map<HexId, number>();
    for (const harvest of this.harvests) {
      const t = (now - harvest.start) / HARVEST_MS;
      if (t >= 0 && t < 0.5) producing.set(harvest.hex, 1 - t / 0.5);
    }
    // El aplastado se acota por abajo: con la camara casi a ras de mesa el
    // aplastado fiel dejaria los numeros en una linea, y el numero de la
    // casilla es lo que mas se mira de todo el tablero.
    const squash = Math.max(0.58, this.cam.groundSquash);
    const tokens = state.board.hexOrder
      .map((id) => ({ id, hex: state.board.hexes[id]! }))
      .filter((t) => t.hex.number !== null)
      .map((t) => {
        const [x, y] = this.hexBoardPoint(t.id);
        return { ...t, x, y, depth: this.cam.depthAt(x, y) };
      })
      .sort((a, b) => b.depth - a.depth);

    for (const token of tokens) {
      const p = this.cam.project(token.x, token.y, 0.014);
      const beat = producing.get(token.id) ?? 0;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.scale(1, squash);
      if (beat > 0) {
        // Un aro dorado que se abre, del mismo color que el de la carta que
        // sube: son la misma cosa contada dos veces, arriba y abajo.
        ctx.save();
        ctx.globalAlpha = beat * 0.75;
        ctx.beginPath();
        ctx.arc(0, 0, p.scale * 0.3 * (1.15 + (1 - beat) * 0.7), 0, Math.PI * 2);
        ctx.strokeStyle = TOKEN.edge;
        ctx.lineWidth = Math.max(1.5, p.scale * 0.03);
        ctx.stroke();
        ctx.restore();
      }
      const grow = 1 + beat * 0.14;
      drawNumberToken(ctx, 0, 0, p.scale * 0.3 * grow, token.hex.number!, token.id === state.robber);
      ctx.restore();
    }
  }

  // -------------------------------------------------------------------------
  // Piezas
  // -------------------------------------------------------------------------

  /**
   * Todo lo que sobresale del plano: muelles, caminos, poblados, ciudades y el
   * ladron. Se recogen en una lista con su profundidad y se pintan de lejos a
   * cerca, para que una pieza de delante tape a la de detras.
   */
  private drawStanding(ctx: CanvasRenderingContext2D): void {
    const state = this.state!;
    const jobs: { depth: number; draw: () => void }[] = [];

    // Puertos.
    for (const port of state.board.ports) {
      const [a, b] = parseEdgeId(port.edge);
      const va = vertexPixel(a, HEX_UNIT);
      const vb = vertexPixel(b, HEX_UNIT);
      const [sx, sy] = this.portSignPoint(port.edge);
      jobs.push({
        depth: this.cam.depthAt(sx, sy),
        draw: () => drawPort3D(ctx, this.cam, sx, sy, va, vb, port.kind, HEX_UNIT),
      });
    }

    // Caminos.
    for (const [edge, road] of Object.entries(state.roads)) {
      const [a, b] = parseEdgeId(edge);
      const [ax, ay] = vertexPixel(a, HEX_UNIT);
      const [bx, by] = vertexPixel(b, HEX_UNIT);
      const progress = this.animProgress(`r:${edge}`);
      const grow = progress === null ? 1 : 0.45 + easeOutBack(progress) * 0.55;
      const color = state.players[road.owner]!.color;
      jobs.push({
        depth: this.cam.depthAt((ax + bx) / 2, (ay + by) / 2),
        draw: () => {
          groundShadow(ctx, this.cam, (ax + bx) / 2, (ay + by) / 2, 0.3, 0.3);
          paintFaces(ctx, this.cam, roadFaces(ax, ay, bx, by, color, grow), {
            outline: PIECE_OUTLINE,
          });
        },
      });
    }

    // Poblados y ciudades.
    for (const [vertex, building] of Object.entries(state.buildings)) {
      const [x, y] = vertexPixel(vertex, HEX_UNIT);
      const progress = this.animProgress(`b:${vertex}`);
      const grow = progress === null ? 1 : 0.35 + easeOutBack(progress) * 0.65;
      const color = state.players[building.owner]!.color;
      const city = building.kind === 'city';
      jobs.push({
        depth: this.cam.depthAt(x, y),
        draw: () => {
          groundShadow(ctx, this.cam, x, y, city ? 0.4 : 0.32, 0.36);
          paintFaces(
            ctx,
            this.cam,
            city ? cityFaces(x, y, color, grow) : settlementFaces(x, y, color, grow),
            { outline: PIECE_OUTLINE },
          );
        },
      });
    }

    // Ladron. Se coloca desplazado hacia la camara para no tapar el numero.
    const [rx, ry] = this.hexBoardPoint(state.robber);
    const towardX = Math.sin(this.cam.yaw) * 0.42;
    const towardY = Math.cos(this.cam.yaw) * 0.42;
    let bx = rx + towardX;
    let by = ry + towardY;
    let lift = 0;
    const anim = this.anims.find((a) => a.kind === 'robber');
    if (anim?.from) {
      const t = easeInOut(Math.min(1, (performance.now() - anim.start) / anim.duration));
      const fromX = anim.from[0] + towardX;
      const fromY = anim.from[1] + towardY;
      bx = fromX + (bx - fromX) * t;
      by = fromY + (by - fromY) * t;
      lift = Math.sin(t * Math.PI) * 0.55;
    }
    jobs.push({
      depth: this.cam.depthAt(bx, by),
      draw: () => {
        groundShadow(ctx, this.cam, bx, by, 0.26 + lift * 0.3, 0.4 - lift * 0.2);
        const faces = robberFaces(bx, by, 1).map((f) => ({
          ...f,
          pts: f.pts.map((p): Point3 => [p[0], p[1], p[2] + lift]),
        }));
        // El ladron va sin filo: en un cuerpo de revolucion el contorno cae en
        // cada faceta del tronco de cono y la pieza acaba pareciendo una pina.
        paintFaces(ctx, this.cam, faces);
      },
    });

    // Piezas fantasma de lo que se puede construir, mezcladas con las reales
    // para que una casa de delante tape a un fantasma de detras.
    if (this.highlight.color) {
      jobs.push(...this.ghostJobs(this.highlight.color));
      this.needsRender = true;
    }

    jobs.sort((a, b) => b.depth - a.depth);
    for (const job of jobs) job.draw();
  }

  // -------------------------------------------------------------------------
  // Aparcadero de piezas
  // -------------------------------------------------------------------------

  /**
   * Piezas que le quedan al jugador, puestas en orden sobre la mesa junto al
   * tablero: los caminos en filas, luego los poblados y luego las ciudades.
   *
   * Van con la misma geometria y la misma luz que las piezas del tablero, asi
   * que son literalmente las mismas piezas antes de colocarlas. Debajo lleva una
   * bandeja oscura que las agrupa y las separa de la madera de la mesa.
   */
  private drawReserve(ctx: CanvasRenderingContext2D): void {
    const reserve = this.reserve;
    if (!reserve) return;
    const slots = this.reserveSlots(reserve);

    // Bandeja: el rectangulo de la dotacion completa, para que no cambie de
    // tamano segun se construye.
    const [tx0, ty0, tx1, ty1] = this.reserveSlots(reserve.capacity).bounds;
    ctx.save();
    ctx.beginPath();
    const corners: [number, number][] = [
      [tx0, ty0],
      [tx1, ty0],
      [tx1, ty1],
      [tx0, ty1],
    ];
    corners.forEach(([x, y], i) => {
      const p = this.cam.project(x, y, -0.02);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.closePath();
    ctx.fillStyle = 'rgba(18,11,5,0.34)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(217,164,65,0.22)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();

    const jobs: { depth: number; draw: () => void }[] = [];
    for (const [x, y] of slots.roads) {
      jobs.push({
        depth: this.cam.depthAt(x, y),
        draw: () =>
          paintFaces(ctx, this.cam, roadFaces(x - 0.22, y, x + 0.22, y, reserve.color), {
            outline: PIECE_OUTLINE,
          }),
      });
    }
    for (const [x, y] of slots.settlements) {
      jobs.push({
        depth: this.cam.depthAt(x, y),
        draw: () =>
          paintFaces(ctx, this.cam, settlementFaces(x, y, reserve.color, 0.92), {
            outline: PIECE_OUTLINE,
          }),
      });
    }
    for (const [x, y] of slots.cities) {
      jobs.push({
        depth: this.cam.depthAt(x, y),
        draw: () =>
          paintFaces(ctx, this.cam, cityFaces(x, y, reserve.color, 0.92), {
            outline: PIECE_OUTLINE,
          }),
      });
    }

    jobs.sort((a, b) => b.depth - a.depth);
    for (const job of jobs) job.draw();
  }

  // -------------------------------------------------------------------------
  // Cosecha
  // -------------------------------------------------------------------------

  /**
   * Cartas que suben desde cada casilla que ha producido, con un aro que se
   * abre sobre su ficha numerica.
   *
   * Es lo que une la tirada con el tablero: sin esto los recursos aparecen en
   * la mano sin que se vea de donde han salido, y con seis casillas repartidas
   * por el mapa no hay forma de seguirlo.
   */
  private drawHarvests(ctx: CanvasRenderingContext2D): void {
    if (!this.harvests.length) return;
    const now = performance.now();
    this.harvests = this.harvests.filter((h) => now - h.start < HARVEST_MS);
    if (!this.harvests.length) return;
    this.needsRender = true;

    for (const harvest of this.harvests) {
      const t = (now - harvest.start) / HARVEST_MS;
      const [bx, by] = this.hexBoardPoint(harvest.hex);

      // Aro sobre la ficha: se abre deprisa y se apaga.
      const ringT = Math.min(1, t * 3.4);
      if (ringT < 1) {
        const p = this.cam.project(bx, by, 0.02);
        const radius = p.scale * (0.3 + ringT * 0.42);
        ctx.save();
        ctx.globalAlpha = (1 - ringT) * 0.85;
        ctx.strokeStyle = '#ffd77a';
        ctx.lineWidth = Math.max(1.5, p.scale * 0.05);
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, radius, radius * this.cam.groundSquash, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // Carta subiendo. Arranca con un impulso y frena al final, como si la
      // levantaran de la mesa.
      const rise = 1 - Math.pow(1 - t, 2.2);
      const p = this.cam.project(bx, by, 0.1 + rise * 1.05);
      // El tamano se ata a la escala del CENTRO del tablero y no a la de cada
      // casilla: asi la carta se lee igual de bien delante que al fondo, y la
      // lamina se memoiza una sola vez en vez de una por posicion.
      const w = Math.max(26, Math.round(this.spriteUnit * 0.52));
      const h = Math.round(w * 1.34);
      const fade = t < 0.72 ? Math.min(1, t * 7) : Math.max(0, (1 - t) / 0.28);

      ctx.save();
      ctx.globalAlpha = fade;

      // Marco claro detras de la carta. Sin el, una carta de madera saliendo de
      // un bosque es la misma imagen sobre si misma y no se distingue nada: la
      // lamina y la casilla son el mismo dibujo a proposito.
      const pad = Math.max(2, w * 0.12);
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = w * 0.5;
      ctx.shadowOffsetY = w * 0.18;
      roundRect(ctx, p.x - w / 2 - pad, p.y - h / 2 - pad, w + pad * 2, h + pad * 2, pad * 2);
      ctx.fillStyle = '#f6e8c6';
      ctx.fill();
      ctx.shadowColor = 'transparent';

      ctx.drawImage(resourceArt(harvest.resource, w, h), p.x - w / 2, p.y - h / 2, w, h);
      ctx.restore();
    }
  }

  // -------------------------------------------------------------------------
  // Dados
  // -------------------------------------------------------------------------

  /**
   * Los dados viven en la esquina, grandes y pulsables: hacen lo mismo que el
   * boton "Tirar dados" de la barra de acciones. Cuando toca tirar se anuncian
   * con un aro dorado que late.
   */
  private drawDice(ctx: CanvasRenderingContext2D): void {
    const progress = this.animProgress('dice');
    const rolling = progress !== null && progress < 1;
    const { size, gap, left, top, totalW, centerY } = this.dice;

    // Aro de llamada cuando el jugador puede tirar.
    if (this.diceMode && !rolling) {
      const beat = 0.5 + Math.sin(performance.now() / 260) * 0.5;
      ctx.save();
      const cxAll = left + totalW / 2;
      const r = totalW * 0.72;
      const glow = ctx.createRadialGradient(cxAll, centerY, r * 0.35, cxAll, centerY, r);
      glow.addColorStop(0, `rgba(255,206,92,${0.3 + beat * 0.24})`);
      glow.addColorStop(1, 'rgba(255,206,92,0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(cxAll, centerY, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    let [a, b] = this.diceDisplay;
    let tumbleA: [number, number, number] = [0, 0, 0];
    let tumbleB: [number, number, number] = [0, 0, 0];
    let hopA = 0;
    let hopB = 0;
    if (rolling) {
      // Los cubos voltean sobre los tres ejes y el giro se apaga con el
      // cuadrado del tiempo que queda, asi que frenan en vez de pararse en
      // seco.
      //
      // Las caras al azar se cortan ANTES del final, en `SETTLE`: a partir de
      // ahi ya se ve el resultado de verdad, todavia dando tumbos. Ensenando
      // caras aleatorias hasta el ultimo fotograma el numero cambiaba justo al
      // pararse -- se veia el cambio, y ademas dejaba la sensacion de que el
      // resultado se decidia al final en vez de estar ya echado.
      if (progress! < SETTLE) {
        // El repaso tambien se frena, para que el ultimo cambio de cara no
        // llegue de golpe desde una velocidad alta.
        const speed = 1 - progress! / SETTLE;
        const t = performance.now() * (0.006 + speed * 0.018);
        a = 1 + (Math.floor(t) % 6);
        b = 1 + (Math.floor(t * 1.37) % 6);
      }
      const fall = 1 - progress!;
      const spin = fall * fall;
      const clock = performance.now() / 1000;
      tumbleA = [spin * 13 * Math.sin(clock * 9), spin * 11, spin * 15];
      tumbleB = [spin * -12, spin * 14 * Math.cos(clock * 7), spin * -10];
      hopA = Math.abs(Math.sin(progress! * Math.PI * 3)) * size * 0.6 * fall;
      hopB = Math.abs(Math.sin(progress! * Math.PI * 2.4 + 0.7)) * size * 0.55 * fall;
    }

    const hovered = this.hoverDice && this.diceMode !== null;
    const bump = hovered && !rolling ? size * 0.06 : 0;

    drawDie3D(ctx, left + size / 2, centerY - hopA - bump, size, a, tumbleA);
    drawDie3D(ctx, left + size * 1.5 + gap, centerY - hopB - bump, size, b, tumbleB);

    // Suma de la tirada, en una chapa bajo los dados.
    if (!rolling && this.diceLive) {
      const total = this.diceDisplay[0] + this.diceDisplay[1];
      const cxAll = left + totalW / 2;
      const cy = top + size * 1.42;
      const r = size * 0.27;
      ctx.save();
      ctx.beginPath();
      ctx.arc(cxAll, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(24,16,9,0.82)';
      ctx.fill();
      ctx.strokeStyle = total === 7 ? '#e0563f' : '#d9a441';
      ctx.lineWidth = Math.max(1.5, r * 0.14);
      ctx.stroke();
      ctx.fillStyle = total === 7 ? '#ffcabb' : '#f4e9d2';
      ctx.font = `700 ${r * 1.05}px "Georgia", serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(total), cxAll, cy + r * 0.04);
      ctx.restore();
    }

    // Llamada a la accion: la etiqueta dice cual de las dos toca.
    if (this.diceMode && !rolling) {
      const label = this.diceMode === 'roll' ? 'TIRAR' : 'PASAR TURNO';
      const cxAll = left + totalW / 2;
      ctx.save();
      ctx.font = `700 ${size * 0.2}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = size * 0.06;
      ctx.strokeStyle = 'rgba(20,12,4,0.75)';
      ctx.strokeText(label, cxAll, top - size * 0.24);
      ctx.fillStyle = this.diceMode === 'roll' ? '#ffd77a' : '#bfe3a8';
      ctx.fillText(label, cxAll, top - size * 0.24);
      ctx.restore();
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

export { PLAYER_PALETTE };
