import { describe, expect, it } from 'vitest';
import type { Terrain } from '../src/engine/index.js';
import { terrainProps } from '../src/ui/props.js';

/**
 * Los objetos que se levantan de las casillas.
 *
 * Son geometria pura -- ni lienzo ni DOM -- asi que se pueden comprobar de
 * verdad, y merece la pena: se calculan una sola vez por tablero y se guardan,
 * de modo que un error aqui no se ve hasta que alguien mira una casilla
 * concreta desde un angulo concreto.
 */

const TERRAINS: Terrain[] = ['forest', 'hills', 'pasture', 'fields', 'mountains', 'desert'];

/** La casilla ocupa un radio de 1; nada puede asomar por el borde. */
const HEX_RADIUS = 1;

/**
 * Muchas casillas, no una.
 *
 * Cada hexagono siembra su propio azar, asi que un objeto que se sale del borde
 * o se mete debajo del numero puede aparecer en una casilla de cada veinte. Con
 * una sola semilla el test pasa y el fallo se ve jugando.
 */
const SEEDS = Array.from({ length: 60 }, (_, i) => `h:${i % 7},${-3 + (i % 11)}`);

describe('objetos 3d del terreno', () => {
  it('todos los terrenos levantan algo', () => {
    for (const terrain of TERRAINS) {
      const props = terrainProps(terrain, 0, 0, 'h:0,0');
      expect(props.length, terrain).toBeGreaterThan(0);
      for (const prop of props) {
        expect(prop.faces.length, terrain).toBeGreaterThan(0);
        for (const face of prop.faces) expect(face.pts.length).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('nada se sale de su casilla ni se hunde bajo la mesa', () => {
    for (const terrain of TERRAINS) {
      for (const seed of SEEDS)
        for (const prop of terrainProps(terrain, 0, 0, seed)) {
        for (const face of prop.faces) {
          for (const [x, y, z] of face.pts) {
            // Fuera del hexagono el objeto pisaria la casilla vecina, que se
            // dibuja despues y lo cortaria por la mitad.
            expect(Math.hypot(x, y), terrain).toBeLessThan(HEX_RADIUS);
            // Bajo cero quedaria enterrado en el grosor de la loseta.
            expect(z, terrain).toBeGreaterThanOrEqual(0);
          }
        }
      }
    }
  });

  it('deja libre el centro, donde va la ficha numerica', () => {
    for (const terrain of TERRAINS) {
      for (const seed of SEEDS)
        for (const prop of terrainProps(terrain, 0, 0, seed)) {
          expect(Math.hypot(prop.x, prop.y), `${terrain} ${seed}`).toBeGreaterThan(0.3);
        }
    }
  });

  it('la misma casilla da siempre el mismo bosque, y dos casillas no', () => {
    const a = terrainProps('forest', 0, 0, 'h:0,0');
    const again = terrainProps('forest', 0, 0, 'h:0,0');
    const other = terrainProps('forest', 0, 0, 'h:2,1');

    expect(a.map((p) => [p.x, p.y])).toEqual(again.map((p) => [p.x, p.y]));
    expect(a.map((p) => [p.x, p.y])).not.toEqual(other.map((p) => [p.x, p.y]));
  });

  it('se colocan en la casilla que se les pide', () => {
    const at = terrainProps('pasture', 4.5, -2.25, 'h:3,3');
    const origin = terrainProps('pasture', 0, 0, 'h:3,3');
    expect(at).toHaveLength(origin.length);
    at.forEach((prop, i) => {
      expect(prop.x - 4.5).toBeCloseTo(origin[i]!.x, 10);
      expect(prop.y + 2.25).toBeCloseTo(origin[i]!.y, 10);
    });
  });

  it('la sombra cubre el objeto sin pasarse', () => {
    for (const terrain of TERRAINS) {
      for (const seed of SEEDS)
        for (const prop of terrainProps(terrain, 0, 0, seed)) {
        let reach = 0;
        for (const face of prop.faces) {
          for (const [x, y] of face.pts) {
            reach = Math.max(reach, Math.hypot(x - prop.x, y - prop.y));
          }
        }
        expect(prop.shadow, terrain).toBeGreaterThanOrEqual(reach);
        expect(prop.shadow, terrain).toBeLessThan(reach * 2 + 0.1);
      }
    }
  });
});
