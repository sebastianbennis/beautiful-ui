// The bed itself: every pin's height, on its own small spring. Everything the
// component shows is a statement about how tall the pins stand, so this one
// file is the source of every state. The renderers only draw what is here.

export const ROW = Math.sqrt(3) / 2;
export const TALLEST = 2.2;

export interface Pulse {
  x: number;
  y: number;
  born: number;
  height: number;
  speed: number;
  width: number;
  life: number;
}

export interface Sweep {
  /** a wave of change leaving a point: pins it has passed switch state */
  x: number;
  y: number;
  born: number;
  speed: number;
}

export interface Turn {
  /** the plate changing material: a front leaves a point and every pin it passes turns over */
  x: number;
  y: number;
  born: number;
  speed: number;
  far: number;
  to: boolean;
  /** how far the front had got at the last step, and has got at this one */
  reach: number;
  next: number;
}

/** how wide the front of a turn is, in pitches */
export const TURN_BAND = 4;
/** asked to change again before a front has crossed, the next front follows it: this many at once */
export const MAX_TURNS = 4;
/** the jump a pin makes as it turns over */
const TURN_KICK = 3.8;

export interface Finish {
  x: number;
  y: number;
  born: number;
  far: number;
  /** false when there is no playable film: the pins simply stay up */
  film: boolean;
}

export type Carry = 'none' | 'window' | 'over' | 'refused';

export interface FieldOptions {
  cols: number;
  rows: number;
  reduced: boolean;
}

/** spring constants, rising is quicker than settling */
const K_RISE = 190;
const K_FALL = 92;
const Z_RISE = 0.6;
const Z_FALL = 0.82;
const PRESS_DEPTH = 0.75;
const HOVER_HEIGHT = 1.25;
const HOVER_RADIUS = 11;
const CARRY_HEIGHT = 1.7;
const CARRY_RADIUS = 24;

export class Field {
  readonly cols: number;
  readonly rows: number;
  readonly n: number;

  h: Float32Array;
  v: Float32Array;
  target: Float32Array;
  /** 0 white of the picture, 1 black of the picture, the shape to press up */
  relief: Float32Array;
  /** how far this column has been pressed up, 0 to 1 */
  fill: Float32Array;
  film: Float32Array;
  opened: Float32Array;
  crowd: Float32Array;
  /** how open each pin's spot is to the sky, including whether its slope faces the light */
  depth: Float32Array;
  private standingAt: Float32Array;
  private standingStale = true;
  private stiff: Float32Array;
  private integral: Float32Array;
  private px: Float32Array;
  private py: Float32Array;

  reduced: boolean;
  dark = false;
  /** above 1, mid tones stay low and only the real darks stand tall */
  gamma = 1.8;
  crowdRadius = 1;
  sag = 0;
  sagTarget = 0;

  pointerActive = false;
  pointerX = 0;
  pointerY = 0;
  private hoverX = 0;
  private hoverY = 0;
  private hoverVX = 0;
  private hoverVY = 0;
  hover = 0;
  private hoverTarget = 0;
  press = 0;
  private pressTarget = 0;

  carry: Carry = 'none';
  private carryX = 0;
  private carryY = 0;
  carryAmount = 0;
  private carryDent = 0;

  pulses: Pulse[] = [];
  ridge: { born: number } | null = null;
  collapse: Sweep | null = null;
  finish: Finish | null = null;
  /** fronts still crossing the bed, oldest first. `dark` is the material none of them has reached */
  turns: Turn[] = [];

  now = 0;

  constructor(opts: FieldOptions) {
    this.cols = opts.cols;
    this.rows = opts.rows;
    this.n = opts.cols * opts.rows;
    this.reduced = opts.reduced;
    this.h = new Float32Array(this.n);
    this.v = new Float32Array(this.n);
    this.target = new Float32Array(this.n);
    this.relief = new Float32Array(this.n);
    this.fill = new Float32Array(this.cols);
    this.film = new Float32Array(this.n);
    this.opened = new Float32Array(this.n);
    this.crowd = new Float32Array(this.n);
    this.depth = new Float32Array(this.n).fill(1);
    this.standingAt = new Float32Array(this.n);
    this.stiff = new Float32Array(this.n);
    this.integral = new Float32Array((this.cols + 1) * (this.rows + 1));
    this.px = new Float32Array(this.n);
    this.py = new Float32Array(this.n);
    let seed = 94271;
    for (let j = 0; j < this.rows; j++) {
      for (let i = 0; i < this.cols; i++) {
        const k = j * this.cols + i;
        this.px[k] = i + 0.5 + 0.5 * (j & 1);
        this.py[k] = (j + 0.5) * ROW;
        seed = (seed * 16807) % 2147483647;
        this.stiff[k] = 0.86 + 0.28 * (seed / 2147483647);
      }
    }
    this.hoverX = this.cols / 2;
    this.hoverY = (this.rows * ROW) / 2;
  }

  /** x and y in pitches from the first cell */
  setPointer(x: number, y: number, active: boolean): void {
    if (active && !this.pointerActive) {
      this.hoverX = x;
      this.hoverY = y;
      this.hoverVX = 0;
      this.hoverVY = 0;
    }
    this.pointerX = x;
    this.pointerY = y;
    this.pointerActive = active;
    this.hoverTarget = active ? 1 : 0;
  }

  setPress(down: boolean): void {
    this.pressTarget = down ? 1 : 0;
  }

  setCarry(carry: Carry, x = this.carryX, y = this.carryY): void {
    if (carry !== 'none' && this.carry === 'none') {
      this.carryX = x;
      this.carryY = y;
    }
    if (carry !== 'none' && this.carry === 'none' && !this.reduced) this.stir();
    this.carry = carry;
    this.carryX = x;
    this.carryY = y;
  }

  /** The plate notices a file has entered the window: every pin moves once. */
  private stir(): void {
    for (let k = 0; k < this.n; k++) this.v[k] += 2.1 * this.stiff[k];
  }

  addPulse(x: number, y: number, height: number, width = 5, speed = 66, life = 1.7): void {
    if (this.reduced) return;
    this.pulses.push({ x, y, height, speed, width, life, born: this.now });
  }

  startRidge(): void {
    if (!this.reduced) this.ridge = { born: this.now };
  }

  stopRidge(): void {
    this.ridge = null;
  }

  beginCollapse(x: number, y: number): void {
    this.collapse = { x, y, born: this.now, speed: 230 };
  }

  /** The distance from a point to the corner of the bed furthest from it. */
  private farFrom(x: number, y: number): number {
    return Math.max(
      Math.hypot(x, y),
      Math.hypot(this.cols - x, y),
      Math.hypot(x, this.rows * ROW - y),
      Math.hypot(this.cols - x, this.rows * ROW - y),
    );
  }

  beginFinish(x: number, y: number, film: boolean): void {
    this.finish = { x, y, born: this.now, far: this.farFrom(x, y), film };
  }

  /** Changes the material. With a starting point the change travels out from it, pin by pin. */
  setDark(dark: boolean, from?: { x: number; y: number; speed: number }): void {
    const turns = this.turns;
    const heading = turns.length ? turns[turns.length - 1].to : this.dark;
    if (from && !this.reduced && dark !== heading && turns.length < MAX_TURNS) {
      turns.push({ x: from.x, y: from.y, born: this.now, speed: from.speed, far: this.farFrom(from.x, from.y), to: dark, reach: 0, next: 0 });
    } else {
      turns.length = 0;
      this.dark = dark;
    }
    this.standingStale = true;
  }

  reset(): void {
    this.relief.fill(0);
    this.standingStale = true;
    this.fill.fill(0);
    this.film.fill(0);
    this.opened.fill(0);
    this.collapse = null;
    this.finish = null;
    this.ridge = null;
    this.pulses.length = 0;
    this.sagTarget = 0;
  }

  /** Call after changing the picture or the material. */
  markRelief(): void {
    this.standingStale = true;
  }

  /** The tone at a pin decides height. In chalk the darks stand, in steel the lights. */
  private standing(tone: number, dark: boolean): number {
    if (tone < 0) return 0; // outside the film's own shape
    // in steel the picture is made of glints, so the mid tones need to stand higher
    return dark ? Math.pow(1 - tone, 1.25) * TALLEST : Math.pow(tone, this.gamma) * TALLEST;
  }

  step(dt: number): boolean {
    this.now += dt;
    const damp = (from: number, to: number, rate: number) => from + (to - from) * (1 - Math.exp(-rate * dt));

    this.hover = damp(this.hover, this.hoverTarget, this.hoverTarget ? 14 : 5.5);
    this.press = damp(this.press, this.pressTarget, this.pressTarget ? 26 : 13);
    this.sag = damp(this.sag, this.sagTarget, 7);
    const carryOn = this.carry === 'over' || this.carry === 'refused' ? 1 : this.carry === 'window' ? 0.0 : 0;
    this.carryAmount = damp(this.carryAmount, carryOn, 9);
    this.carryDent = damp(this.carryDent, this.carry === 'refused' ? 1 : 0, 11);

    // the hill trails the hand a little, on a spring
    const K = 120;
    const C = 2 * 0.86 * Math.sqrt(K);
    this.hoverVX += (K * (this.pointerX - this.hoverX) - C * this.hoverVX) * dt;
    this.hoverVY += (K * (this.pointerY - this.hoverY) - C * this.hoverVY) * dt;
    this.hoverX += this.hoverVX * dt;
    this.hoverY += this.hoverVY * dt;

    for (let p = this.pulses.length - 1; p >= 0; p--) {
      if (this.now - this.pulses[p].born > this.pulses[p].life) this.pulses.splice(p, 1);
    }

    const { cols, n, h, v, target, relief, fill, stiff, px, py, film, opened, standingAt } = this;
    const turns = this.turns;
    const turning = turns.length > 0;
    if (turning) {
      for (let i = 0; i < turns.length; i++) turns[i].next = (this.now - turns[i].born) * turns[i].speed - TURN_BAND * 0.5;
      // once the oldest front has crossed the whole bed, what it brought is simply the plate
      while (turns.length && turns[0].next > turns[0].far + TURN_BAND * 0.5 + 1) {
        this.dark = turns[0].to;
        turns.shift();
      }
      // as a front reaches a pin it turns over: it jumps once and settles at its new height
      for (let k = 0; k < n; k++) {
        let dark = this.dark;
        for (let i = 0; i < turns.length; i++) {
          const turn = turns[i];
          const d = Math.hypot(px[k] - turn.x, py[k] - turn.y);
          if (d >= turn.next) continue;
          dark = turn.to;
          if (d >= turn.reach) v[k] += TURN_KICK * stiff[k];
        }
        standingAt[k] = this.standing(relief[k], dark);
      }
      for (let i = 0; i < turns.length; i++) turns[i].reach = turns[i].next;
      this.standingStale = false;
    }
    if (this.standingStale) {
      for (let k = 0; k < n; k++) standingAt[k] = this.standing(relief[k], this.dark);
      this.standingStale = false;
    }
    const hoverReach = this.hover * (1 - 2 * this.press);
    const sigma2 = 2 * HOVER_RADIUS * HOVER_RADIUS * (1 - 0.3 * this.press);
    const carryS2 = 2 * CARRY_RADIUS * CARRY_RADIUS;
    const ridgeX = this.ridge ? ((this.now - this.ridge.born) * 96) % (cols + 26) - 13 : 0;

    const finish = this.finish;
    let fAge = 0;
    if (finish) fAge = this.now - finish.born;

    const collapse = this.collapse;

    let moving = Math.abs(this.hover - this.hoverTarget) > 0.002 || Math.abs(this.press - this.pressTarget) > 0.002;
    moving = moving || Math.abs(this.hoverVX) + Math.abs(this.hoverVY) > 0.01;
    moving = moving || Math.abs(this.sag - this.sagTarget) > 0.001 || this.pulses.length > 0 || !!this.ridge;
    moving = moving || this.carry !== 'none' || this.carryAmount > 0.002 || turning;

    for (let k = 0; k < n; k++) {
      const i = k % cols;
      const x = px[k];
      const y = py[k];

      let t = standingAt[k] * fill[i];
      if (collapse) {
        const d = Math.hypot(x - collapse.x, y - collapse.y);
        if (d < (this.now - collapse.born) * collapse.speed) t = 0;
      }

      if (finish?.film) {
        const d = Math.hypot(x - finish.x, y - finish.y);
        const front = fAge - 0.12 - d * 0.0058;
        const colour = this.reduced ? Math.min(fAge / 0.5, 1) : Math.min(Math.max(front / 0.09, 0), 1);
        film[k] = Math.max(film[k], colour);
        // the far edges sink first, ending at the column that finished it
        const sinkAt = 1.1 + 0.55 * (1 - d / finish.far);
        const sink = this.reduced ? Math.min(fAge / 0.5, 1) : Math.min(Math.max((fAge - sinkAt) / 0.3, 0), 1);
        const eased = sink * sink * (3 - 2 * sink);
        t *= 1 - eased;
        opened[k] = Math.max(opened[k], Math.min(Math.max((fAge - sinkAt - 0.18) / 0.22, 0), 1) * (this.reduced ? 0 : 1));
        if (this.reduced) opened[k] = Math.max(opened[k], Math.min(fAge / 0.5, 1));
      }

      t *= 1 - this.sag;

      if (hoverReach !== 0) {
        const dx = x - this.hoverX;
        const dy = y - this.hoverY;
        const d2 = dx * dx + dy * dy;
        if (d2 < sigma2 * 5) t += (HOVER_HEIGHT - this.press * (HOVER_HEIGHT + PRESS_DEPTH * 0.4)) * this.hover * Math.exp(-d2 / sigma2);
      }

      if (this.carryAmount > 0.002) {
        const dx = x - this.carryX;
        const dy = y - this.carryY;
        const d2 = dx * dx + dy * dy;
        if (d2 < carryS2 * 5) {
          const hill = this.carryAmount * Math.exp(-d2 / carryS2);
          t += CARRY_HEIGHT * hill * (1 - 1.55 * this.carryDent);
        }
      }

      for (let p = 0; p < this.pulses.length; p++) {
        const pulse = this.pulses[p];
        const age = this.now - pulse.born;
        if (age < 0) continue;
        const d = Math.hypot(x - pulse.x, y - pulse.y);
        const phase = (d - age * pulse.speed) / pulse.width;
        if (phase > -3.2 && phase < 3.2) {
          const fade = Math.pow(1 - age / pulse.life, 2);
          // down first, then up: a weight landing, not a blip
          t += pulse.height * fade * (phase * Math.exp(-phase * phase) * 1.9);
        }
      }

      if (this.ridge) {
        const dx = (x - ridgeX) / 5;
        if (dx > -3 && dx < 3) t += 0.34 * Math.exp(-dx * dx);
      }

      target[k] = t;

      const delta = t - h[k];
      const rising = delta > 0;
      const stiffness = (rising ? K_RISE : K_FALL) * stiff[k];
      const zeta = rising ? Z_RISE : Z_FALL;
      const c = 2 * zeta * Math.sqrt(stiffness);
      v[k] += (stiffness * delta - c * v[k]) * dt;
      h[k] += v[k] * dt;
      if (h[k] < -0.7) {
        h[k] = -0.7;
        v[k] = 0;
      }
      if (!moving && (Math.abs(v[k]) > 0.004 || Math.abs(delta) > 0.004)) moving = true;
    }

    this.computeCrowd();

    return moving;
  }

  /** Reduced motion: heights are simply where they should be. */
  settle(): void {
    this.h.set(this.target);
    this.v.fill(0);
    this.computeCrowd();
  }

  private computeCrowd(): void {
    const { cols, rows, h, integral, crowd } = this;
    const w = cols + 1;
    for (let j = 0; j < rows; j++) {
      let run = 0;
      for (let i = 0; i < cols; i++) {
        run += Math.max(h[j * cols + i], 0);
        integral[(j + 1) * w + i + 1] = integral[j * w + i + 1] + run;
      }
    }
    const R = this.crowdRadius;
    const cells = (2 * R + 1) * (2 * R + 1);
    for (let j = 0; j < rows; j++) {
      const y0 = Math.max(j - R, 0);
      const y1 = Math.min(j + R + 1, rows);
      for (let i = 0; i < cols; i++) {
        const x0 = Math.max(i - R, 0);
        const x1 = Math.min(i + R + 1, cols);
        const sum = integral[y1 * w + x1] - integral[y0 * w + x1] - integral[y1 * w + x0] + integral[y0 * w + x0];
        // a fixed divisor, so the crowd thins out toward the edge of the bed
        crowd[j * cols + i] = sum / cells;
      }
    }
    const { depth } = this;
    const at = (i: number, j: number) => (i < 0 || j < 0 || i >= cols || j >= rows ? 0 : crowd[j * cols + i]);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i;
        const c = crowd[k];
        // low pins stay open and bright, only a tall crowd goes properly dark
        const open = Math.exp(-c * c * 0.62);
        // a slope that faces the light is brighter than one turning away from it,
        // which is what makes a raised area read as a hill and a picture as relief
        const facing = Math.max(-1, Math.min(1, (at(i + 1, j + 1) - at(i - 1, j - 1)) * 0.9));
        depth[k] = Math.max(0, Math.min(1, open + facing * open * (1 - open) * 2.4));
      }
    }
  }
}
