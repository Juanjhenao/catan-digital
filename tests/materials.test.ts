import { describe, expect, it } from 'vitest';
import type { Resource } from '../src/engine/index.js';
import { drawMaterial, MATERIAL_BACKDROP } from '../src/ui/materials.js';

/**
 * El dibujo de los cinco materiales.
 *
 * No hay forma de comprobar aqui si una oveja parece una oveja -- eso se mira
 * con los ojos, renderizando a PNG con `tools/render-cards.ts`. Lo que si se
 * puede comprobar, y es donde se cuelan los fallos de verdad, es que el dibujo
 * sea **el mismo siempre**: el terreno del tablero varia de casilla a casilla a
 * proposito, y es facil arrastrar esa costumbre al arte de las cartas. Dos
 * cartas de trigo distintas en la misma mano serian un error que nadie ve
 * revisando el codigo.
 */

const RESOURCES: Resource[] = ['lumber', 'brick', 'wool', 'grain', 'ore'];

/**
 * Contexto que apunta todo lo que se le pide en vez de pintarlo.
 *
 * Compara dibujos sin necesidad de pixeles: dos llamadas que producen la misma
 * lista de ordenes producen la misma imagen.
 */
function recorder(): { ctx: CanvasRenderingContext2D; log: string[] } {
  const log: string[] = [];
  const gradient = {
    addColorStop: (stop: number, color: string) => log.push(`stop ${stop} ${color}`),
  };
  const round = (n: unknown) => (typeof n === 'number' ? n.toFixed(4) : String(n));
  const target: Record<string, unknown> = {};
  const ctx = new Proxy(target, {
    get(_t, prop: string) {
      if (prop === 'createRadialGradient' || prop === 'createLinearGradient') {
        return (...args: number[]) => {
          log.push(`${prop} ${args.map(round).join(' ')}`);
          return gradient;
        };
      }
      if (prop in target) return target[prop];
      return (...args: unknown[]) => log.push(`${prop} ${args.map(round).join(' ')}`);
    },
    set(_t, prop: string, value) {
      log.push(`${prop} = ${String(value)}`);
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, log };
}

function draw(resource: Resource): string[] {
  const { ctx, log } = recorder();
  drawMaterial(ctx, resource, 100, 100, 60);
  return log;
}

describe('dibujo de los materiales', () => {
  it('cada material dibuja algo, y algo con cuerpo', () => {
    for (const resource of RESOURCES) {
      const log = draw(resource);
      expect(log.length, resource).toBeGreaterThan(30);
      expect(log.filter((line) => line.startsWith('fill ')).length, resource).toBeGreaterThan(2);
    }
  });

  it('el mismo material se dibuja siempre igual', () => {
    for (const resource of RESOURCES) {
      expect(draw(resource), resource).toEqual(draw(resource));
    }
  });

  it('no hay dos materiales que se dibujen igual', () => {
    const seen = new Map<string, Resource>();
    for (const resource of RESOURCES) {
      const key = draw(resource).join('\n');
      expect(seen.get(key), `${resource} se dibuja igual que ${seen.get(key)}`).toBeUndefined();
      seen.set(key, resource);
    }
  });

  it('el tamano manda: al doble de escala, el doble de lejos del centro', () => {
    // Las figuras se describen de -1 a 1 y se escalan al dibujar. Si alguna
    // coordenada se colara en pixeles, dejaria de crecer con la carta y el
    // dibujo se descuadraria justo en el tamano que no se estuviera mirando.
    const at = (s: number): number[] => {
      const { ctx, log } = recorder();
      drawMaterial(ctx, 'ore', 0, 0, s);
      return log
        .filter((line) => line.startsWith('lineTo ') || line.startsWith('moveTo '))
        .map((line) => Number(line.split(' ')[1]));
    };
    const small = at(50);
    const big = at(100);
    expect(big).toHaveLength(small.length);
    small.forEach((v, i) => expect(big[i]!).toBeCloseTo(v * 2, 3));
  });

  it('los cinco materiales tienen fondo', () => {
    for (const resource of RESOURCES) {
      const backdrop = MATERIAL_BACKDROP[resource];
      expect(backdrop.from, resource).toMatch(/^#[0-9a-f]{6}$/i);
      expect(backdrop.to, resource).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});
