/**
 * The inside of the body, as plain numbers, no DOM.
 *
 * The cavity is the body's widest line, centred on the origin, x to the right and y down, in pixels.
 */

export interface Cavity {
  /** Half the inner width. */
  a: number;
  /** Half the inner height. */
  b: number;
  /** Inner corner radius. Equal to `b` for a pill. */
  r: number;
}

/** Pulls a point inside the cavity, keeping `margin` pixels off the wall. */
export function clampInside(c: Cavity, x: number, y: number, margin: number): [number, number] {
  const a = Math.max(c.a - margin, 0.5);
  const b = Math.max(c.b - margin, 0.5);
  const r = Math.max(Math.min(c.r - margin, a, b), 0);
  let qx = Math.min(Math.max(x, -a), a);
  let qy = Math.min(Math.max(y, -b), b);
  const cx = a - r;
  const cy = b - r;
  const ax = Math.abs(qx) - cx;
  const ay = Math.abs(qy) - cy;
  if (ax > 0 && ay > 0) {
    const d = Math.hypot(ax, ay);
    if (d > r) {
      qx = Math.sign(qx) * (cx + (ax / d) * r);
      qy = Math.sign(qy) * (cy + (ay / d) * r);
    }
  }
  return [qx, qy];
}

/** A small seeded generator, so a press always replays the same way. */
export function mulberry(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
