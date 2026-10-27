import type { Resource } from '../engine/index.js';

/**
 * Los cinco materiales, dibujados como objetos.
 *
 * Esto es distinto del terreno, y la diferencia es justo lo que fallaba antes:
 * una casilla de montanas es un PAISAJE, pero lo que se coge con la mano es una
 * piedra. Dibujar la montana en la carta obligaba a traducir mentalmente
 * «montana -> mineral» cada vez, y ademas un paisaje entero encogido a 58x78
 * pixeles no es nada: es una mancha de color.
 *
 * Asi que aqui cada recurso es UN objeto:
 *
 *   madera  -> troncos cortados, con sus anillos
 *   arcilla -> ladrillos apilados
 *   lana    -> una oveja
 *   trigo   -> una gavilla atada
 *   mineral -> rocas con vetas de cristal
 *
 * Tres reglas hacen que se lean a tamano de mano, que es donde se juega:
 *
 * 1. **Una silueta grande y centrada**, ocupando casi toda la carta. Nada de
 *    elementos repartidos: al encoger se convierten en ruido.
 * 2. **Contorno oscuro en todo.** Es lo que separa el objeto del fondo cuando
 *    ya no quedan pixeles para el degradado.
 * 3. **Nada de azar.** El terreno varia de casilla a casilla a proposito; un
 *    icono, no: dos cartas de trigo tienen que ser la misma carta de trigo.
 */

/** Fondo de la carta, de arriba abajo. */
export interface Backdrop {
  from: string;
  to: string;
}

/**
 * Fondos por material.
 *
 * Se mantienen los colores con los que ya se asocia cada recurso (verde el
 * bosque, terracota la arcilla...) porque es lo que permite contar una mano de
 * un vistazo sin leer nada, pero apagados: el objeto de delante es el que tiene
 * que brillar.
 */
export const MATERIAL_BACKDROP: Record<Resource, Backdrop> = {
  lumber: { from: '#3d7d52', to: '#1c4a30' },
  brick: { from: '#c07043', to: '#7e3b19' },
  wool: { from: '#86c25f', to: '#437f33' },
  grain: { from: '#efc451', to: '#b8801f' },
  ore: { from: '#93a0b4', to: '#4e5a6e' },
};

/** Tinta del contorno de cada material: su propio tono, muy oscurecido. */
const INK: Record<Resource, string> = {
  lumber: '#33200f',
  brick: '#4a1c08',
  wool: '#2d2820',
  grain: '#573806',
  ore: '#232a35',
};

// ---------------------------------------------------------------------------
// Utilidades de trazo
// ---------------------------------------------------------------------------

type Pt = [number, number];

/**
 * Estado del dibujo en curso.
 *
 * Todas las figuras se describen en un cuadrado de -1 a 1 y se escalan aqui, de
 * modo que las coordenadas de cada objeto se leen como proporciones y no como
 * pixeles: cambiar el tamano de una carta no obliga a retocar ni un numero.
 */
interface Pen {
  ctx: CanvasRenderingContext2D;
  cx: number;
  cy: number;
  s: number;
  /** Grosor del contorno, ya en pixeles. */
  lw: number;
  ink: string;
}

function path(pen: Pen, pts: Pt[]): void {
  const { ctx, cx, cy, s } = pen;
  ctx.beginPath();
  pts.forEach(([x, y], i) => {
    const px = cx + x * s;
    const py = cy + y * s;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.closePath();
}

/** Poligono relleno y perfilado. `outline: false` lo deja sin contorno. */
function shape(pen: Pen, pts: Pt[], fill: string, outline = true): void {
  path(pen, pts);
  pen.ctx.fillStyle = fill;
  pen.ctx.fill();
  if (outline) stroke(pen);
}

function stroke(pen: Pen, width = pen.lw, color = pen.ink): void {
  pen.ctx.strokeStyle = color;
  pen.ctx.lineWidth = width;
  pen.ctx.lineJoin = 'round';
  pen.ctx.lineCap = 'round';
  pen.ctx.stroke();
}

/** Elipse (o circulo) en coordenadas normalizadas. */
function ellipsePath(pen: Pen, x: number, y: number, rx: number, ry: number, rot = 0): void {
  const { ctx, cx, cy, s } = pen;
  ctx.beginPath();
  ctx.ellipse(cx + x * s, cy + y * s, rx * s, ry * s, rot, 0, Math.PI * 2);
}

function blob(
  pen: Pen,
  x: number,
  y: number,
  rx: number,
  ry: number,
  fill: string,
  rot = 0,
  outline = true,
): void {
  ellipsePath(pen, x, y, rx, ry, rot);
  pen.ctx.fillStyle = fill;
  pen.ctx.fill();
  if (outline) stroke(pen);
}

/** Sombra de contacto: asienta el objeto en vez de dejarlo flotando. */
function contactShadow(pen: Pen, y: number, rx: number): void {
  const { ctx, cx, cy, s } = pen;
  const gx = cx;
  const gy = cy + y * s;
  const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, rx * s);
  g.addColorStop(0, 'rgba(0,0,0,0.4)');
  g.addColorStop(0.6, 'rgba(0,0,0,0.16)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.save();
  ctx.translate(gx, gy);
  ctx.scale(1, 0.32);
  ctx.beginPath();
  ctx.arc(0, 0, rx * s, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Madera: troncos cortados
// ---------------------------------------------------------------------------

/**
 * Tres troncos apilados en piramide, vistos por el corte.
 *
 * El corte es lo que dice «madera cortada» y no «arbol»: los anillos se
 * reconocen incluso reducidos a doce pixeles, que es mas de lo que se puede
 * decir de la copa de un pino.
 */
function drawLumber(pen: Pen): void {
  const bark = '#7c4a24';
  const barkBack = '#553015';
  const cut = '#e3bd83';
  const ring = '#b78a52';
  const r = 0.29;
  // Los troncos se alejan hacia arriba y a la izquierda; asi el corte queda de
  // frente y el cuerpo cuenta que son cilindros y no monedas. Corto a
  // proposito: lo que hay que reconocer son los anillos, no la longitud.
  const ax = -0.24;
  const ay = -0.15;
  // Perpendicular al eje, a la distancia del radio: son los dos puntos por
  // donde el costado toca el circulo. Con las tangentes verticales de siempre
  // el costado salia en punta y el tronco parecia una cuna.
  const len = Math.hypot(ax, ay);
  const px = (-ay / len) * r;
  const py = (ax / len) * r;

  // De atras hacia delante: el de arriba se apoya sobre los dos de abajo.
  const logs: Pt[] = [
    [0, -0.2],
    [-0.31, 0.28],
    [0.31, 0.28],
  ];

  for (const [x, y] of logs) {
    const bx = x + ax;
    const by = y + ay;
    // Tapa del fondo: redondea el extremo lejano.
    blob(pen, bx, by, r, r, barkBack);
    // Costado.
    shape(
      pen,
      [
        [x + px, y + py],
        [bx + px, by + py],
        [bx - px, by - py],
        [x - px, y - py],
      ],
      barkBack,
    );
    // Corteza del canto.
    blob(pen, x, y, r, r, bark);
    // Corte, con sus anillos.
    blob(pen, x, y, r * 0.74, r * 0.74, cut);
    for (const k of [0.5, 0.31, 0.13]) {
      ellipsePath(pen, x - r * 0.05, y - r * 0.04, r * k, r * k);
      stroke(pen, pen.lw * 0.5, ring);
    }
  }
}

// ---------------------------------------------------------------------------
// Arcilla: ladrillos
// ---------------------------------------------------------------------------

/**
 * Tres ladrillos apilados, en isometrica ligera.
 *
 * La cara de arriba mas clara es lo que los convierte en objetos y no en
 * rectangulos: sin ella la pila se lee como una pared plana.
 */
function drawBrick(pen: Pen): void {
  const front = '#c25a2c';
  const top = '#e5834b';
  const side = '#8f3a15';
  const w = 0.68;
  const h = 0.26;
  const dx = 0.2;
  const dy = -0.13;

  // El de abajo primero: cada ladrillo tapa la cara superior del anterior, que
  // es exactamente lo que pasa al apilarlos de verdad.
  const stack: Pt[] = [
    [0.02, 0.44],
    [-0.1, 0.14],
    [0.06, -0.16],
  ];

  for (const [x, y] of stack) {
    const l = x - w / 2;
    const rgt = x + w / 2;
    const t = y - h / 2;
    const b = y + h / 2;
    // Cara frontal.
    shape(
      pen,
      [
        [l, t],
        [rgt, t],
        [rgt, b],
        [l, b],
      ],
      front,
    );
    // Cara superior.
    shape(
      pen,
      [
        [l, t],
        [l + dx, t + dy],
        [rgt + dx, t + dy],
        [rgt, t],
      ],
      top,
    );
    // Canto derecho.
    shape(
      pen,
      [
        [rgt, t],
        [rgt + dx, t + dy],
        [rgt + dx, b + dy],
        [rgt, b],
      ],
      side,
    );
    // Dos motas de barro: quitan la sensacion de plastico.
    blob(pen, x - w * 0.22, y, h * 0.1, h * 0.1, side, 0, false);
    blob(pen, x + w * 0.16, y + h * 0.16, h * 0.07, h * 0.07, side, 0, false);
  }
}

// ---------------------------------------------------------------------------
// Lana: una oveja
// ---------------------------------------------------------------------------

/**
 * Una oveja de frente y tres cuartos.
 *
 * El vellon se monta con circulos solapados: primero todos en el color del
 * contorno y algo mas grandes, luego todos en crema encima. Sale una silueta
 * unica y mullida sin que se vean las costuras entre circulo y circulo, que es
 * lo que pasaria perfilandolos de uno en uno.
 */
function drawWool(pen: Pen): void {
  const fleece = '#f8f4e8';
  const fleeceShade = '#ddd6c2';
  const dark = '#3b352d';
  const puffs: [number, number, number][] = [
    [-0.18, 0.02, 0.3],
    [0.12, -0.06, 0.28],
    [0.3, 0.12, 0.24],
    [-0.02, 0.2, 0.28],
    [-0.34, 0.2, 0.22],
    [-0.06, -0.16, 0.24],
  ];

  // Patas, antes que el cuerpo para que queden por debajo.
  for (const x of [-0.24, 0.02, 0.24]) {
    shape(
      pen,
      [
        [x - 0.055, 0.24],
        [x + 0.055, 0.24],
        [x + 0.045, 0.62],
        [x - 0.045, 0.62],
      ],
      dark,
    );
  }

  // Contorno del vellon: los mismos circulos, mas gordos y en tinta.
  for (const [x, y, r] of puffs) {
    ellipsePath(pen, x, y, r, r);
    pen.ctx.fillStyle = pen.ink;
    pen.ctx.fill();
    stroke(pen, pen.lw * 2);
  }
  // Relleno, encima.
  for (const [x, y, r] of puffs) blob(pen, x, y, r, r, fleece, 0, false);
  // Una sombra suave por abajo para que el vellon tenga volumen.
  for (const [x, y, r] of puffs) {
    if (y < 0.1) continue;
    blob(pen, x, y + r * 0.3, r * 0.72, r * 0.5, fleeceShade, 0, false);
  }

  // Cabeza.
  blob(pen, 0.4, -0.16, 0.19, 0.23, dark, -0.25);
  // Orejas.
  blob(pen, 0.26, -0.3, 0.1, 0.055, dark, -0.7);
  blob(pen, 0.54, -0.32, 0.09, 0.05, dark, 0.5);
  // Copete: un rizo de lana entre las orejas.
  blob(pen, 0.36, -0.34, 0.13, 0.1, fleece);
  // Ojo.
  blob(pen, 0.46, -0.15, 0.045, 0.045, '#fdfbf4', 0, false);
  blob(pen, 0.47, -0.14, 0.022, 0.022, dark, 0, false);
}

// ---------------------------------------------------------------------------
// Trigo: una gavilla
// ---------------------------------------------------------------------------

/**
 * Gavilla de tres espigas, atada por el centro.
 *
 * Lo que se veia feo antes eran briznas sueltas repartidas por la carta: al
 * encoger no quedaba mas que una lluvia de puntos. Una gavilla es UNA figura,
 * simetrica y alta, y el lazo del centro le da un punto donde descansar la
 * vista.
 */
function drawGrain(pen: Pen): void {
  const { ctx, cx, cy, s } = pen;
  const stem = '#c9992c';
  const grain = '#f6cb51';
  const grainLight = '#ffe697';
  const rope = '#8d5712';

  /** Una espiga: tallo curvo y granos por parejas de abajo a arriba. */
  const spike = (lean: number, baseX: number, top: number, scale: number): void => {
    const bottom = 0.72;
    const tipX = baseX + lean;
    ctx.beginPath();
    ctx.moveTo(cx + baseX * s, cy + bottom * s);
    ctx.quadraticCurveTo(
      cx + (baseX + lean * 0.35) * s,
      cy + (bottom + top) * 0.5 * s,
      cx + tipX * s,
      cy + top * s,
    );
    stroke(pen, pen.lw * 1.9, stem);

    // Cinco parejas de grano, gordas. Con mas y mas finas la espiga se
    // convertia en un cepillo: a tamano de mano no se separan unas de otras.
    const pairs = 5;
    for (let i = 0; i < pairs; i++) {
      const t = i / (pairs - 1);
      const gy = top + (0.3 - top) * t;
      const gx = tipX + (baseX + lean * 0.35 - tipX) * t;
      const size = (0.15 - t * 0.03) * scale;
      for (const side of [-1, 1]) {
        blob(
          pen,
          gx + side * size * 0.66,
          gy,
          size * 0.6,
          size,
          side < 0 ? grain : grainLight,
          side * 0.4 + lean * 0.5,
        );
      }
    }
    // Arista: el pelo fino de la punta.
    ctx.beginPath();
    ctx.moveTo(cx + tipX * s, cy + top * s);
    ctx.lineTo(cx + (tipX + lean * 0.32) * s, cy + (top - 0.2) * s);
    stroke(pen, pen.lw * 0.85, stem);
  };

  // Bien separadas: apinadas se fundian en una sola mata.
  spike(-0.42, -0.16, -0.24, 0.9);
  spike(0.42, 0.16, -0.24, 0.9);
  spike(0, 0, -0.5, 1);

  // El lazo, lo ultimo: cruza por delante de los tres tallos y es lo que hace
  // que sean una gavilla y no tres espigas sueltas. Antes iban ademas dos hojas
  // en la base, pero formaban una V que se leia como un cesto.
  shape(
    pen,
    [
      [-0.21, 0.36],
      [0.21, 0.36],
      [0.17, 0.52],
      [-0.17, 0.52],
    ],
    rope,
  );
  // Dos vueltas de cuerda marcadas encima.
  for (const y of [0.41, 0.47]) {
    ctx.beginPath();
    ctx.moveTo(cx - 0.16 * s, cy + y * s);
    ctx.lineTo(cx + 0.16 * s, cy + y * s);
    stroke(pen, pen.lw * 0.55, '#c9902e');
  }
}

// ---------------------------------------------------------------------------
// Mineral: rocas con veta
// ---------------------------------------------------------------------------

/**
 * Un pedrusco con dos esquirlas y vetas de cristal.
 *
 * NO es una montana. La montana es la casilla de donde sale; lo que se lleva
 * uno a la mano es piedra suelta, y confundir las dos cosas obligaba a traducir
 * el paisaje al material cada vez que se miraba la carta.
 */
function drawOre(pen: Pen): void {
  const face = '#9aa6b8';
  const light = '#c6d0de';
  const dark = '#5d6a7e';
  const darker = '#48546a';
  const vein = '#eaf6ff';

  // Esquirla izquierda, detras.
  shape(
    pen,
    [
      [-0.78, 0.22],
      [-0.54, 0.02],
      [-0.26, 0.22],
      [-0.36, 0.54],
      [-0.7, 0.5],
    ],
    darker,
  );
  // Esquirla derecha, detras.
  shape(
    pen,
    [
      [0.3, 0.2],
      [0.62, 0.1],
      [0.78, 0.38],
      [0.52, 0.58],
      [0.28, 0.48],
    ],
    darker,
  );

  // El pedrusco grande. Las caras se cortan fuera del centro a proposito: con
  // la faceta clara justo en el eje, la piedra se leia como un dado.
  const rock: Pt[] = [
    [-0.5, 0.02],
    [-0.3, -0.44],
    [0.16, -0.52],
    [0.5, -0.2],
    [0.46, 0.28],
    [0.0, 0.5],
    [-0.42, 0.34],
  ];
  shape(pen, rock, face);
  // Faceta superior iluminada.
  shape(
    pen,
    [
      [-0.5, 0.02],
      [-0.3, -0.44],
      [0.16, -0.52],
      [-0.12, 0.06],
    ],
    light,
  );
  // Faceta derecha en sombra.
  shape(
    pen,
    [
      [-0.12, 0.06],
      [0.16, -0.52],
      [0.5, -0.2],
      [0.46, 0.28],
      [0.06, 0.42],
    ],
    dark,
  );

  // Vetas de cristal: lo que dice «esto vale algo». Dos, descolocadas.
  for (const [x, y, r, rot] of [
    [-0.22, -0.14, 0.15, -0.3],
    [0.22, -0.04, 0.11, 0.35],
  ] as [number, number, number, number][]) {
    const c = Math.cos(rot);
    const sn = Math.sin(rot);
    const at = (dx: number, dy: number): Pt => [x + dx * c - dy * sn, y + dx * sn + dy * c];
    shape(pen, [at(0, -r), at(r * 0.58, 0), at(0, r), at(-r * 0.58, 0)], vein);
  }
}

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

const DRAW: Record<Resource, (pen: Pen) => void> = {
  lumber: drawLumber,
  brick: drawBrick,
  wool: drawWool,
  grain: drawGrain,
  ore: drawOre,
};

/**
 * Dibuja el material centrado en (cx, cy). `size` es el semilado: la figura
 * ocupa aproximadamente el cuadrado de lado `2 * size`.
 */
export function drawMaterial(
  ctx: CanvasRenderingContext2D,
  resource: Resource,
  cx: number,
  cy: number,
  size: number,
): void {
  const pen: Pen = {
    ctx,
    cx,
    cy,
    s: size,
    // El contorno crece con la figura pero nunca baja de un pixel: por debajo
    // de eso el navegador lo difumina y el objeto pierde el filo justo cuando
    // mas falta le hace, que es a tamano de mano.
    lw: Math.max(1, size * 0.062),
    ink: INK[resource],
  };
  ctx.save();
  contactShadow(pen, 0.74, 0.72);
  DRAW[resource](pen);
  ctx.restore();
}
