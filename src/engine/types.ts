import type { RngState } from './rng.js';

// ---------------------------------------------------------------------------
// Recursos y terrenos
// ---------------------------------------------------------------------------

export type Resource = 'lumber' | 'brick' | 'wool' | 'grain' | 'ore';

export const RESOURCES: readonly Resource[] = ['lumber', 'brick', 'wool', 'grain', 'ore'];

/** Terreno de una casilla. El desierto no produce nada. */
export type Terrain = 'forest' | 'hills' | 'pasture' | 'fields' | 'mountains' | 'desert';

export const TERRAIN_YIELD: Readonly<Record<Terrain, Resource | null>> = {
  forest: 'lumber',
  hills: 'brick',
  pasture: 'wool',
  fields: 'grain',
  mountains: 'ore',
  desert: null,
};

export type ResourceCount = Record<Resource, number>;

// ---------------------------------------------------------------------------
// Geometria
// ---------------------------------------------------------------------------

/** Coordenada axial de hexagono (pointy-top). */
export interface HexCoord {
  q: number;
  r: number;
}

/** Clave canonica de vertice: "X,Y" en la rejilla entera duplicada (ver hex.ts). */
export type VertexId = string;

/** Clave canonica de arista: "vA|vB" con vA < vB lexicograficamente. */
export type EdgeId = string;

export type HexId = string; // "q,r"

export interface Hex {
  id: HexId;
  coord: HexCoord;
  terrain: Terrain;
  /** Ficha numerica 2..12 (sin 7). null en el desierto. */
  number: number | null;
  /** 6 vertices en orden horario empezando por la esquina superior derecha. */
  vertices: VertexId[];
  /** 6 aristas; edges[i] une vertices[i] con vertices[i+1]. */
  edges: EdgeId[];
}

export type PortKind = Resource | 'generic';

export interface Port {
  id: string;
  kind: PortKind;
  /** 2 para puerto especifico, 3 para el generico 3:1. */
  ratio: 2 | 3;
  /** Los dos vertices costeros que dan acceso al puerto. */
  vertices: [VertexId, VertexId];
  /** Arista costera sobre la que se dibuja el muelle. */
  edge: EdgeId;
}

export type BoardVariant = 'base' | 'extended' | 'large' | 'huge';

export interface Board {
  variant: BoardVariant;
  hexes: Record<HexId, Hex>;
  hexOrder: HexId[];
  /** Vertice -> hexes adyacentes (1 a 3). */
  vertexHexes: Record<VertexId, HexId[]>;
  /** Grafo de vertices: vecinos conectados por una arista. */
  vertexNeighbors: Record<VertexId, VertexId[]>;
  /** Arista -> sus dos vertices. */
  edgeVertices: Record<EdgeId, [VertexId, VertexId]>;
  /** Vertice -> aristas incidentes. */
  vertexEdges: Record<VertexId, EdgeId[]>;
  ports: Port[];
  /** Vertice -> puertos accesibles desde el. */
  vertexPorts: Record<VertexId, PortKind[]>;
  /** Casilla donde empieza el ladron (el desierto). */
  robberStart: HexId;
}

// ---------------------------------------------------------------------------
// Jugadores y piezas
// ---------------------------------------------------------------------------

export type PlayerId = number;

export type PlayerColor = 'red' | 'blue' | 'white' | 'orange' | 'green' | 'brown';

/** El motor no distingue humano de bot: solo lo etiqueta para la capa superior. */
export type PlayerKind = 'human' | 'bot';

export type BotDifficulty = 'easy' | 'normal' | 'hard';

export interface PlayerConfig {
  name: string;
  color: PlayerColor;
  kind: PlayerKind;
  /** Solo relevante si kind === 'bot'. */
  difficulty?: BotDifficulty;
}

export type BuildingKind = 'settlement' | 'city';

export interface Building {
  kind: BuildingKind;
  owner: PlayerId;
  vertex: VertexId;
}

export interface Road {
  owner: PlayerId;
  edge: EdgeId;
}

// ---------------------------------------------------------------------------
// Cartas de desarrollo
// ---------------------------------------------------------------------------

export type DevCardKind =
  | 'knight'
  | 'roadBuilding'
  | 'yearOfPlenty'
  | 'monopoly'
  | 'victoryPoint';

export interface DevCard {
  kind: DevCardKind;
  /** Turno de compra: no se puede jugar el mismo turno en que se compro. */
  boughtOnTurn: number;
}

export interface PlayerState {
  id: PlayerId;
  name: string;
  color: PlayerColor;
  kind: PlayerKind;
  difficulty?: BotDifficulty;
  resources: ResourceCount;
  devCards: DevCard[];
  /** Caballeros ya jugados (cuentan para el mayor ejercito). */
  knightsPlayed: number;
  /** Piezas que quedan en la reserva del jugador. */
  piecesLeft: { road: number; settlement: number; city: number };
  buildings: VertexId[];
  roads: EdgeId[];
  ports: PortKind[];
  /** true si ya jugo una carta de desarrollo en este turno. */
  playedDevCardThisTurn: boolean;
  longestRoadLength: number;
}

// ---------------------------------------------------------------------------
// Fases
// ---------------------------------------------------------------------------

export type Phase =
  /** Colocacion inicial en serpiente: poblado y luego camino. */
  | 'setupSettlement'
  | 'setupRoad'
  /** Inicio de turno: se puede jugar carta de desarrollo o tirar los dados. */
  | 'roll'
  /** Tras un 7: los jugadores con mas de 7 cartas descartan la mitad. */
  | 'discard'
  /** Colocar el ladron (por un 7 o por un caballero). */
  | 'moveRobber'
  /** Elegir victima cuando hay varias posibles. */
  | 'steal'
  /** Fase principal: comerciar, construir, jugar cartas. */
  | 'main'
  | 'gameOver';

/** Efecto de carta que aun necesita mas entradas del jugador. */
export type PendingAction =
  | { type: 'roadBuilding'; roadsLeft: number }
  | { type: 'yearOfPlenty' }
  | { type: 'monopoly' };

// ---------------------------------------------------------------------------
// Comercio
// ---------------------------------------------------------------------------

export interface TradeOffer {
  id: number;
  from: PlayerId;
  give: Partial<ResourceCount>;
  want: Partial<ResourceCount>;
  responses: Record<PlayerId, 'accepted' | 'rejected' | 'pending'>;
}

// ---------------------------------------------------------------------------
// Registro de partida
// ---------------------------------------------------------------------------

export interface LogEntry {
  turn: number;
  player: PlayerId | null;
  text: string;
  tone: 'info' | 'build' | 'trade' | 'dice' | 'robber' | 'card' | 'victory';
}

// ---------------------------------------------------------------------------
// Estado completo
// ---------------------------------------------------------------------------

export interface GameRules {
  /** Puntos necesarios para ganar. */
  victoryPoints: number;
  /** Limite de cartas por encima del cual se descarta con un 7. */
  discardLimit: number;
  /** Permitir comercio entre jugadores. */
  playerTrade: boolean;
}

export interface GameState {
  rules: GameRules;
  board: Board;
  players: PlayerState[];
  /** Banco: cartas de recurso disponibles. */
  bank: ResourceCount;
  devDeck: DevCardKind[];
  buildings: Record<VertexId, Building>;
  roads: Record<EdgeId, Road>;
  robber: HexId;
  currentPlayer: PlayerId;
  phase: Phase;
  turn: number;
  dice: [number, number] | null;
  pending: PendingAction | null;
  /** Jugadores que aun deben descartar tras un 7. */
  mustDiscard: PlayerId[];
  /** Candidatos a ser robados tras mover el ladron. */
  stealTargets: PlayerId[];
  activeTrade: TradeOffer | null;
  nextTradeId: number;
  longestRoadHolder: PlayerId | null;
  largestArmyHolder: PlayerId | null;
  /** Orden de juego (asientos), sorteado al crear la partida. */
  turnOrder: PlayerId[];
  /** Orden de colocacion inicial (ida y vuelta). */
  setupOrder: PlayerId[];
  setupIndex: number;
  /** Vertice recien colocado en setup, para forzar el camino adyacente. */
  lastSetupVertex: VertexId | null;
  winner: PlayerId | null;
  rng: RngState;
  log: LogEntry[];
  /**
   * Que ha tapado el servidor antes de mandar este estado, y cuanto habia.
   *
   * `null` en una partida local: ahi no se tapa nada y los datos de verdad
   * estan en el propio estado. En una partida en red el servidor borra lo que
   * un jugador no puede ver -- las manos ajenas, el mazo de desarrollo y el
   * estado del generador de azar, que revelaria las tiradas futuras -- y deja
   * aqui los recuentos publicos, que si son informacion legitima.
   *
   * Se guarda el recuento en vez de dejar una mano falsa del tamano correcto
   * porque una mano falsa es una mentira que cualquier lectura futura del
   * estado se creeria en silencio. Con esto, quien lea `resources` de otro ve
   * cero y quien quiera el numero llama a `handSize`, que sabe donde mirar.
   */
  redacted: Redaction | null;
}

/** Recuentos publicos de lo que el servidor ha tapado. Ver `GameState.redacted`. */
export interface Redaction {
  /** Cartas de recurso en mano, por jugador. */
  hands: number[];
  /** Cartas de desarrollo, por jugador. */
  devCards: number[];
  /** Cartas que quedan en el mazo de desarrollo. */
  devDeck: number;
}
