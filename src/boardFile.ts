/** Whiteboard file format and import logic (kept free of VS Code APIs so it can be tested). */

export const BOARD_FORMAT = 'collab-share-whiteboard';

export function serializeBoard(shapes: unknown[]): string {
  return JSON.stringify({ format: BOARD_FORMAT, version: 1, saved: new Date().toISOString(), shapes }, null, 1);
}

/** Reads a saved board (or a bare array of shapes). Throws if it isn't one. */
export function parseBoard(text: string): any[] {
  const data = JSON.parse(text);
  const shapes = Array.isArray(data) ? data : data?.shapes;
  if (!Array.isArray(shapes)) throw new Error('Not a whiteboard file');
  return shapes.filter((x) => x && typeof x === 'object' && typeof x.id === 'string' && typeof x.type === 'string');
}

/**
 * Prepares imported shapes to be added next to an existing board: fresh ids (nothing clashes),
 * wires re-pointed to the renamed nodes, everything shifted to the right of the current drawing.
 */
export function prepareForAdd(existing: any[], shapes: any[], newId: () => string): any[] {
  const ids = new Map<string, string>();
  for (const x of shapes) ids.set(x.id, newId());
  const xsOf = (x: any): number[] =>
    [x.x1, x.x2, x.x, ...(Array.isArray(x.pts) ? x.pts.filter((_: number, i: number) => i % 2 === 0) : [])].filter((v) => typeof v === 'number');
  const right = Math.max(-Infinity, ...existing.flatMap((x) => xsOf(x).map((v) => v + (typeof x.w === 'number' && typeof x.x === 'number' ? x.w : 0))));
  const left = Math.min(Infinity, ...shapes.flatMap(xsOf));
  const dx = Number.isFinite(right) && Number.isFinite(left) ? right + 160 - left : 0;
  return shapes
    .map((x) => {
      const c = JSON.parse(JSON.stringify(x));
      c.id = ids.get(x.id);
      if (c.type === 'wire') {
        c.a = { ...c.a, n: ids.get(c.a?.n) };
        c.b = { ...c.b, n: ids.get(c.b?.n) };
      }
      if (Array.isArray(c.pts)) c.pts = c.pts.map((v: number, i: number) => (i % 2 ? v : v + dx));
      if (typeof c.x1 === 'number') { c.x1 += dx; c.x2 += dx; }
      if (typeof c.x === 'number') c.x += dx;
      return c;
    })
    .filter((x) => x.type !== 'wire' || (x.a.n && x.b.n));
}
