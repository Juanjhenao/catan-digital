import type { DevCardKind, Resource } from '../engine/index.js';
import { roundRect } from './art.js';
import { el } from './dom.js';
import { icon, type IconName } from './icons.js';
import { drawMaterial, MATERIAL_BACKDROP } from './materials.js';
import { RESOURCE_LABEL, shade, tint } from './theme.js';

/**
 * Cartas de recurso.
 *
 * Son la unidad visual de todo lo que se toca con la mano: la barra inferior,
 * las ventanas de comercio, el descarte y los selectores de las cartas de
 * desarrollo.
 *
 * La ilustracion es el MATERIAL (`materials.ts`), no la casilla de donde sale:
 * troncos y no un bosque, una piedra y no una montana. La carta se mira a 58x78
 * pixeles en la barra de la mano, y a ese tamano un paisaje entero no es mas
 * que una mancha del color del terreno.
 */

const artCache = new Map<string, HTMLCanvasElement>();

/**
 * Lamina de la carta, ya dibujada y memoizada. Se pinta con el doble de
 * resolucion en pantallas densas, como el resto del arte.
 */
export function resourceArt(resource: Resource, width: number, height: number): HTMLCanvasElement {
  const key = `${resource}|${Math.round(width)}x${Math.round(height)}`;
  const cached = artCache.get(key);
  if (cached) return cached;

  const dpr = Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 2);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);

  const backdrop = MATERIAL_BACKDROP[resource];
  const radius = Math.min(width, height) * 0.16;

  ctx.save();
  roundRect(ctx, 0, 0, width, height, radius);
  ctx.clip();

  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, backdrop.from);
  gradient.addColorStop(1, backdrop.to);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  // Foco detras del objeto: lo despega del fondo sin necesidad de aclarar el
  // fondo entero, que le quitaria el color con el que se reconoce el recurso.
  const halo = ctx.createRadialGradient(
    width / 2,
    height * 0.46,
    0,
    width / 2,
    height * 0.46,
    Math.max(width, height) * 0.6,
  );
  halo.addColorStop(0, 'rgba(255,252,240,0.32)');
  halo.addColorStop(1, 'rgba(255,252,240,0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, width, height);

  // El objeto, centrado y grande: es lo unico que hay que reconocer.
  drawMaterial(ctx, resource, width / 2, height * 0.47, Math.min(width, height) * 0.4);

  // Vineta: cierra los bordes y evita que el dibujo parezca recortado.
  const vignette = ctx.createRadialGradient(
    width / 2,
    height / 2,
    Math.min(width, height) * 0.34,
    width / 2,
    height / 2,
    Math.max(width, height) * 0.78,
  );
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.34)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);

  // Brillo superior: da el aspecto de carta plastificada.
  const gloss = ctx.createLinearGradient(0, 0, 0, height * 0.55);
  gloss.addColorStop(0, 'rgba(255,255,255,0.28)');
  gloss.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gloss;
  ctx.fillRect(0, 0, width, height * 0.55);
  ctx.restore();

  // Doble filo: uno claro por dentro y otro oscuro por fuera, para que la carta
  // se recorte igual de bien sobre pergamino que sobre madera.
  roundRect(ctx, 1, 1, width - 2, height - 2, radius - 1);
  ctx.strokeStyle = 'rgba(255,252,244,0.55)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  roundRect(ctx, 0.5, 0.5, width - 1, height - 1, radius);
  ctx.strokeStyle = shade(backdrop.to, 0.45);
  ctx.lineWidth = 1.5;
  ctx.stroke();

  artCache.set(key, canvas);
  return canvas;
}

/** Medidas de cada tamano de carta, en pixeles CSS. */
const SIZES = {
  sm: [34, 46],
  md: [46, 62],
  lg: [58, 78],
} as const;

export type CardSize = keyof typeof SIZES;

export interface CardOptions {
  size?: CardSize;
  /** Numero en la chapa de la esquina. `null` la oculta. */
  count?: number | null;
  /** Texto del pie: el ratio de puerto, el saldo del banco... */
  footer?: string | null;
  /** Carta apagada: no hay nada de ese recurso. */
  empty?: boolean;
  /** Carta boca abajo, para no ensenar la mano ajena. */
  hidden?: boolean;
  /** Clases extra. */
  extra?: string;
}

/**
 * Construye la carta como elemento del DOM. El dibujo va en un `<canvas>`
 * propio; el numero y el pie son HTML, que se posicionan y escalan mejor.
 */
export function resourceCard(resource: Resource, options: CardOptions = {}): HTMLElement {
  const [w, h] = SIZES[options.size ?? 'md'];
  const classes = ['rcard'];
  if (options.empty) classes.push('rcard--empty');
  if (options.hidden) classes.push('rcard--hidden');
  if (options.extra) classes.push(options.extra);

  const children: (HTMLElement | null)[] = [];
  if (!options.hidden) {
    const canvas = el('canvas', { class: 'rcard__art', width: String(w), height: String(h) });
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.drawImage(resourceArt(resource, w, h), 0, 0, w, h);
    children.push(canvas);
  } else {
    children.push(el('div', { class: 'rcard__back', style: `width:${w}px;height:${h}px` }, ['?']));
  }

  if (options.count !== null && options.count !== undefined) {
    children.push(el('span', { class: 'rcard__count' }, [String(options.count)]));
  }
  if (options.footer) {
    children.push(el('span', { class: 'rcard__footer' }, [options.footer]));
  }

  return el(
    'div',
    {
      class: classes.join(' '),
      'data-resource': resource,
      title: RESOURCE_LABEL[resource],
    },
    children,
  );
}

/**
 * Carta pulsable. Se usa en todos los selectores de recurso: la accion siempre
 * es «pulsa la carta», nunca un mas y un menos que hay que buscar.
 */
export function resourceCardButton(
  resource: Resource,
  options: CardOptions & { onclick: () => void; disabled?: boolean; selected?: boolean },
): HTMLElement {
  const card = resourceCard(resource, options);
  const button = el(
    'button',
    {
      type: 'button',
      class: `rcard-btn${options.selected ? ' rcard-btn--on' : ''}`,
      'data-resource': resource,
      'aria-label': RESOURCE_LABEL[resource],
      title: RESOURCE_LABEL[resource],
      disabled: options.disabled,
      onclick: options.onclick,
    },
    [card],
  );
  return button;
}


// ---------------------------------------------------------------------------
// Cartas de desarrollo
// ---------------------------------------------------------------------------

/**
 * Nombre, explicacion e imagen de cada carta de desarrollo.
 *
 * Vive aqui, junto a las cartas de recurso, porque lo consumen dos sitios: la
 * mano del jugador y los textos de ayuda. Tenerlo en uno solo garantiza que la
 * carta de la mano y la explicacion no se llamen distinto.
 */
export const DEV_CARD_INFO: Record<
  DevCardKind,
  { name: string; short: string; desc: string; icon: IconName }
> = {
  knight: {
    name: 'Caballero',
    short: 'Caballero',
    desc: 'Mueve el ladron y roba una carta. Tres caballeros dan el mayor ejercito.',
    icon: 'knight',
  },
  roadBuilding: {
    name: 'Construccion de carreteras',
    short: 'Carreteras',
    desc: 'Coloca dos caminos gratis donde puedas construirlos.',
    icon: 'road',
  },
  yearOfPlenty: {
    name: 'Ano de la abundancia',
    short: 'Abundancia',
    desc: 'Toma dos cartas de recurso cualesquiera del banco.',
    icon: 'card',
  },
  monopoly: {
    name: 'Monopolio',
    short: 'Monopolio',
    desc: 'Nombra un recurso: todos los demas jugadores te dan todas las que tengan.',
    icon: 'trade',
  },
  victoryPoint: {
    name: 'Punto de victoria',
    short: 'Punto',
    desc: 'Vale 1 punto. Permanece oculta hasta que ganas la partida.',
    icon: 'star',
  },
};

export interface DevCardOptions {
  /** Cuantas iguales hay en la mano. */
  count: number;
  /** Si se puede jugar ahora mismo. */
  enabled: boolean;
  /** Por que no se puede jugar, para el texto emergente. */
  reason?: string | null;
  onclick?: () => void;
}

/**
 * Carta de desarrollo de la mano.
 *
 * Se dibuja siempre, se pueda jugar o no: son TUS cartas y saber que tienes es
 * parte de decidir el turno. Cuando no se puede jugar queda apagada y el motivo
 * va en el texto emergente, en vez de desaparecer sin explicacion.
 */
export function devCard(kind: DevCardKind, options: DevCardOptions): HTMLElement {
  const info = DEV_CARD_INFO[kind];
  const title = options.reason ? `${info.name}. ${info.desc} (${options.reason})` : `${info.name}. ${info.desc}`;

  const face = el('span', { class: `dcard dcard--${kind}` }, [
    icon(info.icon, 22),
    el('span', { class: 'dcard__name' }, [info.short]),
    options.count > 1 ? el('span', { class: 'dcard__count' }, [`x${options.count}`]) : null,
  ]);

  return el(
    'button',
    {
      type: 'button',
      class: 'dcard-btn',
      'data-dev': kind,
      title,
      'aria-label': info.name,
      disabled: !options.enabled,
      onclick: options.onclick,
    },
    [face],
  );
}
