import { RandomBot } from '../src/ai/random-bot.js';
import { playOut } from '../src/ai/self-play.js';
import {
  createGame,
  longestRoadFor,
  RESOURCES,
  victoryPoints,
  type GameState,
  type PlayerConfig,
} from '../src/engine/index.js';

const colors = ['red', 'blue', 'white', 'orange', 'green', 'brown'] as const;
const players = (n: number): PlayerConfig[] =>
  Array.from({ length: n }, (_, i) => ({ name: `J${i}`, color: colors[i]!, kind: 'human' }));

const GAMES = Number(process.argv[2] ?? 300);
const problems: string[] = [];
let totalSteps = 0;
let totalTurns = 0;
const winnersByCount = new Map<number, number>();

for (let game = 0; game < GAMES; game++) {
  const count = 2 + (game % 5);
  const seed = game * 2654435761 + 17;
  const state = createGame(players(count), { seed });
  const bots = Array.from({ length: count }, (_, i) => new RandomBot('easy', seed + i));
  const totalPerResource = state.bank.lumber;

  const check = (s: GameState, label: string) => {
    for (const r of RESOURCES) {
      const inHands = s.players.reduce((sum, p) => sum + p.resources[r], 0);
      if (s.bank[r] + inHands !== totalPerResource) {
        problems.push(`partida ${game}: ${r} descuadrado en ${label}`);
      }
      if (s.bank[r] < 0) problems.push(`partida ${game}: banco negativo (${r})`);
    }
    for (const p of s.players) {
      for (const r of RESOURCES) {
        if (p.resources[r] < 0) problems.push(`partida ${game}: mano negativa (${p.name}/${r})`);
      }
      if (p.piecesLeft.road < 0 || p.piecesLeft.settlement < 0 || p.piecesLeft.city < 0) {
        problems.push(`partida ${game}: piezas negativas (${p.name})`);
      }
      // Las piezas colocadas mas las de la reserva deben cuadrar.
      const settlements = p.buildings.filter((v) => s.buildings[v]?.kind === 'settlement').length;
      const cities = p.buildings.filter((v) => s.buildings[v]?.kind === 'city').length;
      if (settlements + p.piecesLeft.settlement !== 5) {
        problems.push(`partida ${game}: poblados descuadrados (${p.name}) en ${label}`);
      }
      if (cities + p.piecesLeft.city !== 4) {
        problems.push(`partida ${game}: ciudades descuadradas (${p.name}) en ${label}`);
      }
      if (p.roads.length + p.piecesLeft.road !== 15) {
        problems.push(`partida ${game}: caminos descuadrados (${p.name}) en ${label}`);
      }
      // La longitud cacheada debe coincidir con el calculo.
      const real = longestRoadFor(p.roads, s.buildings, p.id);
      if (p.longestRoadLength !== real) {
        problems.push(
          `partida ${game}: ruta cacheada ${p.longestRoadLength} != ${real} (${p.name})`,
        );
      }
    }
    // Regla de distancia.
    for (const vertex of Object.keys(s.buildings)) {
      for (const neighbor of s.board.vertexNeighbors[vertex]!) {
        if (s.buildings[neighbor]) problems.push(`partida ${game}: edificios contiguos`);
      }
    }
    // Nadie deberia superar los puntos objetivo sin que la partida termine.
    if (s.phase !== 'gameOver') {
      for (const p of s.players) {
        if (p.id === s.currentPlayer && victoryPoints(s, p.id) >= s.rules.victoryPoints) {
          problems.push(`partida ${game}: ${p.name} tiene los puntos y sigue jugando`);
        }
      }
    }
  };

  const result = playOut(state, bots, { maxSteps: 60000, onStep: (s) => check(s, 'paso') });

  if (result.reason !== 'victory') {
    problems.push(
      `partida ${game} (${count} jugadores): ${result.reason} tras ${result.steps} pasos, ` +
        `ultima accion ${result.lastAction?.type}, fase ${result.state.phase}`,
    );
    continue;
  }
  check(result.state, 'final');
  totalSteps += result.steps;
  totalTurns += result.state.turn;
  winnersByCount.set(count, (winnersByCount.get(count) ?? 0) + 1);
}

console.log(`${GAMES} partidas jugadas`);
console.log(`  media de pasos: ${Math.round(totalSteps / GAMES)}`);
console.log(`  media de turnos: ${Math.round(totalTurns / GAMES)}`);
console.log(`  terminadas por numero de jugadores:`, Object.fromEntries(winnersByCount));
if (problems.length === 0) {
  console.log('  sin incidencias');
} else {
  const unique = [...new Set(problems)];
  console.log(`  INCIDENCIAS (${problems.length}, ${unique.length} distintas):`);
  for (const p of unique.slice(0, 20)) console.log(`    - ${p}`);
}
