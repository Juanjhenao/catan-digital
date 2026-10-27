import {
  applyAction,
  createGame,
  discardAmount,
  getLegalActions,
  playersToAct,
  variantForPlayers,
  VARIANT_SETUP,
  randomSeed,
  PLAYER_COLORS,
  type Action,
  type BotDifficulty,
  type BoardVariant,
  type GameState,
  type PlayerConfig,
  type PlayerId,
} from '../src/engine/index.js';
import { createBot } from '../src/ai/heuristic-bot.js';
import type { Bot } from '../src/ai/types.js';
import { CHAT_MAX_LENGTH, type ChatEntry, type Lobby, type Seat, type SeatToken } from '../src/net/protocol.js';

/**
 * Una sala: los asientos, quien esta conectado y la partida en curso.
 *
 * No sabe nada de WebSockets ni de HTTP. Recibe intenciones («este asiento
 * quiere hacer esta jugada») y devuelve el estado nuevo; quien lo reparta por
 * la red es cosa de `index.ts`. Separarlo asi es lo que permite probar la sala
 * entera sin levantar un servidor.
 *
 * La regla que gobierna todo: **la sala es la unica que aplica jugadas**. Los
 * clientes proponen. Y no basta con validar la jugada, hay que validar QUIEN la
 * manda: `applyAction` comprueba que la accion es legal para el jugador que
 * dice ser, pero nada dentro del motor impide que el asiento 2 mande una accion
 * firmada como del asiento 3. Eso se comprueba aqui.
 */

/** Cuantos asientos puede tener una sala. */
const MIN_SEATS = 2;
const MAX_SEATS = 6;

/**
 * Cuantos mensajes de chat se guardan.
 *
 * La sala vive en memoria y no se limpia sola hasta que se vacia, asi que la
 * conversacion tiene que tener tope: una partida larga con gente habladora
 * acabaria ocupando lo que le diera la gana.
 */
const CHAT_HISTORY = 120;

interface SeatRecord {
  id: PlayerId;
  name: string;
  color: (typeof PLAYER_COLORS)[number];
  kind: 'human' | 'bot';
  difficulty: BotDifficulty;
  token: SeatToken | null;
  /** Nombre de quien lo ocupa; `null` si esta libre. */
  occupant: string | null;
  connected: boolean;
}

export class Room {
  private seats: SeatRecord[] = [];
  private variant: BoardVariant | null = null;
  private victoryPoints: number | null = null;
  private hostSeat: PlayerId | null = null;
  private game: GameState | null = null;
  private bots = new Map<PlayerId, Bot>();
  /** Marca de tiempo del ultimo movimiento, para caducar salas abandonadas. */
  lastActivity = Date.now();
  private chatLog: ChatEntry[] = [];
  private nextChatId = 1;

  constructor(
    readonly code: string,
    private readonly seatCount = 4,
  ) {
    this.seats = Array.from({ length: clampSeats(seatCount) }, (_, i) => ({
      id: i,
      name: `Jugador ${i + 1}`,
      color: PLAYER_COLORS[i]!,
      kind: i === 0 ? 'human' : 'bot',
      difficulty: 'normal' as BotDifficulty,
      token: null,
      occupant: null,
      connected: false,
    }));
  }

  get started(): boolean {
    return this.game !== null;
  }

  get state(): GameState | null {
    return this.game;
  }

  /** Cuantas personas hay conectadas ahora mismo. */
  get connectedCount(): number {
    return this.seats.filter((s) => s.connected).length;
  }

  // -------------------------------------------------------------------------
  // Entrar y salir
  // -------------------------------------------------------------------------

  /**
   * Sienta a alguien.
   *
   * Con `token` se recupera el asiento que ya se tenia -- es lo que hace que
   * una reconexion despues de un corte devuelva al jugador a su sitio y no lo
   * mande al fondo de la sala con las cartas de otro.
   */
  join(name: string, token?: SeatToken): { seat: PlayerId; token: SeatToken } | { error: string } {
    if (token) {
      const mine = this.seats.find((s) => s.token === token);
      if (mine) {
        const volvia = !mine.connected;
        mine.connected = true;
        mine.occupant = name || mine.occupant;
        if (name) mine.name = name;
        if (volvia) this.announce(`${mine.name} ha vuelto.`);
        this.touch();
        return { seat: mine.id, token };
      }
      // Ficha desconocida: si la partida ya corre no hay asiento que dar, y
      // meter a alguien en uno ajeno seria peor que rechazarlo.
      if (this.game) return { error: 'La partida ya ha empezado y ese asiento ya no existe.' };
    }
    if (this.game) return { error: 'La partida ya ha empezado.' };

    const free = this.seats.find((s) => s.kind === 'human' && !s.connected && !s.token);
    const seat = free ?? this.seats.find((s) => s.kind === 'bot' && !s.token);
    if (!seat) return { error: 'La sala esta llena.' };

    seat.kind = 'human';
    seat.connected = true;
    seat.occupant = name;
    if (name) seat.name = name;
    seat.token = newToken();
    if (this.hostSeat === null) this.hostSeat = seat.id;
    this.announce(`${seat.name} se ha unido a la sala.`);
    this.touch();
    return { seat: seat.id, token: seat.token };
  }

  /** Marca un asiento como desconectado, sin liberarlo: puede volver. */
  disconnect(seat: PlayerId): void {
    const record = this.seats[seat];
    if (!record) return;
    record.connected = false;
    this.announce(
      this.game
        ? `${record.name} ha perdido la conexion.`
        : `${record.name} ha salido de la sala.`,
    );
    // Antes de empezar, quien se va libera del todo el asiento: si no, una sala
    // se llenaria de fantasmas de gente que entro a mirar y cerro la pestana.
    if (!this.game) {
      record.token = null;
      record.occupant = null;
      if (this.hostSeat === seat) {
        this.hostSeat = this.seats.find((s) => s.connected)?.id ?? null;
      }
    }
    this.touch();
  }

  // -------------------------------------------------------------------------
  // Configuracion de la sala
  // -------------------------------------------------------------------------

  takeSeat(from: PlayerId, to: PlayerId): string | null {
    if (this.game) return 'La partida ya ha empezado.';
    const target = this.seats[to];
    const current = this.seats[from];
    if (!target || !current) return 'Ese asiento no existe.';
    if (target.connected) return 'Ese asiento ya esta ocupado.';

    target.kind = 'human';
    target.token = current.token;
    target.occupant = current.occupant;
    target.name = current.name;
    target.connected = true;

    current.token = null;
    current.occupant = null;
    current.connected = false;
    current.kind = 'bot';
    current.name = `Jugador ${from + 1}`;

    if (this.hostSeat === from) this.hostSeat = to;
    this.touch();
    return null;
  }

  setSeatKind(
    actor: PlayerId,
    seat: PlayerId,
    kind: 'human' | 'bot',
    difficulty?: BotDifficulty,
  ): string | null {
    if (this.game) return 'La partida ya ha empezado.';
    if (actor !== this.hostSeat) return 'Solo el anfitrion cambia los asientos.';
    const record = this.seats[seat];
    if (!record) return 'Ese asiento no existe.';
    if (record.connected) return 'Ahi hay alguien sentado.';
    record.kind = kind;
    if (difficulty) record.difficulty = difficulty;
    record.name = kind === 'bot' ? `Bot ${seat + 1}` : `Jugador ${seat + 1}`;
    this.touch();
    return null;
  }

  configure(
    actor: PlayerId,
    options: { variant?: BoardVariant; victoryPoints?: number },
  ): string | null {
    if (this.game) return 'La partida ya ha empezado.';
    if (actor !== this.hostSeat) return 'Solo el anfitrion cambia las opciones.';
    if (options.variant) this.variant = options.variant;
    if (options.victoryPoints) this.victoryPoints = options.victoryPoints;
    this.touch();
    return null;
  }

  // -------------------------------------------------------------------------
  // La partida
  // -------------------------------------------------------------------------

  start(actor: PlayerId): string | null {
    if (this.game) return 'La partida ya ha empezado.';
    if (actor !== this.hostSeat) return 'Solo el anfitrion empieza la partida.';
    const humans = this.seats.filter((s) => s.kind === 'human' && s.connected).length;
    if (humans < 1) return 'No hay nadie sentado.';
    if (this.seats.length < MIN_SEATS) return 'Hacen falta al menos dos jugadores.';

    // Un asiento marcado como humano donde no se ha sentado nadie no lo va a
    // jugar nadie: la partida llegaria a su turno y se quedaria esperando a un
    // fantasma para siempre, sin nada en pantalla que explicara por que. Al
    // empezar, esos asientos pasan a bot.
    for (const seat of this.seats) {
      if (seat.kind === 'human' && !seat.connected) {
        seat.kind = 'bot';
        seat.name = `Bot ${seat.id + 1}`;
      }
    }

    const configs: PlayerConfig[] = this.seats.map((s) => ({
      name: s.name,
      color: s.color,
      kind: s.kind,
      ...(s.kind === 'bot' ? { difficulty: s.difficulty } : {}),
    }));

    const variant = this.variant ?? variantForPlayers(configs.length);
    const seed = randomSeed();
    this.game = createGame(configs, {
      seed,
      variant,
      victoryPoints: this.victoryPoints ?? VARIANT_SETUP[variant].victoryPoints,
    });

    this.announce('Empieza la partida. Suerte.');
    this.bots.clear();
    for (const seat of this.seats) {
      if (seat.kind === 'bot') {
        this.bots.set(seat.id, createBot(seat.difficulty, seed + seat.id * 7919));
      }
    }
    this.touch();
    return null;
  }

  /**
   * Devuelve la sala a la pantalla de espera con la misma gente dentro.
   *
   * Es lo que pasa al terminar una partida. Antes no existia: quien pulsaba el
   * boton de la pantalla de victoria cerraba su conexion y recargaba la pagina,
   * de modo que acabar una partida echaba del servidor a quien la habia jugado
   * y habia que volver a dictar el codigo para jugar otra.
   *
   * Se conservan los asientos, las fichas de sesion y la conversacion: la mesa
   * es la misma, lo unico que se tira es la partida. Y se pide que haya
   * terminado -- si no, cualquiera podria borrar de un plumazo la partida de
   * los demas a media jugada.
   */
  returnToLobby(actor: PlayerId): string | null {
    if (!this.game) return 'No hay ninguna partida que cerrar.';
    if (this.game.phase !== 'gameOver') return 'La partida aun no ha terminado.';
    const who = this.seats[actor];
    if (!who) return 'Ese asiento no existe.';

    this.game = null;
    this.bots.clear();
    // Quien se desconecto a media partida conservaba su asiento por si volvia.
    // Terminada la partida ya no hay nada que guardarle, y dejarlo cogido
    // impediria sentarse ahi a quien llegue para la siguiente.
    for (const seat of this.seats) {
      if (seat.connected) continue;
      seat.token = null;
      seat.occupant = null;
      seat.kind = 'bot';
      seat.name = `Bot ${seat.id + 1}`;
    }
    if (this.hostSeat === null || !this.seats[this.hostSeat]?.connected) {
      this.hostSeat = this.seats.find((s) => s.connected)?.id ?? null;
    }
    this.announce(`${who.name} vuelve a la sala. Podeis jugar otra.`);
    this.touch();
    return null;
  }

  /**
   * Aplica una jugada que llega de un asiento.
   *
   * Comprueba dos cosas distintas y las dos hacen falta: que la accion sea
   * legal (de eso ya sabe el motor) y que quien la manda sea el jugador que
   * figura en ella. Sin lo segundo, cualquiera podria mandar
   * `{type:'endTurn', player: 2}` y pasarle el turno a un rival, o peor,
   * `{type:'discard', player: 2, ...}` y tirarle las cartas.
   */
  play(seat: PlayerId, action: Action): string | null {
    if (!this.game) return 'La partida no ha empezado.';
    if (action.player !== seat) return 'Esa jugada no es tuya.';
    const result = applyAction(this.game, action);
    if (!result.ok) return result.error ?? 'Jugada no permitida.';
    this.game = result.state;
    this.touch();
    return null;
  }

  /**
   * Deja que jueguen los bots a los que les toque.
   *
   * Devuelve `true` si alguno ha movido, para que quien llama sepa que hay que
   * volver a repartir el estado. Se hace de uno en uno y desde fuera, con una
   * pausa entre medias, para que en la pantalla se vea lo que hacen en vez de
   * aparecer el turno ya resuelto.
   */
  stepBots(): boolean {
    const state = this.game;
    if (!state || state.phase === 'gameOver') return false;
    for (const id of playersToAct(state)) {
      const bot = this.bots.get(id);
      if (!bot) continue;
      const action = this.botAction(state, bot, id);
      if (!action) continue;
      const result = applyAction(state, action);
      if (!result.ok) continue;
      this.game = result.state;
      this.touch();
      return true;
    }
    return false;
  }

  /**
   * Que hace un bot al que le toca.
   *
   * El descarte va aparte porque `getLegalActions` NO lo enumera: los repartos
   * posibles de media mano son demasiados, asi que quien llama tiene que
   * construirlo con `chooseDiscard`. Aqui faltaba, y la consecuencia era peor
   * que un bot torpe: la lista de legales le salia vacia, no movia nunca, y con
   * el la sala entera se quedaba clavada en la fase de descarte hasta que
   * alguien cerraba el servidor. Con un 7 y un bot con mas de siete cartas --
   * que es lo normal a media partida -- la partida en red no seguia.
   */
  private botAction(state: GameState, bot: Bot, id: PlayerId): Action | null {
    if (state.phase === 'discard' && state.mustDiscard.includes(id)) {
      return {
        type: 'discard',
        player: id,
        resources: bot.chooseDiscard(state, id, discardAmount(state, id)),
      };
    }
    const legal = getLegalActions(state, id);
    return legal.length === 0 ? null : bot.decide(state, id, legal);
  }

  /** Si queda algun bot esperando a mover. */
  botPending(): boolean {
    const state = this.game;
    if (!state || state.phase === 'gameOver') return false;
    return playersToAct(state).some((id) => this.bots.has(id));
  }

  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Chat
  // -------------------------------------------------------------------------

  /** La conversacion hasta ahora. */
  chat(): ChatEntry[] {
    return this.chatLog;
  }

  /**
   * Anota lo que dice alguien.
   *
   * El nombre lo pone la SALA a partir del asiento, no el mensaje: si viniera
   * en el mensaje, cualquiera podria firmar como otro y decir cosas en su
   * nombre. Es la misma razon por la que una jugada se comprueba contra el
   * asiento que la manda.
   */
  say(seat: PlayerId, text: string): void {
    const record = this.seats[seat];
    if (!record) return;
    this.push(seat, record.occupant ?? record.name, text);
  }

  /** Un aviso del propio juego, sin autor. */
  announce(text: string): void {
    this.push(null, '', text);
  }

  private push(seat: PlayerId | null, name: string, text: string): void {
    const clean = text.trim().slice(0, CHAT_MAX_LENGTH);
    if (!clean) return;
    this.chatLog.push({ id: this.nextChatId++, seat, name, text: clean, at: Date.now() });
    if (this.chatLog.length > CHAT_HISTORY) {
      this.chatLog = this.chatLog.slice(-CHAT_HISTORY);
    }
    this.touch();
  }

  lobby(): Lobby {
    const seats: Seat[] = this.seats.map((s) => ({
      id: s.id,
      name: s.name,
      color: s.color,
      kind: s.kind,
      difficulty: s.difficulty,
      occupied: s.connected,
      occupantName: s.occupant,
    }));
    return {
      code: this.code,
      seats,
      variant: this.variant ?? variantForPlayers(this.seats.length),
      victoryPoints: this.victoryPoints ?? 10,
      hostSeat: this.hostSeat,
      started: this.game !== null,
    };
  }

  private touch(): void {
    this.lastActivity = Date.now();
  }
}

function clampSeats(n: number): number {
  return Math.max(MIN_SEATS, Math.min(MAX_SEATS, Math.round(n)));
}

let tokenCounter = 0;
function newToken(): SeatToken {
  tokenCounter += 1;
  return `${Date.now().toString(36)}-${tokenCounter.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}
