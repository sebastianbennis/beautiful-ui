// Joins the field to a canvas: sizing, the loop that sleeps when nothing moves,
// and the moments that span several frames.
import { Field, ROW, type Carry } from './field';
import { createWebGlRenderer, type Palette, type Renderer } from './renderer';
import { createCanvasRenderer } from './fallback';
import type { Picture } from './picture';

const MARGIN_X = 1.5;
const MARGIN_Y = 1.3;
const MAX_PIXELS = 3_400_000;
const PLAY_AT = 1.95;
/** how fast a change of material crosses the plate, in CSS pixels a second */
const TURN_SPEED = 2300;
/** A file lands with a weight read from its size: nothing extra under LIGHT bytes, the most from HEAVY up. */
const LIGHT = 4e8;
const HEAVY = 186e9;

function readColour(ctx: CanvasRenderingContext2D, css: string): [number, number, number] {
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return [lin(d[0]), lin(d[1]), lin(d[2])];
}

export class Bed {
  field: Field;
  readonly webgl: boolean;
  private renderer: Renderer | null;
  private pitch = 10;
  private cssW = 1;
  private cssH = 1;
  private raf = 0;
  private last = 0;
  private picture: Picture | null = null;
  private dark = false;
  private video: HTMLVideoElement | null = null;
  private played = false;
  private settled = false;
  onFinished: (() => void) | null = null;
  private plate: HTMLElement;
  private canvas: HTMLCanvasElement;
  private reduced: boolean;
  private maxPixels: number;

  constructor(plate: HTMLElement, canvas: HTMLCanvasElement, reduced: boolean, maxPixels = MAX_PIXELS) {
    this.plate = plate;
    this.canvas = canvas;
    this.reduced = reduced;
    this.maxPixels = maxPixels;
    const gl = createWebGlRenderer(canvas);
    this.webgl = !!gl;
    if (gl) {
      this.renderer = gl;
    } else {
      // a canvas that has handed out a WebGL context can never give a 2D one
      const flat = canvas.cloneNode() as HTMLCanvasElement;
      canvas.replaceWith(flat);
      this.canvas = flat;
      this.renderer = createCanvasRenderer(flat);
    }
    this.field = new Field({ cols: 2, rows: 2, reduced });
    this.measure();
  }

  private pinPitch(): number {
    const raw = getComputedStyle(this.plate).getPropertyValue('--pinbed-pin').trim();
    const set = parseFloat(raw);
    const unit = !Number.isNaN(set) && set > 0 ? set : 7.2;
    // never fewer than about 190 pins across where there is room, never finer than a thumb can see
    return Math.max(Math.min(unit, this.cssW / 190), Math.min(unit, 4.4));
  }

  measure(): void {
    const rect = this.plate.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    this.cssW = rect.width;
    this.cssH = rect.height;
    this.pitch = this.pinPitch();
    const cols = Math.max(4, Math.floor(this.cssW / this.pitch - MARGIN_X * 2));
    const rows = Math.max(4, Math.floor((this.cssH / this.pitch - MARGIN_Y * 2) / ROW));
    // Sharp, but bounded: a very large plate is drawn at slightly under 2x so the
    // whole bed can move at once and still hold 60fps.
    const dpr = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(this.maxPixels / (this.cssW * this.cssH)));
    if (cols !== this.field.cols || rows !== this.field.rows) {
      const next = new Field({ cols, rows, reduced: this.reduced });
      next.setDark(this.dark);
      next.fill.set(this.resample(this.field.fill, cols));
      this.field = next;
      if (this.picture) this.applyPicture(this.picture);
    }
    this.renderer?.resize(this.cssW, this.cssH, dpr, this.pitch, cols, rows);
    this.readPalette();
    this.wake();
  }

  private resample(from: Float32Array, n: number): Float32Array {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = from[Math.min(from.length - 1, Math.floor((i / n) * from.length))];
    return out;
  }

  readPalette(): void {
    if (!this.renderer) return;
    const c = document.createElement('canvas');
    c.width = 1;
    c.height = 1;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    const css = getComputedStyle(this.plate);
    const get = (name: string, fallback: string) => readColour(ctx, css.getPropertyValue(name).trim() || fallback);
    const p: Palette = {
      chalk: get('--pinbed-chalk', '#e6ebe9'),
      graphite: get('--pinbed-graphite', '#23292b'),
      shade: get('--pinbed-shade', '#57666c'),
      glint: get('--pinbed-glint', '#fdfefe'),
      blued: get('--pinbed-blued', '#10182b'),
    };
    this.renderer.palette(p);
    this.wake();
  }

  /** Changes the material. Given a point on the page, the change spreads out from there. */
  setDark(dark: boolean, from?: [number, number]): void {
    if (dark === this.dark) return;
    this.dark = dark;
    const travels = from && this.webgl && !this.reduced;
    if (travels) {
      const [x, y] = this.toBed(from[0], from[1]);
      this.field.setDark(dark, { x, y, speed: TURN_SPEED / this.pitch });
    } else {
      this.field.setDark(dark);
    }
    this.renderer?.dark(dark);
    this.wake();
  }

  private filmRect(aspect: number): { x: number; y: number; w: number; h: number } {
    const rows = this.field.rows;
    // every second row sits half a pitch to the right, and the picture has to reach its last pin too
    const span = this.field.cols + 0.5;
    const gridAspect = span / (rows * ROW);
    // a film close to the plate's own shape fills it, so no stray flush columns
    if (Math.abs(aspect - gridAspect) / gridAspect < 0.1) return { x: 0, y: 0, w: span, h: rows };
    if (aspect >= gridAspect) {
      const h = (span / aspect) / ROW;
      return { x: 0, y: (rows - h) / 2, w: span, h };
    }
    const w = rows * ROW * aspect;
    return { x: (span - w) / 2, y: 0, w, h: rows };
  }

  /** Puts a picture under the pins, ready to be pressed up as bytes land. */
  setPicture(picture: Picture | null): void {
    this.picture = picture;
    if (picture) this.applyPicture(picture);
    else this.field.relief.fill(0);
    this.wake();
  }

  /** Lays a picture over the pins, leaving anything outside the film's shape flush. */
  private toPins(p: { tone: Float32Array; rgb: Uint8Array; w: number; h: number }, aspect: number): { tone: Float32Array; rgb: Uint8Array } {
    const f = this.field;
    const rect = this.filmRect(aspect);
    const tone = new Float32Array(f.n);
    const rgb = new Uint8Array(f.n * 3);
    for (let j = 0; j < f.rows; j++) {
      for (let i = 0; i < f.cols; i++) {
        const k = j * f.cols + i;
        const u = (i + 0.5 + 0.5 * (j & 1) - rect.x) / rect.w;
        const v = (j + 0.5 - rect.y) / rect.h;
        if (u < 0 || v < 0 || u >= 1 || v >= 1) {
          tone[k] = -1;
          continue;
        }
        const px = u * (p.w - 1);
        const py = v * (p.h - 1);
        const x0 = Math.floor(px);
        const y0 = Math.floor(py);
        const x1 = Math.min(x0 + 1, p.w - 1);
        const y1 = Math.min(y0 + 1, p.h - 1);
        const fx = px - x0;
        const fy = py - y0;
        const at = (y: number, x: number) => p.tone[y * p.w + x];
        tone[k] = (at(y0, x0) * (1 - fx) + at(y0, x1) * fx) * (1 - fy) + (at(y1, x0) * (1 - fx) + at(y1, x1) * fx) * fy;
        const o = (y0 * p.w + x0) * 3;
        rgb[k * 3] = p.rgb[o];
        rgb[k * 3 + 1] = p.rgb[o + 1];
        rgb[k * 3 + 2] = p.rgb[o + 2];
      }
    }
    return { tone, rgb };
  }

  private applyPicture(p: Picture): void {
    const f = this.field;
    const { tone, rgb } = this.toPins(p, p.aspect);
    f.relief.set(tone);
    f.markRelief();
    this.renderer?.film(rgb, f.cols, f.rows);
  }

  /** Pixel position in the page to pitch units on the bed. */
  toBed(clientX: number, clientY: number): [number, number] {
    const rect = this.plate.getBoundingClientRect();
    const ox = (this.cssW - (this.field.cols + 0.5) * this.pitch) / 2;
    const oy = (this.cssH - this.field.rows * ROW * this.pitch) / 2 + 0.35 * this.pitch;
    return [(clientX - rect.left - ox) / this.pitch, (clientY - rect.top - oy) / this.pitch];
  }

  pointer(clientX: number, clientY: number, active: boolean): void {
    const [x, y] = this.toBed(clientX, clientY);
    this.field.setPointer(x, y, active);
    this.wake();
  }

  press(down: boolean): void {
    this.field.setPress(down);
    this.wake();
  }

  carry(state: Carry, clientX = 0, clientY = 0): void {
    const [x, y] = this.toBed(clientX, clientY);
    this.field.setCarry(state, x, y);
    this.wake();
  }

  /** A file lands. The bigger the file, the more the plate feels it. */
  impact(clientX: number, clientY: number, size: number): void {
    const [x, y] = this.toBed(clientX, clientY);
    const span = Math.log(HEAVY / LIGHT);
    const s = Math.max(0, Math.min(1, Math.log(Math.max(size, 1) / LIGHT) / span));
    const f = this.field;
    f.addPulse(x, y, 0.5 + 1.15 * s, 4.5 + 5 * s, 50 + 40 * s, 0.75 + 0.85 * s);
    if (s > 0.35) window.setTimeout(() => this.field.addPulse(x, y, 0.4 * s + 0.1, 5, 62, 0.8), 170);
    this.wake();
    if (!this.reduced && s > 0.2) {
      const d = 3.5 * s;
      this.plate.animate(
        [
          { transform: 'translateY(0)' },
          { transform: `translateY(${d}px)`, offset: 0.16 },
          { transform: `translateY(${-d * 0.32}px)`, offset: 0.46 },
          { transform: `translateY(${d * 0.12}px)`, offset: 0.72 },
          { transform: 'translateY(0)' },
        ],
        { duration: 520, easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)' },
      );
    }
  }

  ridge(on: boolean): void {
    if (on) this.field.startRidge();
    else this.field.stopRidge();
    this.wake();
  }

  sag(amount: number): void {
    this.field.sagTarget = amount;
    this.wake();
  }

  collapse(clientX: number, clientY: number): void {
    const [x, y] = this.toBed(clientX, clientY);
    this.field.beginCollapse(x, y);
    this.wake();
  }

  /** A fresh, empty plate. */
  clear(): void {
    this.picture = null;
    this.field.reset();
    this.field.relief.fill(0);
    this.video = null;
    this.played = false;
    this.settled = false;
    this.canvas.style.visibility = '';
    this.canvas.style.opacity = '';
    this.wake();
  }

  columns(): number {
    return this.field.cols;
  }

  /** The last gap has closed. */
  finish(column: number, video: HTMLVideoElement | null): void {
    const f = this.field;
    const y = (f.rows * ROW) / 2;
    this.video = video;
    f.addPulse(column, y, 0.8, 4.6, 160, 0.9);
    f.beginFinish(column, y, !!video);
    this.wake();
  }

  wake(): void {
    if (this.raf || this.settled) return;
    this.last = 0;
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (t: number) => {
    this.raf = 0;
    const dt = this.last ? Math.min((t - this.last) / 1000, 1 / 20) : 1 / 60;
    this.last = t;
    const f = this.field;
    // one step at a normal frame rate, two small ones to stay stable when it drops
    let moving = dt > 1 / 45 ? f.step(dt / 2) : f.step(dt);
    if (dt > 1 / 45) moving = f.step(dt / 2) || moving;
    if (this.reduced) f.settle();

    const finish = f.finish;
    if (finish) {
      const age = f.now - finish.born;
      // The film holds on the frame the pins are showing, so they sink into exactly
      // that picture, and it only starts to move once they have gone.
      if (this.video && !this.played && age > PLAY_AT) {
        this.played = true;
        void this.video.play().catch(() => undefined);
      }
      if (age > 1.7 && this.onFinished) {
        const done = this.onFinished;
        this.onFinished = null;
        done();
      }
      if (age > 2.5 && !this.settled) {
        if (this.video) {
          this.settled = true;
          this.canvas.style.visibility = 'hidden';
        }
      }
      if (age < 2.5) moving = true;
    }
    if (f.collapse && f.now - f.collapse.born < 1) moving = true;

    this.renderer?.draw(f);
    if (moving && !this.settled) this.raf = requestAnimationFrame(this.frame);
  };

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.renderer?.destroy();
  }
}
