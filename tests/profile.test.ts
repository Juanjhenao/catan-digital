// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  forgetName,
  rememberName,
  remembersName,
  savedName,
  setRemembered,
} from '../src/ui/profile.js';

/**
 * El nombre que el juego recuerda entre partidas.
 *
 * Es poca cosa, pero toca `localStorage`, que es el unico sitio del proyecto
 * donde el navegador puede LANZAR en vez de devolver vacio -- con los datos de
 * sitio bloqueados, hasta leer falla. Que reventara ahi tumbaria la pantalla de
 * configuracion entera antes de pintarse, asi que ese caso tiene su prueba.
 */

describe('el nombre recordado', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('empieza vacio pero con la casilla marcada', () => {
    // Marcada de entrada: es lo que casi todo el mundo quiere, y asi se ve que
    // se va a guardar ANTES de que pase, no despues.
    expect(savedName()).toBe('');
    expect(remembersName()).toBe(true);
  });

  it('guarda el nombre y lo devuelve tal cual', () => {
    rememberName('Juanjo');
    expect(savedName()).toBe('Juanjo');
    expect(remembersName()).toBe(true);
  });

  it('lo limpia al guardarlo, no al leerlo', () => {
    // Si se guardara en bruto, al volver apareceria con los espacios de mas.
    rememberName('  Juanjo  ');
    expect(savedName()).toBe('Juanjo');
    rememberName('x'.repeat(40));
    expect(savedName()).toHaveLength(16);
  });

  it('al desmarcar borra el nombre de verdad', () => {
    rememberName('Juanjo');
    forgetName();
    expect(savedName()).toBe('');
    // Y no vuelve a marcarse sola en la siguiente visita: dejarlo guardado
    // «por si acaso» seria justo lo que se ha pedido no hacer.
    expect(remembersName()).toBe(false);
  });

  it('setRemembered resuelve las dos ramas de la casilla', () => {
    setRemembered('Ana', true);
    expect(savedName()).toBe('Ana');
    setRemembered('Ana', false);
    expect(savedName()).toBe('');
    expect(remembersName()).toBe(false);
  });

  it('no se cae cuando el navegador tiene el almacenamiento bloqueado', () => {
    const real = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('acceso denegado', 'SecurityError');
      },
    });
    try {
      expect(() => rememberName('Juanjo')).not.toThrow();
      expect(savedName()).toBe('');
      // Sin memoria, la casilla sale marcada igual: no se puede saber que
      // alguien la desmarco, y ofrecer guardar es mejor que no ofrecer nada.
      expect(remembersName()).toBe(true);
    } finally {
      if (real) Object.defineProperty(window, 'localStorage', real);
    }
  });
});
