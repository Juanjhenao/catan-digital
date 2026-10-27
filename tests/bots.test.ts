import { describe, expect, it } from 'vitest';
import { HeuristicBot } from '../src/ai/heuristic-bot.js';
import { RandomBot } from '../src/ai/random-bot.js';
import { playOut } from '../src/ai/self-play.js';
import type { Bot, BotDifficulty } from '../src/ai/types.js';
import {
  applyOrThrow,
  createGame,
  getLegalActions,
  totalResources,
  victoryPoints,
  type BoardVariant,
  type GameState,
  type PlayerConfig,
} from '../src/engine/index.js';

const colors = ['red', 'blue', 'white', 'orange', 'green', 'brown'] as const;

function configs(count: number, kind: 'bot' | 'human' = 'bot'): PlayerConfig[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `J${i + 1}`,
    color: colors[i]!,
    kind,
  }));
}

/** Juega una tanda y devuelve cuantas gano el bando `a`. */
function duel(
  a: BotDifficulty[],
  b: BotDifficulty[],
  games: number,
  variant: BoardVariant = 'base',
): { rate: number; played: number } {
  const lineup = [...a, ...b];
  let wins = 0;
  let played = 0;
  for (let game = 0; game < games; game++) {
    // Se rota el orden de la mesa: si no, el bando que empieza tiene ventaja.
    const shift = game % lineup.length;
    const seats = lineup.map((_, i) => lineup[(i + shift) % lineup.length]!);
    const isA = lineup.map((_, i) => (i + shift) % lineup.length < a.length);

    const seed = game * 2654435761 + 31;
    const state = createGame(configs(lineup.length), { seed, variant });
    const bots = seats.map((difficulty, i) => new HeuristicBot(difficulty, seed + i * 7919));
    const result = playOut(state, bots, { maxSteps: 60000 });
    if (result.reason !== 'victory') continue;
    played++;
    if (isA[result.state.winner!]) wins++;
  }
  return { rate: (wins / Math.max(1, played)) * 100, played };
}

describe('contrato de bot', () => {
  it('un bot solo devuelve acciones que estaban en la lista de legales', () => {
    const state = createGame(configs(4), { seed: 12345 });
    const bot = new HeuristicBot('hard', 7);
    let s: GameState = state;
    for (let step = 0; step < 400 && s.phase !== 'gameOver'; step++) {
      if (s.phase === 'discard') break;
      const player = s.currentPlayer;
      const legal = getLegalActions(s, player);
      if (legal.length === 0) break;
      const chosen = bot.decide(s, player, legal);
      expect(legal).toContain(chosen);
      s = applyOrThrow(s, chosen);
    }
  });

  it('el descarte de un bot suma exactamente lo pedido y sale de su mano', () => {
    for (const difficulty of ['easy', 'normal', 'hard'] as BotDifficulty[]) {
      const bot = new HeuristicBot(difficulty, 3);
      const base = createGame(configs(4), { seed: 5150 });
      const state: GameState = {
        ...base,
        players: base.players.map((p) =>
          p.id === 0
            ? { ...p, resources: { lumber: 4, brick: 3, wool: 2, grain: 1, ore: 1 } }
            : p,
        ),
      };
      const discard = bot.chooseDiscard(state, 0, 5);
      const total = Object.values(discard).reduce((sum, n) => sum + (n ?? 0), 0);
      expect(total).toBe(5);
      for (const [resource, amount] of Object.entries(discard)) {
        expect(amount!).toBeLessThanOrEqual(
          state.players[0]!.resources[resource as keyof typeof state.bank],
        );
      }
    }
  });

  it('la misma semilla produce exactamente la misma partida', () => {
    const play = () => {
      const state = createGame(configs(4), { seed: 909090 });
      const bots = Array.from({ length: 4 }, (_, i) => new HeuristicBot('normal', i + 1));
      return playOut(state, bots, { maxSteps: 60000 });
    };
    const a = play();
    const b = play();
    expect(a.state.winner).toBe(b.state.winner);
    expect(a.steps).toBe(b.steps);
    expect(a.state.log.length).toBe(b.state.log.length);
  });
});

describe('los bots no hacen trampa', () => {
  /**
   * La comprobacion clave del proyecto en cuanto a bots.
   *
   * El estado contiene la mano de todos (hace falta para pintar y para el
   * motor), asi que nada impide tecnicamente que un bot la lea. Para demostrar
   * que no lo hace se le pregunta dos veces la misma jugada, cambiando entre
   * medias la COMPOSICION de las manos rivales pero no su tamano ni el banco.
   *
   * Un bot que espiara veria un tablero distinto y podria decidir otra cosa.
   * Uno que solo usa informacion publica tiene que responder exactamente igual,
   * porque desde fuera nada ha cambiado.
   */
  function shuffleOpponentHands(state: GameState, decider: number): GameState {
    return {
      ...state,
      players: state.players.map((p) => {
        // La mano del que decide es suya: esa si la conoce y no se toca.
        if (p.id === decider) return p;
        const total = totalResources(p.resources);
        // Todas las cartas del rival pasan a ser mineral: mismo numero, otra
        // composicion. El banco se deja intacto a proposito.
        return { ...p, resources: { lumber: 0, brick: 0, wool: 0, grain: 0, ore: total } };
      }),
    };
  }

  it('deciden igual aunque cambien las manos ajenas', () => {
    for (const difficulty of ['easy', 'normal', 'hard'] as BotDifficulty[]) {
      let state = createGame(configs(4), { seed: 4242 });
      // Se avanza hasta media partida para que haya algo que decidir.
      const driver = new HeuristicBot('normal', 1);
      for (let step = 0; step < 260 && state.phase !== 'gameOver'; step++) {
        if (state.phase === 'discard') {
          const player = state.mustDiscard[0]!;
          const amount = Math.floor(totalResources(state.players[player]!.resources) / 2);
          state = applyOrThrow(state, {
            type: 'discard',
            player,
            resources: driver.chooseDiscard(state, player, amount),
          });
          continue;
        }
        const player = state.currentPlayer;
        const legal = getLegalActions(state, player);
        if (legal.length === 0) break;
        state = applyOrThrow(state, driver.decide(state, player, legal));
      }
      if (state.phase === 'gameOver' || state.phase === 'discard') continue;

      const player = state.currentPlayer;
      const legal = getLegalActions(state, player);
      if (legal.length === 0) continue;

      // Dos bots identicos (misma semilla) deciden sobre los dos estados.
      const disguised = shuffleOpponentHands(state, player);
      const honest = new HeuristicBot(difficulty, 99).decide(state, player, legal);
      const tempted = new HeuristicBot(difficulty, 99).decide(
        disguised,
        player,
        getLegalActions(disguised, player),
      );
      expect(tempted, `dificultad ${difficulty}`).toEqual(honest);
    }
  });

  it('el monopolio se elige contando el banco, no mirando manos', () => {
    // Los rivales tienen lana; el banco lo refleja. El bot debe pedir lana.
    const base = createGame(configs(4), { seed: 606 });
    const state: GameState = {
      ...base,
      phase: 'main',
      turn: 5, // una carta solo es jugable en un turno posterior al de compra
      dice: [3, 4],
      currentPlayer: 0,
      bank: { ...base.bank, wool: 2 },
      players: base.players.map((p) =>
        p.id === 0
          ? {
              ...p,
              devCards: [{ kind: 'monopoly', boughtOnTurn: 0 }],
              resources: { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 },
            }
          : p,
      ),
    };
    const legal = getLegalActions(state, 0).filter((a) => a.type === 'playMonopoly');
    expect(legal.length).toBeGreaterThan(0);
    const chosen = new HeuristicBot('hard', 5).decide(state, 0, legal);
    expect(chosen).toMatchObject({ type: 'playMonopoly', resource: 'wool' });
  });
});

describe('las dificultades significan algo', () => {
  /**
   * Los margenes de estos tests son deliberadamente holgados respecto a lo
   * medido con muestras grandes (normal gana a facil ~74%, dificil a facil
   * ~84%). Con 60 partidas la desviacion tipica ronda el 5%, asi que se exige
   * bastante menos de lo real para que no fallen por azar, pero lo suficiente
   * para que una regresion de verdad los tumbe.
   */
  it('normal le gana a facil de forma clara', () => {
    const { rate, played } = duel(['normal'], ['easy'], 60);
    expect(played).toBeGreaterThan(50);
    expect(rate).toBeGreaterThan(55);
  });

  it('dificil le gana a facil de forma aplastante', () => {
    const { rate } = duel(['hard'], ['easy'], 60);
    expect(rate).toBeGreaterThan(65);
  });

  it('dificil le gana a normal, aunque por menos margen', () => {
    // Medido con 500 partidas, la ventaja real es de +8.6 puntos porcentuales
    // (58.6% de victorias). Es una diferencia pequena comparada con el salto de
    // facil a normal, asi que hacen falta bastantes partidas para verla sin que
    // el azar la tape: con menos de 300 este test seria una moneda al aire.
    const { rate, played } = duel(['hard'], ['normal'], 300);
    expect(played).toBeGreaterThan(280);
    expect(rate).toBeGreaterThan(52);
  });

  it('normal y dificil sacan mas puntos por partida que facil', () => {
    // Los puntos tienen menos varianza que las victorias, asi que ordenan las
    // dificultades con menos partidas. Entre normal y dificil la diferencia es
    // demasiado fina para este tamano de muestra, y el test no la reclama.
    const totals: Record<BotDifficulty, number> = { easy: 0, normal: 0, hard: 0 };
    const order: BotDifficulty[] = ['easy', 'normal', 'hard'];
    for (let game = 0; game < 45; game++) {
      const shift = game % 3;
      const seats = order.map((_, i) => order[(i + shift) % 3]!);
      const seed = game * 7919 + 5;
      const state = createGame(configs(3), { seed });
      const bots = seats.map((d, i) => new HeuristicBot(d, seed + i));
      const result = playOut(state, bots, { maxSteps: 60000 });
      if (result.reason !== 'victory') continue;
      seats.forEach((difficulty, seat) => {
        totals[difficulty] += victoryPoints(result.state, seat);
      });
    }
    expect(totals.normal).toBeGreaterThan(totals.easy);
    expect(totals.hard).toBeGreaterThan(totals.easy);
  });

  it('cualquier bot heuristico aplasta al que juega al azar', () => {
    let heuristicWins = 0;
    let played = 0;
    for (let game = 0; game < 30; game++) {
      const swap = game % 2 === 1;
      const seed = game * 104729 + 3;
      const state = createGame(configs(2), { seed });
      const bots: Bot[] = swap
        ? [new RandomBot('easy', seed), new HeuristicBot('easy', seed + 1)]
        : [new HeuristicBot('easy', seed), new RandomBot('easy', seed + 1)];
      const result = playOut(state, bots, { maxSteps: 60000 });
      if (result.reason !== 'victory') continue;
      played++;
      if (result.state.winner === (swap ? 1 : 0)) heuristicWins++;
    }
    expect(heuristicWins / played).toBeGreaterThan(0.9);
  });

  it('los bots con criterio terminan la partida mucho antes que el azar', () => {
    const turnsWith = (make: (seed: number) => Bot) => {
      let turns = 0;
      let games = 0;
      for (let game = 0; game < 12; game++) {
        const seed = game * 31337 + 11;
        const state = createGame(configs(4), { seed });
        const bots = Array.from({ length: 4 }, (_, i) => make(seed + i));
        const result = playOut(state, bots, { maxSteps: 60000 });
        if (result.reason !== 'victory') continue;
        turns += result.state.turn;
        games++;
      }
      return turns / Math.max(1, games);
    };
    const random = turnsWith((s) => new RandomBot('easy', s));
    const smart = turnsWith((s) => new HeuristicBot('normal', s));
    expect(smart).toBeLessThan(random * 0.6);
  });
});

describe('los bots juegan en cualquier mapa', () => {
  for (const variant of ['base', 'extended', 'large', 'huge'] as BoardVariant[]) {
    it(`${variant}: la partida termina con bots de las tres dificultades`, () => {
      const seed = 20250820;
      const state = createGame(configs(4), { seed, variant });
      const difficulties: BotDifficulty[] = ['easy', 'normal', 'hard', 'normal'];
      const bots = difficulties.map((d, i) => new HeuristicBot(d, seed + i));
      const result = playOut(state, bots, { maxSteps: 120000 });
      expect(result.reason).toBe('victory');
      expect(victoryPoints(result.state, result.state.winner!)).toBeGreaterThanOrEqual(
        result.state.rules.victoryPoints,
      );
    });
  }
}, 120000);
