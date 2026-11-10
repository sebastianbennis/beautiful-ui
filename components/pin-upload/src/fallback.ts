// For browsers without WebGL2: the same bed from pre-drawn pin sprites on a 2D
// canvas, repainting only the columns whose pins actually changed.
import type { Field } from './field';
import { ROW, TALLEST } from './field';
import { PIN, type Palette, type Renderer } from './renderer';

const LEVELS = 14;

function toCss(c: [number, number, number], alpha = 1): string {
  const enc = (v: number) => Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
  return `rgba(${enc(c[0])},${enc(c[1])},${enc(c[2])},${alpha})`;
}

export function createCanvasRenderer(canvas: HTMLCanvasElement): Renderer | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  let palette: Palette | null = null;
  let dark = false;
  let pitch = 10;
  let ox = 0;
  let oy = 0;
  let cols = 0;
  let rows = 0;
  let sprites: HTMLCanvasElement[] = [];
  let spriteSize = 0;
  let drawn = new Int8Array(0);
  let full = true;

  const makeSprites = () => {
    if (!palette) return;
    const p = palette;
    const reach = Math.ceil(TALLEST * Math.max(PIN.castX, PIN.castY) + 2);
    spriteSize = Math.ceil((reach * 2 + 1) * pitch);
    const centre = spriteSize / 2;
    sprites = [];
    for (let l = 0; l < LEVELS; l++) {
      const s = document.createElement('canvas');
      s.width = spriteSize;
      s.height = spriteSize;
      const c = s.getContext('2d');
      if (!c) continue;
      const h = (l / (LEVELS - 1)) * TALLEST;
      const head = PIN.head * pitch;
      const shaft = PIN.shaft * pitch;
      if (h > 0.03) {
        c.strokeStyle = toCss(dark ? [0, 0, 0] : p.graphite, dark ? 0.55 : 0.34);
        c.lineWidth = shaft * 2;
        c.lineCap = 'round';
        c.beginPath();
        c.moveTo(centre, centre);
        c.lineTo(centre + PIN.castX * h * pitch, centre + PIN.castY * h * pitch);
        c.stroke();
        c.fillStyle = dark ? toCss(p.blued) : toCss(p.shade);
        c.fillRect(centre - shaft, centre - PIN.view * h * pitch, shaft * 2, PIN.view * h * pitch);
      }
      const tipY = centre - PIN.view * h * pitch;
      const g = c.createRadialGradient(centre - head * 0.35, tipY - head * 0.4, head * 0.1, centre, tipY, head);
      if (dark) {
        g.addColorStop(0, h > 0.3 ? toCss(p.glint) : toCss(p.blued));
        g.addColorStop(1, toCss(p.blued));
      } else {
        g.addColorStop(0, toCss(p.chalk));
        g.addColorStop(1, h > 0.3 ? toCss(p.shade) : toCss(p.chalk));
      }
      c.fillStyle = g;
      c.beginPath();
      c.arc(centre, tipY, head, 0, Math.PI * 2);
      c.fill();
      if (h <= 0.3) {
        c.strokeStyle = toCss(p.shade, dark ? 0.2 : 0.3);
        c.lineWidth = Math.max(pitch * 0.04, 0.5);
        c.stroke();
      }
      sprites.push(s);
    }
    full = true;
  };

  const paintColumns = (f: Field, from: number, to: number) => {
    if (!palette) return;
    const reach = Math.ceil(TALLEST * PIN.castX + 1);
    const x0 = from === 0 ? 0 : ox + from * pitch;
    const x1 = to >= cols - 1 ? canvas.width : ox + (to + 1.5) * pitch;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, 0, x1 - x0, canvas.height);
    ctx.clip();
    ctx.fillStyle = dark ? toCss(palette.blued) : toCss(palette.chalk);
    ctx.fillRect(x0, 0, x1 - x0, canvas.height);
    for (let j = 0; j < rows; j++) {
      for (let i = Math.max(0, from - reach); i <= Math.min(cols - 1, to + 1); i++) {
        const k = j * cols + i;
        const level = Math.max(0, Math.min(LEVELS - 1, Math.round((f.h[k] / TALLEST) * (LEVELS - 1))));
        const px = ox + (i + 0.5 + 0.5 * (j & 1)) * pitch;
        const py = oy + (j + 0.5) * ROW * pitch;
        const s = sprites[level];
        if (s) ctx.drawImage(s, px - spriteSize / 2, py - spriteSize / 2);
      }
    }
    ctx.restore();
  };

  return {
    resize(cssW, cssH, dpr, pitchCss, c, r) {
      const w = Math.round(cssW * dpr);
      const h = Math.round(cssH * dpr);
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      pitch = pitchCss * dpr;
      cols = c;
      rows = r;
      ox = (w - (c + 0.5) * pitch) / 2;
      oy = (h - r * ROW * pitch) / 2 + 0.35 * pitch;
      drawn = new Int8Array(c * r).fill(-1);
      makeSprites();
    },
    palette(p) {
      palette = p;
      if (cols) makeSprites();
    },
    dark(on) {
      if (dark !== on) {
        dark = on;
        if (cols) makeSprites();
      }
    },
    film() {
      /* heads keep their material here, the film appears when the plate opens */
    },
    draw(f) {
      if (!palette) return;
      if (full) {
        ctx.fillStyle = dark ? toCss(palette.blued) : toCss(palette.chalk);
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        paintColumns(f, 0, cols - 1);
        for (let k = 0; k < f.n; k++) drawn[k] = Math.round((f.h[k] / TALLEST) * (LEVELS - 1));
        full = false;
      } else {
        const reach = Math.ceil(TALLEST * PIN.castX + 1);
        let start = -1;
        let end = -1;
        const flush = () => {
          if (start >= 0) paintColumns(f, start, Math.min(cols - 1, end + reach));
          start = -1;
        };
        for (let i = 0; i < cols; i++) {
          let changed = false;
          for (let j = 0; j < rows; j++) {
            const k = j * cols + i;
            const level = Math.round((f.h[k] / TALLEST) * (LEVELS - 1));
            if (level !== drawn[k]) {
              changed = true;
              drawn[k] = level;
            }
          }
          if (changed) {
            if (start < 0) start = i;
            end = i;
          } else if (start >= 0 && i > end + reach) {
            flush();
          }
        }
        flush();
      }
      let opened = 0;
      for (let k = 0; k < f.n; k += 37) opened = Math.max(opened, f.opened[k]);
      canvas.style.opacity = String(1 - opened);
    },
    destroy() {
      sprites = [];
    },
  };
}
