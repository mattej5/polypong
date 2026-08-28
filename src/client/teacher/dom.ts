// Tiny DOM helpers. No framework, no dependency, no template strings holding
// markup: every node is created explicitly so a student name from the wire can
// only ever reach the page through `textContent`.

export function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`teacher console: missing element #${id}`);
  return node as T;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(className: string, text: string): HTMLButtonElement {
  const b = el('button', className, text);
  b.type = 'button';
  return b;
}

/** Writes only on change: the roster repaints on every lobby message and an
 *  unchanged assignment still invalidates layout in some browsers. */
export function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

export function setClass(node: HTMLElement, className: string): void {
  if (node.className !== className) node.className = className;
}

export function show(node: HTMLElement, on: boolean): void {
  if (node.hidden === on) node.hidden = !on;
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Lives as countable pips, the same channel the arena uses (SPEC §9): never a
 *  bar, never a colour alone. */
export function pips(lives: number, max: number): string {
  const n = Math.max(0, Math.min(max, Math.floor(lives)));
  const m = Math.max(n, Math.floor(max));
  return '●'.repeat(n) + '○'.repeat(Math.max(0, m - n));
}
