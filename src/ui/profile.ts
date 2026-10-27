/**
 * Lo poco que el juego recuerda de quien esta al teclado: su nombre.
 *
 * Vive en `localStorage`, que es lo unico que sobrevive a cerrar la pestana sin
 * montar cuentas ni servidor. Todo va envuelto en `try`: un navegador con los
 * datos de sitio bloqueados no devuelve `null`, LANZA -- y una pantalla de
 * configuracion que revienta al abrirse por no poder leer un nombre seria un
 * fallo mucho peor que el que se intentaba evitar.
 *
 * Se guarda ademas de la preferencia: si alguien la desmarca, el nombre se
 * borra de verdad en vez de quedarse ahi esperando a que se vuelva a marcar.
 */

const NAME_KEY = 'colonos:nombre';
const REMEMBER_KEY = 'colonos:recordar';

/** Tope igual que el del formulario, por si el valor guardado viene de antes. */
const MAX_LENGTH = 16;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Sin almacenamiento simplemente no se recuerda nada. No es un error que
    // merezca interrumpir a nadie.
  }
}

/** El nombre guardado, o cadena vacia si no hay ninguno. */
export function savedName(): string {
  return (read(NAME_KEY) ?? '').trim().slice(0, MAX_LENGTH);
}

/**
 * Si hay que seguir recordandolo.
 *
 * Cuando no hay nada escrito todavia se responde que si: es lo que casi todo el
 * mundo quiere, y la casilla se ve marcada desde el principio para que quede
 * claro que se va a guardar antes de que pase.
 */
export function remembersName(): boolean {
  const stored = read(REMEMBER_KEY);
  return stored === null ? true : stored === '1';
}

/** Guarda el nombre y deja marcada la preferencia. */
export function rememberName(name: string): void {
  const clean = name.trim().slice(0, MAX_LENGTH);
  write(REMEMBER_KEY, '1');
  write(NAME_KEY, clean || null);
}

/** Olvida el nombre y apunta que no hay que volver a guardarlo. */
export function forgetName(): void {
  write(REMEMBER_KEY, '0');
  write(NAME_KEY, null);
}

/** Aplica la eleccion de la casilla de una vez. */
export function setRemembered(name: string, remember: boolean): void {
  if (remember) rememberName(name);
  else forgetName();
}
