import { shade, tint } from './theme.js';
import type { Point3 } from './camera.js';

/**
 * Dado tridimensional.
 *
 * No es una cara plana con un canto pintado al lado: se construye el cubo en
 * tres dimensiones, se gira, se proyecta en perspectiva y se pintan solo las
 * caras que miran a la camara, con sus puntos colocados SOBRE la cara. Los
 * puntos se proyectan con ella, asi que salen como elipses inclinadas y el
 * cubo se lee como un objeto y no como un icono.
 *
 * El valor va arriba, como en un dado de verdad reposando en la mesa, y las
 * caras laterales llevan valores coherentes: dos caras opuestas suman siete.
 *
 * Vive fuera de `art3d.ts` porque no pertenece al tablero: los dados son una
 * capa superpuesta en pixeles de pantalla, con su propia camara, para que no
 * cambien de tamano cuando se orbita la vista.
 */

/** Posicion de los puntos dentro de la cara, en coordenadas locales [-1, 1]. */
const PIPS: Record<number, [number, number][]> = {
  1: [[0, 0]],
  2: [
    [-1, -1],
    [1, 1],
  ],
  3: [
    [-1, -1],
    [0, 0],
    [1, 1],
  ],
  4: [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ],
  5: [
    [-1, -1],
    [1, -1],
    [0, 0],
    [-1, 1],
    [1, 1],
  ],
  6: [
    [-1, -1],
    [1, -1],
    [-1, 0],
    [1, 0],
    [-1, 1],
    [1, 1],
  ],
};

/**
 * Las seis caras del cubo unidad: normal saliente y los dos ejes que recorren
 * la cara. Con eso se coloca cualquier punto de cualquier cara sin casos
 * especiales.
 */
interface CubeFace {
  normal: Point3;
  u: Point3;
  v: Point3;
}

const CUBE_FACES: CubeFace[] = [
  { normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, // arriba
  { normal: [0, 0, -1], u: [1, 0, 0], v: [0, -1, 0] }, // abajo
  { normal: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] }, // derecha
  { normal: [-1, 0, 0], u: [0, -1, 0], v: [0, 0, 1] }, // izquierda
  { normal: [0, 1, 0], u: [-1, 0, 0], v: [0, 0, 1] }, // fondo
  { normal: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] }, // frente
];

/**
 * Reparte los valores por las caras a partir del que queda arriba.
 *
 * La unica regla que se respeta (y la unica que alguien nota) es que dos caras
 * opuestas suman siete. Cual de los dos pares restantes va a cada lado es
 * arbitrario: solo se ven la cara de arriba y como mucho dos laterales.
 */
function faceValues(top: number): number[] {
  const rest = [1, 2, 3].filter((v) => v !== top && 7 - v !== top);
  const first = rest[0] ?? 1;
  const second = rest[1] ?? 2;
  // [arriba, abajo, derecha, izquierda, fondo, frente]
  return [top, 7 - top, first, 7 - first, second, 7 - second];
}

/**
 * Rotacion Rx . Ry . Rz aplicada a un punto: PRIMERO el giro sobre el eje
 * vertical del dado y DESPUES la inclinacion hacia la camara.
 *
 * El orden importa. Al reves, el giro vertical se convierte en un giro dentro
 * del plano de la pantalla: el dado da vueltas como una moneda y solo enseña
 * dos caras, en vez de mostrar la de arriba y las dos de delante.
 */
function rotate(p: Point3, rx: number, ry: number, rz: number): Point3 {
  const cosX = Math.cos(rx);
  const sinX = Math.sin(rx);
  const cosY = Math.cos(ry);
  const sinY = Math.sin(ry);
  const cosZ = Math.cos(rz);
  const sinZ = Math.sin(rz);

  let x = p[0];
  let y = p[1];
  let z = p[2];

  let nx = x * cosZ - y * sinZ;
  let ny = x * sinZ + y * cosZ;
  x = nx;
  y = ny;

  nx = x * cosY + z * sinY;
  let nz = -x * sinY + z * cosY;
  x = nx;
  z = nz;

  ny = y * cosX - z * sinX;
  nz = y * sinX + z * cosX;
  return [x, ny, nz];
}

/** Inclinacion en reposo: apoyado en la mesa, visto desde delante y arriba. */
const REST_X = (-40 * Math.PI) / 180;
const REST_Z = (32 * Math.PI) / 180;

/** Distancia de la camara del dado, en semilados. Corta, para que el cubo se note. */
const CAM_DISTANCE = 5.4;

/** Foco del dado, en coordenadas de pantalla: arriba, a la izquierda y delante. */
const LIGHT: Point3 = [-0.42, 0.52, 0.75];

function litFace(base: string, k: number): string {
  return k >= 1 ? tint(base, Math.min(0.4, (k - 1) * 0.9)) : shade(base, Math.min(0.6, 1 - k));
}

/**
 * Dibuja un dado. `tumble` gira el cubo sobre sus tres ejes durante la tirada;
 * con [0, 0, 0] queda en la posicion de reposo.
 */
export function drawDie3D(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  value: number,
  tumble: [number, number, number] = [0, 0, 0],
): void {
  // La perspectiva ensancha el cubo respecto a su lado, y el trazo de las
  // aristas anade un poco mas. Se parte de un semilado mas corto para que el
  // parametro `size` siga siendo el ancho real que ocupa el dado en pantalla.
  const half = size * 0.38;
  const values = faceValues(Math.min(6, Math.max(1, Math.round(value))));

  const rx = REST_X + tumble[0];
  const ry = tumble[1];
  const rz = REST_Z + tumble[2];

  const project = (p: Point3): [number, number] => {
    const [x, y, z] = rotate(p, rx, ry, rz);
    const k = CAM_DISTANCE / (CAM_DISTANCE - z);
    return [cx + x * half * k, cy - y * half * k];
  };

  // Sombra sobre la mesa, desplazada segun la luz.
  ctx.save();
  ctx.translate(cx, cy);
  const shadow = ctx.createRadialGradient(size * 0.12, half * 0.98, 0, size * 0.12, half * 0.98, size);
  shadow.addColorStop(0, 'rgba(0,0,0,0.45)');
  shadow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = shadow;
  ctx.beginPath();
  ctx.ellipse(size * 0.12, half * 0.98, size * 0.82, size * 0.26, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Silueta: el casco convexo de los ocho vertices, engordado con un trazo de
  // union redonda. Es lo que le da al cubo las aristas matadas de un dado real
  // sin tener que modelarlas.
  const corners: [number, number][] = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) corners.push(project([sx, sy, sz]));
    }
  }
  const hull = convexHull(corners);
  ctx.save();
  ctx.beginPath();
  hull.forEach(([px, py], i) => (i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)));
  ctx.closePath();
  ctx.lineJoin = 'round';
  ctx.lineWidth = size * 0.1;
  ctx.strokeStyle = '#9d9182';
  ctx.stroke();
  ctx.fillStyle = '#9d9182';
  ctx.fill();
  ctx.restore();

  // Caras visibles, de la mas lejana a la mas cercana.
  const faces = CUBE_FACES.map((face, i) => {
    const n = rotate(face.normal, rx, ry, rz);
    return { face, n, value: values[i]!, depth: n[2] };
  })
    .filter((f) => f.depth > 0.06)
    .sort((a, b) => a.depth - b.depth);

  for (const { face, n, value: faceValue } of faces) {
    const light = 0.72 + 0.3 * Math.max(0, n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]);
    const color = litFace('#f8f3e7', light);
    const inset = 0.9;

    ctx.save();
    ctx.beginPath();
    (
      [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ] as [number, number][]
    ).forEach(([a, b], i) => {
      const [px, py] = project(onFace(face, a * inset, b * inset));
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.closePath();
    ctx.lineJoin = 'round';
    ctx.lineWidth = size * 0.085;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();

    // Puntos. Se proyectan con la cara, asi que se deforman con ella. En una
    // cara casi de perfil eso los reduce a rayas, que se leen como arañazos y
    // no como puntos: ahi se deja la cara lisa y basta con su tono para que el
    // cubo siga teniendo tres caras visibles.
    if (n[2] < 0.4) continue;
    const pipRadius = 0.2;
    const spread = 0.52;
    ctx.fillStyle = litFace('#2b241c', 0.7 + light * 0.3);
    for (const [ax, ay] of PIPS[faceValue] ?? []) {
      const center = onFace(face, ax * spread, ay * spread);
      const [pcx, pcy] = project(center);
      const [pux, puy] = project([
        center[0] + face.u[0] * pipRadius,
        center[1] + face.u[1] * pipRadius,
        center[2] + face.u[2] * pipRadius,
      ]);
      const [pvx, pvy] = project([
        center[0] + face.v[0] * pipRadius,
        center[1] + face.v[1] * pipRadius,
        center[2] + face.v[2] * pipRadius,
      ]);
      ctx.save();
      ctx.transform(pux - pcx, puy - pcy, pvx - pcx, pvy - pcy, pcx, pcy);
      ctx.beginPath();
      ctx.arc(0, 0, 1, 0, Math.PI * 2);
      ctx.restore();
      ctx.fill();
    }
  }
}

/** Punto de la cara en coordenadas locales, ya en el espacio del cubo. */
function onFace(face: CubeFace, a: number, b: number): Point3 {
  return [
    face.normal[0] + face.u[0] * a + face.v[0] * b,
    face.normal[1] + face.u[1] * a + face.v[1] * b,
    face.normal[2] + face.u[2] * a + face.v[2] * b,
  ];
}

/** Casco convexo por cadena monotona. */
function convexHull(points: [number, number][]): [number, number][] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}
