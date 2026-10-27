import type { Action, BoardVariant, GameState, PlayerColor, PlayerId } from '../engine/index.js';

/**
 * El idioma que hablan cliente y servidor.
 *
 * Vive en `src/` y no en `server/` a proposito: los dos lados importan este
 * mismo archivo, asi que un mensaje que cambie de forma rompe la compilacion de
 * ambos a la vez en vez de fallar en tiempo de ejecucion con un campo
 * `undefined` a mitad de partida.
 *
 * El reparto de responsabilidades es el de siempre en un juego por turnos con
 * servidor autoritativo: **el cliente no aplica nada**. Manda la accion que
 * quiere hacer y espera; quien decide si vale y cual es el estado nuevo es el
 * servidor, que es el unico que tiene el estado entero y el generador de azar.
 * El cliente si calcula las acciones legales, pero solo para pintar la interfaz
 * -- que un boton este encendido no es permiso para nada.
 */

/** Version del protocolo. Sube si cambia la forma de cualquier mensaje. */
export const PROTOCOL_VERSION = 1;

/** Como se identifica un asiento de la sala frente al servidor. */
export type SeatToken = string;

/** Un asiento de la sala, tal y como lo ve todo el mundo. */
export interface Seat {
  id: PlayerId;
  name: string;
  color: PlayerColor;
  /** `bot` lo lleva el servidor; `human` espera a que alguien lo ocupe. */
  kind: 'human' | 'bot';
  difficulty?: 'easy' | 'normal' | 'hard';
  /** Si hay alguien conectado ocupandolo ahora mismo. */
  occupied: boolean;
  /** Quien lo ocupa, para pintarlo en la sala de espera. */
  occupantName: string | null;
}

/**
 * Un mensaje del chat.
 *
 * `seat` a `null` marca los avisos del propio juego («Ana se ha unido»), que se
 * pintan distinto. Van por el mismo canal que los de la gente porque en la
 * conversacion son lo mismo: cosas que han pasado, en orden.
 */
export interface ChatEntry {
  id: number;
  seat: PlayerId | null;
  name: string;
  text: string;
  at: number;
}

/** Longitud maxima de un mensaje, recortada en el servidor. */
export const CHAT_MAX_LENGTH = 240;

/** Estado de la sala antes de empezar. */
export interface Lobby {
  code: string;
  seats: Seat[];
  variant: BoardVariant;
  victoryPoints: number;
  /** El anfitrion es quien puede arrancar la partida. */
  hostSeat: PlayerId | null;
  started: boolean;
}

// ---------------------------------------------------------------------------
// Cliente -> servidor
// ---------------------------------------------------------------------------

export type ClientMessage =
  /** Entrar en la sala. Sin `token` pide asiento nuevo; con el, recupera el suyo. */
  | { type: 'join'; version: number; room: string; name: string; token?: SeatToken }
  /** Cambiar de asiento antes de empezar. */
  | { type: 'takeSeat'; seat: PlayerId }
  /** Convertir un asiento libre en bot, o al reves. */
  | { type: 'setSeatKind'; seat: PlayerId; kind: 'human' | 'bot'; difficulty?: 'easy' | 'normal' | 'hard' }
  /** Opciones de partida. Solo le hace caso al anfitrion. */
  | { type: 'configure'; variant?: BoardVariant; victoryPoints?: number }
  /** Empezar. Solo el anfitrion. */
  | { type: 'start' }
  /** Terminada la partida, devolver la sala a la pantalla de espera. */
  | { type: 'returnToLobby' }
  /** Jugar. El servidor comprueba que quien la manda es quien dice ser. */
  | { type: 'action'; action: Action }
  /** Decir algo por el chat. */
  | { type: 'chat'; text: string }
  /** Latido, para que el servidor sepa que el cliente sigue vivo. */
  | { type: 'ping' };

// ---------------------------------------------------------------------------
// Servidor -> cliente
// ---------------------------------------------------------------------------

export type ServerMessage =
  /** Bienvenida: que asiento te ha tocado y con que ficha vuelves si te caes. */
  | { type: 'welcome'; seat: PlayerId; token: SeatToken; lobby: Lobby }
  /** La sala ha cambiado (alguien entra, sale o cambia de asiento). */
  | { type: 'lobby'; lobby: Lobby }
  /** Estado de la partida, ya censurado para quien lo recibe. */
  | { type: 'state'; state: GameState; seat: PlayerId }
  /** La jugada que mandaste no valia. */
  | { type: 'rejected'; reason: string }
  /**
   * La conversacion entera, no solo lo nuevo.
   *
   * Mandar la lista completa cuesta unos kilobytes y ahorra toda una clase de
   * fallos: no hay que acertar con el orden de llegada ni reconstruir nada tras
   * una reconexion, y quien entra a media partida ve lo que se ha dicho.
   */
  | { type: 'chat'; entries: ChatEntry[] }
  /** Algo ha ido mal y no hay partida que seguir. */
  | { type: 'error'; reason: string }
  | { type: 'pong' };

/**
 * Comprueba que un mensaje entrante tiene de verdad la forma que dice tener.
 *
 * Todo lo que llega por el socket es entrada NO fiable, aunque venga del propio
 * juego. No hace falta mala intencion: una pestana con una version vieja, un
 * `undefined` que `JSON.stringify` se traga por el camino y convierte un campo
 * en ausente, o alguien trasteando con la consola del navegador.
 *
 * Sin esta comprobacion, un `{type:'action'}` sin accion reventaba al leer
 * `action.player`, y como el fallo salta dentro del manejador del socket se
 * llevaba por delante el PROCESO -- es decir, la partida de todos los demas, no
 * solo la de quien lo mando. Cualquier cliente podia tumbar la mesa entera.
 *
 * Solo mira la FORMA. Que la jugada sea legal lo decide el motor, y quien puede
 * hacerla, la sala: son tres comprobaciones distintas y cada una en su sitio.
 */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  const str = (v: unknown): v is string => typeof v === 'string';
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

  switch (m.type) {
    case 'ping':
      return { type: 'ping' };
    case 'chat': {
      if (!str(m.text)) return null;
      const text = m.text.trim().slice(0, CHAT_MAX_LENGTH);
      // Un mensaje vacio no es un mensaje: se descarta aqui y no llega a la
      // sala, para no llenar la conversacion de lineas en blanco.
      return text ? { type: 'chat', text } : null;
    }
    case 'start':
      return { type: 'start' };
    case 'returnToLobby':
      return { type: 'returnToLobby' };
    case 'join': {
      if (!num(m.version) || !str(m.room) || !str(m.name)) return null;
      if (m.token !== undefined && !str(m.token)) return null;
      // El recorte se hace aqui y no en la interfaz: la interfaz es del cliente
      // y puede mandar lo que le de la gana.
      return {
        type: 'join',
        version: m.version,
        room: m.room.slice(0, 12),
        name: m.name.slice(0, 16),
        ...(str(m.token) ? { token: m.token } : {}),
      };
    }
    case 'takeSeat':
      return num(m.seat) ? { type: 'takeSeat', seat: m.seat } : null;
    case 'setSeatKind': {
      if (!num(m.seat)) return null;
      if (m.kind !== 'human' && m.kind !== 'bot') return null;
      const difficulty = m.difficulty;
      if (difficulty !== undefined && !['easy', 'normal', 'hard'].includes(String(difficulty))) {
        return null;
      }
      return {
        type: 'setSeatKind',
        seat: m.seat,
        kind: m.kind,
        ...(difficulty === undefined ? {} : { difficulty: difficulty as 'easy' | 'normal' | 'hard' }),
      };
    }
    case 'configure': {
      if (m.variant !== undefined && !str(m.variant)) return null;
      if (m.victoryPoints !== undefined && !num(m.victoryPoints)) return null;
      return {
        type: 'configure',
        ...(str(m.variant) ? { variant: m.variant as BoardVariant } : {}),
        ...(num(m.victoryPoints) ? { victoryPoints: m.victoryPoints } : {}),
      };
    }
    case 'action': {
      const action = m.action;
      if (typeof action !== 'object' || action === null) return null;
      const a = action as Record<string, unknown>;
      if (!str(a.type) || !num(a.player)) return null;
      return { type: 'action', action: action as Action };
    }
    default:
      return null;
  }
}

/**
 * Codigo de sala: cuatro letras, sin vocales ni caracteres que se confundan.
 *
 * Se dicta en voz alta por encima de la mesa, asi que no puede tener ni O/0 ni
 * I/1/L. Sin vocales tampoco salen palabras que ofendan por casualidad.
 */
const CODE_ALPHABET = 'BCDFGHJKMNPQRSTVWXYZ23456789';

export function makeRoomCode(random: () => number = Math.random): string {
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  }
  return code;
}

/** Normaliza lo que teclea el usuario: mayusculas y sin espacios. */
export function normalizeRoomCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}
