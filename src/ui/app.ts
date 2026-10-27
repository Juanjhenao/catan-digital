import {
  applyAction,
  canOfferTrade,
  COSTS,
  createGame,
  defaultDiscard,
  discardAmount,
  getLegalActions,
  hasResources,
  piecesFor,
  playersToAct,
  publicVictoryPoints,
  RESOURCES,
  totalResources,
  handSize,
  devCardCount,
  devDeckSize,
  tradeRatio,
  victoryPoints,
  type Action,
  type BoardVariant,
  type BotDifficulty,
  type DevCardKind,
  type EdgeId,
  type GameState,
  type HexId,
  type PlayerConfig,
  type PlayerId,
  type Resource,
  type ResourceCount,
  type VertexId,
} from '../engine/index.js';
import { createBot } from '../ai/heuristic-bot.js';
import type { Bot } from '../ai/types.js';
import { BoardView, type Highlight, type Pick, type Reserve } from './board-view.js';
import { isMuted, play, playClick, setMuted, type Cue } from './sound.js';
import type { NetClient } from '../net/client.js';
import type { ChatEntry } from '../net/protocol.js';
import { ChatPanel } from './chat.js';
import { clear, el, replace, stepper } from './dom.js';
import { devCard, resourceCard, resourceCardButton } from './cards.js';
import { icon, type IconName } from './icons.js';
import { PLAYER_PALETTE, RESOURCE_COLOR, RESOURCE_LABEL } from './theme.js';

/** Modo de interaccion del tablero: que espera la interfaz que pulses. */
type UiMode =
  | { kind: 'idle' }
  | { kind: 'road' }
  | { kind: 'settlement' }
  | { kind: 'city' };

/** Segundos de que dispone un humano para resolver cada jugada. */
export const TURN_SECONDS = 30;

/**
 * Que hace la interfaz cuando se acaba el tiempo, en orden de preferencia.
 *
 * Solo entran obligaciones que el jugador NO puede saltarse (tirar, descartar,
 * mover el ladron, colocar en la salida) y el cierre del turno. Nunca se
 * construye ni se compra por el: el reloj cumple los tramites pendientes, no
 * gasta los recursos de nadie.
 */
/**
 * Que suena con cada jugada.
 *
 * Las que no aparecen no suenan por si mismas: `offerTrade` y `respondTrade`
 * solo mueven una ventana, y el «toc» del boton ya las acompana.
 */
const ACTION_CUE: Partial<Record<Action['type'], Cue>> = {
  setupSettlement: 'settlement',
  buildSettlement: 'settlement',
  buildCity: 'city',
  setupRoad: 'road',
  buildRoad: 'road',
  rollDice: 'dice',
  discard: 'discard',
  moveRobber: 'robber',
  steal: 'steal',
  buyDevCard: 'devBuy',
  playKnight: 'knight',
  playRoadBuilding: 'devPlay',
  playYearOfPlenty: 'devPlay',
  playMonopoly: 'devPlay',
  bankTrade: 'trade',
  confirmTrade: 'trade',
  endTurn: 'endTurn',
};

const TIMEOUT_ORDER: Action['type'][] = [
  'rollDice',
  'moveRobber',
  'steal',
  'setupSettlement',
  'setupRoad',
  'endTurn',
  // Ultimo recurso: durante la construccion de carreteras no hay forma de
  // pasar sin colocar los caminos gratis.
  'buildRoad',
];

/** Como se nombra cada nivel en la interfaz. */
export const DIFFICULTY_LABEL: Record<BotDifficulty, string> = {
  easy: 'bot facil',
  normal: 'bot normal',
  hard: 'bot dificil',
};

const RESOURCE_ICON: Record<Resource, string> = {
  lumber: '🌲',
  brick: '🧱',
  wool: '🐑',
  grain: '🌾',
  ore: '⛰️',
};

export class GameApp {
  private state: GameState;
  private view: BoardView;
  private mode: UiMode = { kind: 'idle' };
  /** Jugador para el que ya se ha levantado el escudo de privacidad. */
  private revealedFor: PlayerId | null = null;
  /** Ventana abierta a peticion del jugador (no forzada por la fase). */
  private modal: (() => HTMLElement) | null = null;
  private flashMessage: string | null = null;
  private flashTimer = 0;
  /** Cerebro de cada jugador controlado por la maquina (null si es humano). */
  private readonly bots: (Bot | null)[];
  private botTimer = 0;
  /** Los bots juegan con pausa para poder seguirlos; se puede quitar. */
  private fastBots = false;
  /** Reloj de la jugada en curso: instante en que se agota, en ms. */
  private deadline: number | null = null;
  /** Identidad de la jugada a la que pertenece el reloj en marcha. */
  private clockKey = '';
  private clockTimer = 0;
  private clockEl: HTMLElement | null = null;
  /** Ultimo jugador anunciado en el banner, para animar solo los cambios. */
  private bannerOwner: PlayerId | null = null;
  /** El limite de tiempo se puede desactivar desde la barra superior. */
  private clockOn = true;
  /** Recursos cuya carta esta parpadeando porque acaba de cambiar la cuenta. */
  private handPulse = new Set<Resource>();
  private handSnapshot: { owner: PlayerId; hand: ResourceCount } | null = null;
  private handPulseTimer = 0;
  /** Escuchadores de la barra superior, para poder soltarlos al cerrar. */
  private readonly listeners = new AbortController();
  /** Ver `options.onFinish`. */
  private readonly onFinish: (() => void) | null = null;

  /**
   * En partida de red: el enlace con el servidor y el asiento propio.
   *
   * Cuando esto no es `null` cambian tres cosas y solo tres: las jugadas se
   * mandan en vez de aplicarse, el estado llega de fuera en vez de calcularse,
   * y la mano que se ensena es siempre la de `seat` -- nunca la del jugador en
   * turno. Todo lo demas de la interfaz no se entera de que hay red.
   */
  private net: { client: NetClient; seat: PlayerId } | null = null;
  /** Ultimo estado conocido de la conexion, en partida de red. */
  private connection = 'conectado';

  private chat: ChatPanel | null = null;
  /** Contador de mensajes en partidas locales, donde no hay servidor que los numere. */
  private localChatId = 0;

  private readonly gameEl = document.getElementById('game')!;
  private readonly setupEl = document.getElementById('setup')!;
  private readonly overlayEl = document.getElementById('overlay')!;
  private readonly playersEl = document.getElementById('players')!;
  private readonly logEl = document.getElementById('log-list')!;
  private readonly handbarEl = document.getElementById('handbar')!;
  private readonly bannerEl = document.getElementById('turn-banner')!;
  private readonly hintEl = document.getElementById('board-hint')!;

  constructor(
    configs: PlayerConfig[],
    seed: number,
    victoryTarget: number | undefined,
    private onExit: () => void,
    options: {
      variant?: BoardVariant;
      /** Partida en red: estado inicial ya recibido, enlace y asiento propio. */
      net?: { client: NetClient; seat: PlayerId; state: GameState };
      /**
       * Que hacer cuando la partida ACABA, si es distinto de abandonarla.
       *
       * En red no es lo mismo terminar que irse: al terminar se vuelve a la sala
       * -- misma gente, mismos asientos, mismo codigo -- y desde ahi se juega
       * otra. Cerrar la conexion en ese momento, que es lo que hacia antes,
       * echaba a todo el mundo del servidor nada mas cantar la victoria.
       */
      onFinish?: () => void;
    } = {},
  ) {
    this.onFinish = options.onFinish ?? null;
    this.net = options.net ? { client: options.net.client, seat: options.net.seat } : null;
    this.state =
      options.net?.state ??
      createGame(configs, {
        seed,
        victoryPoints: victoryTarget,
        variant: options.variant,
      });
    // Cada bot lleva su propia semilla derivada de la de la partida, para que
    // una partida repetida con la misma semilla salga identica. En red no hay
    // ninguno de este lado: los mueve el servidor, que es el unico que tiene el
    // estado entero y no puede fiarse de que un cliente juegue por ellos.
    this.bots = this.net
      ? configs.map(() => null)
      : configs.map((config, id) =>
          config.kind === 'bot' ? createBot(config.difficulty ?? 'normal', seed + id * 7919) : null,
        );
    this.view = new BoardView(
      document.getElementById('board') as HTMLCanvasElement,
      (pick) => this.handlePick(pick),
      // Los dados del tablero son un atajo de los botones de la barra: mismas
      // acciones, mismas comprobaciones, para no tener dos caminos que puedan
      // divergir.
      () => this.useDice(),
    );

    const on = { signal: this.listeners.signal };
    document.getElementById('btn-new')!.addEventListener('click', () => this.confirmExit(), on);
    document.getElementById('btn-speed')?.addEventListener('click', () => {
      this.fastBots = !this.fastBots;
      this.render();
    }, on);
    if (this.net) {
      // El ritmo de los bots lo pone el servidor: el boton de aqui no llegaria
      // a nadie mas y ensenaria un ajuste que no hace nada.
      document.getElementById('btn-speed')?.classList.add('hidden');
    }
    document.getElementById('btn-rules')!.addEventListener('click', () => {
      this.modal = () => this.renderRules();
      this.render();
    }, on);
    document.getElementById('btn-clock')?.addEventListener('click', () => {
      this.clockOn = !this.clockOn;
      this.render();
    }, on);
    document.getElementById('btn-sound')?.addEventListener('click', () => {
      setMuted(!isMuted());
      this.render();
    }, on);

    // Un «toc» para los botones que no lanzan jugada (abrir una ventana, pasar
    // de pestana). Se pone UNA vez aqui arriba en vez de en cada `onclick`: la
    // barra de la mano se vuelve a construir entera en cada repintado, y colgar
    // el sonido pieza a pieza seria repetirlo en cuarenta sitios y olvidarlo en
    // el siguiente boton que se anada. `playClick` ya se calla solo si la
    // jugada ha sonado.
    this.gameEl.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('button')) playClick();
    }, on);

    const chatEl = document.getElementById('chat');
    if (chatEl) {
      this.chat = new ChatPanel(chatEl, {
        onSend: (text) => this.say(text),
        seatColor: (seat) => this.state.players[seat]?.color ?? null,
        mySeat: () => this.net?.seat ?? this.handOwner,
      });
    }

    this.setupEl.classList.add('hidden');
    this.gameEl.classList.remove('hidden');
    // El primer jugador tambien pasa por el escudo, para que nadie vea el
    // reparto inicial de otro por accidente.
    requestAnimationFrame(() => {
      this.view.resize();
      this.render();
    });
  }

  // -------------------------------------------------------------------------
  // Quien actua y que ve
  // -------------------------------------------------------------------------

  /**
   * Jugador cuya mano se muestra en la barra inferior. Es tambien el que
   * dispara el escudo de privacidad al cambiar.
   */
  private get handOwner(): PlayerId {
    // En red cada persona tiene su pantalla, asi que la mano de abajo es SIEMPRE
    // la suya: se ven las cartas propias mientras juega otro, que es lo normal
    // en una mesa de verdad y lo que el modo por turnos en un solo aparato no
    // puede permitirse.
    if (this.net) return this.net.seat;
    const s = this.state;
    if (s.phase === 'discard') return s.mustDiscard[0] ?? s.currentPlayer;
    return s.currentPlayer;
  }

  // -------------------------------------------------------------------------
  // Turno de los bots
  // -------------------------------------------------------------------------

  /**
   * Primer jugador controlado por la maquina al que le toca actuar.
   *
   * Se consulta `playersToAct` y no `handOwner` porque no siempre coinciden: si
   * un humano pone una oferta sobre la mesa, quien tiene que decidir son los
   * demas, aunque la mano que se sigue mostrando sea la del que ofrece.
   */
  private get actingBot(): PlayerId | null {
    if (this.state.phase === 'gameOver') return null;
    for (const id of playersToAct(this.state)) {
      if (this.state.players[id]!.kind === 'bot') return id;
    }
    return null;
  }

  private scheduleBot(): void {
    window.clearTimeout(this.botTimer);
    const bot = this.actingBot;
    if (bot === null) return;
    // La pausa existe para que se pueda seguir la partida: sin ella los bots
    // resuelven varios turnos entre dos parpadeos y no se entiende nada.
    const delay = this.fastBots ? 90 : this.state.phase === 'roll' ? 850 : 550;
    this.botTimer = window.setTimeout(() => this.playBot(bot), delay);
  }

  private playBot(id: PlayerId): void {
    // El estado puede haber cambiado mientras corria el temporizador.
    if (this.actingBot !== id) return;
    const brain = this.bots[id];
    if (!brain) return;
    const s = this.state;

    if (s.phase === 'discard' && s.mustDiscard.includes(id)) {
      this.dispatch({
        type: 'discard',
        player: id,
        resources: brain.chooseDiscard(s, id, discardAmount(s, id)),
      });
      return;
    }

    const legal = getLegalActions(s, id);
    if (legal.length === 0) return;
    this.dispatch(brain.decide(s, id, legal));
  }

  private dispatch(action: Action): void {
    const before = this.state;

    // En red, el cliente NO aplica nada: propone y espera. Aplicarla aqui
    // ademas de mandarla dejaria dos partidas corriendo en paralelo, y en
    // cuanto uno rechazara una jugada ya no habria forma de saber cual es la
    // buena. La comprobacion local de legalidad se queda, pero solo para no
    // molestar al servidor con jugadas que ya se sabe que no valen.
    if (this.net) {
      const check = applyAction(before, action);
      if (!check.ok) {
        play('error');
        this.flash(check.error ?? 'Movimiento no permitido');
        return;
      }
      this.net.client.play(action);
      this.mode = { kind: 'idle' };
      this.modal = null;
      this.render();
      return;
    }

    const result = applyAction(before, action);
    if (!result.ok) {
      play('error');
      this.flash(result.error ?? 'Movimiento no permitido');
      return;
    }
    this.sound(action, before, result.state);
    this.state = result.state;
    this.mode = { kind: 'idle' };
    // Cualquier accion cierra la ventana que la haya lanzado: si no, el
    // selector de monopolio o el de comercio se quedarian abiertos encima del
    // tablero despues de aplicarse.
    this.modal = null;
    this.render();
  }

  /**
   * Pone sonido a una jugada que acaba de aplicarse.
   *
   * Va en un solo sitio, junto al `dispatch`, y no repartido por los botones:
   * la misma jugada llega desde el tablero, desde la barra, desde una ventana y
   * desde un bot, y todas tienen que sonar igual. Recibe el estado de antes y
   * el de despues porque hay dos efectos que no se deducen de la accion sola:
   * si la tirada ha producido algo y si la partida se ha acabado.
   */
  private sound(action: Action, before: GameState, after: GameState): void {
    const cue = ACTION_CUE[action.type];
    if (cue) play(cue);

    if (action.type === 'rollDice') {
      // La cosecha entra detras del ultimo rebote del dado, no encima.
      const cards = (st: GameState) =>
        st.players.reduce((sum, p) => sum + handSize(st, p.id), 0);
      if (cards(after) > cards(before)) play('harvest', 0.42);
    }

    // La fanfarria se deja respirar un momento tras el golpe de la ultima
    // ciudad o el caballero que da el ejercito.
    if (after.phase === 'gameOver' && before.phase !== 'gameOver') play('win', 0.35);
  }

  /**
   * Estado nuevo llegado del servidor.
   *
   * Es la unica puerta por la que entra el estado en una partida en red. Los
   * sonidos se sacan comparando con el estado anterior en vez de con la accion,
   * porque desde aqui no se sabe QUE ha pasado -- puede ser la jugada de otro,
   * la de un bot, o varias de golpe tras una reconexion.
   */
  applyRemoteState(state: GameState): void {
    const before = this.state;
    this.state = state;
    this.soundFromDiff(before, state);
    // Una jugada ajena puede cerrar la ventana que se tenia abierta (te roban,
    // te toca descartar); la que se abre por fase la vuelve a poner `render`.
    if (before.phase !== state.phase) this.modal = null;
    this.mode = { kind: 'idle' };
    this.render();
  }

  /**
   * Deduce que ha pasado comparando dos estados, y lo suena.
   *
   * En local se sabe la accion y se mira la tabla; aqui no hay accion que
   * mirar, porque el estado llega ya aplicado y puede traer varias jugadas de
   * golpe (una reconexion, un turno entero de bots). Asi que se compara: lo que
   * hay de mas en el tablero dice lo que se ha hecho.
   *
   * Suena UNA cosa por estado nuevo, la mas gorda. Encadenar seis efectos
   * porque un bot ha construido tres caminos seguidos es ruido, no informacion.
   */
  private soundFromDiff(before: GameState, after: GameState): void {
    if (after.phase === 'gameOver' && before.phase !== 'gameOver') {
      play('win');
      return;
    }
    for (const [vertex, now] of Object.entries(after.buildings)) {
      const was = before.buildings[vertex];
      if (!was) {
        play(now.kind === 'city' ? 'city' : 'settlement');
        return;
      }
      if (was.kind !== now.kind) {
        play('city');
        return;
      }
    }
    if (before.robber !== after.robber) {
      play('robber');
      return;
    }
    if (after.dice && (!before.dice || before.dice.join() !== after.dice.join())) {
      play('dice');
      const cards = (st: GameState) => st.players.reduce((sum, p) => sum + handSize(st, p.id), 0);
      if (cards(after) > cards(before)) play('harvest', 0.42);
      return;
    }
    for (const edge of Object.keys(after.roads)) {
      if (!before.roads[edge]) {
        play('road');
        return;
      }
    }
    if (before.turn !== after.turn) play('endTurn');
  }

  /** Si esta partida es en red. Lo consultan la barra y el reloj. */
  get isNetworked(): boolean {
    return this.net !== null;
  }

  /**
   * Manda un mensaje de chat.
   *
   * En red va al servidor, que le pone el nombre segun el asiento -- si el
   * nombre viniera en el mensaje, cualquiera podria firmar como otro. En local
   * no hay servidor y el mensaje se queda aqui, atribuido a quien tiene la mano
   * delante, que es literalmente quien esta al teclado.
   */
  private say(text: string): void {
    if (this.net) {
      this.net.client.send({ type: 'chat', text });
      return;
    }
    const author = this.state.players[this.handOwner]!;
    this.chat?.add({
      id: ++this.localChatId,
      seat: author.id,
      name: author.name,
      text,
      at: Date.now(),
    });
  }

  /** La conversacion que manda el servidor. */
  setChat(entries: ChatEntry[]): void {
    this.chat?.setEntries(entries);
  }

  /** Un aviso que llega del servidor (una jugada rechazada, por ejemplo). */
  flashRemote(message: string): void {
    play('error');
    this.flash(message);
  }

  /**
   * Estado de la conexion, para avisar cuando se cae.
   *
   * Se pinta en la barra de arriba y no en una ventana modal a proposito: la
   * partida sigue ahi y se recupera sola en cuanto vuelva la wifi, asi que
   * tapar la pantalla asustaria mas de lo que ayuda. Lo que si hace falta es
   * que se note, porque con la conexion caida los botones no van a responder.
   */
  setConnection(status: string): void {
    this.connection = status;
    const banner = document.getElementById('net-status');
    if (!banner) return;
    const down = status !== 'conectado';
    banner.classList.toggle('hidden', !down);
    banner.textContent = status === 'reconectando' ? 'Sin conexion. Reintentando...' : 'Conectando...';
  }

  private flash(message: string): void {
    this.flashMessage = message;
    window.clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => {
      this.flashMessage = null;
      this.render();
    }, 2600);
    this.render();
  }

  // -------------------------------------------------------------------------
  // Interaccion con el tablero
  // -------------------------------------------------------------------------

  /**
   * Que hacen los dados del tablero ahora mismo.
   *
   * Son un mando de dos posiciones y no un boton fijo: al principio del turno
   * tiran, y una vez tirados pasan el turno. Es el mismo gesto en el mismo
   * sitio para las dos cosas que enmarcan una jugada, asi no hay que ir a
   * buscar el boton de pasar al otro extremo de la pantalla.
   *
   * Devuelve `null` cuando no hacen nada, que es lo que apaga tambien su brillo
   * de llamada. Se calcula una sola vez y lo usan el tablero y la barra: si
   * cada uno lo dedujera por su cuenta acabarian discrepando.
   */
  private diceAction(): 'roll' | 'end' | null {
    const s = this.state;
    const player = this.handOwner;
    if (s.players[player]!.kind !== 'human') return null;
    // Con el escudo bajado o una ventana abierta encima, el tablero no acepta
    // ordenes: los dados tampoco.
    if (this.needsShield()) return null;
    if (this.modal || s.activeTrade) return null;
    const legal = getLegalActions(s, player);
    if (legal.some((a) => a.type === 'rollDice')) return 'roll';
    if (legal.some((a) => a.type === 'endTurn')) return 'end';
    return null;
  }

  private canRollNow(): boolean {
    return this.diceAction() === 'roll';
  }

  /** Clic sobre los dados del tablero: tirar, o pasar si ya se ha tirado. */
  private useDice(): void {
    const action = this.diceAction();
    if (action === 'roll') this.dispatch({ type: 'rollDice', player: this.handOwner });
    else if (action === 'end') this.dispatch({ type: 'endTurn', player: this.handOwner });
  }

  private handlePick(pick: Pick): void {
    const s = this.state;
    const player = this.handOwner;

    if (pick.kind === 'vertex') {
      if (s.phase === 'setupSettlement') {
        this.dispatch({ type: 'setupSettlement', player, vertex: pick.id });
      } else if (this.mode.kind === 'settlement') {
        this.dispatch({ type: 'buildSettlement', player, vertex: pick.id });
      } else if (this.mode.kind === 'city') {
        this.dispatch({ type: 'buildCity', player, vertex: pick.id });
      } else {
        // Sin modo elegido lo decide el propio cruce, y no hay ambiguedad
        // posible: sobre un poblado tuyo solo cabe mejorarlo a ciudad, y en un
        // cruce libre solo cabe fundar.
        const building = s.buildings[pick.id];
        if (building && building.owner === player) {
          this.dispatch({ type: 'buildCity', player, vertex: pick.id });
        } else {
          this.dispatch({ type: 'buildSettlement', player, vertex: pick.id });
        }
      }
      return;
    }

    if (pick.kind === 'edge') {
      if (s.phase === 'setupRoad') {
        this.dispatch({ type: 'setupRoad', player, edge: pick.id });
      } else {
        this.dispatch({ type: 'buildRoad', player, edge: pick.id });
      }
      return;
    }

    if (pick.kind === 'hex' && s.phase === 'moveRobber') {
      this.dispatch({ type: 'moveRobber', player: s.currentPlayer, hex: pick.id });
    }
  }

  /** Convierte las acciones legales en objetivos pulsables del tablero. */
  private computeHighlight(): Highlight {
    const s = this.state;
    if (this.needsShield() || s.phase === 'gameOver') return {};
    // Mientras juega la maquina el tablero no acepta clics.
    if (s.players[this.handOwner]!.kind === 'bot') return {};

    const player = this.handOwner;
    const legal = getLegalActions(s, player);
    const vertices = new Set<VertexId>();
    const edges = new Set<EdgeId>();
    const hexes = new Set<HexId>();
    const cities = new Set<VertexId>();

    // Sin modo elegido se ensena TODO lo que se puede levantar ahora mismo, y
    // pulsar el tablero lo construye. Los botones dejan de ser un paso previo
    // obligatorio y pasan a ser un filtro: con el tablero lleno de sitios,
    // pulsar «Camino» deja solo los caminos.
    const free = this.mode.kind === 'idle';
    const wantsRoad =
      free ||
      s.phase === 'setupRoad' ||
      s.pending?.type === 'roadBuilding' ||
      this.mode.kind === 'road';

    for (const action of legal) {
      switch (action.type) {
        case 'setupSettlement':
          vertices.add(action.vertex);
          break;
        case 'setupRoad':
          edges.add(action.edge);
          break;
        case 'buildRoad':
          if (wantsRoad) edges.add(action.edge);
          break;
        case 'buildSettlement':
          if (free || this.mode.kind === 'settlement') vertices.add(action.vertex);
          break;
        case 'buildCity':
          if (free || this.mode.kind === 'city') {
            vertices.add(action.vertex);
            cities.add(action.vertex);
          }
          break;
        case 'moveRobber':
          hexes.add(action.hex);
          break;
        default:
          break;
      }
    }

    return { vertices, edges, hexes, cities, color: s.players[player]!.color };
  }

  private hintText(): string {
    if (this.flashMessage) return this.flashMessage;
    const s = this.state;
    if (s.phase === 'gameOver') return '';
    if (this.needsShield()) return '';
    const acting = this.actingBot;
    if (acting !== null) return `${s.players[acting]!.name} esta pensando...`;

    // El aviso es para QUIEN TIENE QUE ACTUAR, que no es siempre quien mira la
    // pantalla. Usar `handOwner` -- la mano de abajo, o sea la propia -- hacia
    // que en red te salieran en segunda persona ordenes que no eran tuyas,
    // dirigidas al jugador en turno mientras le tocaba a otro. Es el mismo
    // error que sacaba el ladron sin ser tu turno, en otro sitio.
    const actor = playersToAct(s)[0] ?? s.currentPlayer;
    const name = s.players[actor]!.name;
    const mio = this.controls(actor);

    if (s.pending?.type === 'roadBuilding') {
      return mio
        ? `Coloca ${s.pending.roadsLeft} camino(s) gratis`
        : `${name} coloca sus caminos gratis`;
    }
    switch (s.phase) {
      case 'setupSettlement':
        return mio ? `${name}: elige donde fundar tu poblado` : `${name} funda su poblado`;
      case 'setupRoad':
        return mio ? `${name}: coloca un camino junto a tu poblado` : `${name} coloca su camino`;
      case 'moveRobber':
        return mio ? `${name}: elige la casilla del ladron` : `${name} esta moviendo el ladron`;
      case 'discard':
        return this.controls(this.handOwner) && s.mustDiscard.includes(this.handOwner)
          ? 'Te toca descartar cartas'
          : `${name} debe descartar cartas`;
      case 'steal':
        return mio ? `${name}: elige a quien robar` : `${name} esta robando`;
      default:
        break;
    }
    switch (this.mode.kind) {
      case 'road':
        return 'Elige donde construir el camino';
      case 'settlement':
        return 'Elige donde construir el poblado';
      case 'city':
        return 'Elige el poblado que quieres mejorar';
      default:
        return this.hasBuildableSpot()
          ? 'Pulsa el tablero para construir donde brilla'
          : '';
    }
  }

  /**
   * Piezas sin colocar que se ensenan junto al tablero. Solo las del jugador
   * cuya mano se esta mostrando: son «tus piezas», y pintar las de los cuatro
   * llenaria la mesa de material ajeno.
   */
  private reserveForBoard(): Reserve | null {
    const s = this.state;
    if (this.needsShield() || s.phase === 'gameOver') return null;
    const player = s.players[this.handOwner]!;
    if (player.kind === 'bot') return null;
    return {
      color: player.color,
      road: player.piecesLeft.road,
      settlement: player.piecesLeft.settlement,
      city: player.piecesLeft.city,
      capacity: piecesFor(s.board.variant),
    };
  }

  /** Si hay algo que se pueda levantar pulsando directamente el tablero. */
  private hasBuildableSpot(): boolean {
    const s = this.state;
    if (s.phase !== 'main') return false;
    return getLegalActions(s, this.handOwner).some(
      (a) => a.type === 'buildRoad' || a.type === 'buildSettlement' || a.type === 'buildCity',
    );
  }

  // -------------------------------------------------------------------------
  // Pintado
  // -------------------------------------------------------------------------

  /**
   * Marca las cartas que acaban de cambiar de cuenta para que se animen.
   *
   * Se compara contra la foto anterior de la MISMA mano: al cambiar de jugador
   * no se anima nada, porque ahi no ha cobrado nadie, solo ha cambiado quien
   * mira la pantalla.
   */
  private trackHandChanges(): void {
    const owner = this.handOwner;
    const hand = this.state.players[owner]!.resources;
    const previous = this.handSnapshot;
    if (previous && previous.owner === owner) {
      const changed = RESOURCES.filter((r) => previous.hand[r] !== hand[r]);
      if (changed.length) {
        this.handPulse = new Set(changed);
        window.clearTimeout(this.handPulseTimer);
        this.handPulseTimer = window.setTimeout(() => {
          this.handPulse.clear();
          this.renderHandbar();
        }, 620);
      }
    } else {
      this.handPulse.clear();
    }
    this.handSnapshot = { owner, hand };
  }

  render(): void {
    this.trackHandChanges();
    this.view.setState(this.state);
    this.view.setHighlight(this.computeHighlight());
    this.view.setDiceAction(this.diceAction());
    this.view.setReserve(this.reserveForBoard());
    this.renderBanner();
    this.renderSpeedButton();
    this.renderPlayers();
    this.renderLog();
    this.renderHandbar();
    this.hintEl.textContent = this.hintText();
    this.renderOverlay();
    this.syncClock();
    this.paintClock();
    this.scheduleBot();
  }

  private renderSpeedButton(): void {
    const button = document.getElementById('btn-speed');
    if (button) {
      const anyBot = this.state.players.some((p) => p.kind === 'bot');
      button.classList.toggle('hidden', !anyBot);
      button.textContent = this.fastBots ? 'Bots rapidos' : 'Bots pausados';
    }
    const clock = document.getElementById('btn-clock');
    if (clock) clock.textContent = this.clockOn ? `Reloj ${TURN_SECONDS} s` : 'Sin reloj';
    const sound = document.getElementById('btn-sound');
    if (sound) sound.textContent = isMuted() ? 'Sin sonido' : 'Sonido';
  }

  private renderBanner(): void {
    const s = this.state;
    const player = s.players[this.handOwner]!;
    const phaseText: Record<string, string> = {
      setupSettlement: 'Colocacion inicial',
      setupRoad: 'Colocacion inicial',
      roll: 'Tira los dados',
      discard: 'Descarte por el 7',
      moveRobber: 'Mueve el ladron',
      steal: 'Roba una carta',
      main: 'Comercia y construye',
      gameOver: 'Partida terminada',
    };
    this.clockEl = el('span', { class: 'turn-clock' }, [icon('timer', 14), el('b', {}, ['--'])]);
    // El banner se reconstruye en CADA repintado -- y hay uno por cada jugada
    // de cualquiera, mas los del reloj -- asi que la entrada solo se marca
    // cuando de verdad cambia de mano. Animarlo siempre seria un parpadeo
    // constante que dejaria de significar nada.
    const changed = player.id !== this.bannerOwner;
    this.bannerOwner = player.id;
    const who = `turn-banner__who${changed ? ' turn-banner__who--in' : ''}`;

    replace(
      this.bannerEl,
      el('span', {
        class: `turn-banner__dot ${who}`,
        style: `background:${PLAYER_PALETTE[player.color].main}`,
      }),
      el('span', { class: who }, [player.name]),
      el('span', { class: 'turn-banner__phase' }, [
        `· Turno ${Math.max(1, s.turn)} · ${phaseText[s.phase] ?? ''}`,
      ]),
      this.clockEl,
    );
    this.paintClock();
  }

  // -------------------------------------------------------------------------
  // Reloj de jugada
  // -------------------------------------------------------------------------

  /**
   * Identidad de la jugada que se esta cronometrando, o null si no toca contar.
   *
   * El reloj es POR JUGADA y no por turno entero: se reinicia cuando cambia
   * quien actua, la fase o lo que el motor esta esperando. Un solo margen para
   * el turno completo tendria que cubrir tirar, comerciar y construir, y treinta
   * segundos no dan para eso.
   *
   * No corre mientras juega un bot (van a su propio ritmo), con el escudo de
   * privacidad puesto (aun no han cogido el aparato) ni con una oferta sobre la
   * mesa (ahi quien decide son los demas).
   */
  private clockKeyNow(): string | null {
    const s = this.state;
    if (!this.clockOn || s.phase === 'gameOver') return null;
    const owner = this.handOwner;
    if (s.players[owner]!.kind !== 'human') return null;
    if (this.needsShield() || s.activeTrade) return null;
    // En red `handOwner` es siempre tu asiento, tambien mientras juegan los
    // demas. Sin esto el reloj contaria hacia atras en tu pantalla durante el
    // turno ajeno y acabaria "resolviendo" un tiempo que no era tuyo.
    if (this.net && !playersToAct(s).includes(owner)) return null;
    return `${owner}|${s.turn}|${s.phase}|${s.pending?.type ?? '-'}`;
  }

  private syncClock(): void {
    const key = this.clockKeyNow();
    if (key === null) {
      this.stopClock();
      return;
    }
    if (key !== this.clockKey) {
      this.clockKey = key;
      this.deadline = Date.now() + TURN_SECONDS * 1000;
    }
    if (!this.clockTimer) {
      this.clockTimer = window.setInterval(() => this.tickClock(), 200);
    }
  }

  private stopClock(): void {
    window.clearInterval(this.clockTimer);
    this.clockTimer = 0;
    this.deadline = null;
    this.clockKey = '';
  }

  private tickClock(): void {
    // La partida puede haberse desmontado con el reloj en marcha (empezar otra
    // reemplaza el DOM entero); ahi no hay nada que contar.
    if (!this.bannerEl.isConnected) {
      this.stopClock();
      return;
    }
    if (this.deadline === null) return;
    if (Date.now() >= this.deadline) {
      this.deadline = null;
      this.resolveTimeout();
      return;
    }
    this.paintClock();
  }

  /** Actualiza solo el texto: repintar la barra entera cada 200 ms sobra. */
  private paintClock(): void {
    const node = this.clockEl;
    if (!node) return;
    const value = node.querySelector('b');
    if (this.deadline === null) {
      node.classList.add('turn-clock--off');
      node.classList.remove('turn-clock--low');
      if (value) value.textContent = this.clockOn ? '--' : 'libre';
      return;
    }
    const left = Math.max(0, Math.ceil((this.deadline - Date.now()) / 1000));
    node.classList.remove('turn-clock--off');
    node.classList.toggle('turn-clock--low', left <= 10);
    if (value) value.textContent = `0:${String(left).padStart(2, '0')}`;
  }

  /**
   * Se acabo el tiempo: la interfaz resuelve el tramite pendiente por el
   * jugador y pasa el turno.
   */
  private resolveTimeout(): void {
    const s = this.state;
    const player = this.handOwner;
    if (s.phase === 'gameOver' || s.players[player]!.kind !== 'human') return;

    if (s.phase === 'discard') {
      this.flash('Se acabo el tiempo: descarte automatico');
      this.dispatch({
        type: 'discard',
        player,
        resources: defaultDiscard(s.players[player]!.resources, discardAmount(s, player)),
      });
      return;
    }

    const legal = getLegalActions(s, player);
    for (const type of TIMEOUT_ORDER) {
      const action = legal.find((a) => a.type === type);
      if (action) {
        this.flash('Se acabo el tiempo');
        this.dispatch(action);
        return;
      }
    }
    // Nada que se pueda resolver solo: queda el aviso y el reloj parado.
    this.flash('Se acabo el tiempo');
  }

  /**
   * Una cifra del panel de jugador: icono mas numero.
   *
   * Todo lo que aparece aqui es informacion PUBLICA de Catan. Cuantas cartas
   * tiene alguien en la mano se ve en la mesa real, y cuantas de desarrollo
   * tambien; lo secreto es CUALES son, y eso no se ensena en ningun momento.
   */
  private stat(name: IconName, value: number, label: string, highlight = false): HTMLElement {
    return el(
      'span',
      { class: `pstat${highlight ? ' pstat--on' : ''}`, title: label },
      [icon(name, 15), el('b', {}, [String(value)])],
    );
  }

  private renderPlayers(): void {
    const s = this.state;
    clear(this.playersEl);
    for (const id of s.turnOrder) {
      const player = s.players[id]!;
      const palette = PLAYER_PALETTE[player.color];
      const isActive = id === this.handOwner;

      // Poblados y ciudades se cuentan del tablero: `buildings` del jugador
      // guarda los cruces, no de que tipo es cada edificio.
      let settlements = 0;
      let cities = 0;
      for (const vertex of player.buildings) {
        const building = s.buildings[vertex];
        if (building?.kind === 'city') cities++;
        else if (building) settlements++;
      }

      this.playersEl.append(
        el(
          'div',
          {
            class: `player-card${isActive ? ' player-card--active' : ''}`,
            style: `--player-color:${palette.main}`,
          },
          [
            el('div', { class: 'player-card__head' }, [
              el('span', {
                class: 'swatch',
                style: `background:${palette.main};width:1.15rem;height:1.15rem`,
              }),
              el('span', { class: 'player-card__name' }, [player.name]),
              player.kind === 'bot'
                ? el('span', { class: 'tag' }, [DIFFICULTY_LABEL[player.difficulty ?? 'normal']])
                : null,
              // Solo se muestran los puntos publicos: las cartas de punto de
              // victoria siguen siendo secretas hasta el final.
              el('span', { class: 'player-card__vp', title: 'Puntos de victoria' }, [
                icon('star', 15),
                el('b', {}, [
                  String(s.phase === 'gameOver' ? victoryPoints(s, id) : publicVictoryPoints(s, id)),
                ]),
              ]),
            ]),
            el('div', { class: 'player-stats' }, [
              this.stat('card', handSize(s, player.id), 'Cartas de recurso en mano'),
              this.stat('dev', devCardCount(s, player.id), 'Cartas de desarrollo'),
              el('span', { class: 'pstat__sep' }),
              this.stat('settlement', settlements, 'Poblados construidos'),
              this.stat('city', cities, 'Ciudades construidas'),
              el('span', { class: 'pstat__sep' }),
              this.stat(
                'longestRoad',
                player.longestRoadLength,
                s.longestRoadHolder === id
                  ? 'Ruta comercial mas larga (+2 puntos)'
                  : 'Tramo continuo de camino mas largo',
                s.longestRoadHolder === id,
              ),
              this.stat(
                'knight',
                player.knightsPlayed,
                s.largestArmyHolder === id
                  ? 'Mayor ejercito (+2 puntos)'
                  : 'Caballeros jugados',
                s.largestArmyHolder === id,
              ),
            ]),
          ],
        ),
      );
    }
  }

  private renderLog(): void {
    clear(this.logEl);
    const entries = this.state.log.slice(-60);
    for (const entry of entries) {
      const who = entry.player !== null ? this.state.players[entry.player]!.name : null;
      this.logEl.append(
        el('li', { class: `log__entry log__entry--${entry.tone}` }, [
          who ? el('strong', {}, [who + ' ']) : null,
          entry.text,
        ]),
      );
    }
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  private renderHandbar(): void {
    const s = this.state;
    const player = s.players[this.handOwner]!;
    const hidden =
      this.needsShield() || s.phase === 'gameOver' || player.kind === 'bot';

    const cards = el(
      'div',
      { class: 'hand__cards' },
      RESOURCES.map((resource) => {
        const count = hidden ? 0 : player.resources[resource];
        return resourceCard(resource, {
          size: 'md',
          count: hidden ? null : count,
          empty: !hidden && count === 0,
          hidden,
          // La carta parpadea sola cuando cambia la cuenta: es la forma mas
          // barata de que se note que acabas de cobrar o de pagar.
          extra: this.handPulse.has(resource) ? 'rcard--bump' : '',
        });
      }),
    );

    const hand = el('div', { class: 'hand' }, [
      el('div', { class: 'hand__group' }, [
        cards,
        el('span', { class: 'hand__count' }, [
          hidden ? 'Mano oculta' : `${totalResources(player.resources)} cartas`,
        ]),
      ]),
      hidden ? null : this.renderDevHand(),
    ]);

    replace(this.handbarEl, hand, el('div', { class: 'actions' }, this.buildActions()));
  }

  /**
   * Cartas de desarrollo, en la mano y no detras de un boton.
   *
   * Son tuyas y saber cuales tienes es parte de decidir el turno; esconderlas en
   * una ventana obliga a abrirla en cada turno solo para recordar que hay. Se
   * pulsan para jugarlas: las que necesitan elegir algo (monopolio y abundancia)
   * abren su selector, el resto se juegan en el acto.
   */
  private renderDevHand(): HTMLElement {
    const s = this.state;
    const player = this.handOwner;
    const cards = s.players[player]!.devCards;
    if (cards.length === 0) {
      return el('div', { class: 'hand__group hand__group--empty' }, [
        el('span', { class: 'hand__count' }, ['Sin cartas de desarrollo']),
      ]);
    }

    // Se agrupan por tipo: cinco caballeros son una carta con un x5, no cinco
    // trozos de barra.
    const grouped = new Map<DevCardKind, { total: number; playable: number }>();
    for (const card of cards) {
      const entry = grouped.get(card.kind) ?? { total: 0, playable: 0 };
      entry.total++;
      if (card.boughtOnTurn < s.turn) entry.playable++;
      grouped.set(card.kind, entry);
    }

    const turnOk =
      (s.phase === 'main' || s.phase === 'roll') &&
      s.currentPlayer === player &&
      !s.pending &&
      !s.players[player]!.playedDevCardThisTurn;

    return el(
      'div',
      { class: 'hand__group' },
      [
        ...[...grouped.entries()].map(([kind, count]) => {
          const action = this.playDevCard(kind);
          const enabled = action !== null && turnOk && count.playable > 0;
          const reason =
            action === null
              ? 'se revela al ganar'
              : count.playable === 0
                ? 'comprada este turno'
                : !turnOk
                  ? 'ahora no se puede jugar'
                  : null;
          return devCard(kind, {
            count: count.total,
            enabled,
            reason,
            onclick: action ?? undefined,
          });
        }),
        el('span', { class: 'hand__count' }, ['Desarrollo']),
      ],
    );
  }

  /** Que hace pulsar una carta de desarrollo, o null si no es jugable. */
  private playDevCard(kind: DevCardKind): (() => void) | null {
    const player = this.handOwner;
    switch (kind) {
      case 'knight':
        return () => this.dispatch({ type: 'playKnight', player });
      case 'roadBuilding':
        return () => this.dispatch({ type: 'playRoadBuilding', player });
      case 'monopoly':
        return () => {
          this.modal = () =>
            this.renderResourceChoice('monopolio', 1, (picked) =>
              this.dispatch({ type: 'playMonopoly', player, resource: picked[0]! }),
            );
          this.render();
        };
      case 'yearOfPlenty':
        return () => {
          this.modal = () =>
            this.renderResourceChoice('abundancia', 2, (picked) =>
              this.dispatch({
                type: 'playYearOfPlenty',
                player,
                resources: [picked[0]!, picked[1]!],
              }),
            );
          this.render();
        };
      default:
        return null;
    }
  }

  private buildActions(): HTMLElement[] {
    const s = this.state;
    const player = this.handOwner;
    if (this.needsShield() || s.phase === 'gameOver') return [];
    if (s.players[player]!.kind === 'bot') {
      return [el('div', { class: 'tag tag--thinking' }, [`${s.players[player]!.name} juega...`])];
    }

    const legal = getLegalActions(s, player);
    const can = (type: Action['type']) => legal.some((a) => a.type === type);
    const buttons: HTMLElement[] = [];

    /**
     * Boton de accion: icono, nombre, coste debajo y, si la accion gasta una
     * pieza, cuantas quedan en la reserva. Ese contador es la unica forma de
     * enterarse de que te has quedado sin caminos antes de intentar poner uno.
     */
    const button = (
      label: string,
      sub: string | null,
      enabled: boolean,
      onclick: () => void,
      options: { icon?: IconName; left?: number; variant?: string } = {},
    ) =>
      el(
        'button',
        {
          type: 'button',
          class: `btn action-btn ${options.variant ?? ''}`,
          disabled: !enabled,
          title: sub ? `${label} - ${sub}` : label,
          onclick,
        },
        [
          options.icon ? icon(options.icon, 20) : null,
          el('span', { class: 'action-btn__label' }, [label]),
          sub ? el('small', {}, [sub]) : null,
          options.left !== undefined
            ? el('span', { class: 'action-btn__left' }, [String(options.left)])
            : null,
        ],
      );

    if (s.pending?.type === 'roadBuilding') {
      return [
        el('div', { class: 'tag' }, [`Coloca ${s.pending.roadsLeft} camino(s) gratis`]),
      ];
    }

    if (s.phase === 'setupSettlement' || s.phase === 'setupRoad') return [];

    if (s.phase === 'roll') {
      buttons.push(
        button(
          'Tirar dados',
          null,
          can('rollDice'),
          () => this.dispatch({ type: 'rollDice', player }),
          { icon: 'dice', variant: 'action-btn--go' },
        ),
      );
      // Las cartas de desarrollo no necesitan boton: estan en la mano, y desde
      // ahi se pueden jugar tambien antes de tirar.
      return buttons;
    }

    if (s.phase === 'main') {
      const left = s.players[player]!.piecesLeft;
      buttons.push(
        button('Camino', costLabel('road'), can('buildRoad'), () => this.setMode('road'), {
          icon: 'road',
          left: left.road,
        }),
        button(
          'Poblado',
          costLabel('settlement'),
          can('buildSettlement'),
          () => this.setMode('settlement'),
          { icon: 'settlement', left: left.settlement },
        ),
        button('Ciudad', costLabel('city'), can('buildCity'), () => this.setMode('city'), {
          icon: 'city',
          left: left.city,
        }),
        button(
          'Comprar carta',
          costLabel('devCard'),
          can('buyDevCard'),
          () => this.dispatch({ type: 'buyDevCard', player }),
          { icon: 'dev', left: devDeckSize(s) },
        ),
        // Banco y jugadores son la misma decision («cambio esto por esto»),
        // asi que van en una sola ventana con dos pestanas. Dos botones
        // separados obligaban a adivinar cual abrir antes de saber que cambio
        // te conviene.
        //
        // La condicion no puede depender solo de `can()`: las ofertas entre
        // jugadores no se enumeran como acciones legales, asi que la consulta
        // siempre diria que no.
        button(
          'Comerciar',
          'banco y jugadores',
          can('bankTrade') || canOfferTrade(s, player),
          () => {
            this.modal = () => this.renderTrade();
            this.render();
          },
          { icon: 'trade' },
        ),
        button(
          'Terminar turno',
          null,
          can('endTurn'),
          () => this.dispatch({ type: 'endTurn', player }),
          { icon: 'flag', variant: 'action-btn--end' },
        ),
      );
    }

    return buttons;
  }

  private setMode(kind: UiMode['kind']): void {
    this.mode = this.mode.kind === kind ? { kind: 'idle' } : ({ kind } as UiMode);
    this.render();
  }

  // -------------------------------------------------------------------------
  // Capa superpuesta: escudo, ventanas forzadas y ventanas a peticion
  // -------------------------------------------------------------------------

  /**
   * Si este dispositivo es quien maneja a ese jugador.
   *
   * No basta con saber a quien le toca: hay que saber si le toca A ESTA
   * PANTALLA. En red es su asiento y solo el suyo; en local, cualquier humano
   * -- porque el aparato se va pasando -- pero NUNCA un bot, que se maneja
   * solo.
   */
  private controls(id: PlayerId): boolean {
    if (this.net) return id === this.net.seat;
    return this.state.players[id]?.kind === 'human';
  }

  /** Hay que tapar la pantalla porque le toca a otra persona del sofa. */
  private needsShield(): boolean {
    // En red no hay sofa que compartir: cada uno mira su propia pantalla y el
    // servidor ya le ha quitado al estado todo lo que no puede ver.
    if (this.net) return false;
    if (this.state.phase === 'gameOver') return false;
    // Un bot no necesita que le pasen el dispositivo, pero su mano tampoco se
    // ensena: se juega contra el, no con el.
    if (this.state.players[this.handOwner]!.kind === 'bot') return false;
    return this.revealedFor !== this.handOwner;
  }

  private renderOverlay(): void {
    const s = this.state;
    let content: HTMLElement | null = null;

    // Las ventanas que impone la fase se le ensenan SOLO a quien tiene que
    // actuar Y esta delante de esta pantalla. Son dos condiciones distintas y
    // hacen falta las dos:
    //
    //  - «a quien tiene que actuar» arregla la red, donde no hay escudo de
    //    privacidad y a los demas les salia el ladron sin ser su turno.
    //  - «delante de esta pantalla» arregla el bot: cuando un bot juega un
    //    caballero, la fase pasa a `steal` con el bot como jugador en turno, y
    //    como un bot no dispara el escudo, el selector de victima se colaba
    //    medio segundo -- justo lo que el bot tarda en decidir -- ensenando una
    //    eleccion que ademas no era de nadie que estuviera mirando.
    const me = this.handOwner;
    const mine = this.controls(me);
    const mustDiscard = mine && s.phase === 'discard' && s.mustDiscard.includes(me);
    const mustSteal = mine && s.phase === 'steal' && me === s.currentPlayer;

    if (s.phase === 'gameOver') content = this.renderVictory();
    else if (this.needsShield()) content = this.renderShield();
    else if (mustDiscard) content = this.renderDiscard();
    else if (mustSteal) content = this.renderSteal();
    else if (s.activeTrade) content = this.renderTradeResponses();
    else if (this.modal) content = this.modal();

    if (!content) {
      this.overlayEl.classList.add('hidden');
      clear(this.overlayEl);
      return;
    }
    this.overlayEl.classList.remove('hidden');
    replace(this.overlayEl, content);
  }

  private renderShield(): HTMLElement {
    const player = this.state.players[this.handOwner]!;
    const palette = PLAYER_PALETTE[player.color];
    return el('div', { class: 'modal' }, [
      el('div', { class: 'shield' }, [
        el(
          'div',
          {
            class: 'shield__crest',
            style: `--shield-color:${palette.main}`,
          },
          [player.name.slice(0, 1).toUpperCase()],
        ),
        el('h2', { class: 'shield__name' }, [`Le toca a ${player.name}`]),
        el('p', { class: 'modal__text' }, [
          'Pasa el dispositivo. Cuando lo tengas delante, pulsa para ver tu mano.',
        ]),
        el(
          'button',
          {
            class: 'btn btn--wide',
            type: 'button',
            onclick: () => {
              this.revealedFor = this.handOwner;
              this.render();
            },
          },
          ['Soy ' + player.name + ', mostrar mis cartas'],
        ),
      ]),
    ]);
  }

  private renderVictory(): HTMLElement {
    const s = this.state;
    const winner = s.players[s.winner!]!;
    const ranking = [...s.players].sort((a, b) => victoryPoints(s, b.id) - victoryPoints(s, a.id));
    return el('div', { class: 'modal' }, [
      el('h2', { class: 'modal__title' }, [`Gana ${winner.name}`]),
      el('p', { class: 'modal__text' }, [
        `Con ${victoryPoints(s, winner.id)} puntos de victoria en el turno ${s.turn}.`,
      ]),
      el(
        'div',
        { class: 'responses' },
        ranking.map((p) =>
          el(
            'div',
            {
              class: 'response-row',
              style: `--player-color:${PLAYER_PALETTE[p.color].main}`,
            },
            [
              el('span', {}, [p.name]),
              el('strong', {}, [`${victoryPoints(s, p.id)} puntos`]),
            ],
          ),
        ),
      ),
      el('div', { class: 'modal__footer' }, [
        // En red esto lleva a la sala de espera, no fuera del servidor: la
        // partida se ha acabado, la mesa no.
        el(
          'button',
          { class: 'btn', type: 'button', onclick: () => (this.onFinish ?? this.onExit)() },
          [this.onFinish ? 'Volver a la sala' : 'Nueva partida'],
        ),
      ]),
    ]);
  }

  private renderDiscard(): HTMLElement {
    const s = this.state;
    const player = this.handOwner;
    const need = discardAmount(s, player);
    const hand = s.players[player]!.resources;
    const selection: Partial<ResourceCount> = { ...defaultDiscard(hand, need) };

    const container = el('div', { class: 'modal' });
    const draw = () => {
      const chosen = RESOURCES.reduce((sum, r) => sum + (selection[r] ?? 0), 0);
    // Lo que aun cabe elegir, repartido entre lo que queda en la mano.
    const remaining = need - chosen;
      replace(
        container,
        el('h2', { class: 'modal__title' }, ['Descarta la mitad de tu mano']),
        el('p', { class: 'modal__text' }, [
          `Ha salido un 7 y tienes ${totalResources(hand)} cartas. Elige ${need} para devolver al banco.`,
        ]),
        el(
          'div',
          { class: 'res-picker' },
          RESOURCES.map((resource) =>
            el(
              'div',
              {
                class: 'res-picker__item',
                'data-selected': String((selection[resource] ?? 0) > 0),
                style: `--res-color:${RESOURCE_COLOR[resource]}`,
              },
              [
                resourceCard(resource, { size: 'sm', extra: 'rcard--chip' }),
                el('div', { class: 'res-picker__name' }, [RESOURCE_LABEL[resource]]),
                el('div', { class: 'res-picker__stock' }, [`tienes ${hand[resource]}`]),
                stepper(
                  selection[resource] ?? 0,
                  0,
                  Math.min(hand[resource], (selection[resource] ?? 0) + remaining),
                  (next) => {
                    selection[resource] = next;
                    draw();
                  },
                ),
              ],
            ),
          ),
        ),
        el('div', { class: 'modal__footer' }, [
          el('span', { class: 'tag' }, [`${chosen} / ${need}`]),
          el(
            'button',
            {
              class: 'btn',
              type: 'button',
              disabled: chosen !== need,
              onclick: () =>
                this.dispatch({ type: 'discard', player, resources: { ...selection } }),
            },
            ['Descartar'],
          ),
        ]),
      );
    };
    draw();
    return container;
  }

  private renderSteal(): HTMLElement {
    const s = this.state;
    const player = s.currentPlayer;
    return el('div', { class: 'modal' }, [
      el('h2', { class: 'modal__title' }, ['Roba una carta']),
      el('p', { class: 'modal__text' }, [
        'Elige a quien robar entre los jugadores con edificios junto al ladron. La carta se toma al azar de su mano.',
      ]),
      el(
        'div',
        { class: 'responses' },
        s.stealTargets.map((id) => {
          const victim = s.players[id]!;
          return el(
            'div',
            {
              class: 'response-row',
              style: `--player-color:${PLAYER_PALETTE[victim.color].main}`,
            },
            [
              el('span', {}, [
                `${victim.name} · ${handSize(s, victim.id)} cartas`,
              ]),
              el(
                'button',
                {
                  class: 'btn',
                  type: 'button',
                  onclick: () => this.dispatch({ type: 'steal', player, target: id }),
                },
                ['Robar'],
              ),
            ],
          );
        }),
      ),
    ]);
  }

  /** Selector reutilizado por monopolio (1 recurso) y abundancia (2). */
  private renderResourceChoice(
    title: string,
    amount: number,
    onConfirm: (picked: Resource[]) => void,
  ): HTMLElement {
    const picked: Resource[] = [];
    const container = el('div', { class: 'modal' });
    const draw = () => {
      replace(
        container,
        el('h2', { class: 'modal__title' }, [
          title === 'monopolio' ? 'Monopolio' : 'Ano de la abundancia',
        ]),
        el('p', { class: 'modal__text' }, [
          title === 'monopolio'
            ? 'Nombra un recurso. Todos los demas jugadores te entregaran todas las cartas que tengan de ese tipo.'
            : 'Toma dos cartas de recurso del banco. Pueden ser iguales o distintas.',
        ]),
        el(
          'div',
          { class: 'res-picker' },
          RESOURCES.map((resource) => {
            const count = picked.filter((p) => p === resource).length;
            return el(
              'div',
              {
                class: 'res-picker__item',
                'data-selected': String(count > 0),
                style: `--res-color:${RESOURCE_COLOR[resource]}`,
              },
              [
                resourceCard(resource, { size: 'sm', extra: 'rcard--chip' }),
                el('div', { class: 'res-picker__name' }, [RESOURCE_LABEL[resource]]),
                el('div', { class: 'res-picker__stock' }, [
                  `banco: ${this.state.bank[resource]}`,
                ]),
                stepper(count, 0, count + (amount - picked.length), (next) => {
                  while (picked.filter((p) => p === resource).length > next) {
                    picked.splice(picked.indexOf(resource), 1);
                  }
                  while (
                    picked.filter((p) => p === resource).length < next &&
                    picked.length < amount
                  ) {
                    picked.push(resource);
                  }
                  draw();
                }),
              ],
            );
          }),
        ),
        el('div', { class: 'modal__footer' }, [
          el('button', { class: 'btn btn--ghost', type: 'button', onclick: () => this.close() }, [
            'Cancelar',
          ]),
          el(
            'button',
            {
              class: 'btn',
              type: 'button',
              disabled: picked.length !== amount,
              onclick: () => onConfirm(picked),
            },
            ['Confirmar'],
          ),
        ]),
      );
    };
    draw();
    return container;
  }

  /**
   * Una fila de la mesa de intercambio: la etiqueta con su flecha y los huecos
   * donde se apilan las cartas puestas. Es el mismo componente para lo que se
   * entrega y para lo que se recibe, solo cambia el color de la flecha, que es
   * lo unico que hay que mirar para saber en que direccion va cada cosa.
   */
  private tradeRow(kind: 'give' | 'want', label: string, cards: HTMLElement[]): HTMLElement {
    return el('div', { class: `trade-row trade-row--${kind}` }, [
      el('div', { class: 'trade-row__tag' }, [
        el('span', { class: `trade-arrow trade-arrow--${kind}` }, [kind === 'give' ? '▲' : '▼']),
        el('span', { class: 'trade-row__label' }, [label]),
      ]),
      el(
        'div',
        { class: 'trade-row__slots' },
        cards.length ? cards : [el('span', { class: 'trade-row__empty' }, ['nada todavia'])],
      ),
    ]);
  }

  /** Cartas sueltas de un monton, una por unidad, pulsables para quitarlas. */
  private tradeStack(bag: Partial<ResourceCount>, onRemove: (r: Resource) => void): HTMLElement[] {
    return RESOURCES.flatMap((resource) =>
      Array.from({ length: bag[resource] ?? 0 }, () =>
        resourceCardButton(resource, {
          size: 'sm',
          extra: 'rcard--deal',
          onclick: () => onRemove(resource),
        }),
      ),
    );
  }

  /**
   * Ventana de comercio: banco y jugadores bajo dos pestanas.
   *
   * La pestana abierta se guarda en el propio elemento y no en el estado de la
   * aplicacion: es una preferencia de la ventana, y guardarla arriba obligaria
   * a limpiarla cada vez que se cierra.
   */
  private renderTrade(): HTMLElement {
    let tab: 'bank' | 'players' = 'bank';
    const container = el('div', { class: 'modal modal--trade' });

    const draw = () => {
      // El panel se cuelga ENTERO, no sus hijos sueltos: cada panel se repinta
      // solo (al elegir una carta, por ejemplo) sobre su propio elemento, y si
      // aqui se copiaran los nodos, esos repintados irian a un elemento
      // desconectado y la ventana se quedaria congelada.
      replace(
        container,
        el('h2', { class: 'modal__title' }, ['Comerciar']),
        el('div', { class: 'trade-tabs' }, [
          el(
            'button',
            {
              type: 'button',
              class: `trade-tab${tab === 'bank' ? ' trade-tab--on' : ''}`,
              onclick: () => {
                tab = 'bank';
                draw();
              },
            },
            [icon('bank', 17), 'Con el banco'],
          ),
          el(
            'button',
            {
              type: 'button',
              class: `trade-tab${tab === 'players' ? ' trade-tab--on' : ''}`,
              onclick: () => {
                tab = 'players';
                draw();
              },
            },
            [icon('trade', 17), 'Con los jugadores'],
          ),
        ]),
        tab === 'bank' ? this.renderBankTrade() : this.renderOfferTrade(),
      );
    };

    draw();
    return container;
  }

  private renderBankTrade(): HTMLElement {
    const s = this.state;
    const player = this.handOwner;
    const hand = s.players[player]!.resources;
    let give: Resource | null = null;
    let want: Resource | null = null;

    const container = el('div', { class: 'trade-panel' });
    const draw = () => {
      const ratio = give ? tradeRatio(s, player, give) : null;
      replace(
        container,
        el('p', { class: 'modal__text' }, [
          'Sin puerto el cambio es 4:1. Un puerto generico lo baja a 3:1 y un puerto de un recurso concreto a 2:1 para ese recurso.',
        ]),

        // La mesa: arriba lo que sale de tu mano, abajo lo que entra.
        el('div', { class: 'trade-board' }, [
          this.tradeRow(
            'give',
            'Entregas',
            give ? Array.from({ length: ratio! }, () => resourceCard(give!, { size: 'sm' })) : [],
          ),
          this.tradeRow('want', 'Recibes', want ? [resourceCard(want, { size: 'sm' })] : []),
        ]),

        el('h4', { class: 'trade-heading' }, ['Tu mano · pulsa lo que entregas']),
        el(
          'div',
          { class: 'card-rail' },
          RESOURCES.map((resource) => {
            const need = tradeRatio(s, player, resource);
            return resourceCardButton(resource, {
              size: 'md',
              count: hand[resource],
              footer: `${need}:1`,
              empty: hand[resource] === 0,
              selected: give === resource,
              disabled: hand[resource] < need,
              onclick: () => {
                give = resource;
                if (want === resource) want = null;
                draw();
              },
            });
          }),
        ),

        el('h4', { class: 'trade-heading' }, ['El banco te da · pulsa lo que recibes']),
        el(
          'div',
          { class: 'card-rail' },
          RESOURCES.map((resource) =>
            resourceCardButton(resource, {
              size: 'md',
              count: s.bank[resource],
              footer: 'banco',
              selected: want === resource,
              disabled: resource === give || s.bank[resource] < 1,
              onclick: () => {
                want = resource;
                draw();
              },
            }),
          ),
        ),

        el('div', { class: 'modal__footer' }, [
          give && want
            ? el('span', { class: 'tag tag--deal' }, [
                `${ratio} ${RESOURCE_LABEL[give]} → 1 ${RESOURCE_LABEL[want]}`,
              ])
            : null,
          el('button', { class: 'btn btn--ghost', type: 'button', onclick: () => this.close() }, [
            'Cancelar',
          ]),
          el(
            'button',
            {
              class: 'btn',
              type: 'button',
              disabled: !give || !want,
              onclick: () => this.dispatch({ type: 'bankTrade', player, give: give!, want: want! }),
            },
            ['Cambiar'],
          ),
        ]),
      );
    };
    draw();
    return container;
  }

  private renderOfferTrade(): HTMLElement {
    const s = this.state;
    const player = this.handOwner;
    const hand = s.players[player]!.resources;
    const give: Partial<ResourceCount> = {};
    const want: Partial<ResourceCount> = {};

    const container = el('div', { class: 'trade-panel' });
    const draw = () => {
      const giveTotal = RESOURCES.reduce((sum, r) => sum + (give[r] ?? 0), 0);
      const wantTotal = RESOURCES.reduce((sum, r) => sum + (want[r] ?? 0), 0);
      replace(
        container,
        el('p', { class: 'modal__text' }, [
          'Pon sobre la mesa lo que ofreces y lo que pides. Pulsa una carta puesta para retirarla. Los demas responderan y tu decides con quien cierras el trato.',
        ]),

        el('div', { class: 'trade-board' }, [
          this.tradeRow(
            'give',
            'Ofreces',
            this.tradeStack(give, (r) => {
              give[r] = (give[r] ?? 1) - 1;
              draw();
            }),
          ),
          this.tradeRow(
            'want',
            'Pides',
            this.tradeStack(want, (r) => {
              want[r] = (want[r] ?? 1) - 1;
              draw();
            }),
          ),
        ]),

        el('h4', { class: 'trade-heading' }, ['Tu mano · pulsa para ofrecer']),
        el(
          'div',
          { class: 'card-rail' },
          RESOURCES.map((resource) => {
            const left = hand[resource] - (give[resource] ?? 0);
            return resourceCardButton(resource, {
              size: 'md',
              count: left,
              empty: left === 0,
              selected: (give[resource] ?? 0) > 0,
              disabled: left <= 0,
              onclick: () => {
                give[resource] = (give[resource] ?? 0) + 1;
                draw();
              },
            });
          }),
        ),

        el('h4', { class: 'trade-heading' }, ['Pulsa lo que pides a cambio']),
        el(
          'div',
          { class: 'card-rail' },
          RESOURCES.map((resource) =>
            resourceCardButton(resource, {
              size: 'md',
              count: want[resource] ?? 0,
              selected: (want[resource] ?? 0) > 0,
              disabled: (want[resource] ?? 0) >= 9,
              onclick: () => {
                want[resource] = (want[resource] ?? 0) + 1;
                draw();
              },
            }),
          ),
        ),

        el('div', { class: 'modal__footer' }, [
          el('button', { class: 'btn btn--ghost', type: 'button', onclick: () => this.close() }, [
            'Cancelar',
          ]),
          el(
            'button',
            {
              class: 'btn',
              type: 'button',
              disabled: giveTotal === 0 || wantTotal === 0,
              onclick: () =>
                this.dispatch({
                  type: 'offerTrade',
                  player,
                  give: { ...give },
                  want: { ...want },
                }),
            },
            ['Poner la oferta'],
          ),
        ]),
      );
    };
    draw();
    return container;
  }

  /**
   * Mesa de negociacion.
   *
   * En local todos comparten pantalla y cada jugador pulsa su propia fila. En
   * red cada uno solo puede pulsar LO SUYO: su aceptar y su pasar, y el que
   * ofrece, el cerrar trato. Ademas, si se puede aceptar o no depende de la
   * mano, que de los rivales no se conoce -- ahi el boton se deja disponible y
   * el motor rechaza la jugada si no cuadra, que es donde tiene que decidirse.
   */
  private renderTradeResponses(): HTMLElement {
    const s = this.state;
    const trade = s.activeTrade!;
    const offerer = s.players[trade.from]!;

    const summary = (delta: Partial<ResourceCount>) =>
      RESOURCES.filter((r) => (delta[r] ?? 0) > 0)
        .map((r) => `${delta[r]} ${RESOURCE_LABEL[r]}`)
        .join(' + ') || 'nada';

    /** Las cartas de un lado de la oferta, una por unidad. */
    const pile = (delta: Partial<ResourceCount>) =>
      RESOURCES.flatMap((r) =>
        Array.from({ length: delta[r] ?? 0 }, () =>
          resourceCard(r, { size: 'sm', extra: 'rcard--deal' }),
        ),
      );

    return el('div', { class: 'modal modal--trade' }, [
      el('h2', { class: 'modal__title' }, [`Oferta de ${offerer.name}`]),
      // El texto se mantiene ademas de las cartas: es lo que leen los lectores
      // de pantalla y lo que hace la oferta inequivoca cuando hay muchas cartas.
      el('p', { class: 'modal__text' }, [
        `Da ${summary(trade.give)} a cambio de ${summary(trade.want)}.`,
      ]),
      el('div', { class: 'trade-board' }, [
        this.tradeRow('give', `${offerer.name} da`, pile(trade.give)),
        this.tradeRow('want', 'y pide', pile(trade.want)),
      ]),
      el(
        'div',
        { class: 'responses' },
        s.players
          .filter((p) => p.id !== trade.from)
          .map((p) => {
            const response = trade.responses[p.id];
            // La mano ajena no se conoce en red, asi que solo se comprueba la
            // propia. Para los demas no se adelanta nada: es informacion suya.
            const mine = this.net === null || p.id === this.net.seat;
            const canAccept = mine ? hasResources(p.resources, trade.want) : true;
            const canPress = mine;
            const canClose = this.net === null || this.net.seat === trade.from;
            return el(
              'div',
              {
                class: 'response-row',
                style: `--player-color:${PLAYER_PALETTE[p.color].main}`,
              },
              [
                el('span', {}, [
                  p.name,
                  response === 'accepted' ? ' · acepta' : '',
                  response === 'rejected' ? ' · rechaza' : '',
                ]),
                response === 'pending' && !canPress
                  ? el('span', { class: 'tag' }, ['pensandolo'])
                  : response === 'pending'
                  ? el('span', { style: 'display:flex;gap:.4rem' }, [
                      el(
                        'button',
                        {
                          class: 'btn',
                          type: 'button',
                          disabled: !canAccept,
                          title: canAccept ? '' : 'No tienes esos recursos',
                          onclick: () =>
                            this.dispatch({ type: 'respondTrade', player: p.id, accept: true }),
                        },
                        ['Acepto'],
                      ),
                      el(
                        'button',
                        {
                          class: 'btn btn--ghost',
                          type: 'button',
                          onclick: () =>
                            this.dispatch({ type: 'respondTrade', player: p.id, accept: false }),
                        },
                        ['Paso'],
                      ),
                    ])
                  : response === 'accepted'
                    ? canClose
                      ? el(
                          'button',
                          {
                            class: 'btn',
                            type: 'button',
                            onclick: () =>
                              this.dispatch({
                                type: 'confirmTrade',
                                player: trade.from,
                                with: p.id,
                              }),
                          },
                          ['Cerrar trato'],
                        )
                      : el('span', { class: 'tag' }, ['acepta'])
                    : el('span', { class: 'tag' }, ['sin trato']),
              ],
            );
          }),
      ),
      el('div', { class: 'modal__footer' }, [
        el(
          'button',
          {
            class: 'btn btn--danger',
            type: 'button',
            onclick: () => this.dispatch({ type: 'cancelTrade', player: trade.from }),
          },
          ['Retirar oferta'],
        ),
      ]),
    ]);
  }

  private renderRules(): HTMLElement {
    return el('div', { class: 'modal' }, [
      el('h2', { class: 'modal__title' }, ['Recordatorio de reglas']),
      el('div', { class: 'rules-list' }, [
        el('p', {}, [
          el('strong', {}, ['Costes. ']),
          'Camino: 1 madera + 1 arcilla. Poblado: 1 madera + 1 arcilla + 1 lana + 1 trigo. ',
          'Ciudad: 2 trigo + 3 mineral. Carta de desarrollo: 1 lana + 1 trigo + 1 mineral.',
        ]),
        el('p', {}, [
          el('strong', {}, ['Produccion. ']),
          'Cada tirada activa las casillas con ese numero: un poblado da 1 carta y una ciudad 2. La casilla del ladron no produce.',
        ]),
        el('p', {}, [
          el('strong', {}, ['El 7. ']),
          'Quien tenga mas de 7 cartas descarta la mitad. Despues el jugador en turno mueve el ladron y roba una carta a alguien con un edificio en esa casilla.',
        ]),
        el('p', {}, [
          el('strong', {}, ['Distancia. ']),
          'Entre dos edificios cualesquiera debe haber al menos un cruce libre. Los caminos no pueden atravesar un poblado rival.',
        ]),
        el('p', {}, [
          el('strong', {}, ['Bonificaciones. ']),
          'Ruta comercial mas larga: 5 o mas caminos continuos (+2). Mayor ejercito: 3 o mas caballeros jugados (+2). Ambas se arrebatan superando al titular.',
        ]),
        el('p', {}, [
          el('strong', {}, ['Puertos. ']),
          'Un poblado sobre un puerto permite cambiar con el banco a 3:1 (generico) o 2:1 (del recurso indicado) en lugar de 4:1.',
        ]),
        el('p', {}, [
          el('strong', {}, ['Construir. ']),
          'No hace falta pulsar ningun boton: el tablero marca en dorado todo lo que puedes levantar y un clic ahi lo construye. Sobre un poblado tuyo, el clic lo mejora a ciudad. Los botones de la barra sirven para filtrar cuando hay demasiados sitios a la vez.',
        ]),
        el('p', {}, [
          el('strong', {}, ['La vista. ']),
          'Arrastra para girar el tablero y verlo desde cualquier lado. La rueda del raton acerca y aleja, y con el boton derecho (o Mayus y arrastrar) se desplaza. Doble clic vuelve al encuadre inicial. Los dados de la esquina se pulsan para tirar.',
        ]),
      ]),
      el('div', { class: 'modal__footer' }, [
        el('button', { class: 'btn', type: 'button', onclick: () => this.close() }, ['Entendido']),
      ]),
    ]);
  }

  private close(): void {
    this.modal = null;
    this.render();
  }

  /**
   * Cierra la partida y suelta todo lo que tenia cogido.
   *
   * Hace falta porque una partida en red ya no acaba con la pagina: al terminar
   * se vuelve a la sala y desde alli se empieza otra, con un `GameApp` nuevo
   * sobre los MISMOS elementos del documento. Sin esto, el anterior seguiria
   * escuchando los botones de arriba y repintando el tablero desde su propio
   * bucle, y cada clic haria dos cosas a la vez.
   */
  destroy(): void {
    window.clearTimeout(this.botTimer);
    window.clearTimeout(this.flashTimer);
    window.clearTimeout(this.handPulseTimer);
    window.clearInterval(this.clockTimer);
    this.listeners.abort();
    this.view.destroy();
    document.getElementById('btn-speed')?.classList.remove('hidden');
    this.gameEl.classList.add('hidden');
    this.overlayEl.classList.add('hidden');
    this.setupEl.classList.remove('hidden');
  }

  private confirmExit(): void {
    this.modal = () =>
      el('div', { class: 'modal' }, [
        el('h2', { class: 'modal__title' }, ['Abandonar la partida']),
        el('p', { class: 'modal__text' }, [
          'Se perdera el progreso actual y volveras a la pantalla de configuracion.',
        ]),
        el('div', { class: 'modal__footer' }, [
          el('button', { class: 'btn btn--ghost', type: 'button', onclick: () => this.close() }, [
            'Seguir jugando',
          ]),
          el('button', { class: 'btn btn--danger', type: 'button', onclick: () => this.onExit() }, [
            'Salir',
          ]),
        ]),
      ]);
    this.render();
  }
}

function costLabel(kind: keyof typeof COSTS): string {
  const cost = COSTS[kind];
  const icons: Record<Resource, string> = RESOURCE_ICON;
  return RESOURCES.filter((r) => cost[r] > 0)
    .map((r) => icons[r].repeat(cost[r]))
    .join('');
}
