/**
 * Sonido del juego, sintetizado en el momento.
 *
 * No hay ni un fichero de audio en el proyecto, igual que no hay ni una imagen:
 * cada efecto se fabrica con osciladores y ruido de la Web Audio API. Sale mas
 * barato de descargar que un solo `.mp3`, se afina cambiando un numero y suena
 * distinto cada vez sin repetir la misma muestra hasta cansar.
 *
 * Tres reglas gobiernan todo lo de aqui:
 *
 * 1. **El contexto se crea al primer clic, no al cargar.** Los navegadores
 *    arrancan el audio suspendido hasta que el usuario toca algo; pedirlo antes
 *    solo deja un contexto muerto que ya no revive.
 * 2. **Nada de esto puede romper la partida.** Si no hay Web Audio (jsdom en
 *    las pruebas, un navegador raro, el usuario sin tarjeta) las llamadas se
 *    quedan en nada y el juego sigue igual.
 * 3. **Cada cosa suena a lo que es.** El camino es madera, la ciudad es piedra,
 *    el ladron es un golpe sordo y grave. Con el juego de espaldas se distingue
 *    lo que ha pasado.
 */

/** Todos los efectos del juego. */
export type Cue =
  | 'click'
  | 'dice'
  | 'harvest'
  | 'road'
  | 'settlement'
  | 'city'
  | 'devBuy'
  | 'devPlay'
  | 'knight'
  | 'trade'
  | 'robber'
  | 'steal'
  | 'discard'
  | 'endTurn'
  | 'error'
  | 'win';

// ---------------------------------------------------------------------------
// El contexto, creado tarde y una sola vez
// ---------------------------------------------------------------------------

type Ctor = new () => AudioContext;

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let broken = false;
let muted = false;

/** Volumen general. Bajo a proposito: esto acompana, no compite con nada. */
const VOLUME = 0.32;

/**
 * Devuelve el contexto de audio, creandolo la primera vez que hace falta.
 *
 * Vuelve `null` cuando no hay Web Audio; todo el modulo comprueba ese `null`
 * en vez de envolver cada efecto en su propio `try`.
 */
function audio(): AudioContext | null {
  if (broken || muted) return null;
  if (ctx) {
    // Si el navegador lo dejo suspendido (pestana de fondo, politica de
    // reproduccion), se reanuda al vuelo. Es una promesa: no se espera.
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  }
  const Ctor: Ctor | undefined =
    typeof window === 'undefined'
      ? undefined
      : ((window.AudioContext ??
          (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext) as
          | Ctor
          | undefined);
  if (!Ctor) {
    broken = true;
    return null;
  }
  try {
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = VOLUME;
    master.connect(ctx.destination);
    return ctx;
  } catch {
    broken = true;
    return null;
  }
}

/** Si el sonido esta apagado. */
export function isMuted(): boolean {
  return muted;
}

/** Apaga o enciende el sonido. Devuelve el estado nuevo. */
export function setMuted(value: boolean): boolean {
  muted = value;
  if (muted && ctx) void ctx.suspend();
  else if (!muted && ctx) void ctx.resume();
  return muted;
}

// ---------------------------------------------------------------------------
// Ladrillos de sintesis
// ---------------------------------------------------------------------------

/**
 * Una nota: oscilador con envolvente de ataque y caida.
 *
 * `from`/`to` permiten deslizar el tono, que es lo que separa un «bien» (sube)
 * de un «mal» (baja) sin cambiar nada mas.
 */
function tone(
  when: number,
  from: number,
  to: number,
  duration: number,
  gain: number,
  type: OscillatorType = 'triangle',
): void {
  const ac = ctx!;
  const osc = ac.createOscillator();
  const env = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(from, when);
  if (to !== from) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), when + duration);
  // Ataque corto pero no instantaneo: a cero absoluto el altavoz chasquea.
  env.gain.setValueAtTime(0.0001, when);
  env.gain.exponentialRampToValueAtTime(gain, when + Math.min(0.015, duration * 0.2));
  env.gain.exponentialRampToValueAtTime(0.0001, when + duration);
  osc.connect(env).connect(master!);
  osc.start(when);
  osc.stop(when + duration + 0.02);
}

const noiseCache = new Map<number, AudioBuffer>();

/** Ruido blanco de una duracion dada, guardado para no regenerarlo. */
function noiseBuffer(duration: number): AudioBuffer {
  const ac = ctx!;
  const frames = Math.max(1, Math.floor(ac.sampleRate * duration));
  const cached = noiseCache.get(frames);
  if (cached) return cached;
  const buffer = ac.createBuffer(1, frames, ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
  noiseCache.set(frames, buffer);
  return buffer;
}

/**
 * Un golpe: ruido filtrado con caida rapida.
 *
 * Es el material de todo lo percusivo. El filtro paso banda decide de que esta
 * hecho el objeto: agudo y estrecho suena a piedra, grave y ancho a tierra.
 */
function hit(
  when: number,
  frequency: number,
  duration: number,
  gain: number,
  q = 1.2,
  type: BiquadFilterType = 'bandpass',
): void {
  const ac = ctx!;
  const src = ac.createBufferSource();
  src.buffer = noiseBuffer(Math.max(0.05, duration));
  const filter = ac.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = frequency;
  filter.Q.value = q;
  const env = ac.createGain();
  env.gain.setValueAtTime(gain, when);
  env.gain.exponentialRampToValueAtTime(0.0001, when + duration);
  src.connect(filter).connect(env).connect(master!);
  src.start(when);
  src.stop(when + duration + 0.02);
}

/** Un poco de azar para que dos golpes seguidos no sean identicos. */
function jitter(amount: number): number {
  return 1 + (Math.random() * 2 - 1) * amount;
}

// ---------------------------------------------------------------------------
// Los efectos
// ---------------------------------------------------------------------------

/**
 * Cada efecto recibe el instante en que empieza. Se programan en el reloj del
 * contexto y no con temporizadores: el navegador puede retrasar un `setTimeout`
 * varias decenas de milisegundos, y en un redoble de dados eso se oye.
 */
const CUES: Record<Cue, (t: number) => void> = {
  /** Toque seco y neutro de interfaz. */
  click: (t) => hit(t, 2400 * jitter(0.08), 0.045, 0.18, 2.4),

  /** Dados: dos rebotes de madera contra la mesa y un golpe final. */
  dice: (t) => {
    hit(t, 1500 * jitter(0.1), 0.07, 0.4, 1.6);
    hit(t + 0.1, 1200 * jitter(0.12), 0.08, 0.32, 1.4);
    hit(t + 0.19, 900 * jitter(0.1), 0.11, 0.26, 1.2);
    hit(t + 0.3, 620, 0.16, 0.22, 0.9);
  },

  /** Cosecha: arpegio corto y alegre, el sonido de cobrar. */
  harvest: (t) => {
    tone(t, 523.25, 523.25, 0.13, 0.16, 'sine');
    tone(t + 0.07, 659.25, 659.25, 0.13, 0.15, 'sine');
    tone(t + 0.14, 783.99, 783.99, 0.22, 0.15, 'sine');
  },

  /** Camino: dos maderos que encajan. */
  road: (t) => {
    hit(t, 780 * jitter(0.08), 0.09, 0.34, 1.1);
    tone(t + 0.01, 300, 190, 0.12, 0.1, 'triangle');
  },

  /** Poblado: la casita que se posa, con su campanilla. */
  settlement: (t) => {
    hit(t, 1000 * jitter(0.06), 0.08, 0.3, 1.4);
    tone(t + 0.04, 587.33, 587.33, 0.2, 0.14, 'triangle');
    tone(t + 0.11, 880, 880, 0.26, 0.12, 'sine');
  },

  /** Ciudad: piedra pesada, mas grave y con mas cuerpo que el poblado. */
  city: (t) => {
    hit(t, 420 * jitter(0.06), 0.16, 0.42, 0.8);
    tone(t + 0.03, 392, 392, 0.3, 0.16, 'triangle');
    tone(t + 0.12, 587.33, 587.33, 0.34, 0.13, 'sine');
    tone(t + 0.2, 783.99, 783.99, 0.38, 0.11, 'sine');
  },

  /** Comprar carta: el roce del mazo y la carta que sale. */
  devBuy: (t) => {
    hit(t, 3200, 0.09, 0.16, 0.7, 'highpass');
    tone(t + 0.06, 440, 660, 0.16, 0.1, 'sine');
  },

  /** Jugar carta: la carta que cae sobre la mesa. */
  devPlay: (t) => {
    hit(t, 2600, 0.07, 0.2, 0.8, 'highpass');
    tone(t + 0.03, 660, 880, 0.18, 0.12, 'triangle');
  },

  /** Caballero: metal. Dos armas que chocan. */
  knight: (t) => {
    hit(t, 3400 * jitter(0.05), 0.14, 0.3, 6);
    hit(t + 0.02, 2200 * jitter(0.05), 0.22, 0.22, 8);
    tone(t + 0.02, 1320, 990, 0.3, 0.07, 'square');
  },

  /** Comercio: dos notas que se cruzan, una que va y otra que viene. */
  trade: (t) => {
    tone(t, 440, 660, 0.22, 0.13, 'sine');
    tone(t + 0.09, 660, 440, 0.24, 0.13, 'sine');
  },

  /** Ladron: paso sordo y grave. Nada agradable. */
  robber: (t) => {
    hit(t, 150, 0.3, 0.5, 0.6, 'lowpass');
    tone(t, 130, 62, 0.34, 0.2, 'sawtooth');
  },

  /** Robo: algo se escurre hacia arriba y desaparece. */
  steal: (t) => {
    tone(t, 300, 1200, 0.26, 0.12, 'sawtooth');
    hit(t + 0.16, 4000, 0.1, 0.14, 1, 'highpass');
  },

  /** Descarte: cartas que caen en el monton. */
  discard: (t) => {
    hit(t, 1800, 0.08, 0.2, 0.8, 'highpass');
    hit(t + 0.07, 1400, 0.09, 0.17, 0.8, 'highpass');
    hit(t + 0.15, 1000, 0.11, 0.14, 0.8, 'highpass');
  },

  /** Fin de turno: dos notas que bajan, «te toca a ti». */
  endTurn: (t) => {
    tone(t, 523.25, 523.25, 0.14, 0.11, 'sine');
    tone(t + 0.1, 392, 392, 0.24, 0.11, 'sine');
  },

  /** Error: bocinazo corto y bajo. Molesta lo justo. */
  error: (t) => {
    tone(t, 200, 150, 0.2, 0.16, 'square');
  },

  /** Victoria: fanfarria de cuatro notas. */
  win: (t) => {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) => {
      tone(t + i * 0.13, f, f, i === 3 ? 0.7 : 0.24, 0.17, 'triangle');
      tone(t + i * 0.13, f * 2, f * 2, i === 3 ? 0.6 : 0.2, 0.06, 'sine');
    });
  },
};

// ---------------------------------------------------------------------------
// Reproduccion
// ---------------------------------------------------------------------------

/** Ultimo instante en que sono cada efecto, para no solaparlos consigo mismos. */
const lastPlayed = new Map<Cue, number>();

/** Instante del ultimo efecto, sea cual sea. Lo mira `playClick`. */
let lastAny = -1;

/** Distancia minima entre dos disparos del mismo efecto, en segundos. */
const MIN_GAP = 0.05;

/**
 * Dispara un efecto, opcionalmente dentro de unos segundos.
 *
 * El retraso se programa en el reloj del audio y no con `setTimeout`: para
 * encadenar la cosecha detras de los dados hace falta precision de
 * milisegundos, y un temporizador del navegador no la da.
 *
 * Nunca lanza: sin audio disponible, no hace nada. Se puede llamar desde
 * cualquier sitio sin preguntar antes si hay altavoces.
 */
export function play(cue: Cue, delay = 0): void {
  const ac = audio();
  if (!ac || !master) return;
  const now = ac.currentTime;
  // Un mismo efecto repetido en el mismo fotograma (varias piezas colocadas a
  // la vez, por ejemplo) sonaria el doble de fuerte por sumarse consigo mismo.
  if (now - (lastPlayed.get(cue) ?? -1) < MIN_GAP) return;
  lastPlayed.set(cue, now);
  lastAny = now;
  try {
    // Un pelin en el futuro: programar exactamente en `currentTime` deja al
    // planificador sin margen y el ataque llega recortado.
    CUES[cue](now + 0.01 + Math.max(0, delay));
  } catch {
    broken = true;
  }
}

/**
 * Clic de interfaz.
 *
 * Se calla si acaba de sonar algo mas expresivo: casi todos los botones lanzan
 * una jugada, y el «toc» del boton pisando al golpe de la ciudad solo ensucia.
 * Queda entonces para lo que NO tiene sonido propio: abrir una ventana, cambiar
 * de pestana, elegir una carta.
 */
export function playClick(): void {
  const ac = audio();
  if (!ac) return;
  if (ac.currentTime - lastAny < 0.14) return;
  play('click');
}
