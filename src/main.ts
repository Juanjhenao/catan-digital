import {
  BOARD_VARIANTS,
  PLAYER_COLORS,
  randomSeed,
  VARIANT_SETUP,
  variantForPlayers,
  type BoardVariant,
  type BotDifficulty,
  type PlayerColor,
  type PlayerConfig,
  type PlayerKind,
} from './engine/index.js';
import { GameApp } from './ui/app.js';
import { openLan } from './ui/lan.js';
import { remembersName, savedName, setRemembered } from './ui/profile.js';
import { el, replace } from './ui/dom.js';
import { PLAYER_PALETTE } from './ui/theme.js';
import './styles.css';

/**
 * Arranque de la aplicacion: pantalla de configuracion y salto a la partida.
 *
 * Hay dos caminos desde aqui. El local crea la partida en el sitio a partir de
 * una semilla y la juega entera en este dispositivo. El de red (`ui/lan.ts`)
 * delega en un servidor, que es el que tiene el estado bueno.
 *
 * Que el segundo se pudiera anadir sin tocar el motor no fue suerte: el motor
 * es un reductor `(estado, accion) -> estado` con el azar DENTRO del estado, asi
 * que un servidor puede aplicar las mismas acciones y obtener exactamente lo
 * mismo que obtendria un cliente.
 */

const setupEl = document.getElementById('setup')!;
const gameEl = document.getElementById('game')!;
const overlayEl = document.getElementById('overlay')!;

/** Opciones del desplegable de cada jugador. */
const SEAT_OPTIONS: { value: string; label: string }[] = [
  { value: 'human', label: 'Humano' },
  { value: 'bot:easy', label: 'Bot facil' },
  { value: 'bot:normal', label: 'Bot normal' },
  { value: 'bot:hard', label: 'Bot dificil' },
];

interface SetupState {
  count: number;
  names: string[];
  /** Si al empezar hay que guardar el nombre del primer asiento humano. */
  remember: boolean;
  colors: PlayerColor[];
  kinds: PlayerKind[];
  difficulties: BotDifficulty[];
  /** 'auto' elige el mapa segun el numero de jugadores. */
  map: BoardVariant | 'auto';
  /** 'auto' usa los puntos que trae el mapa. */
  victoryPoints: number | 'auto';
  seed: string;
}

const DEFAULT_NAMES = ['Ana', 'Bruno', 'Carmen', 'Diego', 'Elena', 'Fabio'];

const setup: SetupState = {
  count: 4,
  names: [...DEFAULT_NAMES],
  colors: [...PLAYER_COLORS],
  // Por defecto una persona contra tres bots: es lo que casi todo el mundo
  // quiere probar primero.
  kinds: ['human', 'bot', 'bot', 'bot', 'bot', 'bot'],
  difficulties: Array(6).fill('normal'),
  map: 'auto',
  victoryPoints: 'auto',
  seed: '',
  remember: remembersName(),
};

/**
 * El asiento de quien esta al teclado: el primero que lleve un humano.
 *
 * Con varias personas en el sofa no hay forma de saber cual es «la mia», asi
 * que se toma la primera, que es la que ya venia rellenada. Es una convencion,
 * no una deduccion, y por eso la casilla de recordar esta pegada a esa fila.
 */
function mySeat(): number {
  const index = setup.kinds.slice(0, setup.count).indexOf('human');
  return index === -1 ? 0 : index;
}

// El nombre guardado entra en el asiento propio antes del primer pintado, para
// que se vea puesto en vez de aparecer despues.
{
  const guardado = savedName();
  if (guardado) setup.names[mySeat()] = guardado;
}

function chosenVariant(): BoardVariant {
  return setup.map === 'auto' ? variantForPlayers(setup.count) : setup.map;
}

function renderSetup(): void {
  const variant = chosenVariant();
  const info = VARIANT_SETUP[variant];
  const humans = setup.kinds.slice(0, setup.count).filter((k) => k === 'human').length;

  const card = el('div', { class: 'setup__card' }, [
    el('h1', { class: 'setup__title' }, ['Colonos']),
    el('p', { class: 'setup__subtitle' }, [
      'Catan completo: contra la maquina o por turnos en este mismo dispositivo.',
    ]),

    el('div', { class: 'setup__grid' }, [
      field('Numero de jugadores', 'count', [2, 3, 4, 5, 6], setup.count, (value) => {
        setup.count = Number(value);
        renderSetup();
      }),
      el('div', { class: 'field' }, [
        el('label', { class: 'field__label', for: 'map' }, ['Tamano del mapa']),
        el(
          'select',
          {
            id: 'map',
            onchange: (event: Event) => {
              setup.map = (event.target as HTMLSelectElement).value as BoardVariant | 'auto';
              renderSetup();
            },
          },
          [
            el('option', { value: 'auto', selected: setup.map === 'auto' }, [
              'Automatico segun jugadores',
            ]),
            ...BOARD_VARIANTS.map((v) =>
              el('option', { value: v, selected: setup.map === v }, [
                `${VARIANT_SETUP[v].label} (${VARIANT_SETUP[v].terrains.length} casillas)`,
              ]),
            ),
          ],
        ),
      ]),
      el('div', { class: 'field' }, [
        el('label', { class: 'field__label', for: 'vp' }, ['Puntos para ganar']),
        el(
          'select',
          {
            id: 'vp',
            onchange: (event: Event) => {
              const raw = (event.target as HTMLSelectElement).value;
              setup.victoryPoints = raw === 'auto' ? 'auto' : Number(raw);
            },
          },
          [
            el('option', { value: 'auto', selected: setup.victoryPoints === 'auto' }, [
              `Los del mapa (${info.victoryPoints})`,
            ]),
            ...[8, 10, 12, 15, 18].map((n) =>
              el('option', { value: String(n), selected: setup.victoryPoints === n }, [
                `${n} puntos`,
              ]),
            ),
          ],
        ),
      ]),
      el('div', { class: 'field' }, [
        el('label', { class: 'field__label', for: 'seed' }, ['Semilla del tablero']),
        el('input', {
          id: 'seed',
          type: 'text',
          placeholder: 'al azar',
          value: setup.seed,
          oninput: (event: Event) => {
            setup.seed = (event.target as HTMLInputElement).value;
          },
        }),
      ]),
    ]),

    el('p', { class: 'note' }, [el('strong', {}, [info.label + '. ']), info.blurb]),

    el('div', { class: 'field' }, [
      el('span', { class: 'field__label' }, ['Jugadores']),
      el(
        'div',
        { class: 'player-rows' },
        Array.from({ length: setup.count }, (_, i) => playerRow(i)),
      ),
      el('label', { class: 'check' }, [
        el('input', {
          type: 'checkbox',
          checked: setup.remember,
          onchange: (event: Event) => {
            setup.remember = (event.target as HTMLInputElement).checked;
          },
        }),
        el('span', {}, [
          `Recordar mi nombre (${PLAYER_PALETTE[setup.colors[mySeat()]!].label})`,
        ]),
      ]),
    ]),

    humans === 0
      ? el('p', { class: 'note note--warn' }, [
          'No hay ningun jugador humano: la partida se jugara sola. Util para ver como juegan los bots.',
        ])
      : null,

    el('button', { class: 'btn btn--wide', type: 'button', onclick: () => startGame() }, [
      'Empezar partida',
    ]),

    // La version publicada como sitio estatico no tiene servidor de partidas
    // detras: el boton de red llevaria a una sala que nunca conecta.
    ...(import.meta.env.VITE_PAGES
      ? [
          el('p', { class: 'note' }, [
            'La partida en red local necesita su propio servidor y no esta en esta version web. ',
            'Para jugarla, clona el repositorio y ejecuta: npm run lan',
          ]),
        ]
      : [
          el('div', { class: 'setup__or' }, ['o']),
          el(
            'button',
            {
              class: 'btn btn--wide btn--ghost',
              type: 'button',
              onclick: () => openLan({ setupEl, gameEl, overlayEl }, () => renderSetup()),
            },
            ['Jugar en red local'],
          ),
          el('p', { class: 'note' }, [
            'Cada uno en su dispositivo, en la misma wifi. Requiere tener el servidor en marcha: npm run serve',
          ]),
        ]),
  ]);

  replace(setupEl, card);
}

function field(
  label: string,
  id: string,
  values: number[],
  current: number,
  onChange: (value: string) => void,
): HTMLElement {
  return el('div', { class: 'field' }, [
    el('label', { class: 'field__label', for: id }, [label]),
    el(
      'select',
      { id, onchange: (event: Event) => onChange((event.target as HTMLSelectElement).value) },
      values.map((n) =>
        el('option', { value: String(n), selected: n === current }, [`${n} jugadores`]),
      ),
    ),
  ]);
}

function playerRow(index: number): HTMLElement {
  const color = setup.colors[index]!;
  const seatValue =
    setup.kinds[index] === 'human' ? 'human' : `bot:${setup.difficulties[index]}`;

  return el('div', { class: 'player-row' }, [
    el('span', {
      class: 'swatch',
      style: `background:${PLAYER_PALETTE[color].main}`,
      title: PLAYER_PALETTE[color].label,
    }),
    el('input', {
      type: 'text',
      value: setup.names[index]!,
      maxlength: '16',
      'aria-label': `Nombre del jugador ${index + 1}`,
      oninput: (event: Event) => {
        setup.names[index] = (event.target as HTMLInputElement).value;
      },
    }),
    el(
      'select',
      {
        'aria-label': `Quien controla al jugador ${index + 1}`,
        onchange: (event: Event) => {
          const value = (event.target as HTMLSelectElement).value;
          if (value === 'human') {
            setup.kinds[index] = 'human';
          } else {
            setup.kinds[index] = 'bot';
            setup.difficulties[index] = value.split(':')[1] as BotDifficulty;
          }
          renderSetup();
        },
      },
      SEAT_OPTIONS.map((option) =>
        el('option', { value: option.value, selected: option.value === seatValue }, [
          option.label,
        ]),
      ),
    ),
  ]);
}

function startGame(): void {
  const configs: PlayerConfig[] = Array.from({ length: setup.count }, (_, i) => ({
    name: setup.names[i]?.trim() || DEFAULT_NAMES[i]!,
    color: setup.colors[i]!,
    kind: setup.kinds[i]!,
    difficulty: setup.difficulties[i]!,
  }));

  // Lo que se recuerda es el nombre ya limpio, el mismo que entra en la
  // partida: guardar lo escrito en bruto haria que al volver apareciera con
  // los espacios de mas, o vacio.
  setRemembered(configs[mySeat()]?.name ?? '', setup.remember);

  // Una semilla escrita a mano se convierte en numero de forma estable; si se
  // deja vacia, se sortea una nueva.
  const seed = setup.seed.trim() ? hashSeed(setup.seed.trim()) : randomSeed();
  const variant = chosenVariant();
  const points = setup.victoryPoints === 'auto' ? undefined : setup.victoryPoints;

  new GameApp(
    configs,
    seed,
    points,
    () => {
      gameEl.classList.add('hidden');
      overlayEl.classList.add('hidden');
      setupEl.classList.remove('hidden');
      // Recargar deja la aplicacion limpia sin arrastrar temporizadores.
      window.location.reload();
    },
    { variant },
  );
}

function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

renderSetup();
