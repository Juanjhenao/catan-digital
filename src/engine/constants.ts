import type {
  BoardVariant,
  DevCardKind,
  PlayerColor,
  Resource,
  ResourceCount,
  Terrain,
} from './types.js';

// ---------------------------------------------------------------------------
// Costes de construccion
// ---------------------------------------------------------------------------

export const COSTS = {
  road: { lumber: 1, brick: 1, wool: 0, grain: 0, ore: 0 },
  settlement: { lumber: 1, brick: 1, wool: 1, grain: 1, ore: 0 },
  city: { lumber: 0, brick: 0, wool: 0, grain: 2, ore: 3 },
  devCard: { lumber: 0, brick: 0, wool: 1, grain: 1, ore: 1 },
} as const satisfies Record<string, ResourceCount>;

export type Buildable = keyof typeof COSTS;

/** Colores en el orden en que se asignan por defecto. */
export const PLAYER_COLORS: readonly PlayerColor[] = [
  'red',
  'blue',
  'white',
  'orange',
  'green',
  'brown',
];

// ---------------------------------------------------------------------------
// Composicion del tablero
// ---------------------------------------------------------------------------

/**
 * Reparto proporcional.
 *
 * En lugar de codificar a mano la lista de casillas y fichas de cada mapa, se
 * derivan de las proporciones del tablero clasico. Merece la pena porque la
 * formula reproduce EXACTAMENTE los dos repartos oficiales (19 casillas y la
 * extension de 30), asi que los mapas grandes no son una invencion suelta:
 * son el mismo juego escalado. Hay un test que lo comprueba.
 */

/** Proporcion de cada terreno productivo en el tablero clasico (18 casillas). */
const TERRAIN_WEIGHTS: readonly [Terrain, number][] = [
  ['forest', 4],
  ['pasture', 4],
  ['fields', 4],
  ['hills', 3],
  ['mountains', 3],
];

/** Proporcion de cada ficha numerica en el tablero clasico (18 fichas). */
const NUMBER_WEIGHTS: readonly [number, number][] = [
  [2, 1],
  [3, 2],
  [4, 2],
  [5, 2],
  [6, 2],
  [8, 2],
  [9, 2],
  [10, 2],
  [11, 2],
  [12, 1],
];

/**
 * Reparte `total` unidades segun unos pesos, usando el metodo del resto mayor.
 * Es lo que garantiza que la suma cuadre exactamente y que el redondeo no
 * favorezca sistematicamente a los primeros elementos de la lista.
 */
function distribute<T>(entries: readonly [T, number][], total: number): T[] {
  const weightSum = entries.reduce((sum, [, w]) => sum + w, 0);
  const exact = entries.map(([item, weight]) => ({
    item,
    exact: (weight * total) / weightSum,
  }));
  const counts = exact.map((e) => ({ item: e.item, count: Math.floor(e.exact), rest: e.exact % 1 }));
  let assigned = counts.reduce((sum, c) => sum + c.count, 0);
  // Los restos mas altos se llevan las unidades que faltan para cuadrar.
  const byRest = [...counts].sort((a, b) => b.rest - a.rest);
  for (let i = 0; assigned < total; i++, assigned++) {
    byRest[i % byRest.length]!.count++;
  }
  return counts.flatMap((c) => Array<T>(c.count).fill(c.item));
}

export interface VariantSetup {
  /** Nombre para la interfaz. */
  label: string;
  /** Descripcion corta de a que sabe jugar en este mapa. */
  blurb: string;
  /** Casillas de terreno a repartir (se barajan). */
  terrains: Terrain[];
  /** Fichas numericas para las casillas productivas. */
  numbers: number[];
  /** Puertos especificos, uno por entrada. */
  ports: Resource[];
  genericPorts: number;
  /** Cartas de recurso disponibles en el banco, por tipo. */
  bankPerResource: number;
  devDeck: Record<DevCardKind, number>;
  victoryPoints: number;
  /** Numero de jugadores para el que el mapa esta pensado. */
  recommendedPlayers: [number, number];
}

interface VariantTuning {
  label: string;
  blurb: string;
  hexCount: number;
  deserts: number;
  /** Puertos totales; se reparten entre especificos y genericos casi al 50%. */
  ports: number;
  bankPerResource: number;
  devDeckSize: number;
  /** Cartas de punto de victoria del mazo (no escalan con el tamano). */
  victoryPointCards: number;
  victoryPoints: number;
  recommendedPlayers: [number, number];
}

/**
 * Los unicos numeros ajustados a mano. Todo lo demas se deriva.
 * `base` y `extended` reproducen el material oficial; `large` y `huge` siguen
 * la misma escala.
 */
const TUNING: Record<BoardVariant, VariantTuning> = {
  base: {
    label: 'Clasico',
    blurb: '19 casillas. La isla de siempre, partida de 60-90 minutos.',
    hexCount: 19,
    deserts: 1,
    ports: 9,
    bankPerResource: 19,
    devDeckSize: 25,
    victoryPointCards: 5,
    victoryPoints: 10,
    recommendedPlayers: [2, 4],
  },
  extended: {
    label: 'Ampliado',
    blurb: '30 casillas. El tablero de la extension para 5 y 6 jugadores.',
    hexCount: 30,
    deserts: 2,
    ports: 11,
    bankPerResource: 24,
    devDeckSize: 34,
    victoryPointCards: 5,
    victoryPoints: 10,
    recommendedPlayers: [5, 6],
  },
  large: {
    label: 'Grande',
    blurb: '37 casillas y 12 puntos. Mas sitio para expandirse y mas puertos.',
    hexCount: 37,
    deserts: 2,
    ports: 13,
    bankPerResource: 30,
    devDeckSize: 44,
    victoryPointCards: 6,
    victoryPoints: 12,
    recommendedPlayers: [4, 6],
  },
  huge: {
    label: 'Enorme',
    blurb: '61 casillas y 15 puntos. Partida larga, con carreteras de verdad.',
    hexCount: 61,
    deserts: 3,
    ports: 17,
    bankPerResource: 40,
    devDeckSize: 60,
    victoryPointCards: 8,
    victoryPoints: 15,
    recommendedPlayers: [4, 6],
  },
};

/**
 * Mazo de desarrollo.
 *
 * Las cartas de punto de victoria NO se reparten proporcionalmente: valen un
 * punto cada una, asi que su numero se fija aparte por variante. Escalarlas con
 * el resto haria la partida mucho mas caprichosa, y de hecho el material
 * oficial tampoco lo hace (5 cartas tanto en el mazo de 25 como en el de 34).
 * Las de accion si se reparten con los pesos clasicos 14/2/2/2, y con esta
 * separacion la formula reproduce exactamente los dos mazos oficiales.
 */
function buildDevDeck(size: number, victoryPointCards: number): Record<DevCardKind, number> {
  const deck: Record<DevCardKind, number> = {
    knight: 0,
    victoryPoint: victoryPointCards,
    roadBuilding: 0,
    yearOfPlenty: 0,
    monopoly: 0,
  };
  const actionCards = distribute<DevCardKind>(
    [
      ['knight', 14],
      ['roadBuilding', 2],
      ['yearOfPlenty', 2],
      ['monopoly', 2],
    ],
    size - victoryPointCards,
  );
  for (const card of actionCards) deck[card]++;
  return deck;
}

function buildSetup(tuning: VariantTuning): VariantSetup {
  const productive = tuning.hexCount - tuning.deserts;

  const terrains: Terrain[] = [
    ...distribute(TERRAIN_WEIGHTS, productive),
    ...Array<Terrain>(tuning.deserts).fill('desert'),
  ];
  const numbers = distribute(NUMBER_WEIGHTS, productive);

  // Los puertos se parten casi por la mitad, con los especificos ganando el
  // desempate. Sale 5 especificos / 4 genericos en el clasico y 6/5 en el
  // ampliado, que es justo el material oficial.
  const specificCount = Math.ceil(tuning.ports / 2);
  const cycle: Resource[] = ['wool', 'grain', 'ore', 'lumber', 'brick'];
  const ports = Array.from({ length: specificCount }, (_, i) => cycle[i % cycle.length]!);

  return {
    label: tuning.label,
    blurb: tuning.blurb,
    terrains,
    numbers,
    ports,
    genericPorts: tuning.ports - specificCount,
    bankPerResource: tuning.bankPerResource,
    devDeck: buildDevDeck(tuning.devDeckSize, tuning.victoryPointCards),
    victoryPoints: tuning.victoryPoints,
    recommendedPlayers: tuning.recommendedPlayers,
  };
}

export const VARIANT_SETUP: Record<BoardVariant, VariantSetup> = {
  base: buildSetup(TUNING.base),
  extended: buildSetup(TUNING.extended),
  large: buildSetup(TUNING.large),
  huge: buildSetup(TUNING.huge),
};

export const BOARD_VARIANTS: readonly BoardVariant[] = ['base', 'extended', 'large', 'huge'];

/** Variante por defecto para un numero de jugadores. */
export function variantForPlayers(count: number): BoardVariant {
  return count >= 5 ? 'extended' : 'base';
}

// ---------------------------------------------------------------------------
// Piezas y reglas numericas
// ---------------------------------------------------------------------------

/** Piezas por jugador en el material clasico. */
export const PIECES_PER_PLAYER = { road: 15, settlement: 5, city: 4 } as const;

/**
 * En los mapas grandes hacen falta mas piezas: con 15 caminos no se llega a
 * los 15 puntos del mapa enorme. Se escala igual que el resto.
 */
export function piecesFor(variant: BoardVariant): { road: number; settlement: number; city: number } {
  switch (variant) {
    case 'large':
      return { road: 20, settlement: 6, city: 5 };
    case 'huge':
      return { road: 26, settlement: 8, city: 6 };
    default:
      return { ...PIECES_PER_PLAYER };
  }
}

/** Con mas de este numero de cartas en mano, un 7 obliga a descartar la mitad. */
export const DISCARD_LIMIT = 7;

/** Caballeros minimos para reclamar el mayor ejercito. */
export const LARGEST_ARMY_MIN = 3;

/** Longitud minima de camino para reclamar la ruta comercial mas larga. */
export const LONGEST_ROAD_MIN = 5;

export const ZERO_RESOURCES: ResourceCount = {
  lumber: 0,
  brick: 0,
  wool: 0,
  grain: 0,
  ore: 0,
};

/** Numero de formas de sacar N con 2d6: mide lo buena que es una casilla. */
export function pipsFor(number: number): number {
  return 6 - Math.abs(7 - number);
}
