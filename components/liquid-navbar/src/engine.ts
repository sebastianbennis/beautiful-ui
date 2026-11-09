'use client';

import {
  BEAD_COUNT,
  DRIP_COUNT,
  DROP_COUNT,
  FIELD_ROWS,
  FIELD_WIDTH,
  FRAGMENT_SHADER,
  MASS_COUNT,
  VERTEX_SHADER,
} from './shader';
import { FRONT_SQUASH, PUFF_SIZE, puffTile } from './daylight';
import type { PendantWeather } from './types';
import { LAMP_COUNT, RING_COUNT, WATER_SHADER } from './water';
import { drawBolt, Weather, type FrontState } from './weather';

type Rgb = [number, number, number];

const STEP = 1 / 240;
/** How long the new weather takes to cross the banner once the drop has landed, in seconds. */
const FRONT_TIME = 1.25;
/** The radius of the drop holding the other weather, and the length of its neck, at scale 1. */
const ORB_RADIUS = 21;
const ORB_NECK = 14;
/** The sun, as a fraction of the width and of the height. */
const SUN: [number, number] = [0.3, 0.27];

/** A damped spring. Everything a pointer can touch is driven by these, so a reversal never jumps. */
export class Spring {
  x: number;
  v = 0;
  to: number;

  constructor(
    x: number,
    public k = 170,
    public c = 26,
    public eps = 0.02,
  ) {
    this.x = x;
    this.to = x;
  }

  set(to: number, k?: number, c?: number): void {
    this.to = to;
    if (k !== undefined) this.k = k;
    if (c !== undefined) this.c = c;
  }

  snap(x: number): void {
    this.x = x;
    this.to = x;
    this.v = 0;
  }

  step(dt: number): void {
    const a = -this.k * (this.x - this.to) - this.c * this.v;
    this.v += a * dt;
    this.x += this.v * dt;
  }

  get done(): boolean {
    return Math.abs(this.x - this.to) < this.eps && Math.abs(this.v) < this.eps * 4;
  }
}

export interface MassSprings {
  cx: Spring;
  hw: Spring;
  depth: Spring;
  r: Spring;
  on: Spring;
}

export interface DropSprings {
  x: Spring;
  reach: Spring;
  len: Spring;
  press: Spring;
}

export interface MassTarget {
  cx: number;
  hw: number;
  depth: number;
  r: number;
  on: number;
}

export interface RestingDrip {
  x: number;
  length: number;
  bulb: number;
  neck: number;
  /** Seconds between drops at rest. */
  every: number;
}

type DripStage = 'off' | 'hang' | 'stretch' | 'recover' | 'pour' | 'jet';

interface Drip {
  stage: DripStage;
  x: Spring;
  root: Spring;
  length: Spring;
  bulb: Spring;
  neck: Spring;
  sway: Spring;
  /** Fades a drip in after the edge it hangs from has changed under it. */
  presence: Spring;
  flare: number;
  rest: RestingDrip;
  growth: number;
  timer: number;
  big: boolean;
}

interface Bead {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  age: number;
  /** Crown droplets are thrown from an impact and carry no fresh volume back to the pool. */
  crown: boolean;
  /** Where it comes down: how far in front of the far edge of the water, in pixels. */
  b: number;
}

/** A rectangle to draw into, in device pixels: x0, y0, x1, y1. */
type Box = [number, number, number, number];

interface Ring {
  x: number;
  b: number;
  age: number;
  amp: number;
}

function makeMass(): MassSprings {
  return {
    cx: new Spring(0),
    hw: new Spring(0),
    depth: new Spring(0),
    r: new Spring(0),
    on: new Spring(0, 200, 28, 0.002),
  };
}

function makeDrop(): DropSprings {
  return {
    x: new Spring(0, 240, 23),
    reach: new Spring(0, 120, 11, 0.003),
    len: new Spring(0, 200, 24),
    press: new Spring(0, 700, 42, 0.004),
  };
}

function makeDrip(): Drip {
  return {
    stage: 'off',
    x: new Spring(0, 900, 60),
    root: new Spring(0, 1100, 66),
    length: new Spring(0, 120, 15, 0.05),
    bulb: new Spring(0, 160, 18, 0.02),
    neck: new Spring(1, 160, 20, 0.02),
    sway: new Spring(0, 34, 5.5, 0.03),
    presence: new Spring(1, 90, 19, 0.004),
    flare: 8,
    rest: { x: 0, length: 0, bulb: 0, neck: 1, every: 4 },
    growth: 0,
    timer: 0,
    big: false,
  };
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

// The shader encodes with a 2.2 power, so this is the exact inverse: colours round-trip unchanged.
const toLinear = (c: number): number => Math.pow(c, 2.2);

/** Reads any CSS colour the host has set, including oklch(), through a one pixel canvas. */
function readColour(probe: CanvasRenderingContext2D, css: string, fallback: Rgb): Rgb {
  if (!css.trim()) return fallback;
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = '#000';
  probe.fillStyle = css;
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
  return [toLinear(r / 255), toLinear(g / 255), toLinear(b / 255)];
}

/** Everything attached to one edge of the banner: its forms, drops, drips, wave and mist. */
export class Layer {
  readonly masses: MassSprings[] = Array.from({ length: MASS_COUNT }, makeMass);
  readonly drops: DropSprings[] = Array.from({ length: DROP_COUNT }, makeDrop);
  readonly drips: Drip[] = Array.from({ length: DRIP_COUNT }, makeDrip);
  readonly action = {
    cx: new Spring(0),
    cy: new Spring(0),
    hw: new Spring(0),
    hh: new Spring(0),
    r: new Spring(0),
    on: new Spring(0, 200, 28, 0.002),
  };
  readonly tiltX = new Spring(0, 46, 11, 0.0004);
  readonly tiltY = new Spring(0, 60, 9, 0.0004);
  readonly glowX = new Spring(0, 300, 30);
  readonly glowY = new Spring(0, 240, 25);
  readonly glowW = new Spring(1, 240, 26);
  readonly glowGain = new Spring(0, 130, 22, 0.002);
  glowHalfHeight = 26;
  actionAttached = true;

  dropShape = [
    { radius: 54, offset: 6 },
    { radius: 42, offset: -24 },
  ];
  fogLevel = 0;
  /** Places the mist never settles: the current page's title, and the brand. */
  fogClear: Array<{ x: number; width: number }> = [];

  readonly wave = new Float32Array(FIELD_WIDTH);
  readonly waveV = new Float32Array(FIELD_WIDTH);
  readonly fog = new Float32Array(FIELD_WIDTH).fill(1);
  waveSpan = { x: 0, w: 0 };
  waveTension = 430;
  waveDamping = 5.2;
  waveLimit = 7;
  waveGrip = 26;
  waveLive = false;
  private fogLive = true;
  private pourLanding = 0;

  readonly springs: Spring[];

  constructor(
    readonly core: PendantEngine,
    readonly flip: 1 | -1,
  ) {
    const a = this.action;
    this.springs = [
      ...this.masses.flatMap((m) => [m.cx, m.hw, m.depth, m.r, m.on]),
      ...this.drops.flatMap((d) => [d.x, d.reach, d.len, d.press]),
      ...this.drips.flatMap((d) => [d.x, d.root, d.length, d.bulb, d.neck, d.sway, d.presence]),
      a.cx,
      a.cy,
      a.hw,
      a.hh,
      a.r,
      a.on,
      this.tiltX,
      this.tiltY,
      this.glowX,
      this.glowY,
      this.glowW,
      this.glowGain,
    ];
  }

  get still(): boolean {
    return this.core.still;
  }

  get scale(): number {
    return this.core.scale;
  }

  invalidate(): void {
    this.core.invalidate();
  }

  setMass(index: number, target: MassTarget, snap = false): void {
    const m = this.masses[index];
    const jump = snap || this.still;
    const assign = (spring: Spring, value: number): void => {
      if (jump) spring.snap(value);
      else spring.to = value;
    };
    assign(m.cx, target.cx);
    assign(m.hw, target.hw);
    assign(m.depth, target.depth);
    assign(m.r, target.r);
    assign(m.on, target.on);
    this.invalidate();
  }

  tuneMass(index: number, k: number, c: number): void {
    const m = this.masses[index];
    for (const spring of [m.cx, m.hw, m.depth, m.r]) {
      spring.k = k;
      spring.c = c;
    }
  }

  setWaveSpan(x: number, width: number): void {
    this.waveSpan = { x, w: width };
  }

  /** Aims a drop. Reach 0 is fully inside the body, reach 1 is fully out. */
  aim(index: number, x: number, reach: number, len: number, snap = false): void {
    const d = this.drops[index];
    if (reach === 0 && d.reach.to === 0 && d.reach.done) return;
    if (snap || this.still) {
      d.x.snap(x);
      d.len.snap(len);
    } else {
      d.x.to = x;
      d.len.to = len;
    }
    if (this.still) d.reach.snap(reach);
    else d.reach.to = reach;
    this.invalidate();
  }

  /** The press: the drop draws back up, then rings past its rest when it lets go. */
  press(down: boolean): void {
    if (this.still) return;
    const p = this.drops[0].press;
    if (down) p.set(-1, 700, 42);
    else p.set(0, 260, 9);
    this.invalidate();
  }

  /** Where a drop is right now: x, y, half width, half height. */
  dropGeometry(index: number): [number, number, number, number] {
    const d = this.drops[index];
    const s = this.scale;
    const shape = this.dropShape[index];
    const big = shape.radius * s;
    const reach = clamp(d.reach.x, -0.1, 1.25);
    const speed = Math.abs(d.x.v);
    const press = d.press.x;
    const base = this.masses[0].depth.x;
    const b = big * (0.5 + 0.5 * Math.min(reach, 1.1)) - press * 3 * s;
    const y =
      base -
      big * 0.98 +
      reach * (big * 0.98 + shape.offset * s) -
      Math.min(16 * s, speed * 0.016) * clamp(reach, 0, 1) +
      press * 12 * s;
    const a = (big * 0.9 + Math.max(d.len.x, 0)) * (0.72 + 0.28 * Math.min(reach, 1)) + Math.min(60 * s, speed * 0.03);
    return [d.x.x, y, reach < 0.004 ? 0 : a, reach < 0.004 ? 0 : b];
  }

  /** How far the free edge reaches at x, or -1 if nothing hangs there. */
  edgeAt(x: number): number {
    let y = -1;
    for (const m of this.masses) {
      if (m.on.x < 0.001) continue;
      if (Math.abs(x - m.cx.x) < m.hw.x - m.r.x * 0.5) y = Math.max(y, m.depth.x);
    }
    for (let i = 0; i < DROP_COUNT; i++) {
      const [dx, dy, a, b] = this.dropGeometry(i);
      if (a <= 0 || Math.abs(x - dx) >= a) continue;
      const e = (x - dx) / a;
      y = Math.max(y, dy + b * Math.sqrt(1 - e * e));
    }
    return y;
  }

  /** How deep a point is inside the forms of this layer, negative when it is outside them. */
  depthInside(x: number, y: number, margin = 0): number {
    let deepest = -Infinity;
    for (const m of this.masses) {
      if (m.on.x < 0.001) continue;
      deepest = Math.max(deepest, Math.min(m.hw.x + margin - Math.abs(x - m.cx.x), m.depth.x - y));
    }
    return deepest;
  }

  waveAtPoint(x: number): number {
    const { x: x0, w } = this.waveSpan;
    if (w <= 0) return 0;
    const u = clamp((x - x0) / w, 0, 1) * (FIELD_WIDTH - 1);
    const i = Math.min(Math.floor(u), FIELD_WIDTH - 2);
    return this.wave[i] + (this.wave[i + 1] - this.wave[i]) * (u - i);
  }

  kick(x: number, amount: number, sigma: number): void {
    const { x: x0, w } = this.waveSpan;
    if (w <= 0) return;
    for (let i = 0; i < FIELD_WIDTH; i++) {
      const cx = x0 + (i / (FIELD_WIDTH - 1)) * w;
      const e = (cx - x) / sigma;
      if (Math.abs(e) < 4) this.waveV[i] += amount * Math.exp(-e * e);
    }
    this.waveLive = true;
  }

  setRestingDrips(list: RestingDrip[]): void {
    const s = this.scale;
    this.drips.slice(1).forEach((drip, i) => {
      const entry = list[i];
      if (!entry) {
        drip.stage = 'off';
        return;
      }
      const fresh = drip.stage === 'off';
      drip.rest = entry;
      if (fresh) {
        drip.x.snap(entry.x);
        drip.growth = ((i + 1) * 0.37) % 1;
        drip.length.snap(entry.length * 0.5);
        drip.bulb.snap(entry.bulb * 0.75);
        drip.neck.snap(entry.neck);
        drip.flare = 7 * s;
        drip.stage = 'hang';
      } else {
        drip.x.to = entry.x;
      }
    });
    this.invalidate();
  }

  /** A jet thrown back up by an impact: a column with a bead on top that climbs and falls. */
  jet(x: number, base: number, height: number, bulb: number): void {
    let slot = this.drips.find((d) => d.stage === 'off');
    if (!slot) slot = this.drips.reduce((a, b) => (a.timer < b.timer ? a : b));
    const s = this.scale;
    slot.stage = 'jet';
    slot.timer = 0.3;
    slot.x.snap(x);
    slot.root.snap(base);
    slot.length.snap(2 * s);
    slot.length.set(height, 230, 13);
    slot.bulb.snap(bulb * 0.7);
    slot.bulb.set(bulb, 300, 26);
    slot.neck.snap(bulb * 0.5);
    slot.neck.set(2.3 * s, 120, 18);
    slot.flare = bulb * 1.5;
    slot.sway.snap(0);
  }

  step(h: number): void {
    this.stepDrips(h);
    this.stepWave(h);
    this.stepFog(h);
  }

  private startStretch(d: Drip, big: boolean): void {
    d.stage = 'stretch';
    d.timer = big ? 0.1 : 0.14;
    d.big = big;
    const s = this.scale;
    d.length.set(d.length.x + (big ? 34 : 20) * s, big ? 520 : 240, big ? 30 : 24);
    d.neck.set(0.85 * s, big ? 900 : 460, big ? 44 : 32);
    if (big) d.bulb.set(Math.max(d.bulb.x, 11.5 * s), 520, 32);
  }

  /** The pinch: the bead lets go, a thread snaps back up and a tiny satellite is left behind. */
  private detach(d: Drip): void {
    const s = this.scale;
    const bulbY = d.root.x + Math.max(d.length.x - d.bulb.x, 0) + this.waveAtPoint(d.x.x);
    const r = Math.max(d.bulb.x, 2 * s);
    const landing = this.core.landing();
    this.core.spawn(d.x.x + d.sway.x, bulbY, r, d.sway.v * 0.3, d.big ? 90 : 40, false, landing);
    this.core.spawn(d.x.x + d.sway.x, bulbY - r * 1.7 - 3 * s, Math.max(r * 0.17, 1.1 * s), d.sway.v * 0.2, 12, true, landing);

    d.length.x = Math.max(d.length.x - r * 2.3, 3 * s);
    d.length.v = -420 * s;
    d.length.set(d.rest.length * 0.4, 170, 11);
    d.bulb.snap(1.6 * s);
    d.bulb.set(d.rest.bulb * 0.7, 26, 9);
    d.neck.set(d.rest.neck, 90, 14);
    d.growth = 0;
    d.big = false;
    d.stage = 'recover';
    d.timer = 0.55;
  }

  /** Clicking lets the drop under the pointer go at once, whatever stage it was in. */
  release(): void {
    if (this.still) return;
    if (this.core.clear) {
      // Cloud does not stretch into a neck. It simply lets go of one bright drop.
      const [x, y, , b] = this.dropGeometry(0);
      this.core.spawn(x, y + b + 18 * this.scale, 5.5 * this.scale, 0, 140, false, this.core.landing());
      this.invalidate();
      return;
    }
    const d = this.drips[0];
    if (d.stage === 'off') this.seedHover();
    this.startStretch(d, true);
    this.kick(d.x.x, 60 * this.scale, 110 * this.scale);
    this.invalidate();
  }

  /** Holding down turns the drip into an unbroken stream to the pool below. */
  beginPour(): void {
    if (this.still || this.core.clear) return;
    const d = this.drips[0];
    if (d.stage === 'off') this.seedHover();
    d.stage = 'pour';
    this.pourLanding = this.core.landing();
    d.neck.set(2.6 * this.scale, 120, 20);
    d.bulb.set(2.8 * this.scale, 200, 26);
    this.invalidate();
  }

  endPour(): void {
    const d = this.drips[0];
    if (d.stage !== 'pour') return;
    const s = this.scale;
    // The stream parts along its length, and each piece falls as its own bead.
    const pieces = 3;
    const top = d.root.x;
    const length = d.length.x;
    for (let i = 1; i <= pieces; i++) {
      const y = top + (length * i) / (pieces + 1);
      this.core.spawn(d.x.x, y, (3.4 + 1.6 * (i % 2)) * s, 0, 260, false, this.pourLanding);
    }
    d.length.x = Math.max(length * 0.12, 8 * s);
    d.length.v = -500 * s;
    d.length.set(d.rest.length, 150, 11);
    d.neck.set(d.rest.neck, 90, 14);
    d.bulb.snap(2 * s);
    d.bulb.set(d.rest.bulb * 0.7, 40, 10);
    d.growth = 0;
    d.stage = 'recover';
    d.timer = 0.5;
    this.invalidate();
  }

  private seedHover(): void {
    const d = this.drips[0];
    const [x, y, , b] = this.dropGeometry(0);
    const s = this.scale;
    d.x.snap(x);
    d.root.snap(y + b - 3 * s);
    d.length.snap(5 * s);
    d.bulb.snap(4 * s);
    d.neck.snap(2.4 * s);
    d.flare = 12 * s;
    d.sway.snap(0);
    d.growth = 0;
    d.stage = 'hang';
  }

  private stepDrips(h: number): void {
    const s = this.scale;
    if (this.flip < 0) {
      for (const d of this.drips) {
        if (d.stage !== 'jet') continue;
        d.timer -= h;
        if (d.timer <= 0 && d.length.to > 0) {
          d.length.set(0, 160, 16);
          d.bulb.set(0, 90, 16);
        }
        if (d.timer <= 0 && d.length.x < 2 * s) d.stage = 'off';
      }
      return;
    }

    const hover = this.drops[0];
    const reach = clamp(hover.reach.x, 0, 1);
    const [hx, hy, ha, hb] = this.dropGeometry(0);

    // Slot 0 hangs from the drop under the pointer.
    const lead = this.drips[0];
    if (reach > 0.72 && lead.stage === 'off') this.seedHover();
    if (lead.stage !== 'off') {
      lead.x.to = hx;
      lead.root.snap(hy + hb - 3 * s);
      lead.rest = { x: hx, length: 15 * s, bulb: 6.5 * s, neck: 1.9 * s, every: 1.25 };
      lead.sway.to = clamp(-hover.x.v * 0.05, -16 * s, 16 * s);
      if (reach < 0.2 && lead.stage === 'hang') {
        lead.length.set(0, 200, 24);
        lead.bulb.set(0, 200, 24);
        if (lead.length.x < 1.5 * s) lead.stage = 'off';
      }
    }

    this.drips.forEach((d, i) => {
      if (d.stage === 'off') return;
      if (i > 0) {
        const edge = this.edgeAt(d.x.x);
        if (edge < 0) return;
        // Rooted exactly on the edge. Any lag and a fast edge leaves the root hanging in the air.
        // If the edge has jumped, a panel has taken this drip over, so it grows in again there.
        if (Math.abs(edge - 3 * s - d.root.x) > 14 * s) d.presence.snap(0);
        d.root.snap(edge - 3 * s);
        const e = (d.x.x - hx) / (ha + 60 * s);
        d.sway.to = clamp(-hover.x.v * 0.035 * reach * Math.exp(-e * e), -12 * s, 12 * s);
      }

      // Drips belong to the storm. Where the sky has cleared they draw back and wait.
      const wet = this.core.dayAt(d.x.x, d.root.x) < 0.5;
      d.presence.to = wet ? 1 : 0;
      if (!wet) return;

      // Reduced motion: every drip stays exactly as it is and nothing lets go.
      if (this.still) return;

      if (d.stage === 'hang') {
        const e = (d.x.x - hx) / (ha + 70 * s);
        const near = i === 0 ? 1 : Math.exp(-e * e) * reach;
        d.growth += (h / d.rest.every) * (1 + near * 4.5);
        const g = Math.min(d.growth, 1);
        const swell = 1 + near * 0.55;
        d.length.to = d.rest.length * (0.5 + 1.15 * g * g) * swell;
        d.bulb.to = d.rest.bulb * (0.68 + 0.52 * g);
        d.neck.to = d.rest.neck * (1 - 0.5 * g * g);
        if (d.growth >= 1) this.startStretch(d, false);
      } else if (d.stage === 'stretch') {
        d.timer -= h;
        if (d.timer <= 0) this.detach(d);
      } else if (d.stage === 'recover') {
        d.timer -= h;
        if (d.timer <= 0) d.stage = 'hang';
      } else if (d.stage === 'pour') {
        const surface = this.core.groundAt(this.pourLanding);
        const span = Math.max(surface - d.root.x + 6 * s, 10 * s);
        d.length.set(span, 90, 15);
        if (d.root.x + d.length.x > surface - 8 * s) this.core.pouring(d.x.x, h, this.pourLanding);
      }
    });
  }

  private stepWave(h: number): void {
    const { x: x0, w } = this.waveSpan;
    if (w <= 0) return;
    const dx = w / (FIELD_WIDTH - 1);
    // An explicit step blows up if a crest can cross more than one cell per step, and a narrow
    // screen has narrow cells. The speed stays under that limit however small the banner gets.
    const celerity = Math.min(this.waveTension * this.scale, (0.8 * dx) / h);
    const c2 = (celerity * celerity) / (dx * dx);
    const u = this.wave;
    const v = this.waveV;

    const hover = this.drops[0];
    const speed = hover.x.v;
    if (Math.abs(speed) > 6 && hover.reach.x > 0.05) {
      const sigma = 104 * this.scale;
      const drive = speed * 0.5 * clamp(hover.reach.x, 0, 1);
      for (let i = 0; i < FIELD_WIDTH; i++) {
        const e = (x0 + i * dx - hover.x.x) / sigma;
        if (Math.abs(e) < 4) v[i] += drive * e * Math.exp(-e * e) * h * 60;
      }
      this.waveLive = true;
    }

    if (!this.waveLive) return;
    const limit = this.waveLimit * this.scale;
    let energy = 0;
    for (let i = 1; i < FIELD_WIDTH - 1; i++) {
      v[i] += (c2 * (u[i - 1] + u[i + 1] - 2 * u[i]) - this.waveGrip * u[i] - this.waveDamping * v[i]) * h;
    }
    for (let i = 1; i < FIELD_WIDTH - 1; i++) {
      u[i] = clamp(u[i] + v[i] * h, -limit, limit);
      energy += Math.abs(u[i]) + Math.abs(v[i]) * 0.05;
    }
    if (energy < 0.08) {
      u.fill(0);
      v.fill(0);
      this.waveLive = false;
    }
  }

  // The mist clears fast where something passes, and creeps back slowly once it has gone.
  private stepFog(h: number): void {
    if (this.fogLevel <= 0) return;
    const { x: x0, w } = this.waveSpan;
    if (w <= 0) return;
    const dx = w / (FIELD_WIDTH - 1);
    const reach = clamp(this.drops[0].reach.x, 0, 1);
    const [hx, , ha] = this.dropGeometry(0);
    const clearing = ha + 18 * this.scale;

    let live = false;
    for (let i = 0; i < FIELD_WIDTH; i++) {
      const x = x0 + i * dx;
      const e = (x - hx) / clearing;
      const wiped = reach > 0.02 ? reach * Math.exp(-e * e) : 0;
      let kept = 0;
      for (const zone of this.fogClear) {
        const a = (x - zone.x) / zone.width;
        kept = Math.max(kept, Math.exp(-a * a));
      }
      const target = (1 - Math.max(wiped, kept)) * this.fogLevel;
      const rate = this.fog[i] > target ? 14 : 0.85;
      const next = this.fog[i] + (target - this.fog[i]) * (1 - Math.exp(-rate * h));
      if (Math.abs(next - this.fog[i]) > 0.00005) live = true;
      this.fog[i] = next;
    }
    this.fogLive = live;
  }

  get moving(): boolean {
    return this.waveLive || this.fogLive || this.drips.some((d) => d.stage !== 'off' && d.stage !== 'hang');
  }
}

export class PendantEngine {
  readonly ok: boolean = false;
  readonly top: Layer;
  readonly bottom: Layer;
  readonly poolFill = new Spring(0, 14, 7, 0.01);
  /** How high the water stands, in pixels from the foot of the banner. */
  readonly level = new Spring(0, 46, 13, 0.05);

  onFrame: (() => void) | null = null;
  /** Called every frame with where the drop holding the other weather is. */
  onOrb: ((x: number, y: number, radius: number, shown: boolean) => void) | null = null;
  /** Reduced motion: no rain falling, no lightning, and frames draw only when something changes. */
  still = false;
  /** Whether the weather has turned, or is turning, to clear. */
  clear = false;
  /** False when the host has switched the drop off. */
  orbEnabled = true;

  scale = 1;
  spectral = 0.008;
  shoulder = 44;
  merge = 40;
  /** Water height when empty, and how much drips can add to it, in pixels. */
  poolBase = 0;
  poolMax = 0;
  /** Nothing lands below this height. A tab bar at the foot of a phone covers the near water. */
  waterFloor = 0;

  private readonly springs: Spring[];
  private beads: Bead[] = [];
  private rings: Ring[] = [];
  private seed = 7;
  private gl: WebGL2RenderingContext | null = null;
  private loc: Record<string, WebGLUniformLocation | null> = {};
  private program: WebGLProgram | null = null;
  private waterProgram: WebGLProgram | null = null;
  private waterLoc: Record<string, WebGLUniformLocation | null> = {};
  private field: WebGLTexture | null = null;
  private readonly fieldData = new Float32Array(FIELD_WIDTH * FIELD_ROWS);
  private raf = 0;
  private ticking = false;
  private again = false;
  private last = 0;
  private bank = 0;
  private time = 0;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private dprCap = 2;
  private pace = 1 / 60;
  private slowFor = 0;
  private firstSlowPace = 0;
  private heldDown = false;
  private settling = 2.5;
  private fastFor = 0;
  private climbs = 2;
  private surface: Rgb = [0.003, 0.003, 0.0035];
  private light: Rgb = [1, 0.99, 0.97];
  private actionColour: Rgb = [0.86, 0.85, 0.82];
  private sky: Rgb = [0.0011, 0.0013, 0.0018];
  private glow: Rgb = [0.5, 0.56, 0.68];

  private zenith: Rgb = [0.14, 0.34, 0.7];
  private haze: Rgb = [0.74, 0.85, 0.92];
  private cloud: Rgb = [1, 0.99, 0.97];
  private cloudShade: Rgb = [0.5, 0.6, 0.76];
  private deep: Rgb = [0.05, 0.2, 0.34];
  private actionDay: Rgb = [0.01, 0.012, 0.02];
  private puff: WebGLTexture | null = null;

  private readonly front: FrontState & { t: number; max: number } = { on: false, x: 0, y: 0, r: 0, soft: 180, amp: 130, base: 0, t: 0, max: 1 };
  private readonly orb = {
    state: 'hang' as 'hang' | 'fall' | 'gone',
    x: 0,
    y: 0,
    vy: 0,
    b: 0,
    wait: 0,
    /** Which weather the drop holds: 1 clear, 0 storm. */
    kind: 1,
    size: new Spring(0, 90, 10, 0.002),
    hover: new Spring(0, 280, 22, 0.002),
    press: new Spring(0, 520, 32, 0.002),
  };
  private pendingWeather: PendantWeather | null = null;
  private glimmerAt = -9;

  private readonly canvas: HTMLCanvasElement;
  private readonly weather: Weather | null;
  private readonly boltCanvas: HTMLCanvasElement | null;

  private flash = 0;
  private strikeAt = -1;
  private flashX = 0.5;
  private nextStrike = 7.5;
  private rainClock = 0;
  private visible = true;

  private readonly lost = (event: Event): void => {
    event.preventDefault();
    this.stop();
  };
  private readonly restored = (): void => {
    this.setup();
    this.invalidate();
  };
  private readonly onVisibility = (): void => {
    this.visible = document.visibilityState === 'visible';
    if (this.visible) this.invalidate();
    else this.stop();
  };

  constructor(canvas: HTMLCanvasElement, weatherCanvas: HTMLCanvasElement | null, boltCanvas: HTMLCanvasElement | null) {
    this.canvas = canvas;
    this.top = new Layer(this, 1);
    this.bottom = new Layer(this, -1);
    this.bottom.waveTension = 520;
    this.bottom.waveDamping = 1.7;
    this.bottom.waveGrip = 7;
    this.bottom.waveLimit = 26;
    this.springs = [...this.top.springs, ...this.bottom.springs, this.poolFill, this.level, this.orb.size, this.orb.hover, this.orb.press];
    this.ok = this.setup();
    this.weather = weatherCanvas ? new Weather(weatherCanvas) : null;
    this.boltCanvas = boltCanvas;
    if (this.ok) {
      canvas.addEventListener('webglcontextlost', this.lost);
      canvas.addEventListener('webglcontextrestored', this.restored);
      document.addEventListener('visibilitychange', this.onVisibility);
    }
  }

  private setup(): boolean {
    const gl = this.canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
    });
    if (!gl) return false;

    const compile = (type: number, source: string): WebGLShader | null => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.warn('pendant: shader failed to compile', gl.getShaderInfoLog(shader));
        return null;
      }
      return shader;
    };

    const vertex = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
    if (!vertex) return false;
    const build = (source: string): WebGLProgram | null => {
      const fragment = compile(gl.FRAGMENT_SHADER, source);
      const built = gl.createProgram();
      if (!fragment || !built) return null;
      gl.attachShader(built, vertex);
      gl.attachShader(built, fragment);
      gl.linkProgram(built);
      if (!gl.getProgramParameter(built, gl.LINK_STATUS)) {
        console.warn('pendant: program failed to link', gl.getProgramInfoLog(built));
        return null;
      }
      return built;
    };
    const program = build(FRAGMENT_SHADER);
    const water = build(WATER_SHADER);
    if (!program || !water) return false;

    this.waterLoc = Object.fromEntries(
      ['uView', 'uDpr', 'uScale', 'uLevel', 'uGap', 'uFocal', 'uTime', 'uFlash', 'uFlashX', 'uSky', 'uGlow', 'uLight', 'uAction', 'uSurface', 'uRing', 'uLamp', 'uMirror', 'uZenith', 'uHaze', 'uDeep', 'uCloud', 'uSunX', 'uGlimmer', 'uFront', 'uFrontEdge', 'uDayBase'].map((n) => [
        n,
        gl.getUniformLocation(water, n),
      ]),
    );
    this.waterProgram = water;

    gl.useProgram(program);
    gl.bindVertexArray(gl.createVertexArray());
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);

    this.field = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.field);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, FIELD_WIDTH, FIELD_ROWS, 0, gl.RED, gl.FLOAT, this.fieldData);

    this.puff = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.puff);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, PUFF_SIZE, PUFF_SIZE, 0, gl.RGBA, gl.FLOAT, puffTile());
    gl.activeTexture(gl.TEXTURE0);

    const names = [
      'uView', 'uDpr', 'uScale', 'uFlip', 'uMass', 'uMassOn', 'uDrop', 'uDrip', 'uDripB', 'uBead',
      'uField', 'uRow', 'uWaveSpan', 'uFog', 'uMerge', 'uShoulder', 'uAct', 'uActInfo', 'uTilt',
      'uGlow', 'uGlowH', 'uSurface', 'uLight', 'uAction', 'uSpec', 'uShadow', 'uFlash', 'uTime',
      'uPuff', 'uCloud', 'uCloudShade', 'uZenith', 'uHaze', 'uActionDay', 'uOrb', 'uOrbB', 'uFront', 'uFrontEdge', 'uDayBase',
    ];
    this.loc = Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(program, n)]));
    gl.uniform1i(this.loc.uField, 0);
    gl.uniform1i(this.loc.uPuff, 1);
    this.gl = gl;
    this.program = program;
    return true;
  }

  /** Takes colours from CSS custom properties, so a host's tokens re-light the surface. */
  setTheme(surface: string, light: string, action: string, sky: string, glow: string): void {
    const probeCanvas = document.createElement('canvas');
    probeCanvas.width = probeCanvas.height = 1;
    const probe = probeCanvas.getContext('2d', { willReadFrequently: true });
    if (!probe) return;
    this.surface = readColour(probe, surface, this.surface);
    this.light = readColour(probe, light, this.light);
    this.actionColour = readColour(probe, action, this.actionColour);
    this.sky = readColour(probe, sky, this.sky);
    this.glow = readColour(probe, glow, this.glow);
    this.weather?.setColours(this.sky, this.glow);
    this.invalidate();
  }

  /** The same for the clear weather. Each is any CSS colour. */
  setDayTheme(zenith: string, haze: string, cloud: string, shade: string, deep: string, action: string): void {
    const probeCanvas = document.createElement('canvas');
    probeCanvas.width = probeCanvas.height = 1;
    const probe = probeCanvas.getContext('2d', { willReadFrequently: true });
    if (!probe) return;
    this.zenith = readColour(probe, zenith, this.zenith);
    this.haze = readColour(probe, haze, this.haze);
    this.cloud = readColour(probe, cloud, this.cloud);
    this.cloudShade = readColour(probe, shade, this.cloudShade);
    this.deep = readColour(probe, deep, this.deep);
    this.actionDay = readColour(probe, action, this.actionDay);
    this.weather?.setDayColours(this.zenith, this.haze, this.cloud, this.cloudShade);
    this.invalidate();
  }

  /** How far the weather has turned at a point on the banner: 0 storm, 1 clear. */
  dayAt(x: number, y: number): number {
    const f = this.front;
    if (!f.on) return f.base;
    const dx = x - f.x;
    const dy = (y - f.y) * (y > f.y ? FRONT_SQUASH : 1);
    const t = clamp((Math.hypot(dx, dy) - (f.r - f.soft)) / f.soft, 0, 1);
    const k = 1 - t * t * (3 - 2 * t);
    return f.base + (1 - 2 * f.base) * k;
  }

  /** The drop can only be pressed while it is hanging there. */
  get orbReady(): boolean {
    return this.orb.state === 'hang' && this.pendingWeather === null;
  }

  orbHover(on: boolean): void {
    this.orb.hover.to = on ? 1 : 0;
    this.invalidate();
  }

  orbPress(down: boolean): void {
    if (this.still) return;
    const p = this.orb.press;
    if (down) p.set(1, 520, 32);
    else p.set(0, 240, 12);
    this.invalidate();
  }

  /** Changes the weather. The drop lets go and the new weather spreads from where it lands. */
  setWeather(next: PendantWeather, jump = false): void {
    const clear = next === 'clear';
    const f = this.front;
    const o = this.orb;
    if (jump || this.still) {
      this.clear = clear;
      this.pendingWeather = null;
      f.on = false;
      f.r = 0;
      f.base = clear ? 1 : 0;
      o.state = 'hang';
      o.kind = clear ? 0 : 1;
      o.size.snap(this.orbEnabled ? 1 : 0);
      this.invalidate();
      return;
    }
    if (o.state !== 'hang') {
      this.pendingWeather = next;
      return;
    }
    this.pendingWeather = null;
    if (clear === this.clear) return;
    this.clear = clear;
    o.kind = clear ? 1 : 0;
    o.state = 'fall';
    o.vy = 180 * this.scale;
    o.b = this.landing();
    o.size.snap(Math.max(o.size.x, 1));
    this.orbHoverOff();
    this.invalidate();
  }

  private orbHoverOff(): void {
    this.orb.hover.to = 0;
    this.orb.press.set(0, 240, 12);
  }

  private orbRadius(): number {
    const o = this.orb;
    return ORB_RADIUS * this.scale * clamp(o.size.x, 0, 1.2) * (1 + 0.1 * clamp(o.hover.x, 0, 1.2));
  }

  private landOrb(): void {
    const o = this.orb;
    const f = this.front;
    const s = this.scale;
    const ground = this.groundAt(o.b);
    this.ring(o.x, o.b, 1);
    this.crown(o.x, ground, 15 * s, o.b);
    this.fill(14 * s);

    const H = this.height;
    const W = this.width;
    f.soft = 0.17 * H;
    f.amp = 0.14 * H;
    const reach = Math.max(Math.hypot(o.x, ground), Math.hypot(W - o.x, ground), Math.hypot(o.x, (H - ground) * FRONT_SQUASH), Math.hypot(W - o.x, (H - ground) * FRONT_SQUASH));
    f.max = reach + f.soft + f.amp;
    f.x = o.x;
    f.y = ground;
    f.r = 0;
    f.t = 0;
    f.base = this.clear ? 0 : 1;
    f.on = true;
    o.state = 'gone';
    o.wait = FRONT_TIME * 0.8;
  }

  private stepOrb(h: number): void {
    const o = this.orb;
    const a = this.top.action;
    const s = this.scale;
    const attached = a.on.x > 0.5;
    if (o.state === 'hang') {
      o.x = attached ? a.cx.x : this.width - 64 * s;
      const r = this.orbRadius();
      // A panel opening beneath the button takes the drop back in until it closes again.
      const panel = this.top.masses[2];
      const blocked = panel.on.to > 0.5 && Math.abs(o.x - panel.cx.to) < panel.hw.to + ORB_RADIUS * 2 * s;
      o.size.to = this.orbEnabled && !blocked ? 1 : 0;
      const root = attached ? a.cy.x + a.hh.x : 0;
      o.y = root + (ORB_NECK + 7 * clamp(o.press.x, -0.5, 1.2)) * s * clamp(o.size.x, 0, 1) + r;
    } else if (o.state === 'fall') {
      o.vy += 2100 * s * h;
      o.y += o.vy * h;
      if (o.y >= this.groundAt(o.b)) this.landOrb();
    } else {
      o.wait -= h;
      if (o.wait <= 0) {
        o.state = 'hang';
        o.kind = this.clear ? 0 : 1;
        o.size.snap(0);
        o.size.to = 1;
        const pending = this.pendingWeather;
        this.pendingWeather = null;
        if (pending) this.setWeather(pending);
      }
    }

    const f = this.front;
    if (f.on) {
      f.t += h;
      const u = Math.min(f.t / FRONT_TIME, 1);
      f.r = f.max * (1 - Math.pow(1 - u, 2.2));
      if (u >= 1) {
        f.on = false;
        f.r = 0;
        f.base = this.clear ? 1 : 0;
      }
    }
  }

  resize(width: number, height: number): void {
    const dpr = Math.min(window.devicePixelRatio || 1, this.dprCap);
    const w = Math.round(width * dpr);
    const h = Math.round(height * dpr);
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this.gl?.viewport(0, 0, w, h);
    this.weather?.resize(width, height);
    this.invalidate();
  }

  /** The screen height of the far edge of the water. */
  poolSurface(): number {
    return this.height - this.level.x;
  }

  /** The screen height of a spot on the water, given how far in front of the far edge it is. */
  groundAt(b: number): number {
    return this.height - this.level.x + b;
  }

  /** Picks where something falling right now comes down on the open water. */
  landing(): number {
    return Math.max(this.level.x - this.waterFloor, 0) * this.random(0.3, 0.86);
  }

  private random(low: number, high: number): number {
    this.seed = (this.seed * 16807) % 2147483647;
    return low + ((this.seed - 1) / 2147483646) * (high - low);
  }

  spawn(x: number, y: number, size: number, vx: number, vy: number, crown: boolean, b: number): void {
    this.beads.push({ x, y, size, vx: vx * this.scale, vy: vy * this.scale, age: 0, crown, b });
    if (this.beads.length > BEAD_COUNT) this.beads.shift();
    this.invalidate();
  }

  private ring(x: number, b: number, amp: number): void {
    this.rings.push({ x, b: Math.max(b, 1), age: 0, amp });
    if (this.rings.length > RING_COUNT) {
      const light = this.rings.findIndex((r) => r.amp < 0.3);
      this.rings.splice(light >= 0 ? light : 0, 1);
    }
  }

  /** Droplets thrown up from a point, and the jet that rises where the drop went in. */
  private crown(x: number, y: number, r: number, b: number): void {
    const s = this.scale;
    const count = Math.round(2 + (r / s) * 0.42);
    for (let i = 0; i < count; i++) {
      const a = (i / (count - 1 || 1) - 0.5) * 1.5 + this.random(-0.12, 0.12);
      const v = this.random(170, 330) * (0.6 + (r / s) * 0.06);
      this.spawn(x + a * r, y - 2 * s, this.random(1.2, 2.6) * s, Math.sin(a) * v, -Math.cos(a) * v, true, b);
    }
    this.bottom.jet(x, this.height - y, (16 + (r / s) * 3.6) * s, Math.max(r * 0.46, 3 * s));
  }

  /** A bead reaching the water: rings, a crown of droplets, a jet, and a little more water. */
  private impact(bead: Bead): void {
    const s = this.scale;
    const r = bead.size;
    if (bead.crown) {
      this.ring(bead.x, bead.b, 0.16);
      return;
    }
    this.ring(bead.x, bead.b, clamp(r / (8 * s), 0.34, 1));
    if (r > 4 * s) this.crown(bead.x, this.groundAt(bead.b), r, bead.b);
    this.fill((r * r * 0.085) / s);
  }

  fill(amount: number): void {
    if (this.poolMax <= 0) return;
    this.poolFill.to = Math.min(this.poolFill.to + amount, this.poolMax);
  }

  /** Touching the open water drops a stone in it. */
  splashAt(x: number, y: number, size: number): void {
    if (this.still) return;
    this.impact({ x, y, vx: 0, vy: 0, size, age: 0, crown: false, b: Math.max(y - this.poolSurface(), 2) });
    this.invalidate();
  }

  /** Pressing a tab throws up the edge of the bar it sits in, without adding any water. */
  splashEdge(x: number, size: number): void {
    if (this.still) return;
    const s = this.scale;
    const edge = this.bottom.edgeAt(x);
    this.bottom.kick(x, -(size / s) * 62 * s, Math.max(size * 2.2, 16 * s));
    this.crown(x, this.height - edge, size, this.level.x - edge);
    this.invalidate();
  }

  private wakeAt = { x: 0, t: -1 };
  /** A pointer moving over the water trails small rings behind it. */
  wake(x: number, y: number): void {
    if (this.still) return;
    const b = y - this.poolSurface();
    if (b < 0 || this.height - y < this.waterFloor) return;
    if (this.time - this.wakeAt.t < 0.075 || Math.abs(x - this.wakeAt.x) < 10 * this.scale) return;
    this.wakeAt = { x, t: this.time };
    this.ring(x, b, 0.24);
    this.invalidate();
  }

  private pourClock = 0;
  pouring(x: number, h: number, b: number): void {
    this.pourClock -= h;
    this.poolFill.to = Math.min(this.poolFill.to + 26 * h * this.scale, this.poolMax);
    if (this.pourClock <= 0) {
      this.pourClock = 0.09;
      this.ring(x, b, 0.5);
      this.spawn(x + this.random(-5, 5), this.groundAt(b) - 2, this.random(1.2, 2.2) * this.scale, this.random(-140, 140), this.random(-260, -130), true, b);
    }
  }

  /** A strike: the storm lights up, the bar flares, and the bolt lands in the water. */
  strike(): void {
    if (this.still) return;
    if (this.clear || this.front.on || this.front.base === 1) {
      // In clear weather the same press runs a flare of sunlight along the water.
      this.glimmerAt = this.time;
      this.invalidate();
      return;
    }
    this.strikeAt = this.time;
    this.flashX = this.random(0.14, 0.86);
    const x = this.flashX * this.width;
    const ground = this.poolSurface();
    if (this.boltCanvas) drawBolt(this.boltCanvas, this.width, this.height, x, ground, () => this.random(0, 1));
    const b = 6 * this.scale;
    this.ring(x, b, 1);
    for (let i = 0; i < 5; i++) {
      this.spawn(x + this.random(-22, 22), ground + b - 2, this.random(1.2, 2.6) * this.scale, this.random(-220, 220), this.random(-420, -200), true, b);
    }
    this.invalidate();
  }

  private stepBeads(h: number): void {
    if (this.beads.length === 0) return;
    const gravity = 2100 * this.scale;
    const survivors: Bead[] = [];
    for (const bead of this.beads) {
      // Liquid falling into liquid is simply absorbed.
      if (this.top.depthInside(bead.x, bead.y) > 2 * this.scale || bead.y < this.top.edgeAt(bead.x) - 2 * this.scale) continue;
      bead.age += h;
      bead.vy += gravity * h;
      bead.x += bead.vx * h;
      bead.y += bead.vy * h;
      // A sheet or tab bar standing in the way catches the drop before it reaches open water.
      const edge = this.bottom.edgeAt(bead.x);
      const onForm = edge > 0 && this.height - edge < this.groundAt(bead.b);
      const ground = onForm ? this.height - edge : this.groundAt(bead.b);
      if (bead.vy > 0 && bead.y + bead.size * 0.5 >= ground) {
        if (!onForm) this.impact(bead);
        else if (bead.crown) this.bottom.kick(bead.x, 20 * this.scale, 24 * this.scale);
        else this.splashEdge(bead.x, bead.size);
      } else if (bead.y - bead.size < this.height + 40) survivors.push(bead);
    }
    this.beads = survivors;
  }

  private stepWorld(h: number): void {
    this.time += h;

    // A bar sitting in the water at the foot of a phone is rained on too.
    if (this.waterFloor > 0 && !this.still && !this.clear) {
      this.rainClock -= h;
      while (this.rainClock <= 0) {
        this.rainClock += 0.03;
        const x = this.random(0, this.width);
        this.bottom.kick(x, this.random(-9, 4) * this.scale, this.random(5, 12) * this.scale);
      }
    }

    for (const ring of this.rings) ring.age += h;
    if (this.rings.length > 0 && this.rings[0].age > 3.4) this.rings = this.rings.filter((r) => r.age <= 3.4);

    // Water seeps away slowly, so drips always have somewhere to go and the level settles.
    this.poolFill.to = Math.max(this.poolFill.to * (1 - 0.024 * h), 0);
    this.level.to = this.poolBase + this.poolFill.x;

    if (!this.still && this.time >= this.nextStrike) {
      // Only a sky that is fully storm can strike. The drop may already be on its way down.
      if (!this.clear && !this.front.on && this.front.base === 0) this.strike();
      this.nextStrike = this.time + this.random(8, 17);
    }

    const age = this.strikeAt < 0 ? 99 : this.time - this.strikeAt;
    const first = age >= 0 ? Math.exp(-age / 0.075) : 0;
    const second = age >= 0.17 ? 0.72 * Math.exp(-(age - 0.17) / 0.11) : 0;
    const last = age >= 0.36 ? 0.3 * Math.exp(-(age - 0.36) / 0.3) : 0;
    this.flash = clamp(Math.max(first, second, last), 0, 1);
  }

  adopt(springs: Spring[]): () => void {
    this.springs.push(...springs);
    return () => {
      for (const spring of springs) {
        const index = this.springs.indexOf(spring);
        if (index >= 0) this.springs.splice(index, 1);
      }
    };
  }

  invalidate(): void {
    if (!this.gl || !this.visible) return;
    // Asked for from inside a frame, this waits for that frame to end. Scheduling here would
    // start a second loop alongside the first, and every drop that landed would add another.
    if (this.ticking) {
      this.again = true;
      return;
    }
    if (this.raf) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  private stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private readonly tick = (now: number): void => {
    this.raf = 0;
    this.ticking = true;
    this.again = false;
    const elapsed = Math.min(Math.max(now - this.last, 0) / 1000, 1 / 20);
    this.bank += elapsed;
    this.last = now;

    // A machine that cannot keep up draws fewer pixels rather than fewer frames. An average is
    // used because a screen that is only just coping alternates between fast and slow frames.
    this.govern(elapsed);

    // Fixed steps: the same inputs always give the same motion, however the frames fall.
    while (this.bank >= STEP) {
      for (const spring of this.springs) spring.step(STEP);
      this.top.step(STEP);
      this.bottom.step(STEP);
      this.stepBeads(STEP);
      this.stepWorld(STEP);
      this.stepOrb(STEP);
      this.bank -= STEP;
    }

    this.onFrame?.();
    this.onOrb?.(this.orb.x, this.orb.y, ORB_RADIUS * this.scale, this.orb.state === 'hang' && this.orb.size.to > 0.5);
    this.draw();

    this.ticking = false;
    const moving = !this.still || this.front.on || this.orb.state !== 'hang' || this.beads.length > 0 || this.top.moving || this.bottom.moving || this.springs.some((s) => !s.done);
    if (moving || this.again) this.raf = requestAnimationFrame(this.tick);
  };

  /** Decides how sharply to draw. Only a slowdown that lasts counts, and it can be taken back. */
  private govern(elapsed: number): void {
    // The first moments are shader compiling and a page still loading. They say nothing about
    // what this machine can hold.
    if (this.settling > 0) {
      this.settling -= elapsed;
      return;
    }
    this.pace += (elapsed - this.pace) * 0.06;
    this.slowFor = this.pace > 1 / 52 ? this.slowFor + elapsed : 0;
    this.fastFor = this.pace < 1 / 57 ? this.fastFor + elapsed : 0;
    if (this.heldDown) return;

    if (this.slowFor > 1.2) {
      if (this.dprCap > 1) {
        if (this.firstSlowPace === 0) this.firstSlowPace = this.pace;
        this.dprCap = Math.max(this.dprCap - 0.5, 1);
        this.retune();
      } else if (this.pace > this.firstSlowPace * 0.9) {
        // Far fewer pixels changed nothing, so something outside is holding the frame rate down:
        // Low Power Mode on a Mac caps it at 30. Blurring the picture cannot help, so it goes back.
        this.heldDown = true;
        this.dprCap = 2;
        this.retune();
      } else {
        // As low as it goes and it did help, so there is nothing more to change for now.
        this.slowFor = 0;
      }
    } else if (this.fastFor > 9 && this.dprCap < 2 && this.climbs > 0) {
      // A stall from something else has passed. Try for the sharper picture again, but not forever.
      this.climbs -= 1;
      this.dprCap = Math.min(this.dprCap + 0.5, 2);
      this.retune();
    }
  }

  private retune(): void {
    this.slowFor = 0;
    this.fastFor = 0;
    this.pace = 1 / 60;
    this.resize(this.width, this.height);
  }

  private uploadFields(): void {
    const gl = this.gl;
    if (!gl) return;
    const data = this.fieldData;
    data.set(this.top.wave, 0);
    data.set(this.top.fog, FIELD_WIDTH);
    data.set(this.bottom.wave, FIELD_WIDTH * 2);
    data.set(this.bottom.fog, FIELD_WIDTH * 3);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, FIELD_WIDTH, FIELD_ROWS, gl.RED, gl.FLOAT, data);
  }

  private drawLayer(layer: Layer, row: number, beads: Float32Array, boxes: Box[]): void {
    const gl = this.gl;
    if (!gl) return;
    const s = this.scale;
    const l = this.loc;

    gl.uniform1f(l.uFlip, layer.flip);
    gl.uniform1i(l.uRow, row);

    const masses = new Float32Array(MASS_COUNT * 4);
    const on = new Float32Array(MASS_COUNT);
    layer.masses.forEach((m, i) => {
      masses.set([m.cx.x, Math.max(m.hw.x, 0.5), Math.max(m.depth.x, 0), Math.max(m.r.x, 0.5)], i * 4);
      on[i] = m.on.x;
    });
    gl.uniform4fv(l.uMass, masses);
    gl.uniform1fv(l.uMassOn, on);

    const drops = new Float32Array(DROP_COUNT * 4);
    layer.drops.forEach((_, i) => drops.set(layer.dropGeometry(i), i * 4));
    gl.uniform4fv(l.uDrop, drops);

    const drips = new Float32Array(DRIP_COUNT * 4);
    const dripsB = new Float32Array(DRIP_COUNT * 4);
    layer.drips.forEach((d, i) => {
      // A drip swallowed by a panel opening over it, or pressed against its side, is not there.
      const buried = clamp((layer.depthInside(d.x.x, d.root.x + d.length.x, 26 * s) - 2 * s) / (8 * s), 0, 1);
      const shown = d.stage !== 'off' && d.length.x > 0.6 ? (1 - buried) * clamp(d.presence.x, 0, 1) : 0;
      drips.set([d.x.x, d.root.x, Math.max(d.length.x, 0.5), Math.max(d.bulb.x, 0.3)], i * 4);
      dripsB.set([Math.max(d.neck.x, 0.3), d.flare, d.sway.x, shown], i * 4);
    });
    gl.uniform4fv(l.uDrip, drips);
    gl.uniform4fv(l.uDripB, dripsB);
    gl.uniform4fv(l.uBead, beads);

    const depth = Math.max(layer.masses[0].depth.x, 1);
    gl.uniform3f(l.uWaveSpan, layer.waveSpan.x, layer.waveSpan.w, depth);
    gl.uniform1f(l.uFog, layer.fogLevel);
    gl.uniform1f(l.uMerge, this.merge * s);
    gl.uniform1f(l.uShoulder, this.shoulder * s);

    const a = layer.action;
    gl.uniform4f(l.uAct, a.cx.x, a.cy.x, Math.max(a.hw.x, 0.5), Math.max(a.hh.x, 0.5));
    gl.uniform3f(l.uActInfo, Math.max(a.r.x, 0), a.on.x, layer.actionAttached ? 1 : 0);
    gl.uniform2f(l.uTilt, layer.tiltX.x, layer.tiltY.x);
    gl.uniform4f(l.uGlow, layer.glowX.x, layer.glowY.x, Math.max(layer.glowW.x, 1), Math.max(layer.glowGain.x, 0));
    gl.uniform1f(l.uGlowH, layer.glowHalfHeight);
    gl.uniform1f(l.uShadow, layer.flip > 0 ? 0.42 : 0);

    const orb = this.orb;
    if (layer === this.top && orb.size.x > 0.01) {
      gl.uniform4f(l.uOrb, orb.x, orb.y, this.orbRadius(), 1);
      gl.uniform4f(l.uOrbB, layer.action.on.x > 0.5 ? layer.action.cy.x + layer.action.hh.x : 0, orb.state === 'hang' ? clamp(orb.size.x, 0, 1) : 0, orb.kind, clamp(orb.hover.x, 0, 1));
    } else {
      gl.uniform4f(l.uOrb, 0, 0, 0, 0);
      gl.uniform4f(l.uOrbB, 0, 0, 0, 0);
    }

    for (const [x0, y0, x1, y1] of boxes) {
      gl.scissor(Math.max(0, x0), Math.max(0, y0), Math.max(0, x1 - x0), Math.max(0, y1 - y0));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  private draw(): void {
    const glimmer = this.time - this.glimmerAt < 3 ? Math.min((this.time - this.glimmerAt) / 0.08, 1) * Math.exp(-(this.time - this.glimmerAt) / 0.55) : 0;
    this.weather?.draw(this.still ? 3.4 : this.time, this.flash, this.flashX, this.poolLevelNormal(), this.front, SUN, glimmer);
    if (this.boltCanvas) this.boltCanvas.style.opacity = this.flash > 0.02 ? String(Math.min(this.flash * 1.3, 1)) : '0';

    const gl = this.gl;
    if (!gl) return;

    gl.disable(gl.SCISSOR_TEST);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.SCISSOR_TEST);
    this.uploadFields();

    const s = this.scale;
    const l = this.loc;
    gl.uniform2f(l.uView, this.width, this.height);
    gl.uniform1f(l.uDpr, this.dpr);
    gl.uniform1f(l.uScale, s);
    gl.uniform3fv(l.uSurface, this.surface);
    gl.uniform3fv(l.uLight, this.light);
    gl.uniform3fv(l.uAction, this.actionColour);
    gl.uniform1f(l.uSpec, this.spectral);
    gl.uniform1f(l.uFlash, this.flash);
    gl.uniform1f(l.uTime, this.still ? 3.4 : this.time);
    gl.uniform3fv(l.uCloud, this.cloud);
    gl.uniform3fv(l.uCloudShade, this.cloudShade);
    gl.uniform3fv(l.uZenith, this.zenith);
    gl.uniform3fv(l.uHaze, this.haze);
    gl.uniform3fv(l.uActionDay, this.actionDay);
    this.sendFront(l);

    const H = this.height * this.dpr;

    // The water first, then anything standing in it, so a bead can be seen arriving.
    this.drawWater(glimmer);
    const noBeads = new Float32Array(BEAD_COUNT * 4);
    const poolTop = this.bottom.masses.reduce((y, m) => (m.on.x > 0.001 ? Math.max(y, m.depth.x) : y), 0);
    const W = Math.ceil(this.width * this.dpr);
    const jets = this.bottom.drips.filter((d) => d.stage === 'jet');
    const lowBoxes: Box[] = [];
    if (poolTop > 0) {
      const tips = jets.map((d) => d.root.x + d.length.x + d.bulb.x);
      const deepest = Math.max(poolTop, ...tips, ...this.bottom.drops.map((_, i) => { const [, y, , b] = this.bottom.dropGeometry(i); return y + b; }));
      lowBoxes.push([0, 0, W, Math.min(Math.ceil((deepest + 90 * s) * this.dpr), H)]);
    } else {
      // On open water a jet stands alone, so only its own small patch is worth drawing.
      for (const d of jets) {
        lowBoxes.push([
          Math.floor((d.x.x - 70 * s) * this.dpr),
          Math.floor((d.root.x - 12 * s) * this.dpr),
          Math.ceil((d.x.x + 70 * s) * this.dpr),
          Math.ceil((d.root.x + d.length.x + d.bulb.x + 24 * s) * this.dpr),
        ]);
      }
    }
    if (lowBoxes.length > 0) this.drawLayer(this.bottom, 2, noBeads, lowBoxes);

    // Then the forms hanging from the top, with their drips and everything falling from them.
    const beads = new Float32Array(BEAD_COUNT * 4);
    const boxes: Box[] = [];
    let low = 0;
    for (const m of this.top.masses) if (m.on.x > 0.001) low = Math.max(low, m.depth.x);
    this.top.drops.forEach((_, i) => {
      const [, y, , b] = this.top.dropGeometry(i);
      low = Math.max(low, y + b);
    });
    for (const d of this.top.drips) if (d.stage !== 'off') low = Math.max(low, d.root.x + d.length.x + d.bulb.x);
    const a = this.top.action;
    if (a.on.x > 0.001) low = Math.max(low, a.cy.x + a.hh.x);
    const orb = this.orb;
    if (orb.state === 'hang' && orb.size.x > 0.01) low = Math.max(low, orb.y + this.orbRadius());
    const margin = 70 * s;
    const mainBottom = Math.max(0, Math.floor(H - (low + margin) * this.dpr));
    boxes.push([0, mainBottom, W, H]);

    this.beads.slice(-BEAD_COUNT).forEach((bead, i) => {
      const grow = Math.min(bead.age / 0.03, 1);
      const wobble = Math.exp(-bead.age * 6) * Math.cos(bead.age * 26) * 0.1 + Math.min(Math.abs(bead.vy) / (12000 * s), 0.12);
      const r = bead.size * grow;
      beads.set([bead.x, bead.y, r, wobble], i * 4);
      if (bead.y + r * 2 + 4 > low + margin) {
        const y0 = Math.max(0, Math.floor(H - (bead.y + r * 2 + 6) * this.dpr));
        const y1 = Math.min(H, Math.ceil(H - (bead.y - r * 2 - 6) * this.dpr));
        const x0 = Math.floor((bead.x - r * 2 - 6) * this.dpr);
        const x1 = Math.ceil((bead.x + r * 2 + 6) * this.dpr);
        if (y1 > y0 && y0 < mainBottom) boxes.push([x0, y0, x1, Math.min(y1, mainBottom)]);
      }
    });
    if (orb.state === 'fall') {
      const r = this.orbRadius() * 1.2 + 4;
      boxes.push([Math.floor((orb.x - r) * this.dpr), Math.max(0, Math.floor(H - (orb.y + r) * this.dpr)), Math.ceil((orb.x + r) * this.dpr), Math.min(H, Math.ceil(H - (orb.y - r) * this.dpr))]);
    }
    this.drawLayer(this.top, 0, beads, boxes);
  }

  private sendFront(l: Record<string, WebGLUniformLocation | null>): void {
    const gl = this.gl;
    if (!gl) return;
    const f = this.front;
    gl.uniform4f(l.uFront, f.x, f.y, f.on ? Math.max(f.r, 0.001) : 0, 0);
    gl.uniform2f(l.uFrontEdge, Math.max(f.soft, 1), f.amp);
    gl.uniform1f(l.uDayBase, f.base);
  }

  private drawWater(glimmer: number): void {
    const gl = this.gl;
    if (!gl || !this.waterProgram) return;
    const level = this.level.x;
    if (level < 1) return;
    const l = this.waterLoc;
    const s = this.scale;
    const gap = 0.045 * this.height;
    const focal = 0.62 * this.height;

    gl.useProgram(this.waterProgram);
    gl.uniform2f(l.uView, this.width, this.height);
    gl.uniform1f(l.uDpr, this.dpr);
    gl.uniform1f(l.uScale, s);
    gl.uniform1f(l.uLevel, level);
    gl.uniform1f(l.uGap, gap);
    gl.uniform1f(l.uFocal, focal);
    gl.uniform1f(l.uTime, this.still ? 3.4 : this.time);
    gl.uniform1f(l.uFlash, this.flash);
    gl.uniform1f(l.uFlashX, this.flashX);
    gl.uniform3fv(l.uSky, this.sky);
    gl.uniform3fv(l.uGlow, this.glow);
    gl.uniform3fv(l.uLight, this.light);
    gl.uniform3fv(l.uAction, this.actionColour);
    gl.uniform3fv(l.uSurface, this.surface);
    gl.uniform3fv(l.uZenith, this.zenith);
    gl.uniform3fv(l.uHaze, this.haze);
    gl.uniform3fv(l.uDeep, this.deep);
    gl.uniform3fv(l.uCloud, this.cloud);
    gl.uniform1f(l.uSunX, SUN[0] * this.width);
    gl.uniform1f(l.uGlimmer, glimmer);
    this.sendFront(l);

    const rings = new Float32Array(RING_COUNT * 4);
    this.rings.slice(-RING_COUNT).forEach((r, i) => {
      const w = r.b + gap;
      rings.set([(r.x - this.width / 2) / w, focal / w, r.age, r.amp], i * 4);
    });
    gl.uniform4fv(l.uRing, rings);

    // The bright things above the water: each form, the action, and the drop under the pointer.
    const lamps = new Float32Array(LAMP_COUNT * 4);
    let count = 0;
    const lamp = (x: number, half: number, power: number, warm: number): void => {
      if (power < 0.002 || count >= LAMP_COUNT) return;
      lamps.set([x, half, power, warm], count * 4);
      count++;
    };
    for (const m of this.top.masses) if (m.on.x > 0.01) lamp(m.cx.x, m.hw.x * 0.7, 0.05 * m.on.x, 0);
    const a = this.top.action;
    if (a.on.x > 0.01) lamp(a.cx.x, a.hw.x * 0.55, 0.3 * a.on.x, 1);
    const [hx, , ha] = this.top.dropGeometry(0);
    lamp(hx, Math.max(ha * 0.55, 20 * s), 0.16 * clamp(this.top.drops[0].reach.x, 0, 1), 0);
    gl.uniform4fv(l.uLamp, lamps);

    const mirrors = new Float32Array(BEAD_COUNT * 4);
    this.beads.slice(-BEAD_COUNT).forEach((bead, i) => {
      if (bead.crown) return;
      const above = this.groundAt(bead.b) - bead.y;
      if (above < 0) return;
      mirrors.set([bead.x, bead.b + above, bead.size, clamp(1 - above / (0.42 * level), 0, 1)], i * 4);
    });
    gl.uniform4fv(l.uMirror, mirrors);

    gl.scissor(0, 0, Math.ceil(this.width * this.dpr), Math.ceil((level + 6 * s) * this.dpr));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.useProgram(this.program);
  }

  private poolLevelNormal(): number {
    if (this.height <= 0) return 0;
    return clamp(this.level.x / this.height, 0, 1);
  }

  destroy(): void {
    this.stop();
    this.canvas.removeEventListener('webglcontextlost', this.lost);
    this.canvas.removeEventListener('webglcontextrestored', this.restored);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.onFrame = null;
    // The context stays with the canvas, so a remount in React's StrictMode can use it again.
    if (this.gl && this.program) this.gl.deleteProgram(this.program);
    if (this.gl && this.waterProgram) this.gl.deleteProgram(this.waterProgram);
    this.program = null;
    this.waterProgram = null;
    this.gl = null;
    this.weather?.destroy();
  }
}
