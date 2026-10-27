import type { PlayerColor, PlayerId } from '../engine/index.js';
import { CHAT_MAX_LENGTH, type ChatEntry } from '../net/protocol.js';
import { el, replace } from './dom.js';
import { PLAYER_PALETTE } from './theme.js';

/**
 * El chat de la partida, en la columna izquierda.
 *
 * Guarda su propio estado en vez de repintarse desde `GameApp` como el resto de
 * la interfaz, y es a proposito: el campo de texto tiene lo que la persona
 * lleva escrito y donde tiene el cursor. Reconstruirlo en cada repintado -- y
 * hay uno por cada jugada de cualquiera, incluidos los bots -- le borraria el
 * mensaje a medio escribir cada pocos segundos.
 *
 * Por eso solo se toca la lista de mensajes al recibir; la caja de escribir se
 * crea una vez y se queda.
 */

export interface ChatOptions {
  /** A donde va lo que se escribe. */
  onSend(text: string): void;
  /** De quien es cada asiento, para el color y el nombre. */
  seatColor(seat: PlayerId): PlayerColor | null;
  /** El asiento propio, para marcar los mensajes de uno. */
  mySeat(): PlayerId | null;
}

export class ChatPanel {
  private readonly listEl: HTMLElement;
  private readonly inputEl: HTMLInputElement;
  private entries: ChatEntry[] = [];
  /** Ultimo id pintado, para saber si hay que avisar de algo nuevo. */
  private lastSeen = 0;
  private unread = 0;
  private readonly badgeEl: HTMLElement;

  constructor(
    private readonly root: HTMLElement,
    private readonly options: ChatOptions,
  ) {
    this.listEl = el('div', { class: 'chat__list' });
    this.badgeEl = el('span', { class: 'chat__badge hidden' });
    this.inputEl = el('input', {
      class: 'chat__input',
      type: 'text',
      maxlength: String(CHAT_MAX_LENGTH),
      placeholder: 'Escribe y pulsa Enter',
      autocomplete: 'off',
    }) as HTMLInputElement;

    const form = el('form', { class: 'chat__form' }, [
      this.inputEl,
      el('button', { class: 'chat__send', type: 'submit', title: 'Enviar' }, ['➤']),
    ]) as HTMLFormElement;

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = this.inputEl.value.trim();
      if (!text) return;
      this.inputEl.value = '';
      this.options.onSend(text);
    });

    // El tablero escucha teclas para la camara; mientras se escribe no puede
    // llevarselas. Se corta aqui la propagacion en vez de comprobar el foco
    // desde el tablero, que obligaria a que el tablero conociera el chat.
    for (const type of ['keydown', 'keyup', 'keypress']) {
      this.inputEl.addEventListener(type, (event) => event.stopPropagation());
    }

    replace(
      this.root,
      el('div', { class: 'chat__head' }, [el('h3', { class: 'chat__title' }, ['Chat']), this.badgeEl]),
      this.listEl,
      form,
    );
    this.draw();
  }

  /** Sustituye la conversacion por la que manda el servidor. */
  setEntries(entries: ChatEntry[]): void {
    this.entries = entries;
    this.draw();
  }

  /** Anade un mensaje local, para las partidas sin servidor. */
  add(entry: ChatEntry): void {
    this.entries = [...this.entries, entry].slice(-120);
    this.draw();
  }

  private draw(): void {
    const mine = this.options.mySeat();
    // Se mira ANTES de repintar: despues, el contenedor ya tiene el alto nuevo
    // y la cuenta sale siempre «no estaba abajo».
    const atBottom =
      this.listEl.scrollHeight - this.listEl.scrollTop - this.listEl.clientHeight < 40;

    replace(
      this.listEl,
      ...this.entries.map((entry) => {
        if (entry.seat === null) {
          return el('p', { class: 'chat__note' }, [entry.text]);
        }
        const color = this.options.seatColor(entry.seat);
        const palette = color ? PLAYER_PALETTE[color] : null;
        return el(
          'p',
          {
            class: `chat__line${entry.seat === mine ? ' chat__line--me' : ''}`,
            style: palette ? `--player-color:${palette.main}` : '',
          },
          [el('span', { class: 'chat__who' }, [entry.name || 'Alguien']), entry.text],
        );
      }),
    );

    // Solo se baja solo si ya se estaba abajo: si alguien esta leyendo hacia
    // arriba, un mensaje nuevo no puede arrancarle la vista de donde estaba.
    if (atBottom) {
      this.listEl.scrollTop = this.listEl.scrollHeight;
      this.markRead();
    } else {
      const nuevos = this.entries.filter((e) => e.id > this.lastSeen).length;
      this.unread = nuevos;
      this.paintBadge();
    }
  }

  private markRead(): void {
    this.lastSeen = this.entries.at(-1)?.id ?? this.lastSeen;
    this.unread = 0;
    this.paintBadge();
  }

  private paintBadge(): void {
    this.badgeEl.textContent = String(this.unread);
    this.badgeEl.classList.toggle('hidden', this.unread === 0);
  }
}
