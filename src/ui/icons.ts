import { svg } from './dom.js';

/**
 * Iconos de la interfaz.
 *
 * Van en SVG y no en emoji ni en una tipografia de iconos por tres razones: se
 * ven nitidos a cualquier tamano, heredan el color del texto con
 * `currentColor` (asi un boton deshabilitado apaga tambien su icono sin reglas
 * extra), y se dibujan igual en todos los sistemas, cosa que los emoji no
 * hacen.
 *
 * Todos comparten el lienzo de 24x24 para que se puedan intercambiar sin
 * recolocar nada, y el detalle interior va calado (ver `PATHS`).
 */

export type IconName =
  | 'card'
  | 'dev'
  | 'settlement'
  | 'city'
  | 'road'
  | 'longestRoad'
  | 'knight'
  | 'star'
  | 'timer'
  | 'bank'
  | 'trade'
  | 'dice'
  | 'flag';

/** Trazos de cada icono: `d` macizo, `s` contorno, `w` grosor del contorno. */
interface Glyph {
  /**
   * Formas macizas. Los subtrazos que van DENTRO de otro se calan (regla
   * par-impar), y por ahi se ve el fondo: es lo que permite meter una puerta en
   * una casa o una espada en un escudo sin necesitar un segundo color.
   */
  d?: string[];
  /** Trazos abiertos, para lo que es una linea y no una silueta. */
  s?: string[];
  /** Grosor de los trazos de `s`. */
  w?: number;
}

/*
 * El detalle interior va SIEMPRE calado, nunca pintado.
 *
 * Un icono hereda el color del texto con `currentColor` y no sabe nada del
 * fondo sobre el que cae, asi que una ventana dibujada en el mismo color que la
 * pared simplemente no existe. Antes se resolvia con una regla mas dura -- cada
 * icono macizo O de contorno, nunca las dos cosas -- pero eso dejaba siluetas
 * planas y sin caracter. Calar el hueco resuelve lo mismo y deja poner detalle:
 * la casa tiene puerta, la ciudad ventanas, el camino su linea discontinua.
 */
const PATHS: Record<IconName, Glyph> = {
  // Cartas en mano: dos cartas en abanico, con hueco entre ellas para que se
  // lean como dos y no como una mancha.
  card: {
    d: [
      'M3.6 8 9 5.4l2.8 12.2-5.4 2.6z',
      'M14.8 5.6h4.4a1.8 1.8 0 0 1 1.8 1.8v11.2a1.8 1.8 0 0 1-1.8 1.8h-4.4a1.8 1.8 0 0 1-1.8-1.8V7.4a1.8 1.8 0 0 1 1.8-1.8z',
    ],
  },
  // Carta de desarrollo: contorno con el interrogante, que la separa de un
  // vistazo de la carta de recurso maciza.
  dev: {
    d: ['M12 15.7a1.05 1.05 0 1 1 0 2.1 1.05 1.05 0 0 1 0-2.1z'],
    s: [
      'M6.6 3.9h10.8a1.8 1.8 0 0 1 1.8 1.8v12.6a1.8 1.8 0 0 1-1.8 1.8H6.6a1.8 1.8 0 0 1-1.8-1.8V5.7a1.8 1.8 0 0 1 1.8-1.8z',
      'M9.9 9.1a2.15 2.15 0 1 1 2.9 2.05c-.55.22-.85.72-.85 1.3v.55',
    ],
  },
  // Poblado: la casita, con la puerta calada en la fachada.
  settlement: {
    d: ['M12 3.4 21 11h-2.6v9.2H5.6V11H3zM10 20.2v-4.8a2 2 0 0 1 4 0v4.8z'],
  },
  // Ciudad: nave baja pegada a una torre, ambas con sus ventanas.
  city: {
    d: [
      'M3 20.6V12l4.6-3.6L12.2 12v8.6zM6 14.4h3.2v3.4H6z',
      'M13.4 20.6V7.2L17.7 3l4.3 4.2v13.4zM16.2 10.2h3v2.8h-3zM16.2 15.2h3v2.8h-3z',
    ],
  },
  // Camino: la calzada en perspectiva con su linea discontinua.
  road: {
    d: [
      'M4.2 21 9.5 3h5l5.3 18zM11.15 5h1.7v2.8h-1.7zM10.9 9.8h2.2v3.2h-2.2zM10.6 15h2.8v3.6h-2.8z',
    ],
  },
  // Ruta comercial mas larga: un trazado que serpentea, con cuerpo de calzada.
  longestRoad: {
    s: ['M3 18c3.4 0 3-9 6.4-9s3 9 6.4 9 3-9 5.2-9'],
    w: 2.8,
  },
  // Mayor ejercito: el escudo del caballero, con la espada calada.
  knight: {
    d: [
      'M12 2.4 20.2 5.5v6.2c0 5-4.3 8.4-8.2 9.9-3.9-1.5-8.2-4.9-8.2-9.9V5.5zM11.1 6.2h1.8v3.6h2.6v1.8h-2.6v6.2h-1.8v-6.2H8.5V9.8h2.6z',
    ],
  },
  // Punto de victoria.
  star: {
    d: ['M12 2.6l2.9 6.1 6.6.9-4.8 4.6 1.2 6.6L12 17.7l-5.9 3.1 1.2-6.6L2.5 9.6l6.6-.9z'],
  },
  // Reloj de arena: la camara de arriba calada, la de abajo llena. Se lee «se
  // esta acabando» sin necesidad de un segundo color.
  timer: {
    d: ['M7 3.6h10v3.1L13.1 12 17 17.3v3.1H7v-3.1L10.9 12 7 6.7zM8.9 6.1h6.2L12 9.9z'],
  },
  // Banco: el edificio con columnas.
  bank: {
    d: ['M12 2.6 22 8v2H2V8z', 'M2 19h20v2.4H2z'],
    s: ['M5.6 11.4v6.2', 'M9.9 11.4v6.2', 'M14.1 11.4v6.2', 'M18.4 11.4v6.2'],
  },
  // Comercio entre jugadores: dos flechas cruzadas.
  trade: {
    d: ['M14.6 2.6 20.6 8l-6 5.4v-3.2H7.4V5.8h7.2z', 'M9.4 21.4 3.4 16l6-5.4v3.2h7.2v4.4H9.4z'],
  },
  // Dado: contorno con los puntos macizos, para que los puntos se vean.
  dice: {
    d: [
      'M7.35 8.4a1.05 1.05 0 1 0 2.1 0 1.05 1.05 0 1 0-2.1 0z',
      'M14.55 8.4a1.05 1.05 0 1 0 2.1 0 1.05 1.05 0 1 0-2.1 0z',
      'M10.95 12a1.05 1.05 0 1 0 2.1 0 1.05 1.05 0 1 0-2.1 0z',
      'M7.35 15.6a1.05 1.05 0 1 0 2.1 0 1.05 1.05 0 1 0-2.1 0z',
      'M14.55 15.6a1.05 1.05 0 1 0 2.1 0 1.05 1.05 0 1 0-2.1 0z',
    ],
    s: [
      'M5.6 4.4h12.8a1.2 1.2 0 0 1 1.2 1.2v12.8a1.2 1.2 0 0 1-1.2 1.2H5.6a1.2 1.2 0 0 1-1.2-1.2V5.6a1.2 1.2 0 0 1 1.2-1.2z',
    ],
  },
  // Fin de turno.
  flag: {
    d: ['M5.6 3.2h1.9v17.6H5.6z', 'M8.6 3.8h10.8l-2.6 4 2.6 4H8.6z'],
  },
};

/**
 * Construye un icono. `size` es el lado en pixeles CSS; el color sale del
 * texto que lo contiene.
 */
export function icon(name: IconName, size = 16): SVGElement {
  const spec = PATHS[name];
  const children: Element[] = [];

  for (const d of spec.d ?? []) {
    // `evenodd` es lo que cala los subtrazos interiores. En las formas de un
    // solo trazo no cambia nada, asi que se pone siempre.
    children.push(svg('path', { d, fill: 'currentColor', 'fill-rule': 'evenodd' }));
  }
  for (const d of spec.s ?? []) {
    children.push(
      svg('path', {
        d,
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': spec.w ?? 2,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      }),
    );
  }

  return svg(
    'svg',
    {
      class: 'icon',
      viewBox: '0 0 24 24',
      width: size,
      height: size,
      'aria-hidden': 'true',
      focusable: 'false',
    },
    children,
  );
}
