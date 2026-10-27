import type { Action, GameState, PlayerId } from '../engine/index.js';
import {
  PROTOCOL_VERSION,
  type ChatEntry,
  type ClientMessage,
  type Lobby,
  type ServerMessage,
} from './protocol.js';

/**
 * El extremo cliente de una partida en red.
 *
 * Envuelve el WebSocket y poco mas: no guarda estado de juego ni decide nada.
 * Eso es deliberado -- **el cliente no aplica jugadas**. Manda lo que quiere
 * hacer y espera a que llegue el estado nuevo. Si mandara la jugada y a la vez
 * la aplicara en local para que se viera al instante, habria dos partidas en
 * marcha y en cuanto una se desviara de la otra (una jugada rechazada, dos
 * personas actuando a la vez) ya no habria forma de saber cual es la buena.
 *
 * Lo unico que si guarda es la ficha del asiento, en `sessionStorage`, para que
 * recargar la pagina o perder la wifi un momento devuelva al jugador a su sitio
 * con sus cartas en vez de tratarlo como a un recien llegado.
 */

export interface NetHandlers {
  onLobby(lobby: Lobby, seat: PlayerId): void;
  onState(state: GameState, seat: PlayerId): void;
  onChat(entries: ChatEntry[]): void;
  onRejected(reason: string): void;
  onError(reason: string): void;
  onStatus(status: NetStatus): void;
}

export type NetStatus = 'conectando' | 'conectado' | 'reconectando' | 'cerrado';

/** Cada cuanto se manda un latido, para que no se corte la conexion sola. */
const PING_EVERY = 20_000;

/** Espera antes de reintentar, que crece hasta un tope. */
const RETRY_BASE = 600;
const RETRY_MAX = 8_000;

export class NetClient {
  private socket: WebSocket | null = null;
  private pingTimer = 0;
  private retryTimer = 0;
  private attempts = 0;
  private closedByUs = false;
  private token: string | null = null;

  seat: PlayerId | null = null;
  lobby: Lobby | null = null;
  /** Lo dicho hasta ahora, para poder pintarlo en cuanto haya donde. */
  chat: ChatEntry[] = [];

  constructor(
    private readonly room: string,
    private readonly name: string,
    private readonly handlers: NetHandlers,
  ) {
    this.token = sessionStorage.getItem(this.tokenKey());
  }

  /** La direccion del servidor: la misma pagina, pero en ws. */
  private url(): string {
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${scheme}//${location.host}`;
  }

  private tokenKey(): string {
    return `colonos:asiento:${this.room || 'nueva'}`;
  }

  connect(): void {
    this.closedByUs = false;
    this.handlers.onStatus(this.attempts === 0 ? 'conectando' : 'reconectando');
    const socket = new WebSocket(this.url());
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.attempts = 0;
      this.handlers.onStatus('conectado');
      this.send({
        type: 'join',
        version: PROTOCOL_VERSION,
        room: this.room,
        name: this.name,
        ...(this.token ? { token: this.token } : {}),
      });
      window.clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.send({ type: 'ping' }), PING_EVERY);
    });

    socket.addEventListener('message', (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      this.receive(message);
    });

    socket.addEventListener('close', () => {
      window.clearInterval(this.pingTimer);
      if (this.closedByUs) {
        this.handlers.onStatus('cerrado');
        return;
      }
      // Reintento con espera creciente: si el servidor se ha caido del todo, no
      // tiene sentido machacarlo diez veces por segundo.
      this.attempts += 1;
      const wait = Math.min(RETRY_MAX, RETRY_BASE * 2 ** (this.attempts - 1));
      this.handlers.onStatus('reconectando');
      this.retryTimer = window.setTimeout(() => this.connect(), wait);
    });
  }

  private receive(message: ServerMessage): void {
    switch (message.type) {
      case 'welcome':
        this.seat = message.seat;
        this.lobby = message.lobby;
        // El cambio de asiento reutiliza `welcome` sin ficha nueva.
        if (message.token) {
          this.token = message.token;
          sessionStorage.setItem(this.tokenKey(), message.token);
        }
        this.handlers.onLobby(message.lobby, message.seat);
        return;
      case 'lobby':
        this.lobby = message.lobby;
        if (this.seat !== null) this.handlers.onLobby(message.lobby, this.seat);
        return;
      case 'state':
        this.seat = message.seat;
        this.handlers.onState(message.state, message.seat);
        return;
      case 'chat':
        this.chat = message.entries;
        this.handlers.onChat(message.entries);
        return;
      case 'rejected':
        this.handlers.onRejected(message.reason);
        return;
      case 'error':
        this.handlers.onError(message.reason);
        return;
      case 'pong':
        return;
    }
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  /** Propone una jugada. Quien decide si vale es el servidor. */
  play(action: Action): void {
    this.send({ type: 'action', action });
  }

  close(): void {
    this.closedByUs = true;
    window.clearInterval(this.pingTimer);
    window.clearTimeout(this.retryTimer);
    this.socket?.close();
    this.socket = null;
  }
}
