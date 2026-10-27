/**
 * Torneo entre bots.
 *
 * Es la unica forma honesta de saber si las dificultades significan algo: si
 * "dificil" no le gana a "facil" de forma consistente, la etiqueta es mentira.
 * Tambien sirve para afinar los pesos del heuristico sin adivinar.
 *
 *   npx tsx tools/tournament.ts [partidas] [variante]
 */
import { HeuristicBot } from '../src/ai/heuristic-bot.js';
import { RandomBot } from '../src/ai/random-bot.js';
import { playOut } from '../src/ai/self-play.js';
import type { Bot, BotDifficulty } from '../src/ai/types.js';
import {
  createGame,
  victoryPoints,
  type BoardVariant,
  type PlayerConfig,
} from '../src/engine/index.js';

const GAMES = Number(process.argv[2] ?? 200);
const VARIANT = (process.argv[3] ?? 'base') as BoardVariant;

const colors = ['red', 'blue', 'white', 'orange', 'green', 'brown'] as const;

type Contender = { name: string; make: (seed: number) => Bot };

const CONTENDERS: Contender[] = [
  { name: 'azar', make: (s) => new RandomBot('easy', s) },
  { name: 'facil', make: (s) => new HeuristicBot('easy', s) },
  { name: 'normal', make: (s) => new HeuristicBot('normal', s) },
  { name: 'dificil', make: (s) => new HeuristicBot('hard', s) },
];

interface Tally {
  games: number;
  wins: number;
  points: number;
}

const tally = new Map<string, Tally>();
for (const c of CONTENDERS) tally.set(c.name, { games: 0, wins: 0, points: 0 });

let unfinished = 0;
let totalTurns = 0;
const start = Date.now();

for (let game = 0; game < GAMES; game++) {
  // Se rota el orden en la mesa para que ninguno se beneficie de empezar.
  const rotation = game % CONTENDERS.length;
  const seats = CONTENDERS.map((_, i) => CONTENDERS[(i + rotation) % CONTENDERS.length]!);

  const configs: PlayerConfig[] = seats.map((c, i) => ({
    name: c.name,
    color: colors[i]!,
    kind: 'bot',
  }));
  const seed = game * 2654435761 + 101;
  const state = createGame(configs, { seed, variant: VARIANT });
  const bots = seats.map((c, i) => c.make(seed + i * 7919));

  const result = playOut(state, bots, { maxSteps: 60000 });
  if (result.reason !== 'victory') {
    unfinished++;
    continue;
  }
  totalTurns += result.state.turn;

  for (let seat = 0; seat < seats.length; seat++) {
    const entry = tally.get(seats[seat]!.name)!;
    entry.games++;
    entry.points += victoryPoints(result.state, seat);
    if (result.state.winner === seat) entry.wins++;
  }
}

const seconds = (Date.now() - start) / 1000;
console.log(`${GAMES} partidas en el tablero "${VARIANT}" (${seconds.toFixed(1)}s)`);
console.log(`  turnos por partida: ${Math.round(totalTurns / Math.max(1, GAMES - unfinished))}`);
if (unfinished > 0) console.log(`  SIN TERMINAR: ${unfinished}`);
console.log('');
console.log('  contendiente   victorias    %     puntos/partida');
for (const c of CONTENDERS) {
  const t = tally.get(c.name)!;
  const rate = t.games === 0 ? 0 : (t.wins / t.games) * 100;
  console.log(
    `  ${c.name.padEnd(14)} ${String(t.wins).padStart(4)}/${String(t.games).padEnd(5)} ` +
      `${rate.toFixed(1).padStart(5)}%  ${(t.points / Math.max(1, t.games)).toFixed(2)}`,
  );
}

/** Duelos directos: cada dificultad contra la anterior, mesa de dos. */
console.log('\n  duelos uno contra uno:');
const ladder: BotDifficulty[] = ['easy', 'normal', 'hard'];
for (let i = 1; i < ladder.length; i++) {
  const strong = ladder[i]!;
  const weak = ladder[i - 1]!;
  let strongWins = 0;
  let played = 0;
  for (let game = 0; game < GAMES; game++) {
    const swap = game % 2 === 1;
    const configs: PlayerConfig[] = [
      { name: 'a', color: 'red', kind: 'bot' },
      { name: 'b', color: 'blue', kind: 'bot' },
    ];
    const seed = game * 40503 + 7;
    const state = createGame(configs, { seed, variant: VARIANT });
    const bots = [
      new HeuristicBot(swap ? weak : strong, seed),
      new HeuristicBot(swap ? strong : weak, seed + 13),
    ];
    const result = playOut(state, bots, { maxSteps: 60000 });
    if (result.reason !== 'victory') continue;
    played++;
    const strongSeat = swap ? 1 : 0;
    if (result.state.winner === strongSeat) strongWins++;
  }
  const rate = played === 0 ? 0 : (strongWins / played) * 100;
  console.log(`    ${strong} vs ${weak}: ${rate.toFixed(1)}% (${strongWins}/${played})`);
}
