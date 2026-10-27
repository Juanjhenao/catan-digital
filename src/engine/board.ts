import { VARIANT_SETUP } from './constants.js';
import { edgeId, hexCorners, hexEdges, hexId, parseEdgeId } from './hex.js';
import { shuffle, type RngState } from './rng.js';
import type {
  Board,
  BoardVariant,
  EdgeId,
  Hex,
  HexCoord,
  HexId,
  Port,
  PortKind,
  Terrain,
  VertexId,
} from './types.js';

// ---------------------------------------------------------------------------
// Formas de tablero
// ---------------------------------------------------------------------------

/**
 * Cada entrada es [r, qMin, qMax] inclusive. Las filas estan elegidas para que
 * los centros queden alineados verticalmente (X = 2q + r constante por columna).
 */
/**
 * Hexagono regular de radio `radius`: todas las coordenadas a esa distancia o
 * menos del centro. Da 3r(r+1)+1 casillas, es decir 19, 37 y 61 para radios
 * 2, 3 y 4.
 */
function hexagonCoords(radius: number): HexCoord[] {
  const out: HexCoord[] = [];
  for (let r = -radius; r <= radius; r++) {
    const qMin = Math.max(-radius, -r - radius);
    const qMax = Math.min(radius, -r + radius);
    for (let q = qMin; q <= qMax; q++) out.push({ q, r });
  }
  return out;
}

/**
 * El tablero de la extension no es un hexagono regular sino uno estirado
 * (filas de 3-4-5-6-5-4-3), asi que va escrito a mano. Los rangos estan
 * elegidos para que las columnas queden alineadas: X = 2q + r.
 */
const EXTENDED_ROWS: readonly [number, number, number][] = [
  [-3, 0, 2],
  [-2, -1, 2],
  [-1, -2, 2],
  [0, -3, 2],
  [1, -3, 1],
  [2, -3, 0],
  [3, -3, -1],
];

export function layoutCoords(variant: BoardVariant): HexCoord[] {
  if (variant === 'extended') {
    const out: HexCoord[] = [];
    for (const [r, qMin, qMax] of EXTENDED_ROWS) {
      for (let q = qMin; q <= qMax; q++) out.push({ q, r });
    }
    return out;
  }
  return hexagonCoords(variant === 'huge' ? 4 : variant === 'large' ? 3 : 2);
}

// ---------------------------------------------------------------------------
// Grafo de vertices y aristas
// ---------------------------------------------------------------------------

export interface Topology {
  vertexHexes: Record<VertexId, HexId[]>;
  vertexNeighbors: Record<VertexId, VertexId[]>;
  edgeVertices: Record<EdgeId, [VertexId, VertexId]>;
  vertexEdges: Record<VertexId, EdgeId[]>;
  /** Cuantos hexagonos comparten cada arista (1 = costa, 2 = interior). */
  edgeHexCount: Record<EdgeId, number>;
}

export function buildTopology(coords: HexCoord[]): Topology {
  const vertexHexes: Record<VertexId, HexId[]> = {};
  const vertexNeighbors: Record<VertexId, Set<VertexId>> = {};
  const edgeVertices: Record<EdgeId, [VertexId, VertexId]> = {};
  const vertexEdges: Record<VertexId, Set<EdgeId>> = {};
  const edgeHexCount: Record<EdgeId, number> = {};

  for (const coord of coords) {
    const id = hexId(coord);
    const corners = hexCorners(coord);
    for (let i = 0; i < 6; i++) {
      const v = corners[i]!;
      const next = corners[(i + 1) % 6]!;
      const e = edgeId(v, next);

      (vertexHexes[v] ??= []).push(id);
      (vertexNeighbors[v] ??= new Set()).add(next);
      (vertexNeighbors[next] ??= new Set()).add(v);
      (vertexEdges[v] ??= new Set()).add(e);
      (vertexEdges[next] ??= new Set()).add(e);
      if (!edgeVertices[e]) edgeVertices[e] = [v < next ? v : next, v < next ? next : v];
      edgeHexCount[e] = (edgeHexCount[e] ?? 0) + 1;
    }
  }

  return {
    vertexHexes,
    vertexNeighbors: mapValues(vertexNeighbors, (s) => [...s].sort()),
    edgeVertices,
    vertexEdges: mapValues(vertexEdges, (s) => [...s].sort()),
    edgeHexCount,
  };
}

function mapValues<A, B>(obj: Record<string, A>, fn: (a: A) => B): Record<string, B> {
  const out: Record<string, B> = {};
  for (const key of Object.keys(obj)) out[key] = fn(obj[key]!);
  return out;
}

// ---------------------------------------------------------------------------
// Costa
// ---------------------------------------------------------------------------

/**
 * Devuelve las aristas costeras ordenadas siguiendo el perimetro, de modo que
 * dos entradas consecutivas comparten un vertice. Es lo que permite repartir
 * los puertos a intervalos regulares alrededor de la isla.
 */
export function coastalRing(topology: Topology): EdgeId[] {
  const coastal = Object.keys(topology.edgeHexCount).filter(
    (e) => topology.edgeHexCount[e] === 1,
  );
  if (coastal.length === 0) return [];

  const coastalSet = new Set(coastal);
  /** vertice -> aristas costeras incidentes (siempre 2 en un tablero convexo). */
  const byVertex: Record<VertexId, EdgeId[]> = {};
  for (const e of coastal) {
    const [a, b] = topology.edgeVertices[e]!;
    (byVertex[a] ??= []).push(e);
    (byVertex[b] ??= []).push(e);
  }

  const ring: EdgeId[] = [];
  const visited = new Set<EdgeId>();
  let current = coastal[0]!;
  let cursor = topology.edgeVertices[current]![0];

  while (!visited.has(current)) {
    visited.add(current);
    ring.push(current);
    const [a, b] = topology.edgeVertices[current]!;
    const nextVertex = a === cursor ? b : a;
    const candidates = (byVertex[nextVertex] ?? []).filter(
      (e) => e !== current && coastalSet.has(e),
    );
    const next = candidates[0];
    if (!next) break;
    current = next;
    cursor = nextVertex;
  }

  return ring;
}

/**
 * Reparte `count` puertos sobre `ring` dejando huecos lo mas parejos posible.
 *
 * En el tablero real de 19 casillas la costa tiene 30 aristas y hay 9 puertos:
 * entre uno y el siguiente quedan 2 o 3 aristas libres, y los huecos grandes
 * van REPARTIDOS por toda la vuelta, no seguidos.
 *
 * Repartirlos es justo lo que fallaba. Agrandar los primeros huecos y dejar el
 * resto al minimo -- que es lo que sale de la division entera a secas -- da los
 * tres huecos grandes juntos: un lado de la isla con los puertos separados y
 * otro con todos apretados. La cuenta correcta es la de Bresenham: se coloca
 * cada puerto en la posicion exacta `i * ringLength / count` y se redondea, con
 * lo que los huecos grandes caen alternados solos.
 */
function portEdgePositions(ringLength: number, count: number): number[] {
  if (count <= 0 || ringLength <= 0) return [];
  const positions: number[] = [];
  for (let i = 0; i < count; i++) {
    positions.push(Math.round((i * ringLength) / count) % ringLength);
  }
  return positions;
}

// ---------------------------------------------------------------------------
// Fichas numericas
// ---------------------------------------------------------------------------

const RED_NUMBERS = new Set([6, 8]);

/**
 * Coloca las fichas evitando que dos numeros rojos (6 y 8) queden en casillas
 * adyacentes, que es la restriccion oficial del reparto aleatorio.
 * Si tras muchos intentos no lo consigue, acepta el mejor reparto encontrado
 * para no bloquear nunca la creacion de partida.
 */
function assignNumbers(
  productiveHexes: HexCoord[],
  numbers: number[],
  adjacency: Map<string, string[]>,
  rng: RngState,
): [Map<HexId, number>, RngState] {
  let state = rng;
  let best: Map<HexId, number> | null = null;
  let bestConflicts = Infinity;

  for (let attempt = 0; attempt < 500; attempt++) {
    const [shuffled, next] = shuffle(numbers, state);
    state = next;

    const assignment = new Map<HexId, number>();
    productiveHexes.forEach((coord, i) => assignment.set(hexId(coord), shuffled[i]!));

    let conflicts = 0;
    for (const [id, value] of assignment) {
      if (!RED_NUMBERS.has(value)) continue;
      for (const neighbor of adjacency.get(id) ?? []) {
        const other = assignment.get(neighbor);
        if (other !== undefined && RED_NUMBERS.has(other)) conflicts++;
      }
    }

    if (conflicts === 0) return [assignment, state];
    if (conflicts < bestConflicts) {
      bestConflicts = conflicts;
      best = assignment;
    }
  }

  return [best!, state];
}

function hexAdjacency(coords: HexCoord[]): Map<HexId, HexId[]> {
  const present = new Set(coords.map(hexId));
  const map = new Map<HexId, HexId[]>();
  for (const coord of coords) {
    const neighbors: HexId[] = [];
    for (const d of [
      { q: 1, r: -1 },
      { q: 1, r: 0 },
      { q: 0, r: 1 },
      { q: -1, r: 1 },
      { q: -1, r: 0 },
      { q: 0, r: -1 },
    ]) {
      const id = hexId({ q: coord.q + d.q, r: coord.r + d.r });
      if (present.has(id)) neighbors.push(id);
    }
    map.set(hexId(coord), neighbors);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Generacion completa
// ---------------------------------------------------------------------------

export function generateBoard(variant: BoardVariant, rng: RngState): [Board, RngState] {
  const setup = VARIANT_SETUP[variant];
  const coords = layoutCoords(variant);
  const topology = buildTopology(coords);

  let state = rng;

  // 1. Terrenos.
  const [terrains, afterTerrain] = shuffle(setup.terrains, state);
  state = afterTerrain;

  // 2. Fichas numericas sobre las casillas productivas.
  const productive: HexCoord[] = [];
  coords.forEach((coord, i) => {
    if (terrains[i] !== 'desert') productive.push(coord);
  });
  const [numbers, afterNumbers] = assignNumbers(
    productive,
    setup.numbers,
    hexAdjacency(coords),
    state,
  );
  state = afterNumbers;

  // 3. Montaje de las casillas.
  const hexes: Record<HexId, Hex> = {};
  const hexOrder: HexId[] = [];
  let robberStart: HexId | null = null;
  coords.forEach((coord, i) => {
    const id = hexId(coord);
    const terrain = terrains[i] as Terrain;
    hexes[id] = {
      id,
      coord,
      terrain,
      number: numbers.get(id) ?? null,
      vertices: hexCorners(coord),
      edges: hexEdges(coord),
    };
    hexOrder.push(id);
    if (terrain === 'desert' && robberStart === null) robberStart = id;
  });

  // 4. Puertos repartidos por la costa.
  const ring = coastalRing(topology);
  const portKinds: PortKind[] = [
    ...setup.ports,
    ...Array<PortKind>(setup.genericPorts).fill('generic'),
  ];
  const [shuffledKinds, afterPorts] = shuffle(portKinds, state);
  state = afterPorts;

  const positions = portEdgePositions(ring.length, shuffledKinds.length);
  const ports: Port[] = positions.map((pos, i) => {
    const edge = ring[pos]!;
    const [a, b] = parseEdgeId(edge);
    const kind = shuffledKinds[i]!;
    return {
      id: `port-${i}`,
      kind,
      ratio: kind === 'generic' ? 3 : 2,
      vertices: [a, b],
      edge,
    };
  });

  const vertexPorts: Record<VertexId, PortKind[]> = {};
  for (const port of ports) {
    for (const v of port.vertices) (vertexPorts[v] ??= []).push(port.kind);
  }

  const board: Board = {
    variant,
    hexes,
    hexOrder,
    vertexHexes: topology.vertexHexes,
    vertexNeighbors: topology.vertexNeighbors,
    edgeVertices: topology.edgeVertices,
    vertexEdges: topology.vertexEdges,
    ports,
    vertexPorts,
    robberStart: robberStart ?? hexOrder[0]!,
  };

  return [board, state];
}

/** Todos los vertices del tablero. */
export function allVertices(board: Board): VertexId[] {
  return Object.keys(board.vertexHexes);
}

/** Todas las aristas del tablero. */
export function allEdges(board: Board): EdgeId[] {
  return Object.keys(board.edgeVertices);
}
