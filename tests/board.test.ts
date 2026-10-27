import { describe, expect, it } from 'vitest';
import { buildTopology, coastalRing, generateBoard, layoutCoords } from '../src/engine/board.js';
import { piecesFor, VARIANT_SETUP } from '../src/engine/constants.js';
import { edgeId, hexCorners, hexEdges, parseEdgeId } from '../src/engine/hex.js';
import { createRng } from '../src/engine/rng.js';
import type { BoardVariant } from '../src/engine/types.js';

const VARIANTS: BoardVariant[] = ['base', 'extended', 'large', 'huge'];

describe('geometria hexagonal', () => {
  it('los hexagonos vecinos comparten exactamente dos esquinas', () => {
    const a = hexCorners({ q: 0, r: 0 });
    const b = hexCorners({ q: 1, r: 0 });
    const shared = a.filter((v) => b.includes(v));
    expect(shared).toHaveLength(2);
  });

  it('tres hexagonos que rodean un cruce producen la misma clave de vertice', () => {
    const a = hexCorners({ q: 0, r: 0 });
    const b = hexCorners({ q: 1, r: 0 });
    const c = hexCorners({ q: 0, r: 1 });
    const shared = a.filter((v) => b.includes(v) && c.includes(v));
    expect(shared).toHaveLength(1);
  });

  it('la clave de arista es la misma en cualquier orden', () => {
    expect(edgeId('1,1', '0,2')).toBe(edgeId('0,2', '1,1'));
  });

  it('cada arista de un hexagono une dos esquinas consecutivas', () => {
    const corners = hexCorners({ q: -1, r: 2 });
    const edges = hexEdges({ q: -1, r: 2 });
    edges.forEach((edge, i) => {
      const [a, b] = parseEdgeId(edge);
      const expected = [corners[i]!, corners[(i + 1) % 6]!].sort();
      expect([a, b].sort()).toEqual(expected);
    });
  });
});

describe('generacion de tablero', () => {
  for (const variant of VARIANTS) {
    describe(variant, () => {
      const setup = VARIANT_SETUP[variant];
      const [board] = generateBoard(variant, createRng(12345));

      it('tiene el numero correcto de casillas', () => {
        expect(layoutCoords(variant)).toHaveLength(setup.terrains.length);
        expect(board.hexOrder).toHaveLength(setup.terrains.length);
      });

      it('reparte exactamente los terrenos previstos', () => {
        const tally = new Map<string, number>();
        for (const id of board.hexOrder) {
          const t = board.hexes[id]!.terrain;
          tally.set(t, (tally.get(t) ?? 0) + 1);
        }
        const expected = new Map<string, number>();
        for (const t of setup.terrains) expected.set(t, (expected.get(t) ?? 0) + 1);
        expect(Object.fromEntries(tally)).toEqual(Object.fromEntries(expected));
      });

      it('reparte exactamente las fichas numericas y ninguna en el desierto', () => {
        const numbers: number[] = [];
        for (const id of board.hexOrder) {
          const hex = board.hexes[id]!;
          if (hex.terrain === 'desert') {
            expect(hex.number).toBeNull();
          } else {
            expect(hex.number).not.toBeNull();
            numbers.push(hex.number!);
          }
        }
        expect(numbers.sort((a, b) => a - b)).toEqual([...setup.numbers].sort((a, b) => a - b));
      });

      it('nunca coloca un 7', () => {
        for (const id of board.hexOrder) expect(board.hexes[id]!.number).not.toBe(7);
      });

      it('coloca el numero correcto de puertos, todos en la costa', () => {
        expect(board.ports).toHaveLength(setup.ports.length + setup.genericPorts);
        const coastal = new Set(coastalRingOf(variant));
        for (const port of board.ports) expect(coastal.has(port.edge)).toBe(true);
      });

      it('no repite la misma arista en dos puertos', () => {
        const edges = board.ports.map((p) => p.edge);
        expect(new Set(edges).size).toBe(edges.length);
      });

      it('reparte los puertos por toda la costa, sin amontonarlos', () => {
        // El anillo ORDENADO, recorriendo el perimetro. `coastalRingOf`
        // devuelve las mismas aristas pero sueltas, y sobre esa lista las
        // distancias no significan nada.
        const ring = coastalRing(buildTopology(layoutCoords(variant)));
        const at = board.ports.map((port) => ring.indexOf(port.edge)).sort((a, b) => a - b);
        expect(at.every((i) => i >= 0)).toBe(true);

        // Ningun puerto se aparta mas de una arista de donde le tocaria con el
        // reparto perfecto.
        //
        // Es una condicion mas fuerte que mirar los huecos, y hace falta que lo
        // sea: el reparto viejo -- huecos de 4,4,4,3,3,3,3,3,3 -- tambien tiene
        // todos los huecos a distancia 1 entre si, y sin embargo amontona los
        // tres grandes en el mismo lado de la isla. Lo que delata el
        // amontonamiento es la deriva acumulada, no el hueco suelto.
        at.forEach((pos, i) => {
          const ideal = (i * ring.length) / at.length;
          expect(Math.abs(pos - ideal), `puerto ${i} en ${pos}, le tocaba ${ideal}`).toBeLessThanOrEqual(1);
        });

        const gaps = at.map((v, i) => {
          const next = at[(i + 1) % at.length]!;
          return (next - v + ring.length) % ring.length;
        });
        expect(gaps.reduce((a, b) => a + b, 0)).toBe(ring.length);
      });

      it('dos puertos nunca comparten un cruce', () => {
        // Si lo compartieran, un solo poblado daria dos puertos: en el juego de
        // mesa no pasa porque siempre queda al menos una arista libre en medio.
        const seen = new Set<string>();
        for (const port of board.ports) {
          for (const vertex of port.vertices) {
            expect(seen.has(vertex)).toBe(false);
            seen.add(vertex);
          }
        }
      });

      it('cada puerto se apoya en una sola casilla de la isla', () => {
        // Es la definicion de arista costera, y ademas lo que permite dibujar
        // el puerto: la casilla de mar donde va la ficha es la reflejada de esa
        // casilla de tierra a traves del punto medio de la arista. Con dos
        // casillas -- o con ninguna -- no habria donde ponerlo.
        for (const port of board.ports) {
          const [a, b] = port.vertices;
          const at = new Set(board.vertexHexes[b] ?? []);
          const shared = (board.vertexHexes[a] ?? []).filter((h) => at.has(h));
          expect(shared, port.edge).toHaveLength(1);
        }
      });

      it('el ladron empieza en un desierto', () => {
        expect(board.hexes[board.robberStart]!.terrain).toBe('desert');
      });

      it('el grafo de cruces es coherente', () => {
        for (const [vertex, neighbors] of Object.entries(board.vertexNeighbors)) {
          for (const neighbor of neighbors) {
            expect(board.vertexNeighbors[neighbor]).toContain(vertex);
          }
          // Cada cruce toca entre 2 y 3 aristas y entre 1 y 3 casillas.
          expect(board.vertexEdges[vertex]!.length).toBeGreaterThanOrEqual(2);
          expect(board.vertexEdges[vertex]!.length).toBeLessThanOrEqual(3);
          expect(board.vertexHexes[vertex]!.length).toBeGreaterThanOrEqual(1);
          expect(board.vertexHexes[vertex]!.length).toBeLessThanOrEqual(3);
        }
      });
    });
  }

  it('la misma semilla produce el mismo tablero', () => {
    const [a] = generateBoard('extended', createRng(777));
    const [b] = generateBoard('extended', createRng(777));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('semillas distintas producen tableros distintos', () => {
    const [a] = generateBoard('base', createRng(1));
    const [b] = generateBoard('base', createRng(2));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('evita el 6 y el 8 adyacentes en la gran mayoria de tableros', () => {
    let clean = 0;
    const attempts = 40;
    for (let seed = 0; seed < attempts; seed++) {
      const [board] = generateBoard('base', createRng(seed * 9973 + 5));
      let conflicts = 0;
      for (const id of board.hexOrder) {
        const hex = board.hexes[id]!;
        if (hex.number !== 6 && hex.number !== 8) continue;
        for (const other of board.hexOrder) {
          if (other === id) continue;
          const o = board.hexes[other]!;
          if (o.number !== 6 && o.number !== 8) continue;
          const shared = hex.vertices.filter((v) => o.vertices.includes(v));
          if (shared.length === 2) conflicts++;
        }
      }
      if (conflicts === 0) clean++;
    }
    expect(clean).toBe(attempts);
  });
});

/** Recalcula el anillo costero desde cero para comprobar los puertos. */
function coastalRingOf(variant: BoardVariant): string[] {
  const coords = layoutCoords(variant);
  const count = new Map<string, number>();
  for (const coord of coords) {
    for (const edge of hexEdges(coord)) count.set(edge, (count.get(edge) ?? 0) + 1);
  }
  return [...count.entries()].filter(([, n]) => n === 1).map(([edge]) => edge);
}

describe('composicion derivada de las proporciones clasicas', () => {
  /**
   * El reparto de terrenos, fichas y cartas de los mapas grandes no esta
   * escrito a mano: se deriva de las proporciones del tablero clasico. Estos
   * tests fijan la propiedad que justifica ese enfoque, que es que la formula
   * reproduce EXACTAMENTE el material oficial de las dos variantes que existen
   * de verdad. Si alguien toca los pesos, esto salta.
   */
  const tally = (items: (string | number)[]) => {
    const out: Record<string, number> = {};
    for (const item of items) out[String(item)] = (out[String(item)] ?? 0) + 1;
    return out;
  };

  it('el tablero clasico da el material oficial de 19 casillas', () => {
    const setup = VARIANT_SETUP.base;
    expect(tally(setup.terrains)).toEqual({
      forest: 4,
      pasture: 4,
      fields: 4,
      hills: 3,
      mountains: 3,
      desert: 1,
    });
    expect(tally(setup.numbers)).toEqual(
      tally([2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12]),
    );
    expect(setup.devDeck).toEqual({
      knight: 14,
      victoryPoint: 5,
      roadBuilding: 2,
      yearOfPlenty: 2,
      monopoly: 2,
    });
    expect(setup.ports).toHaveLength(5);
    expect(setup.genericPorts).toBe(4);
    expect(setup.bankPerResource).toBe(19);
  });

  it('el tablero ampliado da el material oficial de la extension 5-6', () => {
    const setup = VARIANT_SETUP.extended;
    expect(tally(setup.terrains)).toEqual({
      forest: 6,
      pasture: 6,
      fields: 6,
      hills: 5,
      mountains: 5,
      desert: 2,
    });
    expect(tally(setup.numbers)).toEqual(
      tally([
        2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6, 8, 8, 8, 9, 9, 9, 10, 10, 10, 11, 11, 11,
        12, 12,
      ]),
    );
    expect(setup.devDeck).toEqual({
      knight: 20,
      victoryPoint: 5,
      roadBuilding: 3,
      yearOfPlenty: 3,
      monopoly: 3,
    });
    expect(setup.ports).toHaveLength(6);
    expect(setup.genericPorts).toBe(5);
    expect(setup.bankPerResource).toBe(24);
  });

  it('cada mapa tiene una ficha por casilla productiva', () => {
    for (const variant of VARIANTS) {
      const setup = VARIANT_SETUP[variant];
      const deserts = setup.terrains.filter((t) => t === 'desert').length;
      expect(setup.numbers).toHaveLength(setup.terrains.length - deserts);
      expect(setup.numbers).not.toContain(7);
    }
  });

  it('los mapas crecen de verdad y suben el objetivo de puntos', () => {
    const sizes = VARIANTS.map((v) => VARIANT_SETUP[v].terrains.length);
    expect(sizes).toEqual([19, 30, 37, 61]);
    expect(VARIANT_SETUP.large.victoryPoints).toBeGreaterThan(VARIANT_SETUP.base.victoryPoints);
    expect(VARIANT_SETUP.huge.victoryPoints).toBeGreaterThan(VARIANT_SETUP.large.victoryPoints);
  });

  it('en los mapas grandes hay piezas suficientes para llegar al objetivo', () => {
    for (const variant of VARIANTS) {
      const setup = VARIANT_SETUP[variant];
      const pieces = piecesFor(variant);
      // Solo con edificios, sin cartas ni bonificaciones, hay que poder pasar
      // del objetivo: si no, la partida seria imposible de ganar.
      const maxFromBuildings = pieces.settlement + pieces.city * 2;
      expect(maxFromBuildings).toBeGreaterThan(setup.victoryPoints);
    }
  });
});

describe('anillo costero', () => {
  for (const variant of VARIANTS) {
    it(`${variant}: recorre toda la costa en un unico ciclo`, () => {
      const coords = layoutCoords(variant);
      const topology = buildMinimalTopology(coords);
      const ring = coastalRing(topology);
      expect(ring).toHaveLength(coastalRingOf(variant).length);
      // Dos aristas consecutivas del anillo comparten un cruce.
      for (let i = 0; i < ring.length; i++) {
        const a = parseEdgeId(ring[i]!);
        const b = parseEdgeId(ring[(i + 1) % ring.length]!);
        expect(a.some((v) => b.includes(v))).toBe(true);
      }
    });
  }
});

function buildMinimalTopology(coords: { q: number; r: number }[]) {
  const edgeVertices: Record<string, [string, string]> = {};
  const edgeHexCount: Record<string, number> = {};
  for (const coord of coords) {
    const corners = hexCorners(coord);
    for (let i = 0; i < 6; i++) {
      const a = corners[i]!;
      const b = corners[(i + 1) % 6]!;
      const e = edgeId(a, b);
      edgeVertices[e] = a < b ? [a, b] : [b, a];
      edgeHexCount[e] = (edgeHexCount[e] ?? 0) + 1;
    }
  }
  return {
    vertexHexes: {},
    vertexNeighbors: {},
    edgeVertices,
    vertexEdges: {},
    edgeHexCount,
  };
}
