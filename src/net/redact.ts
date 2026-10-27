import { totalResources, ZERO_RESOURCES, type GameState, type PlayerId } from '../engine/index.js';

/**
 * Quita del estado todo lo que un jugador no tiene derecho a ver.
 *
 * Es la unica pieza de la parte de red que hay que leer con cuidado, porque es
 * la que separa «jugar en red» de «jugar en red con las cartas boca arriba».
 * Mandar el estado entero y confiar en que la interfaz no lo ensene no sirve de
 * nada: cualquiera abre las herramientas del navegador y lee el mensaje.
 *
 * Se tapan cuatro cosas:
 *
 * 1. **Las manos ajenas.** Lo publico es cuantas cartas tiene cada uno, no
 *    cuales.
 * 2. **Las cartas de desarrollo ajenas.** Igual: el numero es publico, el tipo
 *    no. Por eso existe `publicVictoryPoints` aparte de `victoryPoints`.
 * 3. **El mazo de desarrollo.** Su ORDEN es la proxima carta de todo el mundo.
 * 4. **El estado del generador de azar.** Este es el que menos se ve venir y el
 *    mas grave: el azar es determinista a partir de su estado, asi que quien lo
 *    tenga puede calcular todas las tiradas que quedan.
 *
 * Lo que se tapa se deja VACIO, no falso, y los recuentos publicos van aparte
 * en `state.redacted`. Rellenar la mano ajena con cartas inventadas del numero
 * correcto habria sido mas comodo para la interfaz, pero deja una mentira en el
 * estado que cualquier lectura futura se cree sin enterarse.
 */
export function redactFor(state: GameState, viewer: PlayerId): GameState {
  return {
    ...state,
    players: state.players.map((player) =>
      player.id === viewer
        ? player
        : { ...player, resources: { ...ZERO_RESOURCES }, devCards: [] },
    ),
    devDeck: [],
    // El generador se sustituye por uno inerte en vez de quitarlo: el tipo pide
    // que este, y asi cualquier codigo de cliente que intentara avanzar la
    // partida por su cuenta produciria un disparate evidente en vez de acertar.
    rng: { seed: 0 },
    redacted: {
      hands: state.players.map((p) => totalResources(p.resources)),
      devCards: state.players.map((p) => p.devCards.length),
      devDeck: state.devDeck.length,
    },
  };
}

/**
 * Comprueba que un estado censurado no lleva nada de contrabando.
 *
 * Se usa en las pruebas y como red de seguridad en el servidor: si alguien
 * anade un campo secreto a `GameState` y se olvida de taparlo, esto lo caza. Es
 * barato compararlo con lo que cuesta enterarse jugando.
 */
export function findLeaks(state: GameState, viewer: PlayerId): string[] {
  const leaks: string[] = [];
  if (!state.redacted) leaks.push('el estado no viene marcado como censurado');
  if (state.devDeck.length > 0) leaks.push('el mazo de desarrollo va entero');
  if (state.rng.seed !== 0) leaks.push('va el estado del azar');
  for (const player of state.players) {
    if (player.id === viewer) continue;
    if (totalResources(player.resources) > 0) leaks.push(`va la mano de ${player.name}`);
    if (player.devCards.length > 0) leaks.push(`van las cartas de desarrollo de ${player.name}`);
  }
  return leaks;
}
