/**
 * Generador pseudoaleatorio determinista (mulberry32).
 *
 * Todo el azar del juego pasa por aquí y el estado del RNG vive dentro de
 * GameState. Eso hace que una partida sea 100% reproducible a partir de la
 * semilla + la lista de acciones, lo cual es imprescindible para:
 *   - tests deterministas del motor,
 *   - repeticiones / "replay" de partidas,
 *   - futura validación servidor-cliente en el modo online.
 */
export interface RngState {
  seed: number;
}

export function createRng(seed: number): RngState {
  return { seed: seed >>> 0 };
}

/** Devuelve [valor en [0,1), nuevo estado]. Nunca muta la entrada. */
export function nextFloat(rng: RngState): [number, RngState] {
  let t = (rng.seed + 0x6d2b79f5) >>> 0;
  let x = t;
  x = Math.imul(x ^ (x >>> 15), x | 1);
  x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
  const value = ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  return [value, { seed: t }];
}

/** Entero en [0, max). */
export function nextInt(rng: RngState, max: number): [number, RngState] {
  const [f, next] = nextFloat(rng);
  return [Math.floor(f * max), next];
}

/** Dado de 6 caras: 1..6 */
export function rollDie(rng: RngState): [number, RngState] {
  const [n, next] = nextInt(rng, 6);
  return [n + 1, next];
}

/** Fisher-Yates puro: devuelve una copia barajada. */
export function shuffle<T>(items: readonly T[], rng: RngState): [T[], RngState] {
  const out = items.slice();
  let state = rng;
  for (let i = out.length - 1; i > 0; i--) {
    const [j, next] = nextInt(state, i + 1);
    state = next;
    const a = out[i]!;
    const b = out[j]!;
    out[i] = b;
    out[j] = a;
  }
  return [out, state];
}

/** Semilla aleatoria para partidas nuevas (fuera del motor determinista). */
export function randomSeed(): number {
  return (Math.random() * 0xffffffff) >>> 0;
}
