// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * La pantalla de configuracion de la partida local.
 *
 * Se prueba entera importando `main.ts`, que se pinta solo al cargarse. Es la
 * unica forma de comprobar que lo que guarda `profile.ts` llega de verdad al
 * formulario: el modulo puede estar perfecto y el nombre no aparecer nunca en
 * la casilla si el cableado esta mal.
 */

// La partida en si no se prueba aqui: pulsar «Empezar» solo tiene que dejar el
// nombre guardado. Sin este doble, `GameApp` buscaria el lienzo del tablero en
// una pagina que no lo tiene y reventaria despues de la comprobacion.
vi.mock('../src/ui/app.js', () => ({
  GameApp: class {
    constructor() {}
  },
}));

const SHELL =
  '<section id="setup" class="screen setup"></section>' +
  '<section id="game" class="screen game hidden"></section>' +
  '<div id="overlay" class="overlay hidden"></div>';

async function openSetup(): Promise<HTMLElement> {
  vi.resetModules();
  document.body.innerHTML = SHELL;
  await import('../src/main.js');
  return document.getElementById('setup')!;
}

const nameInputs = (root: HTMLElement): HTMLInputElement[] =>
  [...root.querySelectorAll('.player-row input[type="text"]')] as HTMLInputElement[];

const rememberBox = (root: HTMLElement): HTMLInputElement =>
  root.querySelector('.check input[type="checkbox"]') as HTMLInputElement;

describe('pantalla de configuracion', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('sin nombre guardado deja los de siempre y ofrece recordarlo', async () => {
    const setup = await openSetup();
    expect(nameInputs(setup)[0]!.value).toBe('Ana');
    expect(rememberBox(setup).checked).toBe(true);
  });

  it('rellena el asiento propio con el nombre guardado', async () => {
    localStorage.setItem('colonos:nombre', 'Juanjo');
    const setup = await openSetup();
    // El asiento propio es el primero humano, que por defecto es el primero.
    expect(nameInputs(setup)[0]!.value).toBe('Juanjo');
    // Y los demas siguen siendo los de siempre: se recuerda UNA persona, no la
    // mesa entera.
    expect(nameInputs(setup)[1]!.value).toBe('Bruno');
  });

  it('empezar partida guarda el nombre escrito', async () => {
    const setup = await openSetup();
    const input = nameInputs(setup)[0]!;
    input.value = '  Juanjo  ';
    input.dispatchEvent(new window.Event('input'));

    const empezar = [...setup.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').trim().startsWith('Empezar'),
    )!;
    empezar.dispatchEvent(new window.Event('click'));

    expect(localStorage.getItem('colonos:nombre')).toBe('Juanjo');
  });

  it('con la casilla desmarcada no guarda nada', async () => {
    localStorage.setItem('colonos:nombre', 'Juanjo');
    const setup = await openSetup();
    const box = rememberBox(setup);
    box.checked = false;
    box.dispatchEvent(new window.Event('change'));

    const empezar = [...setup.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').trim().startsWith('Empezar'),
    )!;
    empezar.dispatchEvent(new window.Event('click'));

    expect(localStorage.getItem('colonos:nombre')).toBeNull();
  });
});
