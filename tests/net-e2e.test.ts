// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { getLegalActions, type GameState } from '../src/engine/index.js';
import { findLeaks, redactFor } from '../src/net/redact.js';
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type Lobby,
  type ServerMessage,
} from '../src/net/protocol.js';
import { Room } from '../server/room.js';

/**
 * La partida en red, de punta a punta y por un socket de verdad.
 *
 * Los otros tests comprueban la sala y la censura por separado, llamando a las
 * funciones. Este levanta un servidor, conecta dos clientes reales y juega: es
 * lo unico que demuestra que las piezas encajan -- que el JSON va y vuelve, que
 * cada cliente recibe SU version del estado, y que el turno pasa de uno a otro.
 *
 * El servidor de aqui es un calco minimo del de `server/index.ts`: solo la
 * parte de WebSocket, sin el servidor de archivos. Montarlo asi mantiene el
 * test rapido y sin depender de que exista `dist/`.
 */

let http: Server;
let wss: WebSocketServer;
let port = 0;
let room: Room;
const seats = new Map<WebSocket, number>();

/** Sala limpia y sin nadie sentado, para que un test no herede el del anterior. */
function resetRoom(): void {
  room = new Room('TEST', 2);
  seats.clear();
}

beforeAll(async () => {
  resetRoom();

  http = createServer();
  wss = new WebSocketServer({ server: http });

  const send = (socket: WebSocket, message: ServerMessage) => socket.send(JSON.stringify(message));
  const broadcastState = () => {
    const state = room.state;
    if (!state) return;
    for (const [socket, seat] of seats) {
      send(socket, { type: 'state', state: redactFor(state, seat), seat });
    }
  };
  const broadcastLobby = () => {
    const lobby = room.lobby();
    for (const socket of seats.keys()) send(socket, { type: 'lobby', lobby });
  };

  wss.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as ClientMessage;
      if (message.type === 'join') {
        const seated = room.join(message.name, message.token);
        if ('error' in seated) {
          send(socket, { type: 'error', reason: seated.error });
          return;
        }
        seats.set(socket, seated.seat);
        send(socket, {
          type: 'welcome',
          seat: seated.seat,
          token: seated.token,
          lobby: room.lobby(),
        });
        return;
      }
      const seat = seats.get(socket);
      if (seat === undefined) return;
      if (message.type === 'start') {
        const error = room.start(seat);
        if (error) send(socket, { type: 'rejected', reason: error });
        else broadcastState();
        return;
      }
      if (message.type === 'returnToLobby') {
        const error = room.returnToLobby(seat);
        if (error) send(socket, { type: 'rejected', reason: error });
        else broadcastLobby();
        return;
      }
      if (message.type === 'action') {
        const error = room.play(seat, message.action);
        if (error) send(socket, { type: 'rejected', reason: error });
        else broadcastState();
      }
    });
  });

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  port = (http.address() as AddressInfo).port;
});

afterAll(async () => {
  wss.close();
  await new Promise<void>((resolve) => http.close(() => resolve()));
});

/** Un cliente de pruebas que sabe esperar a un mensaje concreto. */
class TestClient {
  private socket!: WebSocket;
  private queue: ServerMessage[] = [];
  private waiters: ((m: ServerMessage) => void)[] = [];
  seat = -1;
  state: GameState | null = null;
  lobby: Lobby | null = null;

  /** Si el socket sigue abierto. Es lo que separa «volver a la sala» de «irse». */
  get open(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }

  async connect(name: string): Promise<void> {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });
    this.socket.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as ServerMessage;
      if (message.type === 'state') {
        this.seat = message.seat;
        this.state = message.state;
      }
      if (message.type === 'welcome') {
        this.seat = message.seat;
        this.lobby = message.lobby;
      }
      if (message.type === 'lobby') this.lobby = message.lobby;
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.queue.push(message);
    });
    this.send({ type: 'join', version: PROTOCOL_VERSION, room: 'TEST', name });
    await this.next();
  }

  send(message: ClientMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  next(): Promise<ServerMessage> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      setTimeout(() => resolve({ type: 'error', reason: 'tiempo agotado' }), 3000);
    });
  }

  close(): void {
    this.socket.close();
  }
}

describe('partida en red de punta a punta', () => {
  it('dos clientes juegan una colocacion inicial completa, cada uno con su vista', async () => {
    const ana = new TestClient();
    const bruno = new TestClient();
    await ana.connect('Ana');
    await bruno.connect('Bruno');
    expect(ana.seat).toBe(0);
    expect(bruno.seat).toBe(1);

    ana.send({ type: 'start' });
    await ana.next();
    await bruno.next();
    expect(ana.state).not.toBeNull();
    expect(bruno.state).not.toBeNull();

    // Cada uno recibe su propia version, y ninguna trae nada de contrabando.
    expect(findLeaks(ana.state!, 0)).toEqual([]);
    expect(findLeaks(bruno.state!, 1)).toEqual([]);

    // Una jugada mandada por quien no le toca se rechaza aunque sea legal.
    const turn = ana.state!.currentPlayer;
    const wrong = turn === 0 ? bruno : ana;
    const right = turn === 0 ? ana : bruno;
    const legal = getLegalActions(ana.state!, turn);
    wrong.send({ type: 'action', action: legal[0]! });
    const refused = await wrong.next();
    expect(refused.type).toBe('rejected');

    // La colocacion inicial entera, alternando de cliente en cliente.
    for (let guard = 0; guard < 40; guard++) {
      const state = right.state ?? ana.state!;
      if (state.phase !== 'setupSettlement' && state.phase !== 'setupRoad') break;
      const actor = state.currentPlayer;
      const client = actor === 0 ? ana : bruno;
      const moves = getLegalActions(state, actor);
      expect(moves.length).toBeGreaterThan(0);
      client.send({ type: 'action', action: moves[0]! });
      await ana.next();
      await bruno.next();
    }

    expect(ana.state!.phase).toBe('roll');
    // Los dos han seguido la misma partida.
    expect(ana.state!.turn).toBe(bruno.state!.turn);
    expect(Object.keys(ana.state!.buildings)).toEqual(Object.keys(bruno.state!.buildings));
    // Y cada uno ve solo su mano.
    expect(findLeaks(ana.state!, 0)).toEqual([]);
    expect(findLeaks(bruno.state!, 1)).toEqual([]);

    ana.close();
    bruno.close();
  }, 20_000);

  it('al terminar la partida vuelven a la sala sin perder la conexion', async () => {
    // El fallo que traia: el boton de la pantalla de victoria cerraba el socket
    // y recargaba la pagina, asi que acabar una partida echaba del servidor a
    // quien la habia jugado y habia que volver a dictar el codigo para otra.
    resetRoom();
    const ana = new TestClient();
    const bruno = new TestClient();
    await ana.connect('Ana');
    await bruno.connect('Bruno');

    ana.send({ type: 'start' });
    await ana.next();
    await bruno.next();

    // Mientras la partida vive, la sala no se puede cerrar.
    ana.send({ type: 'returnToLobby' });
    expect((await ana.next()).type).toBe('rejected');

    room.state!.phase = 'gameOver';
    room.state!.winner = 0;
    ana.send({ type: 'returnToLobby' });
    await ana.next();
    await bruno.next();

    // Los dos siguen conectados y los dos ven la sala de espera, con su sitio.
    expect(ana.open).toBe(true);
    expect(bruno.open).toBe(true);
    expect(ana.lobby!.started).toBe(false);
    expect(bruno.lobby!.started).toBe(false);
    expect(ana.lobby!.code).toBe('TEST');
    expect(bruno.lobby!.seats[1]!.occupantName).toBe('Bruno');

    // Y desde ahi se empieza otra sin volver a entrar.
    ana.send({ type: 'start' });
    await ana.next();
    await bruno.next();
    expect(room.started).toBe(true);
    expect(ana.state!.phase).toBe('setupSettlement');

    ana.close();
    bruno.close();
  }, 20_000);
});
