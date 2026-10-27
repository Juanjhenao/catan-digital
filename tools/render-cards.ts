/**
 * Renderiza las cartas de recurso a un PNG sin navegador.
 *
 * Como `render-board.ts`, no reimplementa nada: llama al mismo `resourceArt`
 * que dibuja las cartas del juego. Cada recurso sale dos veces, al tamano
 * grande de la mano y ampliado, que es donde se ve si el dibujo aguanta.
 *
 *   npx tsx tools/render-cards.ts [salida.png]
 */
import { createCanvas } from 'canvas';
import { writeFileSync } from 'node:fs';
import type { Resource } from '../src/engine/index.js';

const globals = globalThis as unknown as Record<string, unknown>;
globals.document = {
  createElement: (tag: string) => {
    if (tag !== 'canvas') throw new Error(`elemento no soportado: ${tag}`);
    return createCanvas(1, 1);
  },
};
globals.window = { devicePixelRatio: 1, addEventListener: () => {} };

const { resourceArt } = await import('../src/ui/cards.js');
const { RESOURCE_LABEL } = await import('../src/ui/theme.js');

const RESOURCES: Resource[] = ['lumber', 'brick', 'wool', 'grain', 'ore'];
const output = process.argv[2] ?? 'cards.png';

const BIG = [180, 242] as const;
const SMALL = [58, 78] as const;
const PAD = 26;
const W = PAD + RESOURCES.length * (BIG[0] + PAD);
const H = PAD + BIG[1] + PAD + SMALL[1] + PAD + 30;

const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d');
ctx.fillStyle = '#2a2018';
ctx.fillRect(0, 0, W, H);

RESOURCES.forEach((resource, i) => {
  const x = PAD + i * (BIG[0] + PAD);
  ctx.drawImage(resourceArt(resource, BIG[0], BIG[1]) as never, x, PAD);
  // El mismo dibujo al tamano real de la mano, que es como se ve jugando.
  ctx.drawImage(
    resourceArt(resource, SMALL[0], SMALL[1]) as never,
    x + BIG[0] / 2 - SMALL[0] / 2,
    PAD + BIG[1] + PAD,
  );
  ctx.fillStyle = '#e8dcc6';
  ctx.font = '15px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(RESOURCE_LABEL[resource], x + BIG[0] / 2, PAD + BIG[1] + PAD + SMALL[1] + 22);
});

writeFileSync(output, canvas.toBuffer('image/png'));
console.log(`Escrito ${output} (${W}x${H})`);
