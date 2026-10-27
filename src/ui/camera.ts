/**
 * Camara en perspectiva para el tablero.
 *
 * El tablero vive en un plano horizontal (z = 0) con coordenadas de "unidades
 * de hexagono": las mismas que devuelven `hexCenterPixel`, `vertexPixel` y
 * compania con `size = 1`. La camara lo mira desde delante y desde arriba, asi
 * que todo el juego se dibuja en 2D pero con geometria genuinamente
 * tridimensional: las piezas tienen altura real y se proyectan como cualquier
 * otro solido.
 *
 * Modelo (camara estenopeica, sin distorsion):
 *
 *   1. Se lleva el punto al origen restando el pivote (centro del tablero).
 *   2. Se gira sobre el eje vertical (yaw) para poder orbitar un poco.
 *   3. Se aplica la inclinacion (pitch): 90 grados seria una vista cenital,
 *      0 grados una vista a ras de mesa.
 *
 *      depth = D - Y*cos(p) - z*sin(p)
 *      sx    = cx + f * X / depth
 *      sy    = cy + f * (Y*sin(p) - z*cos(p)) / depth
 *
 * De ahi salen las tres propiedades que usa el resto del renderizador: la
 * posicion en pantalla, la PROFUNDIDAD (para ordenar el pintado de atras hacia
 * delante) y la ESCALA local en pixeles por unidad de tablero (para que cada
 * pieza se dibuje del tamano que le toca segun lo lejos que este).
 */

export interface Projected {
  /** Posicion en pixeles dentro del lienzo. */
  x: number;
  y: number;
  /** Distancia a la camara. Mayor = mas lejos. */
  depth: number;
  /** Pixeles por unidad de tablero en ese punto. */
  scale: number;
}

/** Punto del mundo: dos coordenadas de tablero mas la altura. */
export type Point3 = [number, number, number];

const DEG = Math.PI / 180;

export class Camera {
  /** Inclinacion en radianes medida desde el plano de la mesa. */
  pitch = 54 * DEG;
  /** Giro sobre el eje vertical. */
  yaw = 0;
  /** Distancia camara-pivote en unidades de tablero. */
  distance = 30;
  /** Distancia focal en pixeles (la fija `fit`). */
  focal = 900;
  /** Punto de fuga en pantalla (lo fija `fit`). */
  cx = 0;
  cy = 0;
  /** Punto del tablero al que mira la camara. */
  pivotX = 0;
  pivotY = 0;

  static readonly MIN_PITCH = 20 * DEG;
  static readonly MAX_PITCH = 88 * DEG;

  /**
   * Encaje base, antes de aplicar zoom y desplazamiento. Se guarda para poder
   * mover la vista sin volver a medir el tablero entero en cada rueda del raton.
   */
  private baseFocal = 900;
  private centerU = 0;
  private centerV = 0;

  // Cacheados: `project` se llama decenas de miles de veces por fotograma.
  private sinPitch = Math.sin(54 * DEG);
  private cosPitch = Math.cos(54 * DEG);
  private sinYaw = 0;
  private cosYaw = 1;

  /**
   * Fija la orientacion. La inclinacion se acota (por arriba seria cenital y
   * por abajo se veria el tablero de canto), pero el giro da la vuelta entera:
   * el tablero se puede mirar desde cualquier lado, como se rodea una mesa.
   */
  setAngles(pitch: number, yaw: number): void {
    this.pitch = clamp(pitch, Camera.MIN_PITCH, Camera.MAX_PITCH);
    this.yaw = wrapAngle(yaw);
    this.sinPitch = Math.sin(this.pitch);
    this.cosPitch = Math.cos(this.pitch);
    this.sinYaw = Math.sin(this.yaw);
    this.cosYaw = Math.cos(this.yaw);
  }

  /**
   * Cuanto se aplasta verticalmente un circulo apoyado en la mesa. Se usa para
   * las fichas numericas y las sombras, que se dibujan tumbadas pero con el
   * texto derecho.
   */
  get groundSquash(): number {
    return this.sinPitch;
  }

  // -------------------------------------------------------------------------
  // Proyeccion
  // -------------------------------------------------------------------------

  /** Coordenadas de camara (antes de aplicar focal y centro). */
  private normalized(bx: number, by: number, z: number): [number, number, number] {
    const dx = bx - this.pivotX;
    const dy = by - this.pivotY;
    const X = dx * this.cosYaw - dy * this.sinYaw;
    const Y = dx * this.sinYaw + dy * this.cosYaw;
    const depth = this.distance - Y * this.cosPitch - z * this.sinPitch;
    return [X / depth, (Y * this.sinPitch - z * this.cosPitch) / depth, depth];
  }

  project(bx: number, by: number, z = 0): Projected {
    const [u, v, depth] = this.normalized(bx, by, z);
    return {
      x: this.cx + u * this.focal,
      y: this.cy + v * this.focal,
      depth,
      scale: this.focal / depth,
    };
  }

  projectPoint(p: Point3): Projected {
    return this.project(p[0], p[1], p[2]);
  }

  /** Solo la profundidad, para ordenar sin proyectar del todo. */
  depthAt(bx: number, by: number, z = 0): number {
    const dx = bx - this.pivotX;
    const dy = by - this.pivotY;
    const Y = dx * this.sinYaw + dy * this.cosYaw;
    return this.distance - Y * this.cosPitch - z * this.sinPitch;
  }

  /**
   * Deshace la proyeccion sobre el plano de la mesa (z = 0). Es lo que traduce
   * un clic del raton a una posicion del tablero.
   *
   * Devuelve null si el punto cae por encima del horizonte, donde el rayo de la
   * camara ya no corta la mesa.
   */
  unproject(px: number, py: number): [number, number] | null {
    const u = (px - this.cx) / this.focal;
    const v = (py - this.cy) / this.focal;
    const denom = this.sinPitch + v * this.cosPitch;
    if (denom <= 1e-6) return null;
    const Y = (v * this.distance) / denom;
    const depth = this.distance - Y * this.cosPitch;
    if (depth <= 1e-6) return null;
    const X = u * depth;
    return [
      this.pivotX + X * this.cosYaw + Y * this.sinYaw,
      this.pivotY - X * this.sinYaw + Y * this.cosYaw,
    ];
  }

  /**
   * Matriz afin que lleva unidades de tablero a pixeles EN EL ENTORNO de un
   * punto concreto. Es la linealizacion de la perspectiva ahi mismo, y basta
   * para estampar la textura de una casilla: el error es del orden del cuadrado
   * de tamano/distancia, muy por debajo del pixel a estas escalas.
   *
   * Devuelve [a, b, c, d, e, f] tal cual lo espera `ctx.setTransform`.
   */
  groundTransform(
    bx: number,
    by: number,
    z = 0,
  ): [number, number, number, number, number, number] {
    const dx = bx - this.pivotX;
    const dy = by - this.pivotY;
    const X = dx * this.cosYaw - dy * this.sinYaw;
    const Y = dx * this.sinYaw + dy * this.cosYaw;
    const depth = this.distance - Y * this.cosPitch - z * this.sinPitch;
    const s = this.focal / depth;
    const vertical = Y * this.sinPitch - z * this.cosPitch;

    // Derivadas respecto a los ejes de camara.
    const dsxdX = s;
    const dsydX = 0;
    const dsxdY = (X * s * this.cosPitch) / depth;
    const dsydY = s * this.sinPitch + (vertical * s * this.cosPitch) / depth;

    // Y de vuelta a los ejes del tablero deshaciendo el yaw.
    const a = this.cosYaw * dsxdX + this.sinYaw * dsxdY;
    const b = this.cosYaw * dsydX + this.sinYaw * dsydY;
    const c = -this.sinYaw * dsxdX + this.cosYaw * dsxdY;
    const d = -this.sinYaw * dsydX + this.cosYaw * dsydY;

    return [a, b, c, d, this.cx + X * s, this.cy + vertical * s];
  }

  /**
   * Indica si una cara vertical mira hacia la camara, dada su normal en
   * coordenadas de tablero. Sirve para no dibujar los laterales ocultos.
   */
  facesCamera(nx: number, ny: number): boolean {
    return nx * this.sinYaw + ny * this.cosYaw > 1e-3;
  }

  // -------------------------------------------------------------------------
  // Encaje
  // -------------------------------------------------------------------------

  /**
   * Mide el encaje del tablero en el lienzo: la focal con la que cabe entero y
   * donde queda su centro. La proyeccion es lineal en la focal una vez fijados
   * los angulos, asi que un solo pase basta: no hace falta iterar.
   *
   * No coloca la camara; de eso se encarga `place`, que anade el zoom y el
   * desplazamiento del jugador.
   */
  fit(width: number, height: number, points: Point3[], fill = 0.94): void {
    if (!points.length || width <= 0 || height <= 0) return;
    let uMin = Infinity;
    let uMax = -Infinity;
    let vMin = Infinity;
    let vMax = -Infinity;
    for (const [bx, by, z] of points) {
      const [u, v] = this.normalized(bx, by, z);
      if (u < uMin) uMin = u;
      if (u > uMax) uMax = u;
      if (v < vMin) vMin = v;
      if (v > vMax) vMax = v;
    }
    const spanU = Math.max(uMax - uMin, 1e-4);
    const spanV = Math.max(vMax - vMin, 1e-4);
    this.baseFocal = Math.min(width / spanU, height / spanV) * fill;
    this.centerU = (uMin + uMax) / 2;
    this.centerV = (vMin + vMax) / 2;
    this.place(width, height);
  }

  /**
   * Coloca la camara con el zoom y el arrastre actuales sobre el encaje ya
   * medido. Con zoom 1 y sin desplazamiento el tablero queda centrado y entero.
   */
  place(width: number, height: number, zoom = 1, panX = 0, panY = 0): void {
    this.focal = this.baseFocal * zoom;
    this.cx = width / 2 - this.centerU * this.focal + panX;
    this.cy = height / 2 - this.centerV * this.focal + panY;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Lleva un angulo al intervalo (-pi, pi] para que el giro no crezca sin fin. */
function wrapAngle(a: number): number {
  const twoPi = Math.PI * 2;
  const wrapped = a - twoPi * Math.floor((a + Math.PI) / twoPi);
  return wrapped;
}
