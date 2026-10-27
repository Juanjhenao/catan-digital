import {
  BOARD_VARIANTS,
  VARIANT_SETUP,
  type BoardVariant,
  type PlayerConfig,
  type PlayerId,
} from '../engine/index.js';
import { NetClient, type NetStatus } from '../net/client.js';
import { normalizeRoomCode, type Lobby } from '../net/protocol.js';
import { GameApp } from './app.js';
import { el, replace } from './dom.js';
import { icon } from './icons.js';
import { remembersName, savedName, setRemembered } from './profile.js';
import { PLAYER_PALETTE } from './theme.js';

/**
 * Pantalla de partida en red local: crear sala, entrar en una, y esperar.
 *
 * Es la unica parte del cliente que sabe que existe un servidor. En cuanto la
 * partida arranca cede el mando a `GameApp`, que se comporta igual que en
 * local salvo por las tres diferencias que ya conoce: manda las jugadas en vez
 * de aplicarlas, recibe el estado de fuera, y ensena siempre la mano propia.
 */

interface Screens {
  setupEl: HTMLElement;
  gameEl: HTMLElement;
  overlayEl: HTMLElement;
}

export function openLan(screens: Screens, onBack: () => void): void {
  // El nombre se recuerda en el mismo sitio que en la partida local: quien
  // juega es la misma persona, y tener dos memorias distintas del mismo dato
  // solo sirve para que una de las dos se quede vieja.
  let name = savedName();
  let remember = remembersName();
  let code = '';
  let error: string | null = null;

  const draw = (): void => {
    const card = el('div', { class: 'setup__card' }, [
      el('h1', { class: 'setup__title' }, ['Jugar en red local']),
      el('p', { class: 'setup__subtitle' }, [
        'Cada persona en su propio dispositivo, en la misma wifi. Uno crea la sala y dicta el codigo; los demas lo escriben aqui.',
      ]),

      el('div', { class: 'setup__grid' }, [
        el('div', { class: 'field' }, [
          el('label', { class: 'field__label', for: 'lan-name' }, ['Tu nombre']),
          el('input', {
            id: 'lan-name',
            type: 'text',
            maxlength: '16',
            value: name,
            placeholder: 'Como te llamas',
            oninput: (event: Event) => {
              name = (event.target as HTMLInputElement).value;
            },
          }),
        ]),
        el('div', { class: 'field' }, [
          el('label', { class: 'field__label', for: 'lan-code' }, ['Codigo de la sala']),
          el('input', {
            id: 'lan-code',
            type: 'text',
            maxlength: '6',
            value: code,
            placeholder: 'Dejalo vacio para crear una',
            style: 'text-transform:uppercase;letter-spacing:.18em',
            oninput: (event: Event) => {
              code = normalizeRoomCode((event.target as HTMLInputElement).value);
            },
          }),
        ]),
      ]),

      el('label', { class: 'check' }, [
        el('input', {
          type: 'checkbox',
          checked: remember,
          onchange: (event: Event) => {
            remember = (event.target as HTMLInputElement).checked;
          },
        }),
        el('span', {}, ['Recordar mi nombre en este dispositivo']),
      ]),

      error ? el('p', { class: 'setup__error' }, [error]) : null,

      el('div', { class: 'setup__actions' }, [
        el(
          'button',
          {
            class: 'btn btn--ghost',
            type: 'button',
            onclick: onBack,
          },
          ['Volver'],
        ),
        el(
          'button',
          {
            class: 'btn btn--primary',
            type: 'button',
            onclick: () => {
              const trimmed = name.trim();
              if (!trimmed) {
                error = 'Escribe tu nombre para que te reconozcan en la mesa.';
                draw();
                return;
              }
              setRemembered(trimmed, remember);
              enterRoom(screens, code, trimmed, onBack);
            },
          },
          [icon('trade', 17), code ? 'Entrar en la sala' : 'Crear sala'],
        ),
      ]),
    ]);

    replace(screens.setupEl, card);
  };

  draw();
}

/**
 * Conecta y se queda en la sala de espera hasta que empieza la partida.
 *
 * El mismo `NetClient` sigue vivo despues: los mensajes de estado se
 * redirigen a `GameApp`. Reconectar con otro cliente distinto obligaria a
 * volver a negociar el asiento y se perderia la ficha de sesion.
 */
function enterRoom(screens: Screens, room: string, name: string, onBack: () => void): void {
  let status: NetStatus = 'conectando';
  let lobby: Lobby | null = null;
  let seat: PlayerId | null = null;
  let notice: string | null = null;
  let app: GameApp | null = null;

  const client: NetClient = new NetClient(room, name, {
    onLobby: (next, mySeat) => {
      lobby = next;
      seat = mySeat;
      if (next.started) return;
      // La sala vuelve a estar sin empezar mientras hay partida en pantalla:
      // alguien ha cerrado la que acabo de terminar. Se desmonta y todos
      // aparecen otra vez en la sala de espera, con su sitio y el mismo codigo.
      if (app) {
        app.destroy();
        app = null;
      }
      drawLobby();
    },
    onState: (state, mySeat) => {
      seat = mySeat;
      if (!app) {
        // Los asientos de la sala son la lista de jugadores de la partida; el
        // estado que manda el servidor ya los trae, asi que aqui solo hacen
        // falta para el constructor.
        const configs: PlayerConfig[] = state.players.map((p) => ({
          name: p.name,
          color: p.color,
          kind: p.kind,
          ...(p.difficulty ? { difficulty: p.difficulty } : {}),
        }));
        app = new GameApp(
          configs,
          0,
          state.rules.victoryPoints,
          // Abandonar a media partida si es irse del todo: se cierra la
          // conexion y se vuelve al menu.
          () => {
            client.close();
            window.location.reload();
          },
          {
            net: { client, seat: mySeat, state },
            // Terminarla, en cambio, devuelve a la sala. El servidor tira la
            // partida y manda la sala nueva a TODOS, asi que basta con pedirlo:
            // el desmontaje lo dispara el `lobby` que llega de vuelta, igual
            // para quien pulsa que para quien no.
            onFinish: () => client.send({ type: 'returnToLobby' }),
          },
        );
        // Lo que se dijo en la sala de espera no se pierde al empezar.
        app.setChat(client.chat);
        return;
      }
      app.applyRemoteState(state);
    },
    onChat: (entries) => {
      // Puede llegar antes de que exista la partida (en la sala de espera): se
      // guarda en el cliente y se vuelca en cuanto hay panel donde pintarlo.
      app?.setChat(entries);
    },
    onRejected: (reason) => {
      notice = reason;
      if (!app) drawLobby();
      else app.flashRemote(reason);
    },
    onError: (reason) => {
      client.close();
      screens.gameEl.classList.add('hidden');
      screens.overlayEl.classList.add('hidden');
      screens.setupEl.classList.remove('hidden');
      replace(
        screens.setupEl,
        el('div', { class: 'setup__card' }, [
          el('h1', { class: 'setup__title' }, ['No se ha podido entrar']),
          el('p', { class: 'setup__subtitle' }, [reason]),
          el('div', { class: 'setup__actions' }, [
            el('button', { class: 'btn btn--primary', type: 'button', onclick: onBack }, [
              'Volver',
            ]),
          ]),
        ]),
      );
    },
    onStatus: (next) => {
      status = next;
      if (!app && !lobby) drawConnecting();
      else if (!app) drawLobby();
      else app.setConnection(next);
    },
  });

  const drawConnecting = (): void => {
    replace(
      screens.setupEl,
      el('div', { class: 'setup__card' }, [
        el('h1', { class: 'setup__title' }, ['Conectando...']),
        el('p', { class: 'setup__subtitle' }, [
          status === 'reconectando'
            ? 'Se ha cortado la conexion. Reintentando.'
            : 'Buscando el servidor de la partida.',
        ]),
      ]),
    );
  };

  const drawLobby = (): void => {
    if (!lobby || seat === null) {
      drawConnecting();
      return;
    }
    const current = lobby;
    const mySeat = seat;
    const isHost = current.hostSeat === mySeat;

    const card = el('div', { class: 'setup__card' }, [
      el('h1', { class: 'setup__title' }, ['Sala ', el('span', { class: 'room-code' }, [current.code])]),
      el('p', { class: 'setup__subtitle' }, [
        'Dicta ese codigo a quien quieras que juegue. Puede entrar desde cualquier dispositivo de esta red abriendo la misma direccion.',
      ]),
      status !== 'conectado'
        ? el('p', { class: 'setup__error' }, ['Sin conexion con el servidor. Reintentando...'])
        : null,
      notice ? el('p', { class: 'setup__error' }, [notice]) : null,

      el(
        'div',
        { class: 'lobby__seats' },
        current.seats.map((s) => {
          const palette = PLAYER_PALETTE[s.color];
          const label = s.occupied
            ? s.occupantName ?? s.name
            : s.kind === 'bot'
              ? `Bot ${s.difficulty ?? 'normal'}`
              : 'Libre';
          return el(
            'div',
            {
              class: `lobby__seat${s.id === mySeat ? ' lobby__seat--me' : ''}`,
              style: `--player-color:${palette.main}`,
            },
            [
              el('span', { class: 'lobby__dot' }),
              el('span', { class: 'lobby__name' }, [
                label,
                s.id === mySeat ? el('span', { class: 'tag' }, ['tu']) : null,
                s.id === current.hostSeat ? el('span', { class: 'tag' }, ['anfitrion']) : null,
              ]),
              // Sentarse en un sitio libre, o convertirlo en bot si mandas.
              !s.occupied && s.id !== mySeat
                ? el(
                    'button',
                    {
                      class: 'btn btn--ghost',
                      type: 'button',
                      onclick: () => {
                        notice = null;
                        client.send({ type: 'takeSeat', seat: s.id });
                      },
                    },
                    ['Sentarme aqui'],
                  )
                : null,
              !s.occupied && isHost
                ? el(
                    'button',
                    {
                      class: 'btn btn--ghost',
                      type: 'button',
                      onclick: () => {
                        notice = null;
                        client.send({
                          type: 'setSeatKind',
                          seat: s.id,
                          kind: s.kind === 'bot' ? 'human' : 'bot',
                          difficulty: 'normal',
                        });
                      },
                    },
                    [s.kind === 'bot' ? 'Dejar libre' : 'Poner bot'],
                  )
                : null,
            ],
          );
        }),
      ),

      isHost
        ? el('div', { class: 'field' }, [
            el('label', { class: 'field__label', for: 'lan-map' }, ['Tamano del mapa']),
            el(
              'select',
              {
                id: 'lan-map',
                onchange: (event: Event) => {
                  client.send({
                    type: 'configure',
                    variant: (event.target as HTMLSelectElement).value as BoardVariant,
                  });
                },
              },
              BOARD_VARIANTS.map((v) =>
                el('option', { value: v, selected: current.variant === v }, [
                  `${VARIANT_SETUP[v].label} (${VARIANT_SETUP[v].terrains.length} casillas)`,
                ]),
              ),
            ),
          ])
        : null,

      el('div', { class: 'setup__actions' }, [
        el(
          'button',
          {
            class: 'btn btn--ghost',
            type: 'button',
            onclick: () => {
              client.close();
              onBack();
            },
          },
          ['Salir'],
        ),
        isHost
          ? el(
              'button',
              {
                class: 'btn btn--primary',
                type: 'button',
                onclick: () => {
                  notice = null;
                  client.send({ type: 'start' });
                },
              },
              [icon('dice', 17), 'Empezar partida'],
            )
          : el('span', { class: 'tag' }, ['Esperando al anfitrion']),
      ]),
    ]);

    replace(screens.setupEl, card);
  };

  drawConnecting();
  client.connect();
}
