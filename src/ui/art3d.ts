import type { PlayerColor, PortKind, Resource } from '../engine/index.js';
import { hexPath, roundRect } from './art.js';
import { drawMaterial, MATERIAL_BACKDROP } from './materials.js';
import {
  PLAYER_PALETTE,
  RESOURCE_COLOR,
  WATER,
  TABLE,
  shade,
  tint,
} from './theme.js';
import type { Camera, Point3 } from './camera.js';

/**
 * Solidos del tablero.
 *
 * Aqui vive todo lo que tiene VOLUMEN: las paredes de las casillas, los
 * caminos, los poblados, las ciudades, el ladron y los muelles. Cada pieza se
 * describe como una lista de caras en coordenadas de mundo (dos de tablero mas
 * la altura) y se pinta con el algoritmo del pintor: se ordenan las caras de
 * lejos a cerca y se rellenan en ese orden. Para un solido convexo eso da el
 * resultado exacto, sin necesidad de un buffer de profundidad.
 *
 * La iluminacion es un unico foco direccional fijo desde arriba a la izquierda.
 * Con eso basta para que un cubo se lea como un cubo: la cara de arriba clara,
 * la de la izquierda intermedia y la de la derecha oscura.
 */

/** Cara: poligono en el mundo mas el color base con el que se rellena. */
export interface Face {
  pts: Point3[];
  color: string;
  /** Si es false la cara no recibe sombreado direccional. */
  lit?: boolean;
  /** Contorno opcional. */
  stroke?: string;
  /** Grosor del contorno en unidades de tablero. */
  lineWidth?: number;
}

/**
 * Foco direccional (ya normalizado). Apunta desde la escena hacia la luz: arriba
 * a la izquierda y algo por delante, para que la cara que mira al jugador sea
 * la iluminada. Con la luz detras, todo lo que se ve queda en sombra y las
 * piezas se leen como manchas planas.
 */
const LIGHT: Point3 = [-0.5, 0.34, 0.8];

const AMBIENT = 0.5;
const DIFFUSE = 0.55;

// ---------------------------------------------------------------------------
// Nucleo: pintar caras
// ---------------------------------------------------------------------------

function normalOf(pts: Point3[]): Point3 {
  const [a, b, c] = pts;
  if (!a || !b || !c) return [0, 0, 1];
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

function centroid(pts: Point3[]): Point3 {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const p of pts) {
    x += p[0];
    y += p[1];
    z += p[2];
  }
  return [x / pts.length, y / pts.length, z / pts.length];
}

/**
 * Intensidad de luz sobre una cara, entre AMBIENT y AMBIENT + DIFFUSE.
 *
 * El orden de los vertices no garantiza hacia donde apunta la normal, asi que
 * se orienta hacia FUERA usando el centro del solido: para un cuerpo convexo
 * eso da siempre la normal exterior correcta, que es la que decide si una cara
 * esta al sol o a la sombra. Sin esto, la pared izquierda y la derecha
 * recibirian la misma luz y el volumen desapareceria.
 */
function intensity(pts: Point3[], pivot: Point3): number {
  const n = normalOf(pts);
  const c = centroid(pts);
  const outward =
    n[0] * (c[0] - pivot[0]) + n[1] * (c[1] - pivot[1]) + n[2] * (c[2] - pivot[2]) >= 0 ? 1 : -1;
  const dot =
    outward * (n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]);
  return AMBIENT + DIFFUSE * Math.max(0, dot);
}

/** Aplica la intensidad a un color: >1 aclara, <1 oscurece. */
function litColor(color: string, k: number): string {
  return k >= 1 ? tint(color, Math.min(0.45, (k - 1) * 0.9)) : shade(color, Math.min(0.7, 1 - k));
}

function centroidDepth(cam: Camera, pts: Point3[]): number {
  let sum = 0;
  for (const p of pts) sum += cam.depthAt(p[0], p[1], p[2]);
  return sum / pts.length;
}

export interface PaintOptions {
  /**
   * Centro del solido. Se usa para orientar las normales hacia fuera; por
   * defecto es el centro de todas las caras que se pasan, que es lo correcto
   * cuando se pinta una pieza entera de una vez.
   */
  pivot?: Point3;
  /** Filo oscuro en cada cara: separa la pieza del terreno que tiene debajo. */
  outline?: string;
}

/**
 * Dibuja un conjunto de caras ordenandolas de atras hacia delante. Todas las
 * caras de una misma pieza deben pasarse juntas: es lo que permite calcular el
 * centro del solido y lo que hace que se tapen bien entre si.
 */
export function paintFaces(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  faces: Face[],
  options: PaintOptions = {},
): void {
  if (!faces.length) return;
  const pivot = options.pivot ?? centroid(faces.flatMap((f) => f.pts));

  const ordered = faces
    .map((face) => ({ face, depth: centroidDepth(cam, face.pts) }))
    .sort((a, b) => b.depth - a.depth);

  for (const { face } of ordered) {
    const pts = face.pts;
    if (pts.length < 3) continue;
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const p = cam.projectPoint(pts[i]!);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
    ctx.fillStyle = face.lit === false ? face.color : litColor(face.color, intensity(pts, pivot));
    ctx.fill();
    const stroke = face.stroke ?? options.outline;
    if (stroke) {
      const scale = cam.project(pts[0]![0], pts[0]![1], pts[0]![2]).scale;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = Math.max(0.7, (face.lineWidth ?? 0.014) * scale);
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
  }
}

/** Filo estandar de las piezas de jugador. */
export const PIECE_OUTLINE = 'rgba(22,14,6,0.5)';

// ---------------------------------------------------------------------------
// Constructores de geometria
// ---------------------------------------------------------------------------

/** Vector unitario 2D. */
type Vec2 = [number, number];

function perp(v: Vec2): Vec2 {
  return [-v[1], v[0]];
}

/**
 * Caras de una caja apoyada en el plano, orientada segun `dir`.
 *
 * `dir` es la direccion del lado largo; el lado corto sale de girarla 90
 * grados. Se devuelven las cuatro paredes y la tapa: la base nunca se ve.
 */
export function boxFaces(
  cx: number,
  cy: number,
  dir: Vec2,
  halfLength: number,
  halfWidth: number,
  z0: number,
  z1: number,
  color: string,
  topColor = color,
): Face[] {
  const u = dir;
  const v = perp(dir);
  const corner = (su: number, sv: number, z: number): Point3 => [
    cx + u[0] * halfLength * su + v[0] * halfWidth * sv,
    cy + u[1] * halfLength * su + v[1] * halfWidth * sv,
    z,
  ];

  const t0 = corner(1, 1, z1);
  const t1 = corner(-1, 1, z1);
  const t2 = corner(-1, -1, z1);
  const t3 = corner(1, -1, z1);
  const b0 = corner(1, 1, z0);
  const b1 = corner(-1, 1, z0);
  const b2 = corner(-1, -1, z0);
  const b3 = corner(1, -1, z0);

  return [
    { pts: [t0, t1, b1, b0], color },
    { pts: [t1, t2, b2, b1], color },
    { pts: [t2, t3, b3, b2], color },
    { pts: [t3, t0, b0, b3], color },
    { pts: [t0, t1, t2, t3], color: topColor },
  ];
}

/** Prisma de base regular de n lados: paredes mas tapa. */
export function prismFaces(
  cx: number,
  cy: number,
  radius: number,
  sides: number,
  z0: number,
  z1: number,
  color: string,
  rotation = 0,
): Face[] {
  const ring: Vec2[] = [];
  for (let i = 0; i < sides; i++) {
    const a = rotation + (i / sides) * Math.PI * 2;
    ring.push([cx + Math.cos(a) * radius, cy + Math.sin(a) * radius]);
  }
  const faces: Face[] = [];
  for (let i = 0; i < sides; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % sides]!;
    faces.push({
      pts: [
        [a[0], a[1], z1],
        [b[0], b[1], z1],
        [b[0], b[1], z0],
        [a[0], a[1], z0],
      ],
      color,
    });
  }
  faces.push({ pts: ring.map((p): Point3 => [p[0], p[1], z1]), color });
  return faces;
}

/** Tronco de cono aproximado: como el prisma pero con radios distintos. */
export function frustumFaces(
  cx: number,
  cy: number,
  rBottom: number,
  rTop: number,
  sides: number,
  z0: number,
  z1: number,
  color: string,
): Face[] {
  const faces: Face[] = [];
  for (let i = 0; i < sides; i++) {
    const a0 = (i / sides) * Math.PI * 2;
    const a1 = ((i + 1) / sides) * Math.PI * 2;
    faces.push({
      pts: [
        [cx + Math.cos(a0) * rTop, cy + Math.sin(a0) * rTop, z1],
        [cx + Math.cos(a1) * rTop, cy + Math.sin(a1) * rTop, z1],
        [cx + Math.cos(a1) * rBottom, cy + Math.sin(a1) * rBottom, z0],
        [cx + Math.cos(a0) * rBottom, cy + Math.sin(a0) * rBottom, z0],
      ],
      color,
    });
  }
  return faces;
}

// ---------------------------------------------------------------------------
// Sombra sobre la mesa
// ---------------------------------------------------------------------------

/** Mancha oscura y aplastada bajo una pieza, para que no parezca flotando. */
export function groundShadow(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  bx: number,
  by: number,
  radius: number,
  alpha = 0.34,
): void {
  const p = cam.project(bx, by, 0.002);
  const rx = radius * p.scale;
  const ry = rx * cam.groundSquash;
  const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, Math.max(rx, 0.001));
  g.addColorStop(0, `rgba(12,8,4,${alpha})`);
  g.addColorStop(1, 'rgba(12,8,4,0)');
  ctx.save();
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(p.x, p.y, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Piezas de jugador
// ---------------------------------------------------------------------------

export const ROAD_HEIGHT = 0.12;
export const TILE_THICKNESS = 0.19;

/**
 * Camino: una viga de madera tumbada entre dos cruces. Se deja algo de aire en
 * los extremos para que dos caminos que comparten cruce no se fundan en uno.
 */
export function roadFaces(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  color: PlayerColor,
  grow = 1,
): Face[] {
  const p = PLAYER_PALETTE[color];
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  const dir: Vec2 = [dx / len, dy / len];
  const half = (len / 2) * 0.8 * grow;
  return boxFaces(
    (ax + bx) / 2,
    (ay + by) / 2,
    dir,
    half,
    0.085 * grow,
    0.004,
    ROAD_HEIGHT * grow,
    p.main,
    tint(p.main, 0.16),
  );
}

/** Poblado: casita de base rectangular con tejado a dos aguas. */
export function settlementFaces(x: number, y: number, color: PlayerColor, grow = 1): Face[] {
  const p = PLAYER_PALETTE[color];
  const u: Vec2 = [1, 0];
  const hu = 0.18 * grow;
  const hv = 0.19 * grow;
  const wallTop = 0.22 * grow;
  const ridge = 0.46 * grow;
  const over = 1.2; // vuelo del alero

  const faces = boxFaces(x, y, u, hu, hv, 0, wallTop, p.main, p.main);
  // La tapa de la caja queda tapada por el tejado: fuera.
  faces.pop();

  // La cumbrera corre hacia la camara, no de lado: asi lo que se ve de frente
  // es el HASTIAL triangular, que es lo que hace que una caja pequeña se lea
  // sin dudas como una casa. Con la cumbrera de lado solo se ve una lamina
  // inclinada y la pieza parece un cajon con tapa.
  const ro = hu * over;
  const rv = hv * over;
  const frontR: Point3 = [x, y + rv, ridge];
  const backR: Point3 = [x, y - rv, ridge];
  const P1: Point3 = [x + ro, y + rv, wallTop];
  const P2: Point3 = [x + ro, y - rv, wallTop];
  const P3: Point3 = [x - ro, y - rv, wallTop];
  const P4: Point3 = [x - ro, y + rv, wallTop];

  // El tejado va MUY oscurecido, no un poco: la cara que mira al jugador es
  // tambien la mejor iluminada, y un oscurecimiento suave lo compensa la luz
  // hasta dejarlo del mismo tono que el muro.
  const roof = shade(p.main, 0.52);
  faces.push({ pts: [P1, P2, backR, frontR], color: roof });
  faces.push({ pts: [P4, P3, backR, frontR], color: roof });
  faces.push({ pts: [P1, P4, frontR], color: tint(p.main, 0.12) });
  faces.push({ pts: [P2, P3, backR], color: tint(p.main, 0.12) });

  return faces;
}

/** Ciudad: nave con tejado a dos aguas pegada a una torre con chapitel. */
export function cityFaces(x: number, y: number, color: PlayerColor, grow = 1): Face[] {
  const p = PLAYER_PALETTE[color];
  const u: Vec2 = [1, 0];
  const roof = shade(p.main, 0.52);

  // Nave.
  const nx = x - 0.14 * grow;
  const nhu = 0.14 * grow;
  const nhv = 0.17 * grow;
  const nTop = 0.19 * grow;
  const faces = boxFaces(nx, y, u, nhu, nhv, 0, nTop, p.main, p.main);
  faces.pop();

  const no = nhu * 1.14;
  const nv = nhv * 1.14;
  const nRidge = nTop + 0.15 * grow;
  const A: Point3 = [nx + no, y + nv, nTop];
  const B: Point3 = [nx - no, y + nv, nTop];
  const C: Point3 = [nx - no, y - nv, nTop];
  const D: Point3 = [nx + no, y - nv, nTop];
  const R1: Point3 = [nx + no, y, nRidge];
  const R2: Point3 = [nx - no, y, nRidge];
  faces.push({ pts: [A, B, R2, R1], color: roof });
  faces.push({ pts: [D, C, R2, R1], color: roof });
  faces.push({ pts: [A, D, R1], color: tint(p.main, 0.12) });
  faces.push({ pts: [B, C, R2], color: tint(p.main, 0.12) });

  // Torre.
  const tx = x + 0.15 * grow;
  const th = 0.13 * grow;
  const tTop = 0.46 * grow;
  const tower = boxFaces(tx, y, u, th, th, 0, tTop, p.main, p.main);
  tower.pop();
  faces.push(...tower);

  // Chapitel piramidal.
  const to = th * 1.2;
  const apex: Point3 = [tx, y, tTop + 0.22 * grow];
  const t0: Point3 = [tx + to, y + to, tTop];
  const t1: Point3 = [tx - to, y + to, tTop];
  const t2: Point3 = [tx - to, y - to, tTop];
  const t3: Point3 = [tx + to, y - to, tTop];
  faces.push({ pts: [t0, t1, apex], color: roof });
  faces.push({ pts: [t1, t2, apex], color: roof });
  faces.push({ pts: [t2, t3, apex], color: roof });
  faces.push({ pts: [t3, t0, apex], color: roof });

  // Ventana encendida en la torre, del lado que mira al jugador.
  faces.push({
    pts: [
      [tx + th + 0.002, y + 0.05 * grow, 0.22 * grow],
      [tx + th + 0.002, y - 0.05 * grow, 0.22 * grow],
      [tx + th + 0.002, y - 0.05 * grow, 0.32 * grow],
      [tx + th + 0.002, y + 0.05 * grow, 0.32 * grow],
    ],
    color: 'rgba(255,226,150,0.95)',
    lit: false,
  });

  return faces;
}

/** Ladron: la pieza troncoconica de siempre, con su capucha. */
export function robberFaces(x: number, y: number, grow = 1): Face[] {
  const faces: Face[] = [];
  faces.push(...frustumFaces(x, y, 0.17 * grow, 0.08 * grow, 16, 0, 0.24 * grow, '#332e27'));
  faces.push(
    ...frustumFaces(x, y, 0.08 * grow, 0.115 * grow, 16, 0.24 * grow, 0.34 * grow, '#403930'),
  );
  faces.push(
    ...frustumFaces(x, y, 0.115 * grow, 0.02 * grow, 16, 0.34 * grow, 0.48 * grow, '#4b4339'),
  );
  return faces;
}

// ---------------------------------------------------------------------------
// Puertos
// ---------------------------------------------------------------------------

/**
 * Muelle en 3D: una pasarela de tablones desde la costa hasta un poste con el
 * cartel del tipo de cambio. El cartel se dibuja como cartelon plano orientado
 * a la camara para que el 2:1 se lea siempre.
 */
const portArtCache = new Map<string, HTMLCanvasElement>();

/**
 * Lamina redonda con el material que compra un puerto.
 *
 * Se pinta UNA vez a resolucion generosa y luego se escala: el cartel cambia de
 * tamano con el zoom en cada fotograma, y redibujar el dibujo a cada rueda del
 * raton seria trabajo tirado.
 *
 * Ensena el MATERIAL y no la casilla, igual que la carta: un puerto de mineral
 * es una piedra, porque lo que se entrega ahi son piedras. Compartir el dibujo
 * con la carta tiene ademas un efecto util -- lo que se ve en el puerto es
 * exactamente lo que hay que buscar en la mano.
 */
function portArt(resource: Resource): HTMLCanvasElement {
  const cached = portArtCache.get(resource);
  if (cached) return cached;

  const size = PORT_ART_PX;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const backdrop = MATERIAL_BACKDROP[resource];
  const c = size / 2;

  ctx.save();
  ctx.beginPath();
  ctx.arc(c, c, c, 0, Math.PI * 2);
  ctx.clip();
  const g = ctx.createLinearGradient(0, 0, 0, size);
  g.addColorStop(0, backdrop.from);
  g.addColorStop(1, backdrop.to);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  // Algo mas arriba del centro: la cinta con la proporcion tapa la parte baja
  // del disco, y el objeto tiene que quedar entero por encima de ella.
  drawMaterial(ctx, resource, c, c * 0.92, c * 0.62);
  ctx.restore();

  portArtCache.set(resource, canvas);
  return canvas;
}

/** Resolucion de la lamina del puerto. Ver `portArt`. */
const PORT_ART_PX = 128;

export function drawPort3D(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  signX: number,
  signY: number,
  vertexA: readonly [number, number],
  vertexB: readonly [number, number],
  kind: PortKind,
  unit: number,
): void {
  // Un muelle a CADA vertice, no una pasarela al punto medio.
  //
  // No es adorno: un puerto se usa desde dos cruces concretas y desde ninguna
  // otra, y con una sola pasarela al centro de la arista no habia forma de
  // saber cuales mirando el tablero. Con los dos muelles el propio dibujo lo
  // dice, que es como funciona la ficha de carton.
  for (const vertex of [vertexA, vertexB]) {
    const dx = vertex[0] - signX;
    const dy = vertex[1] - signY;
    const len = Math.hypot(dx, dy) || 1;
    const dir: Vec2 = [dx / len, dy / len];
    // Arranca fuera de la plataforma para que no se claven uno en otro.
    const from = unit * 0.2;
    const mid = (from + len) / 2;
    paintFaces(
      ctx,
      cam,
      boxFaces(
        signX + dir[0] * mid,
        signY + dir[1] * mid,
        dir,
        (len - from) / 2,
        unit * 0.075,
        0,
        unit * 0.06,
        '#6d4a2c',
        '#8d6440',
      ),
    );
  }

  // Plataforma bajo el poste, que es lo que ata los dos muelles.
  paintFaces(ctx, cam, prismFaces(signX, signY, unit * 0.2, 6, 0, unit * 0.075, '#7a5334'));

  // Poste.
  const postTop = unit * 0.62;
  paintFaces(
    ctx,
    cam,
    boxFaces(signX, signY, [1, 0], unit * 0.035, unit * 0.035, unit * 0.07, postTop, '#6b4526'),
  );

  // Cartel: disco plano mirando a la camara.
  const generic = kind === 'generic';
  const anchor = cam.project(signX, signY, postTop);
  // El de recurso lleva dibujo dentro y necesita mas sitio; el generico solo
  // tiene tres caracteres y se queda pequeno.
  const r = unit * (generic ? 0.34 : 0.4) * anchor.scale;
  ctx.save();
  ctx.translate(anchor.x, anchor.y - r * 0.75);
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = r * 0.5;
  ctx.shadowOffsetY = r * 0.2;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = generic ? '#f3e7cb' : RESOURCE_COLOR[kind];
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = Math.max(1.5, r * 0.16);
  ctx.strokeStyle = 'rgba(30,22,12,0.75)';
  ctx.stroke();

  if (generic) {
    // Puerto de cualquier cosa: no hay recurso que ensenar, solo el precio.
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.8, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,252,244,0.55)';
    ctx.lineWidth = Math.max(1, r * 0.08);
    ctx.stroke();
    ctx.font = `700 ${r * 0.78}px "Georgia", serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = Math.max(1, r * 0.16);
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.strokeText('3:1', 0, 0);
    ctx.fillStyle = '#3a3025';
    ctx.fillText('3:1', 0, 0);
    ctx.restore();
    return;
  }

  // Puerto de recurso: se ve QUE se cambia, no solo a cuanto. Un «2:1» a secas
  // obliga a mirar el color del disco y recordar que color era cada cosa.
  const art = r * 0.82;
  ctx.save();
  ctx.beginPath();
  ctx.arc(0, -r * 0.12, art, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(portArt(kind), -art, -r * 0.12 - art, art * 2, art * 2);
  ctx.restore();
  ctx.beginPath();
  ctx.arc(0, -r * 0.12, art, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(30,22,12,0.55)';
  ctx.lineWidth = Math.max(1, r * 0.07);
  ctx.stroke();

  // Cinta con la proporcion, cruzada sobre la parte de abajo del disco.
  const bandH = r * 0.46;
  const bandY = r * 0.44;
  ctx.beginPath();
  ctx.moveTo(-r * 0.98, bandY - bandH / 2);
  ctx.lineTo(r * 0.98, bandY - bandH / 2);
  ctx.lineTo(r * 0.8, bandY + bandH / 2);
  ctx.lineTo(-r * 0.8, bandY + bandH / 2);
  ctx.closePath();
  ctx.fillStyle = 'rgba(38,26,14,0.9)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,240,210,0.5)';
  ctx.lineWidth = Math.max(1, r * 0.05);
  ctx.stroke();
  ctx.font = `700 ${bandH * 0.82}px "Georgia", serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fdf4de';
  ctx.fillText('2:1', 0, bandY);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Texturas: mar y mesa
// ---------------------------------------------------------------------------

const waterCache = new Map<string, HTMLCanvasElement>();

/** Casilla de mar: mismo formato que `tileSprite`, con olas en vez de relieve. */
export function waterSprite(size: number, seed: string): HTMLCanvasElement {
  const key = `${Math.round(size)}|${seed}`;
  const cached = waterCache.get(key);
  if (cached) return cached;

  const dpr = Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 2);
  const canvas = document.createElement('canvas');
  const w = Math.ceil(size * Math.sqrt(3)) + 4;
  const h = Math.ceil(size * 2) + 4;
  canvas.width = Math.ceil(w * dpr);
  canvas.height = Math.ceil(h * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);

  const cx = w / 2;
  const cy = h / 2;
  let h32 = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h32 ^= seed.charCodeAt(i);
    h32 = Math.imul(h32, 16777619);
  }
  const rand = () => {
    h32 += 0x6d2b79f5;
    let t = h32;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  ctx.save();
  hexPath(ctx, cx, cy, size);
  ctx.clip();
  const g = ctx.createLinearGradient(cx, cy - size, cx, cy + size);
  g.addColorStop(0, WATER.base);
  g.addColorStop(1, WATER.shade);
  ctx.fillStyle = g;
  ctx.fillRect(cx - size, cy - size, size * 2, size * 2);

  // Olas: arcos claros repartidos sin tocar los bordes.
  ctx.strokeStyle = WATER.foam;
  ctx.lineCap = 'round';
  for (let i = 0; i < 14; i++) {
    const a = rand() * Math.PI * 2;
    const rr = Math.sqrt(rand()) * size * 0.8;
    const wx = cx + Math.cos(a) * rr;
    const wy = cy + Math.sin(a) * rr;
    const wlen = size * (0.16 + rand() * 0.2);
    ctx.globalAlpha = 0.2 + rand() * 0.3;
    ctx.lineWidth = Math.max(1, size * 0.035);
    ctx.beginPath();
    ctx.moveTo(wx - wlen, wy);
    ctx.quadraticCurveTo(wx, wy - size * 0.08, wx + wlen, wy);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  hexPath(ctx, cx, cy, size);
  ctx.strokeStyle = 'rgba(10,32,50,0.4)';
  ctx.lineWidth = Math.max(1, size * 0.03);
  ctx.stroke();

  waterCache.set(key, canvas);
  return canvas;
}

let tableCanvas: HTMLCanvasElement | null = null;
let tableKey = '';

/** Fondo: la mesa de madera sobre la que se apoya el tablero. */
export function tableTexture(width: number, height: number): HTMLCanvasElement {
  const key = `${Math.round(width)}x${Math.round(height)}`;
  if (tableCanvas && tableKey === key) return tableCanvas;

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext('2d')!;

  const g = ctx.createLinearGradient(0, 0, 0, height);
  g.addColorStop(0, TABLE.light);
  g.addColorStop(0.55, TABLE.base);
  g.addColorStop(1, TABLE.dark);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, height);

  // Veta: lineas largas y ligeramente onduladas.
  let seed = 99;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  ctx.strokeStyle = TABLE.grain;
  for (let i = 0; i < 90; i++) {
    const y = rnd() * height;
    ctx.globalAlpha = 0.08 + rnd() * 0.16;
    ctx.lineWidth = 0.6 + rnd() * 2.4;
    ctx.beginPath();
    ctx.moveTo(-20, y);
    for (let x = 0; x < width + 40; x += 60) {
      ctx.quadraticCurveTo(x + 30, y + (rnd() - 0.5) * 9, x + 60, y + (rnd() - 0.5) * 5);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Vineta: la luz cae sobre el centro de la mesa.
  const v = ctx.createRadialGradient(
    width / 2,
    height * 0.42,
    Math.min(width, height) * 0.12,
    width / 2,
    height * 0.5,
    Math.max(width, height) * 0.78,
  );
  v.addColorStop(0, 'rgba(255,226,180,0.16)');
  v.addColorStop(0.55, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,0.62)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, width, height);
  tableCanvas = canvas;
  tableKey = key;
  return canvas;
}
