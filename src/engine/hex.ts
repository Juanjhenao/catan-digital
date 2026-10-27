import type { EdgeId, HexCoord, HexId, VertexId } from './types.js';

/**
 * Geometria de la rejilla hexagonal (hexagonos "pointy-top").
 *
 * El truco central: en lugar de calcular la posicion de cada esquina en coma
 * flotante y luego intentar decidir si dos esquinas "son la misma", trabajamos
 * en una rejilla ENTERA duplicada donde la esquina de un hexagono cae siempre
 * en coordenadas enteras exactas. Dos hexagonos vecinos producen literalmente
 * el mismo par (X, Y) para la esquina que comparten, asi que la identidad de
 * vertice es igualdad de enteros y no hay epsilon en ninguna parte.
 *
 *   centro del hex (q, r)  ->  X = 2q + r,  Y = 3r
 *   esquina i del hex      ->  centro + CORNER_OFFSETS[i]
 *
 * Para dibujar se convierte de vuelta a pixeles:
 *   x = X * (sqrt(3)/2) * size
 *   y = Y * (1/2) * size
 */

export const CORNER_OFFSETS: readonly [number, number][] = [
  [1, -1], // 0: superior derecha
  [1, 1], // 1: inferior derecha
  [0, 2], // 2: inferior
  [-1, 1], // 3: inferior izquierda
  [-1, -1], // 4: superior izquierda
  [0, -2], // 5: superior
];

/** Vecinos axiales en el mismo orden angular que CORNER_OFFSETS. */
export const HEX_DIRECTIONS: readonly HexCoord[] = [
  { q: 1, r: -1 },
  { q: 1, r: 0 },
  { q: 0, r: 1 },
  { q: -1, r: 1 },
  { q: -1, r: 0 },
  { q: 0, r: -1 },
];

export function hexId(coord: HexCoord): HexId {
  return `${coord.q},${coord.r}`;
}

export function parseHexId(id: HexId): HexCoord {
  const [q, r] = id.split(',');
  return { q: Number(q), r: Number(r) };
}

/** Coordenada entera del centro del hexagono en la rejilla duplicada. */
export function hexCenterGrid(coord: HexCoord): [number, number] {
  return [2 * coord.q + coord.r, 3 * coord.r];
}

export function vertexId(x: number, y: number): VertexId {
  return `${x},${y}`;
}

export function parseVertexId(id: VertexId): [number, number] {
  const [x, y] = id.split(',');
  return [Number(x), Number(y)];
}

/** Las 6 esquinas de un hexagono, en orden horario desde la superior derecha. */
export function hexCorners(coord: HexCoord): VertexId[] {
  const [cx, cy] = hexCenterGrid(coord);
  return CORNER_OFFSETS.map(([dx, dy]) => vertexId(cx + dx, cy + dy));
}

/**
 * Clave canonica de arista: los dos vertices ordenados de forma estable, para
 * que (a, b) y (b, a) produzcan siempre la misma cadena.
 */
export function edgeId(a: VertexId, b: VertexId): EdgeId {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function parseEdgeId(id: EdgeId): [VertexId, VertexId] {
  const [a, b] = id.split('|');
  return [a as VertexId, b as VertexId];
}

/** Las 6 aristas de un hexagono; edges[i] une corners[i] con corners[i+1]. */
export function hexEdges(coord: HexCoord): EdgeId[] {
  const corners = hexCorners(coord);
  return corners.map((v, i) => edgeId(v, corners[(i + 1) % 6]!));
}

/** Conversion a pixeles para el renderizador. `size` = radio del hexagono. */
export function gridToPixel(x: number, y: number, size: number): [number, number] {
  return [(x * Math.sqrt(3) * size) / 2, (y * size) / 2];
}

export function hexCenterPixel(coord: HexCoord, size: number): [number, number] {
  const [gx, gy] = hexCenterGrid(coord);
  return gridToPixel(gx, gy, size);
}

export function vertexPixel(id: VertexId, size: number): [number, number] {
  const [x, y] = parseVertexId(id);
  return gridToPixel(x, y, size);
}

export function edgeMidpointPixel(id: EdgeId, size: number): [number, number] {
  const [a, b] = parseEdgeId(id);
  const [ax, ay] = vertexPixel(a, size);
  const [bx, by] = vertexPixel(b, size);
  return [(ax + bx) / 2, (ay + by) / 2];
}

export function addHex(a: HexCoord, b: HexCoord): HexCoord {
  return { q: a.q + b.q, r: a.r + b.r };
}

/** Distancia en pasos de hexagono. */
export function hexDistance(a: HexCoord, b: HexCoord): number {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  return (Math.abs(dq) + Math.abs(dq + dr) + Math.abs(dr)) / 2;
}
