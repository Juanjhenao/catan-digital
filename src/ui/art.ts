import type { Terrain } from '../engine/index.js';
import { TERRAIN_PALETTE, TOKEN } from './theme.js';

/**
 * Ilustracion procedural.
 *
 * No hay ni un solo archivo de imagen en el proyecto: cada casilla se dibuja
 * con trazos de canvas. Las variaciones (donde cae cada arbol, cada oveja,
 * cada roca) salen de un generador sembrado con el identificador del hexagono,
 * asi que una misma casilla se ve siempre igual entre repintados, pero dos
 * casillas del mismo terreno nunca son identicas.
 */

/** PRNG diminuto para el detalle decorativo (no toca la logica del juego). */
function seededRandom(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hexPath(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 30);
    const px = x + size * Math.cos(angle);
    const py = y + size * Math.sin(angle);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

// ---------------------------------------------------------------------------
// Casillas
// ---------------------------------------------------------------------------

const tileCache = new Map<string, HTMLCanvasElement>();

/**
 * Devuelve (y memoiza) una casilla ya dibujada. Repintar el tablero entero es
 * entonces solo copiar 19-30 mapas de bits, que es lo que permite animar a 60
 * fotogramas sin esfuerzo.
 */
export function tileSprite(terrain: Terrain, size: number, seed: string): HTMLCanvasElement {
  const key = `${terrain}|${Math.round(size)}|${seed}`;
  const cached = tileCache.get(key);
  if (cached) return cached;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = document.createElement('canvas');
  const w = Math.ceil(size * Math.sqrt(3)) + 4;
  const h = Math.ceil(size * 2) + 4;
  canvas.width = Math.ceil(w * dpr);
  canvas.height = Math.ceil(h * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);

  const cx = w / 2;
  const cy = h / 2;
  drawTile(ctx, terrain, cx, cy, size, seed);

  tileCache.set(key, canvas);
  return canvas;
}

function drawTile(
  ctx: CanvasRenderingContext2D,
  terrain: Terrain,
  cx: number,
  cy: number,
  size: number,
  seed: string,
): void {
  const palette = TERRAIN_PALETTE[terrain];
  const rand = seededRandom(seed);

  ctx.save();
  hexPath(ctx, cx, cy, size);
  ctx.clip();

  // Fondo con degradado suave de arriba a abajo.
  const gradient = ctx.createLinearGradient(cx, cy - size, cx, cy + size);
  gradient.addColorStop(0, palette.base);
  gradient.addColorStop(1, palette.shade);
  ctx.fillStyle = gradient;
  ctx.fillRect(cx - size, cy - size, size * 2, size * 2);

  // Grano de textura: puntos tenues repartidos por toda la casilla.
  ctx.globalAlpha = 0.06;
  ctx.fillStyle = '#000';
  for (let i = 0; i < 90; i++) {
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * size * 0.95;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, rand() * 1.6 + 0.3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  drawGround(ctx, terrain, cx, cy, size, rand);

  ctx.restore();

  // Bisel: luz arriba, sombra abajo.
  ctx.save();
  hexPath(ctx, cx, cy, size);
  ctx.clip();
  const bevel = ctx.createLinearGradient(cx, cy - size, cx, cy + size);
  bevel.addColorStop(0, 'rgba(255,255,255,0.16)');
  bevel.addColorStop(0.4, 'rgba(255,255,255,0)');
  bevel.addColorStop(1, 'rgba(0,0,0,0.22)');
  ctx.fillStyle = bevel;
  ctx.fillRect(cx - size, cy - size, size * 2, size * 2);
  ctx.restore();

  hexPath(ctx, cx, cy, size);
  ctx.strokeStyle = 'rgba(24,18,10,0.45)';
  ctx.lineWidth = Math.max(1.5, size * 0.035);
  ctx.stroke();
}

/**
 * El SUELO de una casilla.
 *
 * Aqui no hay ni un objeto: ni arboles, ni ovejas, ni ladrillos. Eso se levanta
 * aparte, en `props.ts`, con volumen de verdad.
 *
 * La separacion es la leccion que costo aprender. Antes esta funcion pintaba
 * arbolitos y ovejitas planas sobre la loseta, y como la loseta se ve en
 * perspectiva, los objetos pintados salian TUMBADOS: pegatinas aplastadas
 * contra el suelo, con arboles de verdad de pie justo encima. Dos escalas y dos
 * perspectivas peleando en el mismo sitio.
 *
 * Asi que el suelo es solo suelo -- tierra, hierba, surcos, roca, arena -- y lo
 * que se levanta se levanta. El terreno se reconoce por lo que tiene encima; el
 * suelo pone la textura y el color.
 */
function drawGround(
  ctx: CanvasRenderingContext2D,
  terrain: Terrain,
  cx: number,
  cy: number,
  size: number,
  rand: () => number,
): void {
  switch (terrain) {
    case 'forest':
      groundForest(ctx, cx, cy, size, rand);
      break;
    case 'hills':
      groundHills(ctx, cx, cy, size, rand);
      break;
    case 'pasture':
      groundPasture(ctx, cx, cy, size, rand);
      break;
    case 'fields':
      groundFields(ctx, cx, cy, size, rand);
      break;
    case 'mountains':
      groundMountains(ctx, cx, cy, size, rand);
      break;
    case 'desert':
      groundDesert(ctx, cx, cy, size, rand);
      break;
  }
}

/** Semilla reutilizable para el detalle ilustrado fuera del tablero. */
export function motifRandom(seed: string): () => number {
  return seededRandom(seed);
}

/**
 * Reparte n puntos dentro del hexagono.
 *
 * A diferencia de los objetos, la textura del suelo SI pasa por debajo de la
 * ficha numerica: es suelo, y que se interrumpiera justo donde va el numero
 * dibujaria un halo alrededor de la ficha.
 */
function scatter(count: number, size: number, rand: () => number): [number, number][] {
  const points: [number, number][] = [];
  let guard = 0;
  while (points.length < count && guard++ < count * 40) {
    const x = (rand() * 2 - 1) * size * 0.82;
    const y = (rand() * 2 - 1) * size * 0.82;
    // Dentro del hexagono, aproximado por sus dos pares de lados.
    if (Math.abs(y) > size * 0.88) continue;
    if (Math.abs(x) * 0.577 + Math.abs(y) * 0.5 > size * 0.84) continue;
    points.push([x, y]);
  }
  return points;
}

/** Manchas irregulares de suelo: el mismo terreno, un poco mas claro o mas oscuro. */
function patches(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  rand: () => number,
  count: number,
  color: string,
  alpha: number,
): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  for (const [dx, dy] of scatter(count, size, rand)) {
    const r = size * (0.16 + rand() * 0.2);
    ctx.save();
    ctx.translate(cx + dx, cy + dy);
    ctx.rotate(rand() * Math.PI);
    ctx.beginPath();
    // Contorno irregular: un ovalo perfecto se reconoce como ovalo y delata que
    // esto esta dibujado, no gastado.
    for (let i = 0; i <= 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const k = 0.78 + ((i * 37) % 11) / 24;
      const px = Math.cos(a) * r * k;
      const py = Math.sin(a) * r * 0.62 * k;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

/** Guijarros: piedrecillas angulosas repartidas por el suelo. */
function pebbles(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  rand: () => number,
  count: number,
  color: string,
  scale = 1,
): void {
  ctx.fillStyle = color;
  for (const [dx, dy] of scatter(count, size, rand)) {
    const r = size * (0.012 + rand() * 0.016) * scale;
    ctx.save();
    ctx.translate(cx + dx, cy + dy);
    ctx.rotate(rand() * Math.PI);
    ctx.beginPath();
    ctx.moveTo(-r, 0);
    ctx.lineTo(-r * 0.3, -r * 0.8);
    ctx.lineTo(r, -r * 0.2);
    ctx.lineTo(r * 0.4, r * 0.7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

/** Suelo de bosque: mantillo, claros de tierra y hojarasca. */
function groundForest(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  rand: () => number,
): void {
  const p = TERRAIN_PALETTE.forest;
  patches(ctx, cx, cy, size, rand, 6, p.detailDark, 0.44);
  patches(ctx, cx, cy, size, rand, 5, '#6b5334', 0.32);

  // Agujas y hojas caidas: trazos cortos en todas direcciones.
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(1, size * 0.012);
  for (const [dx, dy] of scatter(26, size, rand)) {
    const a = rand() * Math.PI * 2;
    const len = size * (0.035 + rand() * 0.04);
    ctx.strokeStyle = rand() < 0.5 ? p.detailDark : '#7a6038';
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.moveTo(cx + dx, cy + dy);
    ctx.lineTo(cx + dx + Math.cos(a) * len, cy + dy + Math.sin(a) * len);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/** Suelo de colinas: arcilla en estratos, agrietada, con guijarros. */
function groundHills(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  rand: () => number,
): void {
  const p = TERRAIN_PALETTE.hills;

  // Estratos: bandas de arcilla que cruzan la casilla de lado a lado.
  for (let i = 0; i < 5; i++) {
    const y = cy + size * (-0.72 + i * 0.34 + rand() * 0.08);
    const h = size * (0.08 + rand() * 0.1);
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = i % 2 === 0 ? p.detailDark : '#c4784a';
    ctx.beginPath();
    ctx.moveTo(cx - size, y);
    ctx.quadraticCurveTo(cx, y - size * 0.14, cx + size, y);
    ctx.lineTo(cx + size, y + h);
    ctx.quadraticCurveTo(cx, y - size * 0.14 + h, cx - size, y + h);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Grietas de barro seco.
  ctx.strokeStyle = p.detailDark;
  ctx.globalAlpha = 0.34;
  ctx.lineWidth = Math.max(1, size * 0.014);
  for (const [dx, dy] of scatter(5, size, rand)) {
    ctx.beginPath();
    let x = cx + dx;
    let y = cy + dy;
    ctx.moveTo(x, y);
    for (let i = 0; i < 3; i++) {
      x += (rand() - 0.5) * size * 0.3;
      y += (rand() - 0.5) * size * 0.24;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  pebbles(ctx, cx, cy, size, rand, 10, p.detailDark);
}

/** Suelo de pasto: hierba segada en franjas, con matas y alguna flor. */
function groundPasture(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  rand: () => number,
): void {
  const p = TERRAIN_PALETTE.pasture;

  // Franjas de siega, muy suaves: dan direccion al prado sin dibujar nada.
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = p.detail;
  for (let i = -3; i <= 3; i++) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-0.32);
    ctx.fillRect(-size, i * size * 0.3, size * 2, size * 0.15);
    ctx.restore();
  }
  ctx.globalAlpha = 1;

  patches(ctx, cx, cy, size, rand, 4, p.detailDark, 0.16);

  // Matas: tres briznas que salen del mismo punto.
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(1, size * 0.013);
  for (const [dx, dy] of scatter(20, size, rand)) {
    const x = cx + dx;
    const y = cy + dy;
    const h = size * (0.05 + rand() * 0.04);
    ctx.strokeStyle = rand() < 0.5 ? p.detailDark : '#a8d47a';
    ctx.globalAlpha = 0.6;
    for (const lean of [-0.5, 0, 0.5]) {
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(x + lean * h * 0.5, y - h * 0.6, x + lean * h, y - h);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;

  // Cuatro florecillas: el unico color ajeno que se permite, y se agradece.
  for (const [dx, dy] of scatter(4, size, rand)) {
    ctx.fillStyle = rand() < 0.5 ? '#f5f0dc' : '#f2d873';
    ctx.beginPath();
    ctx.arc(cx + dx, cy + dy, size * 0.014, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Suelo de campo: surcos arados en curva, con rastrojo entre ellos. */
function groundFields(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  rand: () => number,
): void {
  const p = TERRAIN_PALETTE.fields;

  // Surcos: la firma del campo labrado. Curvos, porque el arado no va recto.
  ctx.lineCap = 'round';
  for (let i = -6; i <= 6; i++) {
    const y = cy + i * size * 0.145;
    ctx.strokeStyle = i % 2 === 0 ? p.detailDark : p.detail;
    ctx.globalAlpha = i % 2 === 0 ? 0.34 : 0.24;
    ctx.lineWidth = Math.max(1, size * (i % 2 === 0 ? 0.028 : 0.016));
    ctx.beginPath();
    ctx.moveTo(cx - size * 0.95, y);
    ctx.quadraticCurveTo(cx, y - size * 0.1, cx + size * 0.95, y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Rastrojo: lo que queda en pie despues de segar.
  ctx.lineWidth = Math.max(1, size * 0.012);
  ctx.strokeStyle = '#f0dda2';
  ctx.globalAlpha = 0.5;
  for (const [dx, dy] of scatter(24, size, rand)) {
    const h = size * (0.03 + rand() * 0.03);
    ctx.beginPath();
    ctx.moveTo(cx + dx, cy + dy);
    ctx.lineTo(cx + dx + (rand() - 0.5) * h * 0.6, cy + dy - h);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/** Suelo de montana: roca viva, con vetas y cascajo. */
function groundMountains(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  rand: () => number,
): void {
  const p = TERRAIN_PALETTE.mountains;
  patches(ctx, cx, cy, size, rand, 5, p.detailDark, 0.34);
  patches(ctx, cx, cy, size, rand, 4, '#aab4c2', 0.22);

  // Vetas: fracturas largas y casi paralelas, que es como se parte la roca.
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(1, size * 0.016);
  for (const [dx, dy] of scatter(9, size, rand)) {
    const a = -0.6 + (rand() - 0.5) * 0.5;
    const len = size * (0.18 + rand() * 0.3);
    ctx.strokeStyle = rand() < 0.6 ? p.detailDark : '#c2ccd8';
    ctx.globalAlpha = 0.4;
    ctx.beginPath();
    ctx.moveTo(cx + dx - Math.cos(a) * len, cy + dy - Math.sin(a) * len);
    ctx.lineTo(cx + dx + Math.cos(a) * len, cy + dy + Math.sin(a) * len);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  pebbles(ctx, cx, cy, size, rand, 14, p.detailDark, 1.3);
}

/** Suelo de desierto: arena con rizos de viento y alguna piedra. */
function groundDesert(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  rand: () => number,
): void {
  const p = TERRAIN_PALETTE.desert;
  patches(ctx, cx, cy, size, rand, 5, p.detail, 0.28);

  // Rizos del viento: arcos largos y paralelos, que es como se ordena la arena.
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(1, size * 0.015);
  for (let i = -5; i <= 5; i++) {
    const y = cy + i * size * 0.17 + (rand() - 0.5) * size * 0.05;
    ctx.strokeStyle = i % 2 === 0 ? p.detailDark : '#f2e3b6';
    ctx.globalAlpha = 0.26;
    ctx.beginPath();
    ctx.moveTo(cx - size * 0.9, y);
    ctx.quadraticCurveTo(cx + size * 0.2, y - size * 0.16, cx + size * 0.9, y + size * 0.04);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  pebbles(ctx, cx, cy, size, rand, 8, p.detailDark);
}

// ---------------------------------------------------------------------------
// Ficha numerica
// ---------------------------------------------------------------------------

export function drawNumberToken(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  value: number,
  blocked: boolean,
): void {
  const hot = value === 6 || value === 8;

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = radius * 0.5;
  ctx.shadowOffsetY = radius * 0.14;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = TOKEN.face;
  ctx.fill();
  ctx.restore();

  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.strokeStyle = TOKEN.edge;
  ctx.lineWidth = radius * 0.12;
  ctx.stroke();

  ctx.fillStyle = hot ? TOKEN.red : TOKEN.ink;
  ctx.font = `700 ${radius * 1.15}px "Georgia", serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(value), x, y - radius * 0.12);

  // Puntos de probabilidad: cuantos mas, mas facil sale el numero.
  const pips = 6 - Math.abs(7 - value);
  const pipRadius = radius * 0.075;
  const gap = pipRadius * 3;
  const startX = x - (gap * (pips - 1)) / 2;
  ctx.fillStyle = hot ? TOKEN.red : TOKEN.ink;
  for (let i = 0; i < pips; i++) {
    ctx.beginPath();
    ctx.arc(startX + i * gap, y + radius * 0.55, pipRadius, 0, Math.PI * 2);
    ctx.fill();
  }

  if (blocked) {
    // Basta con apagar la ficha para que se note que no produce; oscurecerla
    // del todo esconderia el numero.
    ctx.globalAlpha = 0.38;
    ctx.fillStyle = '#12100d';
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

// ---------------------------------------------------------------------------
// Utilidad
// ---------------------------------------------------------------------------

export function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}
