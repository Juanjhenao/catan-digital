import { LONGEST_ROAD_MIN } from './constants.js';
import { parseEdgeId } from './hex.js';
import type { Building, EdgeId, GameState, PlayerId, VertexId } from './types.js';

/**
 * Longitud del camino continuo mas largo de un jugador.
 *
 * Reglas que hay que respetar y que son faciles de implementar mal:
 *  - Es el recorrido mas largo sin repetir NINGUN tramo, pero SI puede repetir
 *    cruces: un anillo cerrado de 6 caminos vale 6, no 3.
 *  - Un poblado o ciudad rival corta el camino en ese cruce: se puede llegar
 *    hasta el, pero no atravesarlo.
 *  - Las bifurcaciones no suman: solo cuenta la rama mas larga.
 *
 * Por eso es una busqueda del "trail" mas largo (camino con aristas distintas),
 * no un simple recorrido en anchura. Con 15 caminos por jugador el coste de la
 * exploracion exhaustiva es despreciable.
 */
export function longestRoadFor(
  roads: readonly EdgeId[],
  buildings: Record<VertexId, Building>,
  player: PlayerId,
): number {
  if (roads.length === 0) return 0;

  const owned = new Set(roads);
  /** cruce -> tramos propios que salen de el. */
  const incident = new Map<VertexId, EdgeId[]>();
  for (const edge of roads) {
    const [a, b] = parseEdgeId(edge);
    if (!incident.has(a)) incident.set(a, []);
    if (!incident.has(b)) incident.set(b, []);
    incident.get(a)!.push(edge);
    incident.get(b)!.push(edge);
  }

  const blocked = (vertex: VertexId): boolean => {
    const building = buildings[vertex];
    return building !== undefined && building.owner !== player;
  };

  const used = new Set<EdgeId>();
  let best = 0;

  /** Avanza habiendo llegado ya a `vertex` tras recorrer `length` tramos. */
  const advance = (vertex: VertexId, length: number): void => {
    if (length > best) best = length;
    // Un edificio rival corta aqui: se puede llegar, pero no seguir de largo.
    if (blocked(vertex)) return;
    for (const edge of incident.get(vertex) ?? []) {
      if (used.has(edge)) continue;
      const [a, b] = parseEdgeId(edge);
      const next = a === vertex ? b : a;
      used.add(edge);
      advance(next, length + 1);
      used.delete(edge);
    }
  };

  // El recorrido se siembra por TRAMOS, no por cruces. La diferencia importa:
  // un edificio rival en la punta de un camino no lo acorta (solo estorba si
  // esta en medio), pero si la busqueda arrancase en ese cruce se cortaria
  // antes de dar el primer paso y el tramo contaria de menos.
  for (const edge of owned) {
    const [a, b] = parseEdgeId(edge);
    used.add(edge);
    advance(b, 1);
    advance(a, 1);
    used.delete(edge);
  }

  return best;
}

/**
 * Recalcula la longitud de todos los jugadores y decide quien tiene la ruta
 * comercial mas larga. El titular actual conserva el titulo en caso de empate:
 * solo se le arrebata superandolo estrictamente.
 */
export function recomputeLongestRoad(state: GameState): {
  holder: PlayerId | null;
  lengths: number[];
} {
  const lengths = state.players.map((p) => longestRoadFor(p.roads, state.buildings, p.id));

  const best = Math.max(...lengths, 0);
  if (best < LONGEST_ROAD_MIN) return { holder: null, lengths };

  const leaders = lengths.flatMap((len, id) => (len === best ? [id] : []));

  // El titular conserva el titulo mientras siga empatado en cabeza: solo se le
  // arrebata superandolo. Si el titular cae y quedan varios empatados, el
  // titulo queda vacante hasta que alguien desempate.
  const current = state.longestRoadHolder;
  if (current !== null && leaders.includes(current)) return { holder: current, lengths };
  if (leaders.length === 1) return { holder: leaders[0]!, lengths };
  return { holder: null, lengths };
}
