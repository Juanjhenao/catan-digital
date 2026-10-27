/** Ayudas minimas para construir DOM sin plantillas ni dependencias. */

type Attrs = Record<string, string | number | boolean | ((e: Event) => void) | undefined>;
type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === 'style' && typeof value === 'string') {
      node.setAttribute('style', value);
    } else if (key === 'class') {
      node.className = String(value);
    } else if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function replace(node: Element, ...children: Child[]): void {
  clear(node);
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
}

/** Control +/- acotado, usado en descartes y ofertas de comercio. */
export function stepper(
  value: number,
  min: number,
  max: number,
  onChange: (next: number) => void,
): HTMLElement {
  return el('div', { class: 'stepper' }, [
    el(
      'button',
      {
        type: 'button',
        disabled: value <= min,
        onclick: () => onChange(value - 1),
        'aria-label': 'quitar uno',
      },
      ['-'],
    ),
    el('span', { class: 'stepper__value' }, [String(value)]),
    el(
      'button',
      {
        type: 'button',
        disabled: value >= max,
        onclick: () => onChange(value + 1),
        'aria-label': 'anadir uno',
      },
      ['+'],
    ),
  ]);
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Igual que `el` pero en el espacio de nombres de SVG.
 *
 * Hace falta un constructor aparte porque `document.createElement('svg')`
 * fabrica un elemento HTML desconocido, no un SVG: el navegador lo acepta sin
 * quejarse y luego no dibuja nada.
 */
export function svg(
  tag: string,
  attrs: Record<string, string | number> = {},
  children: Element[] = [],
): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  for (const child of children) node.append(child);
  return node;
}
