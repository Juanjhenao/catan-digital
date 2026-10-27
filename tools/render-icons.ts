import { createCanvas, loadImage, type CanvasRenderingContext2D as NodeCtx } from 'canvas';
import { readFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';

/**
 * Vuelca los iconos de la interfaz a un PNG.
 *
 *   npx tsx tools/render-icons.ts [salida.png]
 *
 * Se serializa lo que devuelve `icon()` a un documento SVG y se pasa por el
 * renderizador de SVG de node-canvas, asi que lo que sale es el mismo dibujo
 * que hara el navegador. Un trazo mal escrito no falla en la aplicacion:
 * simplemente no pinta nada, y sin una captura no hay forma de enterarse.
 */

interface FakeNode {
  tag: string;
  attrs: Record<string, string>;
  childNodes: FakeNode[];
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  append(child: FakeNode): void;
}

function fakeNode(tag: string): FakeNode {
  const attrs: Record<string, string> = {};
  const childNodes: FakeNode[] = [];
  return {
    tag,
    attrs,
    childNodes,
    setAttribute: (name, value) => void (attrs[name] = value),
    getAttribute: (name) => attrs[name] ?? null,
    append: (child) => void childNodes.push(child),
  };
}

const globals = globalThis as unknown as Record<string, unknown>;
globals.document = {
  createElement: () => createCanvas(1, 1),
  createElementNS: (_ns: string, tag: string) => fakeNode(tag),
};
globals.window = { devicePixelRatio: 1 };

const source = await readFile(new URL('../src/ui/icons.ts', import.meta.url), 'utf8');
const names = [...source.matchAll(/^  (\w+): \{$/gm)].map((m) => m[1]!);

const { icon } = await import('../src/ui/icons.js');

/** Serializa el nodo falso a texto SVG, con el color ya resuelto. */
function serialize(node: FakeNode, color: string): string {
  const attrs = Object.entries(node.attrs)
    .filter(([k]) => k !== 'class' && k !== 'aria-hidden' && k !== 'focusable')
    .map(([k, v]) => `${k}="${v.replace(/currentColor/g, color)}"`)
    .join(' ');
  const inner = node.childNodes.map((c) => serialize(c, color)).join('');
  return `<${node.tag} ${attrs}>${inner}</${node.tag}>`;
}

const CELL = 104;
const SIZE = Number(process.argv[3] ?? 56);
const cols = Math.min(7, names.length);
const rows = Math.ceil(names.length / cols);
const canvas = createCanvas(cols * CELL, rows * CELL);
const ctx = canvas.getContext('2d') as unknown as NodeCtx & CanvasRenderingContext2D;
ctx.fillStyle = '#2a1d12';
ctx.fillRect(0, 0, canvas.width, canvas.height);

for (const [i, name] of names.entries()) {
  const node = icon(name as never, SIZE) as unknown as FakeNode;
  node.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const markup = serialize(node, '#f4e9d2');
  const image = await loadImage(
    `data:image/svg+xml;base64,${Buffer.from(markup).toString('base64')}`,
  );

  const cx = (i % cols) * CELL + CELL / 2;
  const cy = Math.floor(i / cols) * CELL + CELL / 2;
  ctx.drawImage(image, cx - SIZE / 2, cy - SIZE / 2 - 8, SIZE, SIZE);

  ctx.fillStyle = '#d9a441';
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(name, cx, cy + SIZE / 2 + 6);
}

writeFileSync(process.argv[2] ?? 'icons.png', canvas.toBuffer('image/png'));
console.log('ok:', names.join(', '));
