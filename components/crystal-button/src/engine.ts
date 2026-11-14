'use client';

/**
 * Draws the button: a solid piece of crystal lying on the page, the light caught inside it,
 * and the light and shadow it lays on the page around it. Pressed, the crystal comes apart into
 * cells, in a wave from where it was pressed. The cells pass the light between them, and when
 * the job ends they close up into one piece again.
 * No React in here. The component feeds it pointer positions and the state of the job.
 */
import { type Cavity, clampInside, mulberry } from './optics';
import { CAUSTIC_FS, CAUSTIC_VS, FINAL_FS, GROUND_FS, QUAD_VS, SHAPE_FS } from './shaders';

export type Phase = 'idle' | 'working' | 'done' | 'failed' | 'stopping';

type RGB = [number, number, number];

const GRID_U = 1280;
const GRID_V = 48;
/**
 * Where the page's own light comes from: up and to the left, high enough that the shadow stays
 * close to the body. Points to the light.
 */
const SUN: readonly [number, number, number] = (() => {
  const up = (56 * Math.PI) / 180;
  const round = (30 * Math.PI) / 180;
  return [-Math.cos(round) * Math.cos(up), -Math.sin(round) * Math.cos(up), Math.sin(up)] as const;
})();
/** Where a lamp is sampled from, so it has a size. */
const SPOTS: ReadonlyArray<readonly [number, number]> = [
  [0.1, 0.9],
  [-0.85, -0.4],
  [0.75, -0.5],
];

// The crystal comes apart: the times of the one timeline, in ms.
/** The most cells the body ever comes apart into. */
const MOST = 32;
/** How long the wave takes to cross from the press to the furthest point of the body. */
const SWEEP = 760;
/** How long a furrow takes to open once the wave reaches it. */
const OPEN = 300;
/** How long the light spends on each cell as it goes round. */
const HOP = 150;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const approach = (cur: number, target: number, dt: number, tau: number) => target + (cur - target) * Math.exp(-dt / tau);

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const make = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, make(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, make(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'program');
  return p;
}

function uniforms(gl: WebGL2RenderingContext, p: WebGLProgram): Record<string, WebGLUniformLocation | null> {
  const out: Record<string, WebGLUniformLocation | null> = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    if (info) out[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name);
  }
  return out;
}

/** A sheet of triangles with one vertex per grid point, its two numbers running 0 to 1. */
function sheet(gl: WebGL2RenderingContext, nu: number, nv: number): { vao: WebGLVertexArrayObject; count: number } {
  const verts = new Float32Array((nu + 1) * (nv + 1) * 2);
  let v = 0;
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      verts[v++] = i / nu;
      verts[v++] = j / nv;
    }
  }
  const idx = new Uint16Array(nu * nv * 6);
  let k = 0;
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const p = j * (nu + 1) + i;
      idx[k++] = p;
      idx[k++] = p + 1;
      idx[k++] = p + nu + 1;
      idx[k++] = p + 1;
      idx[k++] = p + nu + 2;
      idx[k++] = p + nu + 1;
    }
  }
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
  return { vao, count: idx.length };
}

let scratch: CanvasRenderingContext2D | null = null;
/** Any CSS colour to linear RGB. */
function readColour(css: string, fallback: RGB): RGB {
  if (!css) return fallback;
  scratch ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!scratch) return fallback;
  scratch.canvas.width = scratch.canvas.height = 1;
  scratch.clearRect(0, 0, 1, 1);
  scratch.fillStyle = css;
  scratch.fillRect(0, 0, 1, 1);
  const d = scratch.getImageData(0, 0, 1, 1).data;
  if (d[3] === 0) return fallback;
  const lin = (v: number) => Math.pow(v / 255, 2.2);
  return [lin(d[0]), lin(d[1]), lin(d[2])];
}

/** One of the cells the body comes apart into. */
interface Cell {
  /** Where its heart rests, and where it is right now. */
  hx: number;
  hy: number;
  x: number;
  y: number;
  /** How far its heart is from the press. */
  far: number;
  /** Its place in the round the light makes. */
  turn: number;
  /** A number of its own, 0 to 1. */
  own: number;
  /** The light it keeps, and the light passing through it. */
  light: number;
  spark: number;
}

export class LightEngine {
  private gl: WebGL2RenderingContext;
  private causticProg: WebGLProgram;
  private groundProg: WebGLProgram;
  private shapeProg: WebGLProgram;
  private finalProg: WebGLProgram;
  private cu: Record<string, WebGLUniformLocation | null>;
  private gu: Record<string, WebGLUniformLocation | null>;
  private su: Record<string, WebGLUniformLocation | null>;
  private fu: Record<string, WebGLUniformLocation | null>;
  /** The shadow the page's own light gives the body. It only changes with the shape. */
  private still: { tex: WebGLTexture; fbo: WebGLFramebuffer };
  /** The shape of the body, what each cell of it holds, and how far apart it has come. */
  private form: { shape: WebGLTexture; cells: WebGLTexture; more: WebGLTexture; fbo: WebGLFramebuffer };
  private stale = true;
  private reshape = true;
  private gridVao: WebGLVertexArrayObject;
  private gridCount: number;
  private quadVao: WebGLVertexArrayObject;
  private fbo: WebGLFramebuffer;
  private tex: WebGLTexture;
  private cellData = new Float32Array(MOST * 4);
  private ownData = new Float32Array(MOST);

  // Shape, in CSS pixels.
  private w = 0;
  private h = 0;
  private rad = 0;
  /** How far the canvas reaches past the button on every side, for the shadow and the light on the page. */
  private spill = 0;
  /** How far in from the edge the surface is still curving, and half the body's thickness. */
  private bevel = 1;
  private rise = 1;
  private cav: Cavity = { a: 1, b: 1, r: 1 };
  private wall = 1;
  private dpr = 1;

  // Look.
  private light: RGB = [1, 1, 0.95];
  private face: RGB = [0.05, 0.06, 0.06];
  private shade: RGB = [0, 0, 0];
  private day = 0;

  // The pointer's lamp.
  private ptrX = 0;
  private ptrY = 0;
  private ptrIn = false;
  private lampX = 0;
  private lampY = 0;
  private lampZ = 0;
  private near = 0;
  private hand = 1;
  private pressed = false;
  private sink = 0;
  private sinkV = 0;

  // The job.
  private phase: Phase = 'idle';
  private t0 = 0;
  private seed = 1;
  private cells: Cell[] = [];
  /** How far apart the hearts of the cells are, where the body was pressed, and how far the wave has to go. */
  private pitch = 10;
  private pressX = 0;
  private pressY = 0;
  private reach = 1;
  /** When the body came apart, and when it began to close up again. Zero when it has not. */
  private since = 0;
  private shut = 0;
  private held = 0;
  private progress: number | null = null;
  private fill = 0;
  private lit = 0;
  private dull = 0;
  private off = 0;
  private offTarget = 0;
  private focus = 0;
  private focusTarget = 0;
  private calm = 0;

  private reduced = false;
  private raf = 0;
  private last = 0;
  private dead = false;
  private dirty = true;

  constructor(
    private canvas: HTMLCanvasElement,
    private host: HTMLElement,
  ) {
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is not available');
    // The shape of the body is kept in a texture, and that needs more than eight bits.
    if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) throw new Error('No float render targets');
    this.gl = gl;

    this.causticProg = compile(gl, CAUSTIC_VS, CAUSTIC_FS);
    this.groundProg = compile(gl, QUAD_VS, GROUND_FS);
    this.shapeProg = compile(gl, QUAD_VS, SHAPE_FS);
    this.finalProg = compile(gl, QUAD_VS, FINAL_FS);
    this.cu = uniforms(gl, this.causticProg);
    this.gu = uniforms(gl, this.groundProg);
    this.su = uniforms(gl, this.shapeProg);
    this.fu = uniforms(gl, this.finalProg);
    this.still = { tex: gl.createTexture()!, fbo: gl.createFramebuffer()! };
    this.form = { shape: gl.createTexture()!, cells: gl.createTexture()!, more: gl.createTexture()!, fbo: gl.createFramebuffer()! };

    // The wall, unrolled.
    const wall = sheet(gl, GRID_U, GRID_V);
    this.gridVao = wall.vao;
    this.gridCount = wall.count;

    this.quadVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.quadVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.tex = gl.createTexture()!;
    this.fbo = gl.createFramebuffer()!;

    this.measure();
    this.lampZ = this.wall * 1.8;
    this.wake();
  }

  /** Reads size, shape and colours from the element. Call when any of them may have changed. */
  measure(): void {
    const gl = this.gl;
    const box = this.host.getBoundingClientRect();
    const cs = getComputedStyle(this.host);
    const w = this.host.offsetWidth || box.width;
    const h = this.host.offsetHeight || box.height;
    if (w < 2 || h < 2) return;
    const probe = getComputedStyle(this.canvas);
    const spill = this.room(w, h, Math.round(Math.min(Math.max(parseFloat(probe.wordSpacing) || 0, 0), h * 1.5)));
    const rad = Math.min(parseFloat(cs.borderTopLeftRadius) || 0, w / 2, h / 2);
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const lift = parseFloat(cs.getPropertyValue('--caughtlight-rise'));
    // A pill is round all the way over. A squarer body is a slab with a rounded edge.
    const bevel = Math.min(Math.max(rad, h * 0.16), h / 2);
    const rise = Math.min(Math.max(Number.isFinite(lift) ? lift : 1, 0.3), 1.3) * (h * 0.175 + bevel * 0.65);
    const changed = w !== this.w || h !== this.h || spill !== this.spill || rad !== this.rad || dpr !== this.dpr || rise !== this.rise;
    this.w = w;
    this.h = h;
    this.spill = spill;
    this.rad = rad;
    this.dpr = dpr;
    this.bevel = bevel;
    this.rise = rise;
    // The light is caught on the body's widest line, just inside the surface.
    const rim = Math.max(h * 0.04, 1.5);
    this.cav = { a: w / 2 - rim, b: h / 2 - rim, r: Math.max(rad - rim, 0) };
    this.wall = this.cav.b * 0.6;

    this.light = readColour(probe.color, this.light);
    this.face = readColour(probe.caretColor, this.face);
    this.shade = readColour(probe.outlineColor, this.shade);
    this.day = parseFloat(cs.getPropertyValue('--caughtlight-day')) > 0.5 ? 1 : 0;

    if (changed) {
      const cw = w + spill * 2;
      const ch = h + spill * 2;
      const pw = Math.max(2, Math.round(cw * dpr));
      const ph = Math.max(2, Math.round(ch * dpr));
      this.canvas.width = pw;
      this.canvas.height = ph;
      const surface = (tex: WebGLTexture, mips: boolean) => {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, pw, ph, 0, gl.RGBA, gl.HALF_FLOAT, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        if (mips) gl.generateMipmap(gl.TEXTURE_2D);
      };
      const single = (tex: WebGLTexture, fbo: WebGLFramebuffer, mips: boolean) => {
        surface(tex, mips);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      };
      single(this.tex, this.fbo, true);
      single(this.still.tex, this.still.fbo, false);
      surface(this.form.shape, false);
      surface(this.form.cells, false);
      surface(this.form.more, false);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.form.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.form.shape, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.form.cells, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, this.form.more, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.stale = true;
      this.reshape = true;
      // A body that changes size while it is apart goes back to one piece: the plan no longer fits it.
      this.cells = [];
    }
    this.wake();
  }

  /**
   * How far the canvas may reach past the button without making anything scroll: never further
   * than the room there is inside whatever the button scrolls in. Sets the canvas to that size.
   */
  private room(w: number, h: number, want: number): number {
    // The canvas is set from here, so no rule of the page's can leave it the wrong size.
    const st = this.canvas.style;
    const place = (s: number) => {
      st.left = st.top = `${-s}px`;
      st.width = `${w + s * 2}px`;
      st.height = `${h + s * 2}px`;
      st.maxWidth = st.maxHeight = 'none';
    };
    place(0);
    const root = document.scrollingElement ?? document.documentElement;
    let box: Element = root;
    for (let el = this.host.parentElement; el && el !== root && el !== document.body; el = el.parentElement) {
      const cs = getComputedStyle(el);
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
        box = el;
        break;
      }
    }
    const b = this.host.getBoundingClientRect();
    let left = -window.scrollX;
    let top = -window.scrollY;
    if (box !== root) {
      const r = box.getBoundingClientRect();
      left = r.left + box.clientLeft - box.scrollLeft;
      top = r.top + box.clientTop - box.scrollTop;
    }
    const right = left + Math.max(box.scrollWidth, box.clientWidth);
    const bottom = top + Math.max(box.scrollHeight, box.clientHeight);
    const fits = Math.floor(Math.min(b.left - left, right - b.right, b.top - top, bottom - b.bottom));
    const spill = Math.max(0, Math.min(want, fits));
    place(spill);
    return spill;
  }

  setReduced(on: boolean): void {
    this.reduced = on;
    this.wake();
  }

  setDisabled(on: boolean): void {
    this.offTarget = on ? 1 : 0;
    this.wake();
  }

  setFocus(on: boolean): void {
    this.focusTarget = on ? 1 : 0;
    this.wake();
  }

  /** Progress from 0 to 1, or null when the job cannot say. */
  setProgress(p: number | null): void {
    this.progress = p === null ? null : clamp01(p);
    this.wake();
  }

  /** Where the pointer is, in viewport coordinates. `null` when it has gone. */
  pointer(clientX: number | null, clientY = 0): void {
    if (clientX === null) {
      if (!this.ptrIn) return;
      this.ptrIn = false;
      this.wake();
      return;
    }
    const box = this.host.getBoundingClientRect();
    this.ptrX = clientX - (box.left + box.width / 2);
    this.ptrY = clientY - (box.top + box.height / 2);
    const reach = this.h * 3.2 + 40;
    const inRange = Math.abs(this.ptrX) < this.w / 2 + reach && Math.abs(this.ptrY) < this.h / 2 + reach;
    if (inRange || this.ptrIn) this.wake();
    if (inRange && !this.ptrIn && this.near < 0.02) {
      // A lamp that has just arrived starts where the pointer is, not where it last was.
      this.lampX = this.ptrX;
      this.lampY = this.ptrY;
    }
    this.ptrIn = inRange;
  }

  press(down: boolean): void {
    this.pressed = down;
    this.wake();
  }

  /** The light drops in and the body starts to come apart. `x` and `y` are viewport coordinates of the press, or null for the keyboard. */
  commit(clientX: number | null, clientY: number | null, seed?: number): void {
    const { a, b } = this.cav;
    let x = -a * 0.42;
    let y = b * 0.1;
    if (clientX !== null && clientY !== null) {
      const box = this.host.getBoundingClientRect();
      x = clientX - (box.left + box.width / 2);
      y = clientY - (box.top + box.height / 2);
    }
    [x, y] = clampInside(this.cav, x, y, Math.min(b * 0.35, 6));
    this.seed = seed ?? ((Math.round(x * 7) * 73856093) ^ (Math.round(y * 7) * 19349663)) >>> 0;
    this.pressX = x;
    this.pressY = y;
    this.reach = Math.hypot(Math.abs(x) + this.w / 2, Math.abs(y) + this.h / 2);
    this.cells = this.plan(x, y);
    this.phase = 'working';
    this.t0 = this.since = performance.now();
    this.shut = 0;
    this.fill = 0;
    this.pressed = false;
    this.reshape = true;
    this.wake();
  }

  /** The job has ended. */
  finish(how: 'done' | 'failed' | 'stopped'): void {
    if (this.phase !== 'working') return;
    this.phase = how === 'done' ? 'done' : how === 'failed' ? 'failed' : 'stopping';
    this.t0 = performance.now();
    // Done, the cells hold their light for a moment before they close. Cut short, they close at once.
    this.shut = this.t0 + (how === 'done' ? 110 : how === 'failed' ? 150 : 0);
    this.wake();
  }

  /** Back to rest, from any state. */
  rest(): void {
    if (this.phase === 'idle') return;
    this.phase = 'idle';
    this.t0 = performance.now();
    this.wake();
  }

  get state(): Phase {
    return this.phase;
  }

  destroy(): void {
    this.dead = true;
    cancelAnimationFrame(this.raf);
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  /**
   * Where the cells' hearts lie, and the round the light makes through them. The same press on
   * the same body always gives the same cells.
   */
  private plan(px: number, py: number): Cell[] {
    const rnd = mulberry(this.seed);
    const { a, b, r } = this.cav;
    const area = 4 * a * b - (4 - Math.PI) * r * r;
    const across = Math.max(this.h * 0.4, 15);
    const n = Math.max(4, Math.min(MOST, Math.round(area / (across * across * 0.87))));
    const pitch = Math.sqrt(area / n);
    this.pitch = pitch;

    // Scatter the hearts, then let them push one another apart until they sit evenly.
    const xs = new Float64Array(n);
    const ys = new Float64Array(n);
    for (let i = 0; i < n; i++) [xs[i], ys[i]] = clampInside(this.cav, (rnd() * 2 - 1) * a, (rnd() * 2 - 1) * b, pitch * 0.42);
    for (let it = 0; it < 90; it++) {
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const dx = xs[j] - xs[i];
          const dy = ys[j] - ys[i];
          const d = Math.hypot(dx, dy) || 1e-3;
          const push = (pitch * 1.25 - d) * 0.25;
          if (push <= 0) continue;
          xs[i] -= (dx / d) * push;
          ys[i] -= (dy / d) * push;
          xs[j] += (dx / d) * push;
          ys[j] += (dy / d) * push;
        }
      }
      for (let i = 0; i < n; i++) [xs[i], ys[i]] = clampInside(this.cav, xs[i], ys[i], pitch * 0.42);
    }
    const cells: Cell[] = Array.from({ length: n }, (_, i) => ({
      hx: xs[i],
      hy: ys[i],
      x: xs[i],
      y: ys[i],
      far: Math.hypot(xs[i] - px, ys[i] - py),
      turn: 0,
      own: rnd(),
      light: 0,
      spark: 0,
    }));

    // The round the light makes: from the cell under the press, always on to the nearest one not yet visited.
    const todo = [...cells];
    let at = todo.reduce((best, c) => (c.far < best.far ? c : best), todo[0]);
    for (let k = 0; k < n; k++) {
      at.turn = k;
      todo.splice(todo.indexOf(at), 1);
      if (!todo.length) break;
      const from: Cell = at;
      at = todo.reduce((best, c) => (Math.hypot(c.hx - from.hx, c.hy - from.hy) < Math.hypot(best.hx - from.hx, best.hy - from.hy) ? c : best), todo[0]);
    }
    return cells;
  }

  private wake(): void {
    this.dirty = true;
    if (!this.raf && !this.dead) this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number): void => {
    this.raf = 0;
    if (this.dead) return;
    const dt = Math.min(64, this.last ? now - this.last : 16.7);
    this.last = now;
    const moving = this.step(now, dt);
    this.draw(now);
    if (moving || this.dirty) {
      this.dirty = false;
      this.raf = requestAnimationFrame(this.frame);
    } else {
      this.last = 0;
    }
  };

  /** Moves everything one frame on. Returns true while anything is still moving. */
  private step(now: number, dt: number): boolean {
    let moving = false;
    const settle = (cur: number, target: number, tau: number) => {
      const next = approach(cur, target, dt, tau);
      if (Math.abs(next - target) > 5e-4) moving = true;
      return Math.abs(next - target) < 1e-5 ? target : next;
    };

    // The pointer's lamp.
    const { a, b } = this.cav;
    const outX = Math.max(Math.abs(this.ptrX) - a, 0);
    const outY = Math.max(Math.abs(this.ptrY) - b, 0);
    const out = Math.hypot(outX, outY);
    const range = this.h * 3.2;
    const working = this.phase !== 'idle';
    this.hand = settle(this.hand, working || this.reduced ? 0 : 1, working ? 90 : 420);
    const nearTarget = this.ptrIn ? Math.pow(1 - clamp01(out / range), 1.6) : 0;
    this.near = settle(this.near, nearTarget, nearTarget > this.near ? 140 : 380);
    if (this.ptrIn) {
      this.lampX = settle(this.lampX, this.ptrX, 55);
      this.lampY = settle(this.lampY, this.ptrY, 55);
    }
    // Pressed, the lamp comes down until it all but touches the glass.
    const zTarget = this.pressed ? this.wall * 0.86 : this.wall * 1.8 + out * 0.5;
    this.lampZ = settle(this.lampZ, zTarget, this.pressed ? 70 : 130);

    // The body sinks on a spring when pressed.
    const sinkTarget = this.pressed ? 1 : 0;
    const steps = Math.max(1, Math.round(dt / 4));
    for (let i = 0; i < steps; i++) {
      const h = dt / steps / 1000;
      this.sinkV += (-(this.sink - sinkTarget) * 620 - this.sinkV * 30) * h;
      this.sink += this.sinkV * h;
    }
    if (Math.abs(this.sink - sinkTarget) > 1e-3 || Math.abs(this.sinkV) > 1e-2) moving = true;
    else {
      this.sink = sinkTarget;
      this.sinkV = 0;
    }

    this.off = settle(this.off, this.offTarget, 160);
    this.focus = settle(this.focus, this.focusTarget, 110);

    // The job.
    const t = now - this.t0;
    const n = this.cells.length;
    const speed = this.reach / SWEEP;
    let lit = 0;
    let dull = 0;
    /** What each cell is heading for, given its place in the round: the light it keeps, and the light passing through. */
    let want: (turn: number) => number = () => 0;
    let pass: (turn: number) => number = () => 0;
    let quick = 90;

    if (this.phase === 'working') {
      moving = true;
      const auto = 1 - Math.exp(-t / 9000);
      this.fill = settle(this.fill, this.progress ?? auto * 0.55, 380);
      // The light goes round the cells, there and back, and leaves the ones the job has got to lit.
      const span = Math.max(n - 1, 1);
      const lap = (t / (HOP * span)) % 2;
      const where = (lap < 1 ? lap : 2 - lap) * span;
      const reached = this.fill * n;
      const still = this.reduced;
      want = (turn) => clamp01(reached - turn);
      pass = (turn) => (still ? (turn < 0.5 ? 0.7 : 0) : Math.exp(-Math.pow((turn - where) / 0.8, 2)));
    } else if (this.phase === 'done') {
      // Every cell takes the light, they close up into one, and the one is full of it.
      want = () => 1;
      quick = 70;
      // The light fills the body in the wave that closes it, so it is simply on from the moment that wave starts.
      lit = this.reduced || !this.cells.length ? 1 : smooth(90, 150, t);
      this.fill = settle(this.fill, 1, 160);
      if (t < 760) moving = true;
    } else if (this.phase === 'failed' || this.phase === 'stopping') {
      // The light goes out of the cells, last ones first, and they close up.
      const span = this.phase === 'failed' ? 460 : 300;
      const gone = this.reduced ? 1 : clamp01(t / (span * 0.5));
      want = (turn) => (turn / Math.max(n, 1) < 1 - gone ? 0.5 : 0);
      quick = 60;
      dull = this.phase === 'failed' ? smooth(0, 1, t / 320) : 0;
      this.fill = settle(this.fill, 0, 140);
      if (t < span + 40) moving = true;
      else if (this.phase === 'stopping') {
        this.phase = 'idle';
        this.t0 = now;
      }
    } else if (n && !this.shut) {
      // At rest the body is one piece.
      this.shut = now;
    }

    if (n) {
      this.reshape = true;
      // Once the closing wave has crossed the whole body there are no cells any more.
      const closing = this.shut && now >= this.shut;
      if (closing && (this.reduced || now - this.shut > this.reach / (speed * 1.8) + OPEN)) {
        this.cells = [];
        this.held = 0;
      } else {
        if (this.phase !== 'working') moving = true;
        let held = 0;
        const age = now - this.since;
        for (const c of this.cells) {
          // How far the wave has got with this cell.
          const got = this.reduced ? 1 : easeOut(clamp01((age - c.far / speed) / OPEN));
          // A cell starts a little nearer the press and moves out to its place as it forms, then keeps stirring.
          const turn = c.own * 6.283;
          const stir = this.reduced ? 0 : this.pitch * 0.09;
          c.x = c.hx + (this.pressX - c.hx) * 0.16 * (1 - got) + Math.sin(now / 1900 + turn * 3) * stir;
          c.y = c.hy + (this.pressY - c.hy) * 0.16 * (1 - got) + Math.cos(now / 2300 + turn * 5) * stir;
          c.light = approach(c.light, want(c.turn) * got, dt, quick);
          c.spark = approach(c.spark, pass(c.turn) * got, dt, 70);
          held += (c.light * 0.6 + c.spark * 0.4) / n;
        }
        this.held = closing ? 0 : held;
      }
    }

    this.lit = lit > 0 || this.phase === 'done' ? lit : settle(this.lit, 0, 210);
    this.dull = this.phase === 'failed' ? dull : settle(this.dull, 0, 240);
    // While the body is apart, the page's own light counts for less.
    this.calm = settle(this.calm, working ? 1 : 0, working ? 240 : 520);
    return moving;
  }

  /** The shape of the body, for any shader that needs it. */
  private body(u: Record<string, WebGLUniformLocation | null>): void {
    const gl = this.gl;
    gl.uniform2f(u.uHalf, this.w / 2, this.h / 2);
    gl.uniform1f(u.uRad, this.rad);
    gl.uniform1f(u.uBevel, this.bevel);
    gl.uniform1f(u.uRise, this.rise);
  }

  private draw(now: number): void {
    const gl = this.gl;
    if (this.w < 2) return;
    const pw = this.canvas.width;
    const ph = this.canvas.height;
    const vx = this.w / 2 + this.spill;
    const vy = this.h / 2 + this.spill;
    const { a, b, r } = this.cav;
    const soft = b * 0.7;
    const lightOn = 1 - this.off;
    const sink = clamp01(this.sink);
    const crease = this.pitch * 0.42;

    // The pointer's lamp, as the walls catch it. The page's own light is not traced: at rest it
    // gathers at the far end of the body in one clean crescent, which the picture draws itself.
    const bPow = 0.62 * this.near * this.hand * (this.lampZ * this.lampZ + soft * soft) * (1 + 1.4 * sink);
    // The lamp is not a point. Drawing it from a few places gives every edge of light its softness.
    const bSize = b * 0.028;

    gl.viewport(0, 0, pw, ph);
    gl.clearColor(0, 0, 0, 0);
    gl.disable(gl.BLEND);

    if (this.stale) {
      this.stale = false;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.still.fbo);
      gl.clear(gl.COLOR_BUFFER_BIT);
      // Where the page's light still reaches the page: everywhere but the body's shadow.
      gl.useProgram(this.groundProg);
      this.body(this.gu);
      gl.uniform2f(this.gu.uRes, pw, ph);
      gl.uniform1f(this.gu.uPix, this.dpr);
      gl.uniform3f(this.gu.uSun, SUN[0], SUN[1], SUN[2]);
      gl.bindVertexArray(this.quadVao);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    if (this.reshape) {
      // Only while the body is apart does its shape need writing down again.
      this.reshape = this.cells.length > 0;
      const count = Math.min(this.cells.length, MOST);
      for (let i = 0; i < count; i++) {
        const c = this.cells[i];
        this.cellData[i * 4] = c.x;
        this.cellData[i * 4 + 1] = c.y;
        this.cellData[i * 4 + 2] = c.light;
        this.cellData[i * 4 + 3] = c.spark;
        this.ownData[i] = c.own;
      }
      const swift = this.reduced ? 1e6 : 0;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.form.fbo);
      gl.useProgram(this.shapeProg);
      this.body(this.su);
      gl.uniform2f(this.su.uRes, pw, ph);
      gl.uniform1f(this.su.uPix, this.dpr);
      gl.uniform1i(this.su.uCount, count);
      gl.uniform2f(this.su.uPress, this.pressX, this.pressY);
      gl.uniform1f(this.su.uAge, now - this.since + swift);
      gl.uniform1f(this.su.uShut, this.shut && now >= this.shut ? now - this.shut + swift : -1);
      gl.uniform1f(this.su.uSpeed, this.reach / SWEEP);
      gl.uniform1f(this.su.uOpening, OPEN);
      gl.uniform1f(this.su.uCrease, crease);
      gl.uniform4fv(this.su.uCell, this.cellData);
      gl.uniform1fv(this.su.uOwn, this.ownData);
      gl.bindVertexArray(this.quadVao);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    if (lightOn > 0.01 && bPow > 1e-3) {
      gl.useProgram(this.causticProg);
      const u = this.cu;
      gl.uniform3f(u.uCav, a, b, r);
      gl.uniform1f(u.uWall, this.wall);
      gl.uniform1f(u.uSoft, soft);
      gl.uniform2f(u.uView, vx, vy);
      gl.uniform1f(u.uPix, this.dpr);
      gl.bindVertexArray(this.gridVao);
      // Pressed, the glass gives almost everything back, so the light keeps going.
      gl.uniform1f(u.uRho, mix(0.34, 0.94, sink));
      gl.uniform1f(u.uPower, bPow / SPOTS.length);
      for (const [sx, sy] of SPOTS) {
        gl.uniform3f(u.uLamp, this.lampX + sx * bSize, this.lampY + sy * bSize, this.lampZ);
        gl.drawElements(gl.TRIANGLES, this.gridCount, gl.UNSIGNED_SHORT, 0);
      }
    }
    gl.disable(gl.BLEND);
    // Smaller copies of the light, so its edges can be drawn soft.
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.generateMipmap(gl.TEXTURE_2D);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, pw, ph);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.finalProg);
    const f = this.fu;
    this.body(f);
    gl.uniform2f(f.uRes, pw, ph);
    gl.uniform1f(f.uPix, this.dpr);
    gl.uniform3fv(f.uFace, this.face);
    gl.uniform3fv(f.uGlow, this.light);
    gl.uniform3fv(f.uShade, this.shade);
    gl.uniform3f(f.uLampB, this.lampX, this.lampY, this.near * this.hand * (1 + 1.2 * sink));
    // While the pointer's lamp is near, or the body is apart, the page's own light counts for less.
    gl.uniform1f(f.uSun, (1 - 0.5 * this.near * this.hand) * (1 - 0.4 * this.calm));
    gl.uniform1f(f.uLit, this.lit);
    gl.uniform1f(f.uDull, this.dull);
    gl.uniform1f(f.uOff, this.off);
    gl.uniform1f(f.uFocus, this.focus);
    gl.uniform1f(f.uSink, this.sink);
    gl.uniform1f(f.uDay, this.day);
    gl.uniform1f(f.uCrease, crease);
    gl.uniform1f(f.uHeld, this.held);
    gl.uniform2f(f.uTravel, -SUN[0] / Math.hypot(SUN[0], SUN[1]), -SUN[1] / Math.hypot(SUN[0], SUN[1]));
    gl.uniform1i(f.uLight, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.form.shape);
    gl.uniform1i(f.uShape, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.still.tex);
    gl.uniform1i(f.uStill, 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.form.cells);
    gl.uniform1i(f.uCells, 3);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.form.more);
    gl.uniform1i(f.uMore, 4);
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }
}
