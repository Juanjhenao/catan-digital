import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { redactFor } from '../src/net/redact.js';
import {
  makeRoomCode,
  normalizeRoomCode,
  parseClientMessage,
  PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
} from '../src/net/protocol.js';
import { Room } from './room.js';
import type { PlayerId } from '../src/engine/index.js';

/**
 * Servidor de partidas en red local.
 *
 * Hace dos cosas a la vez y a proposito: sirve el juego ya compilado por HTTP y
 * atiende las partidas por WebSocket **en el mismo puerto**. Asi montar una
 * partida en casa es una sola orden y una sola direccion que dictar -- quien se
 * conecta abre la URL y ya esta, sin instalar nada.
 *
 *   npm run build && npm run serve
 *
 * No lleva cuentas de usuario ni base de datos: las salas viven en memoria y se
 * borran solas cuando se quedan vacias. Es una tarde de juegos en el salon, no
 * un servicio.
 *
 * **Aviso de alcance.** Esto esta pensado para una red de confianza. El trafico
 * va en claro (ws://, no wss://) y el unico control de acceso es el codigo de
 * cuatro letras de la sala. Vale para la wifi de casa; no lo expongas a
 * internet tal cual.
 */

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';
const DIST = resolve(process.cwd(), 'dist');

/** Cada cuanto mueve ficha un bot, en ms. Con pausa se sigue lo que hacen. */
const BOT_DELAY = 900;

/** Salas sin nadie conectado que se borran pasado este tiempo. */
const ROOM_TTL = 1000 * 60 * 30;

// ---------------------------------------------------------------------------
// Salas
// ---------------------------------------------------------------------------

const rooms = new Map<string, Room>();
/** Que sockets miran cada sala. */
const watchers = new Map<string, Set<Client>>();

interface Client {
  socket: WebSocket;
  room: Room | null;
  seat: PlayerId | null;
}

function send(client: Client, message: ServerMessage): void {
  if (client.socket.readyState === client.socket.OPEN) {
    client.socket.send(JSON.stringify(message));
  }
}

/**
 * Reparte el estado a todo el mundo, **censurado para cada uno**.
 *
 * Es el sitio donde de verdad se protege la informacion oculta: aqui se llama a
 * `redactFor` una vez por destinatario, con su asiento. Mandar el estado tal
 * cual y confiar en que la interfaz no lo ensene no serviria de nada, porque el
 * mensaje se lee entero desde las herramientas del navegador.
 */
function broadcastState(room: Room): void {
  const state = room.state;
  if (!state) return;
  for (const client of watchers.get(room.code) ?? []) {
    if (client.seat === null) continue;
    send(client, { type: 'state', state: redactFor(state, client.seat), seat: client.seat });
  }
}

function broadcastLobby(room: Room): void {
  const lobby = room.lobby();
  for (const client of watchers.get(room.code) ?? []) send(client, { type: 'lobby', lobby });
}

function broadcastChat(room: Room): void {
  const entries = room.chat();
  for (const client of watchers.get(room.code) ?? []) send(client, { type: 'chat', entries });
}

/**
 * Deja jugar a los bots, uno cada `BOT_DELAY`.
 *
 * Se hace con temporizador y no en bucle porque si no el turno entero de los
 * bots aparece resuelto de golpe: se ve el resultado pero no lo que han hecho,
 * que es justo lo que hay que poder seguir para jugar contra ellos.
 */
const botTimers = new Map<string, NodeJS.Timeout>();

function pumpBots(room: Room): void {
  const existing = botTimers.get(room.code);
  if (existing) return;
  if (!room.botPending()) return;
  const timer = setTimeout(() => {
    botTimers.delete(room.code);
    if (!room.stepBots()) {
      // Que no mueva puede ser normal: una jugada humana llegada mientras
      // corria el temporizador puede haber dejado de tocarle. Lo que no puede
      // ser es que le siga tocando y no pueda mover, porque entonces volver a
      // llamar repetiria el intento cada 900 ms para siempre con la sala igual
      // de parada. Se corta aqui y se deja constancia.
      if (room.botPending()) {
        console.error(
          `sala ${room.code}: un bot no ha podido mover; se detiene el turno automatico`,
        );
      }
      return;
    }
    broadcastState(room);
    pumpBots(room);
  }, BOT_DELAY);
  botTimers.set(room.code, timer);
}

// ---------------------------------------------------------------------------
// HTTP: el juego compilado
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  if (!existsSync(DIST)) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Falta la carpeta dist. Ejecuta antes: npm run build');
    return;
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  // `normalize` mas la comprobacion de prefijo cortan los `..`: sin esto,
  // pedir /../../algo serviria cualquier archivo del disco.
  const wanted = normalize(join(DIST, decodeURIComponent(url.pathname)));
  const target =
    wanted.startsWith(DIST) && existsSync(wanted) && statSync(wanted).isFile()
      ? wanted
      : join(DIST, 'index.html');

  res.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' });
  createReadStream(target).pipe(res);
}

const http = createServer(serveStatic);
const wss = new WebSocketServer({ server: http });

// ---------------------------------------------------------------------------
// WebSocket: las partidas
// ---------------------------------------------------------------------------

wss.on('connection', (socket: WebSocket) => {
  const client: Client = { socket, room: null, seat: null };

  // `ws` exige un manejador de error en cada socket: sin el, un corte brusco
  // se convierte en excepcion sin capturar y tumba el proceso. El cierre se
  // trata abajo, asi que aqui no hay nada que hacer salvo no morirse.
  socket.on('error', () => {});

  socket.on('message', (raw) => {
    let message: ClientMessage | null = null;
    try {
      message = parseClientMessage(JSON.parse(String(raw)));
    } catch {
      message = null;
    }
    if (!message) {
      send(client, { type: 'error', reason: 'Mensaje ilegible.' });
      return;
    }
    try {
      handle(client, message);
    } catch (error) {
      // Un fallo atendiendo a UN cliente no puede llevarse la partida de los
      // demas por delante. Se le avisa a el y el servidor sigue en pie.
      console.error('fallo atendiendo un mensaje:', error);
      send(client, { type: 'error', reason: 'El servidor no ha podido atender esa peticion.' });
    }
  });

  socket.on('close', () => {
    if (!client.room || client.seat === null) return;
    const room = client.room;
    room.disconnect(client.seat);
    watchers.get(room.code)?.delete(client);
    broadcastLobby(room);
    broadcastChat(room);
  });
});

function handle(client: Client, message: ClientMessage): void {
  if (message.type === 'ping') {
    send(client, { type: 'pong' });
    return;
  }

  if (message.type === 'join') {
    if (message.version !== PROTOCOL_VERSION) {
      send(client, {
        type: 'error',
        reason: 'Tu version del juego no cuadra con la del servidor. Recarga la pagina.',
      });
      return;
    }
    const code = normalizeRoomCode(message.room);
    // Sin codigo se crea sala nueva: es lo que hace el anfitrion.
    const room = code ? rooms.get(code) : createRoom();
    if (!room) {
      send(client, { type: 'error', reason: `No hay ninguna sala con el codigo ${code}.` });
      return;
    }
    const seated = room.join(message.name, message.token);
    if ('error' in seated) {
      send(client, { type: 'error', reason: seated.error });
      return;
    }
    client.room = room;
    client.seat = seated.seat;
    let set = watchers.get(room.code);
    if (!set) {
      set = new Set();
      watchers.set(room.code, set);
    }
    set.add(client);

    send(client, {
      type: 'welcome',
      seat: seated.seat,
      token: seated.token,
      lobby: room.lobby(),
    });
    broadcastLobby(room);
    // La conversacion entera, tambien a quien acaba de llegar: lo que se ha
    // dicho antes es parte de la partida.
    broadcastChat(room);
    // Quien vuelve a una partida en curso necesita el estado ya mismo.
    if (room.started) broadcastState(room);
    return;
  }

  const room = client.room;
  const seat = client.seat;
  if (!room || seat === null) {
    send(client, { type: 'error', reason: 'Todavia no estas en ninguna sala.' });
    return;
  }

  switch (message.type) {
    case 'takeSeat': {
      const error = room.takeSeat(seat, message.seat);
      if (error) {
        send(client, { type: 'rejected', reason: error });
        return;
      }
      client.seat = message.seat;
      send(client, { type: 'welcome', seat: message.seat, token: '', lobby: room.lobby() });
      broadcastLobby(room);
      return;
    }
    case 'setSeatKind': {
      const error = room.setSeatKind(seat, message.seat, message.kind, message.difficulty);
      if (error) send(client, { type: 'rejected', reason: error });
      else broadcastLobby(room);
      return;
    }
    case 'configure': {
      const error = room.configure(seat, message);
      if (error) send(client, { type: 'rejected', reason: error });
      else broadcastLobby(room);
      return;
    }
    case 'start': {
      const error = room.start(seat);
      if (error) {
        send(client, { type: 'rejected', reason: error });
        return;
      }
      broadcastLobby(room);
      broadcastChat(room);
      broadcastState(room);
      pumpBots(room);
      return;
    }
    case 'returnToLobby': {
      // Si ya la ha cerrado otro, esto no es un fallo: es que dos personas han
      // pulsado el mismo boton. Se le manda la sala y en paz -- responder con
      // un rechazo le pintaria un error en la pantalla de espera por haber
      // hecho justo lo que se le pedia.
      if (!room.started) {
        send(client, { type: 'lobby', lobby: room.lobby() });
        return;
      }
      const error = room.returnToLobby(seat);
      if (error) {
        send(client, { type: 'rejected', reason: error });
        return;
      }
      // El reloj de los bots pertenecia a la partida que se acaba de tirar.
      const timer = botTimers.get(room.code);
      if (timer) clearTimeout(timer);
      botTimers.delete(room.code);
      broadcastLobby(room);
      broadcastChat(room);
      return;
    }
    case 'chat': {
      room.say(seat, message.text);
      broadcastChat(room);
      return;
    }
    case 'action': {
      const error = room.play(seat, message.action);
      if (error) {
        send(client, { type: 'rejected', reason: error });
        // Aun asi se le reenvia el estado: si su copia se habia desincronizado,
        // esto la vuelve a poner en su sitio en vez de dejarla divergiendo.
        send(client, { type: 'state', state: redactFor(room.state!, seat), seat });
        return;
      }
      broadcastState(room);
      pumpBots(room);
      return;
    }
  }
}

function createRoom(): Room {
  let code = makeRoomCode();
  while (rooms.has(code)) code = makeRoomCode();
  const room = new Room(code);
  rooms.set(code, room);
  return room;
}

/** Barre salas vacias, para que el proceso no crezca sin fin. */
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.connectedCount > 0) continue;
    if (now - room.lastActivity < ROOM_TTL) continue;
    const timer = botTimers.get(code);
    if (timer) clearTimeout(timer);
    botTimers.delete(code);
    watchers.delete(code);
    rooms.delete(code);
  }
}, 60_000).unref();

// ---------------------------------------------------------------------------

/** Las direcciones IPv4 de esta maquina en la red local, para dictarlas. */
function localAddresses(): string[] {
  const out: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) out.push(entry.address);
    }
  }
  return out;
}

http.listen(PORT, HOST, () => {
  const addresses = localAddresses();
  console.log('\n  Colonos — servidor de red local\n');
  console.log(`  En esta maquina:  http://localhost:${PORT}/`);
  for (const address of addresses) {
    console.log(`  Desde la red:     http://${address}:${PORT}/`);
  }
  if (addresses.length === 0) {
    console.log('  (no se ha encontrado ninguna direccion de red local)');
  }
  if (!existsSync(DIST)) {
    console.log('\n  Falta dist/. Ejecuta antes:  npm run build');
  }
  console.log('');
});
