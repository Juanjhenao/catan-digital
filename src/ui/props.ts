import type { Terrain } from '../engine/index.js';
import { motifRandom } from './art.js';
import { boxFaces, frustumFaces, prismFaces, type Face } from './art3d.js';
import { shade, tint } from './theme.js';
import type { Point3 } from './camera.js';

/**
 * Lo que se levanta de cada casilla.
 *
 * La loseta pone el suelo (`art.ts`); aqui van los objetos, con volumen de
 * verdad y las caras iluminadas por el mismo foco que las piezas de jugador.
 * Es lo que hace que la mesa parezca una maqueta y no un tapete.
 *
 * Dos decisiones gobiernan el archivo:
 *
 * **Se calculan UNA vez por tablero.** No se mueven jamas, asi que por
 * fotograma solo hay que proyectarlos. Reconstruir varios cientos de caras
 * sesenta veces por segundo seria tirar el tiempo.
 *
 * **Se parecen a la carta.** La oveja del prado es la misma oveja que la carta
 * de lana, la gavilla del campo es la de la carta de trigo, la roca de la
 * montana es la de la carta de mineral. No es coqueteria: quien mira el tablero
 * buscando de donde sacar lana tiene que reconocer lo que lleva en la mano sin
 * traducir nada por el camino.
 */

/** Un objeto colocado: sus caras y el punto por el que se ordena en profundidad. */
export interface Prop {
  x: number;
  y: number;
  faces: Face[];
  /** Radio de la sombra que proyecta, medido de su propia anchura. */
  shadow: number;
}

/** Lo que devuelven los generadores: la sombra se mide despues, de la geometria. */
type Piece = Omit<Prop, 'shadow'>;

/** Numero de lados de los cuerpos de revolucion. Pocos: hay muchos en pantalla. */
const SIDES = 6;

/**
 * Reparte n objetos en un anillo alrededor del centro de la casilla.
 *
 * El centro se deja libre a proposito: ahi va la ficha numerica, y un arbol
 * asomando por debajo del numero es justo lo que no se quiere.
 */
function ring(count: number, rand: () => number, radius = 0.52, spread = 0.16): [number, number][] {
  const out: [number, number][] = [];
  // Un giro inicial distinto por casilla: sin el, todas las casillas del mismo
  // terreno colocan su primer objeto en el mismo sitio y se nota el patron.
  const turn = rand() * Math.PI * 2;
  for (let i = 0; i < count; i++) {
    const angle = turn + (i / count) * Math.PI * 2 + (rand() - 0.5) * 0.6;
    const r = radius + rand() * spread;
    out.push([Math.cos(angle) * r, Math.sin(angle) * r]);
  }
  return out;
}

/** Cono de n lados, para copas de arbol. */
function cone(x: number, y: number, radius: number, z0: number, z1: number, color: string): Face[] {
  return frustumFaces(x, y, radius, radius * 0.06, SIDES, z0, z1, color);
}

/**
 * Piramide de base cuadrada, con la base girada y la punta desplazada.
 *
 * Los dos parametros de mas son lo que separa una roca de un cono de trafico:
 * una piramide recta y centrada se reconoce al instante como figura geometrica.
 */
function pyramid(
  x: number,
  y: number,
  half: number,
  z0: number,
  z1: number,
  color: string,
  turn = 0,
  tilt = 0,
): Face[] {
  const apex: Point3 = [x + Math.cos(tilt) * half * 0.3, y + Math.sin(tilt) * half * 0.3, z1];
  const base: Point3[] = [0, 1, 2, 3].map((i) => {
    const a = turn + (i / 4) * Math.PI * 2;
    return [x + Math.cos(a) * half, y + Math.sin(a) * half, z0] as Point3;
  });
  return base.map((corner, i) => ({ pts: [corner, base[(i + 1) % 4]!, apex], color }));
}

// ---------------------------------------------------------------------------
// Bosque
// ---------------------------------------------------------------------------

/**
 * Coniferas de tres pisos y algun arbol de copa redonda.
 *
 * Mezclar las dos formas es lo que separa un bosque de una fila de conos
 * iguales: sin variacion se lee como un patron, no como vegetacion.
 */
function forestProps(rand: () => number): Piece[] {
  const needle = '#2f6b3f';
  const needleDark = '#1f4c2c';
  const leaf = '#4a8a45';
  const trunk = '#4a3320';

  return ring(4, rand, 0.46, 0.22).map(([x, y]) => {
    const scale = 0.8 + rand() * 0.45;
    if (rand() < 0.28) {
      // Copa redonda: tronco visible y una bola en tres gajos.
      return {
        x,
        y,
        faces: [
          ...frustumFaces(x, y, 0.035, 0.028, SIDES, 0, 0.16 * scale, trunk),
          ...frustumFaces(x, y, 0.07, 0.13, SIDES, 0.13 * scale, 0.24 * scale, shade(leaf, 0.2)),
          ...frustumFaces(x, y, 0.13, 0.13, SIDES, 0.24 * scale, 0.33 * scale, leaf),
          ...frustumFaces(x, y, 0.13, 0.03, SIDES, 0.33 * scale, 0.44 * scale, tint(leaf, 0.12)),
        ],
      };
    }
    return {
      x,
      y,
      faces: [
        ...frustumFaces(x, y, 0.032, 0.024, SIDES, 0, 0.09 * scale, trunk),
        ...cone(x, y, 0.15 * scale, 0.06 * scale, 0.24 * scale, needleDark),
        ...cone(x, y, 0.12 * scale, 0.2 * scale, 0.38 * scale, needle),
        ...cone(x, y, 0.085 * scale, 0.34 * scale, 0.52 * scale, tint(needle, 0.14)),
      ],
    };
  });
}

// ---------------------------------------------------------------------------
// Montanas
// ---------------------------------------------------------------------------

/** Penascos con cumbre nevada y una roca suelta con su cristal, como la carta. */
function mountainProps(rand: () => number): Piece[] {
  const rock = '#7b8798';
  const rockDark = '#5a6675';
  const snow = '#eef3f7';
  const crystal = '#cfe8f5';

  return ring(3, rand, 0.44, 0.2).map(([x, y], i) => {
    if (i === 2) {
      // Roca baja con la veta asomando: la misma que la carta de mineral.
      const r = 0.16 + rand() * 0.05;
      return {
        x,
        y,
        faces: [
          ...prismFaces(x, y, r, 5, 0, 0.12, rockDark, rand() * Math.PI),
          ...frustumFaces(x, y, r, r * 0.5, 5, 0.12, 0.2, rock),
          ...pyramid(x, y, r * 0.28, 0.18, 0.32, crystal, rand() * Math.PI),
        ],
      };
    }
    const scale = 0.9 + rand() * 0.4;
    const height = 0.46 * scale;
    const half = 0.26 * scale;
    const turn = rand() * Math.PI;
    const tilt = rand() * Math.PI * 2;
    return {
      x,
      y,
      faces: [
        ...pyramid(x, y, half, 0, height, rock, turn, tilt),
        // La nieve lleva el mismo giro y la misma inclinacion que el penasco:
        // con otros, la cumbre se posa torcida sobre su propia montana.
        ...pyramid(
          x + Math.cos(tilt) * half * 0.19,
          y + Math.sin(tilt) * half * 0.19,
          half * 0.36,
          height * 0.64,
          height * 1.02,
          snow,
          turn,
          tilt,
        ),
      ],
    };
  });
}

// ---------------------------------------------------------------------------
// Colinas
// ---------------------------------------------------------------------------

/** Pilas de ladrillo cocido, las de la carta de arcilla. */
function hillProps(rand: () => number): Piece[] {
  const brick = '#c25a2c';
  const brickDark = '#9c431d';

  return ring(3, rand, 0.48, 0.18).map(([x, y]) => {
    const faces: Face[] = [];
    const base = rand() * Math.PI;
    for (let i = 0; i < 3; i++) {
      // Cada hilada girada sobre la de abajo: es como se apila de verdad, y de
      // paso deja ver que son piezas sueltas y no un bloque.
      const angle = base + i * 1.1 + (rand() - 0.5) * 0.4;
      const dir: [number, number] = [Math.cos(angle), Math.sin(angle)];
      faces.push(
        ...boxFaces(
          x + (rand() - 0.5) * 0.03,
          y + (rand() - 0.5) * 0.03,
          dir,
          0.115,
          0.058,
          i * 0.062,
          (i + 1) * 0.062,
          i % 2 === 0 ? brick : brickDark,
          tint(brick, 0.16),
        ),
      );
    }
    return { x, y, faces };
  });
}

// ---------------------------------------------------------------------------
// Campos
// ---------------------------------------------------------------------------

/**
 * Gavillas: estrechas abajo, atadas, y abiertas en abanico arriba.
 *
 * Han pasado por dos intentos fallidos. Primero fueron conos marrones y
 * parecian macetas. Luego, tres haces en corro con un anillo de atadura en
 * medio -- pero el anillo quedaba DENTRO de los haces, invisible salvo por los
 * huecos, y el conjunto se leia como una seta.
 *
 * Lo que hace que una gavilla se reconozca es su perfil: junco estrecho, la
 * atadura marcada mas ancha que el, y la espiga abriendose por encima. Un solo
 * cuerpo con esos tres tramos lo dice mejor que tres cuerpos sueltos.
 */
function fieldProps(rand: () => number): Piece[] {
  const stalk = '#d9a93c';
  const ear = '#f4d47c';
  const tie = '#96601a';

  return ring(3, rand, 0.48, 0.18).map(([x, y]) => {
    const k = 0.9 + rand() * 0.3;
    return {
      x,
      y,
      faces: [
        // Los tallos, casi rectos.
        ...frustumFaces(x, y, 0.05 * k, 0.056 * k, SIDES, 0, 0.13 * k, stalk),
        // La atadura: mas ancha que el haz a proposito, para que se vea.
        ...frustumFaces(x, y, 0.072 * k, 0.072 * k, SIDES, 0.13 * k, 0.17 * k, tie),
        // La espiga, abriendose. Alta y estrecha: achaparrada se leia como seta.
        ...frustumFaces(x, y, 0.056 * k, 0.115 * k, SIDES, 0.17 * k, 0.4 * k, ear),
        // Remate: las puntas sueltas del grano, algo mas abiertas todavia.
        ...frustumFaces(x, y, 0.115 * k, 0.125 * k, SIDES, 0.4 * k, 0.46 * k, tint(ear, 0.16)),
      ],
    };
  });
}

// ---------------------------------------------------------------------------
// Pastos
// ---------------------------------------------------------------------------

/**
 * Ovejas mullidas, las mismas de la carta de lana.
 *
 * El vellon son tres bombos redondeados en fila y no una caja: una caja blanca
 * con patas es un taburete, y a la escala del tablero lo parecia.
 */
function pastureProps(rand: () => number): Piece[] {
  // Blanco de verdad: el foco oscurece los costados, y partiendo de un crema
  // apagado las ovejas acababan grises sobre la hierba.
  const fleece = '#fffdf6';
  const fleeceShade = '#ece6d6';
  const dark = '#3c3630';

  return ring(3, rand, 0.5, 0.16).map(([x, y]) => {
    const a = rand() * Math.PI * 2;
    const dir: [number, number] = [Math.cos(a), Math.sin(a)];
    const perp: [number, number] = [-dir[1], dir[0]];
    const faces: Face[] = [];

    // Cuatro patas finas, antes que el cuerpo: quedan por debajo.
    for (const along of [0.055, -0.055]) {
      for (const side of [0.035, -0.035]) {
        faces.push(
          ...boxFaces(
            x + dir[0] * along + perp[0] * side,
            y + dir[1] * along + perp[1] * side,
            dir,
            0.013,
            0.013,
            0,
            0.055,
            dark,
          ),
        );
      }
    }

    // Vellon: tres bombos a lo largo del cuerpo, cada uno una cupula.
    for (const along of [-0.06, 0, 0.06]) {
      const bx = x + dir[0] * along;
      const by = y + dir[1] * along;
      const r = along === 0 ? 0.088 : 0.076;
      faces.push(
        ...frustumFaces(bx, by, r * 0.8, r, SIDES, 0.05, 0.12, fleeceShade),
        ...frustumFaces(bx, by, r, r * 0.55, SIDES, 0.12, 0.19, fleece),
      );
    }

    // Cabeza y orejas, por delante.
    faces.push(
      ...frustumFaces(x + dir[0] * 0.12, y + dir[1] * 0.12, 0.035, 0.028, SIDES, 0.07, 0.165, dark),
      ...boxFaces(
        x + dir[0] * 0.115 + perp[0] * 0.045,
        y + dir[1] * 0.115 + perp[1] * 0.045,
        perp,
        0.024,
        0.01,
        0.142,
        0.158,
        dark,
      ),
      ...boxFaces(
        x + dir[0] * 0.115 - perp[0] * 0.045,
        y + dir[1] * 0.115 - perp[1] * 0.045,
        perp,
        0.024,
        0.01,
        0.142,
        0.158,
        dark,
      ),
    );
    return { x, y, faces };
  });
}

// ---------------------------------------------------------------------------
// Desierto
// ---------------------------------------------------------------------------

/** Un cactus con brazos y piedras resecas. */
function desertProps(rand: () => number): Piece[] {
  const green = '#4f8a4a';
  const greenDark = '#3d6f3a';
  const stone = '#b79c65';

  return ring(3, rand, 0.5, 0.16).map(([x, y], i) => {
    if (i === 0) {
      const faces: Face[] = [
        ...frustumFaces(x, y, 0.045, 0.038, SIDES, 0, 0.34, green),
        ...frustumFaces(x, y, 0.038, 0.03, SIDES, 0.34, 0.37, greenDark),
      ];
      // Dos brazos, cada uno con su codo: el travesano que sale y el tramo que
      // sube. Sin el codo, un brazo recto se lee como una rama cualquiera.
      for (const [side, at, up] of [
        [1, 0.16, 0.26],
        [-1, 0.11, 0.21],
      ] as [number, number, number][]) {
        faces.push(
          ...boxFaces(x + side * 0.055, y, [1, 0], 0.035, 0.026, at, at + 0.055, green),
          ...frustumFaces(x + side * 0.085, y, 0.027, 0.023, SIDES, at, up, green),
        );
      }
      return { x, y, faces };
    }
    // Piedras de cinco lados, para que no parezcan monedas.
    const scale = 0.85 + rand() * 0.5;
    return {
      x,
      y,
      faces: [
        ...prismFaces(x, y, 0.1 * scale, 5, 0, 0.06 * scale, shade(stone, 0.14), rand() * Math.PI),
        ...frustumFaces(x, y, 0.1 * scale, 0.05 * scale, 5, 0.06 * scale, 0.12 * scale, stone),
      ],
    };
  });
}

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

const GENERATORS: Record<Terrain, (rand: () => number) => Piece[]> = {
  forest: forestProps,
  mountains: mountainProps,
  hills: hillProps,
  fields: fieldProps,
  pasture: pastureProps,
  desert: desertProps,
};

/**
 * Los objetos de una casilla, ya colocados en coordenadas de tablero.
 *
 * El identificador del hexagono siembra el azar, asi que una casilla concreta
 * tiene siempre los mismos arboles en los mismos sitios entre repintados, pero
 * dos bosques nunca son identicos.
 */
export function terrainProps(terrain: Terrain, cx: number, cy: number, seed: string): Prop[] {
  const rand = motifRandom(`props:${seed}`);
  const props = GENERATORS[terrain](rand);

  // Las funciones colocan los objetos alrededor del origen; aqui se llevan a su
  // casilla, sumando el centro a cada vertice de una vez por todas.
  return props.map((prop) => {
    // La sombra se saca de lo ancho que es el objeto de verdad, no de una cifra
    // escrita a mano por cada cuerpo: un cactus y una piedra la quieren muy
    // distinta y asi ninguna se olvida al retocar la geometria.
    let reach = 0;
    for (const face of prop.faces) {
      for (const pt of face.pts) {
        reach = Math.max(reach, Math.hypot(pt[0] - prop.x, pt[1] - prop.y));
      }
    }
    return {
      x: cx + prop.x,
      y: cy + prop.y,
      shadow: reach * 1.25 + 0.02,
      faces: prop.faces.map((face) => ({
        ...face,
        pts: face.pts.map((p): Point3 => [cx + p[0], cy + p[1], p[2]]),
      })),
    };
  });
}
