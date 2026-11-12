// The sound of the ribbon while a hand moves it: the music under the lens, at the speed and in the
// direction it is passing, the way tape sounds when it is pulled across a head.

/** The audio worklet, kept as text so the kit stays one folder with no extra file to serve. */
export const scrubWorklet = `
// The read point plays the hand's movement a moment after it happened, so the report of it is
// already in hand. That trail is the oldest a report has been on arrival plus a margin, in seconds.
// Every report is late by the sound's output delay, about 5 ms on a built-in speaker and over 200 ms
// on wireless headphones, so the quickest report of a press sets the base, and the trail is held to
// at most LATE beyond it, CEILING beyond it when a press starts.
const FLOOR = 0.012;
const LATE = 0.05;
const CEILING = 0.2;
const MARGIN = 0.003;
// The longest pause between two reports that still counts as one movement.
const STILL = 0.2;
// A mouse reports only when it has moved a whole step. A silence longer than this, and much longer
// than the steps before it, means the hand was all but still and crossed into its new step at the end.
const QUIET = 0.03;

// How long the read point carries on past the newest report before it comes to rest.
const CARRY = 0.025;
// How much faster or slower than real time the playhead runs to hold the trail: a little while the
// ribbon moves, more while it is all but still and little is heard.
const EASE = 0.02;
const CATCH = 0.5;
// The spring between the hand and the read point, in radians per second.
const OMEGA = 100;

class GlassHeadScrub extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffers = new Map();
    this.offsets = [0];
    this.on = false;
    this.until = Infinity;
    this.points = [{ at: 0, pos: 0 }];
    this.slope = 0;
    // The time between the last two reports that moved, while the hand keeps moving.
    this.step = 0.016;
    // The moment of the hand's movement being played now, on the sound's clock.
    this.q = 0;
    // What a press starts with: the oldest a report was on arrival during the last one.
    this.trail = 0.03;
    this.worst = 0;
    // The quickest a report has arrived during this press, and during the last one.
    this.quick = 0.01;
    this.base = 0.01;
    // The trail this press needs so far.
    this.need = 0.03;
    this.pos = 0;
    this.vel = 0;
    this.gain = 0;
    this.port.onmessage = (e) => this.take(e.data);
  }

  now() {
    return currentFrame / sampleRate;
  }

  get delay() {
    return this.now() - this.q;
  }

  take(m) {
    if (m.type === 'layout') {
      this.offsets = m.offsets;
      this.buffers.clear();
    } else if (m.type === 'buffer') {
      this.buffers.set(m.index, { rate: m.rate, samples: m.samples });
    } else if (m.type === 'drop') {
      this.buffers.delete(m.index);
    } else if (m.type === 'start') {
      const now = this.now();
      this.on = true;
      this.until = Infinity;
      this.points = [{ at: m.at, pos: m.pos }];
      this.slope = 0;
      this.step = 0.016;
      this.pos = m.pos;
      this.vel = 0;
      this.worst = now - m.at;
      this.quick = now - m.at;
      this.need = this.trail;
      // Nothing is sounding yet, so the trail can start at whatever this press needs.
      this.q = now - Math.min(this.base + CEILING, Math.max(this.trail, now - m.at + MARGIN));
    } else if (m.type === 'move') {
      this.add(m.at, m.pos);
    } else if (m.type === 'stop') {
      // The hand let go then. Everything it did before that is still played out.
      this.until = m.at;
      this.base = this.quick;
      this.trail = Math.min(this.quick + LATE, Math.max(FLOOR, this.worst + MARGIN));
    }
  }

  /** Where the hand was at time q, from the reports in hand. */
  target(q) {
    const p = this.points;
    while (p.length > 1 && p[1].at <= q) {
      this.slope = (p[1].pos - p[0].pos) / (p[1].at - p[0].at);
      p.shift();
    }
    const a = p[0];
    if (q <= a.at) return a.pos;
    if (p.length > 1) {
      const b = p[1];
      return a.pos + ((b.pos - a.pos) * (q - a.at)) / (b.at - a.at);
    }
    // Past the newest report the hand is most likely still moving the way it was, so the read point
    // eases on for a moment instead of stalling.
    return a.pos + this.slope * CARRY * (1 - Math.exp(-(q - a.at) / CARRY));
  }

  add(at, pos) {
    const p = this.points;
    const last = p[p.length - 1];
    at = Math.max(at, last.at + 1e-5);
    const now = this.now();
    const age = now - at;
    this.worst = Math.max(this.worst, age);
    this.quick = Math.min(this.quick, age);
    this.need = Math.min(this.quick + LATE, Math.max(this.need, age + MARGIN));
    const starved = p.length === 1 && this.q > last.at;
    const held = starved ? this.target(this.q) : 0;
    const gap = at - last.at;
    const quiet = gap > STILL || gap > Math.max(QUIET, 2.5 * this.step);
    if (pos !== last.pos) this.step = Math.min(gap, STILL / 2.5);
    if (quiet) {
      // The hand was still, or nearly, and moved into this step just before the report. Rewinding the
      // playhead over the stillness would only add delay, so the move is placed at its end.
      const lead = Math.min(0.04, Math.max(0.008, gap / 2));
      let begin = Math.max(last.at + 1e-5, at - lead);
      let from = last.pos;
      if (starved) {
        // The move starts from where the sound already is.
        from = held;
        if (this.q > begin) {
          // Already past where the move began: play it at up to twice its speed, and rewind only for
          // what that cannot cover.
          begin = Math.min(this.q, Math.max(last.at + 1e-5, at - lead / 2));
          this.q = begin;
        } else {
          p.push({ at: this.q, pos: held });
        }
      }
      p.push({ at: begin, pos: from }, { at, pos });
      this.slope = 0;
    } else {
      p.push({ at, pos });
      if (starved) {
        // The read point ran past the newest report and carried on. Move the playhead to the
        // moment of the hand's path that matches where the sound already is, so nothing jumps.
        const span = pos - last.pos;
        let s = span !== 0 ? last.at + ((held - last.pos) / span) * (at - last.at) : last.at;
        s = Math.min(at, Math.max(last.at, s));
        this.q = Math.min(s, now - this.need);
      }
    }
    if (p.length > 512) p.shift();
  }

  read(g) {
    const o = this.offsets;
    let i = 0;
    while (i < o.length - 2 && g >= o[i + 1]) i++;
    const b = this.buffers.get(i);
    if (!b) return 0;
    const x = (g - o[i]) * b.rate;
    const k = Math.floor(x);
    if (k < 0 || k >= b.samples.length - 1) return 0;
    const s = b.samples[k];
    return (s + (b.samples[k + 1] - s) * (x - k)) / 32768;
  }

  /** While the hand holds still the playhead can skip ahead to the trail without being heard. */
  skip(now) {
    const p = this.points;
    const edge = now - this.need;
    if (this.q >= edge) return;
    const here = this.target(this.q);
    let to = this.q;
    if (p.length === 1) {
      if (this.q - p[0].at > 5 * CARRY) to = edge;
    } else {
      for (let k = 1; k < p.length && Math.abs(p[k].pos - here) < 2e-4; k++) to = Math.min(edge, p[k].at);
    }
    this.q = Math.max(this.q, to);
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const first = out[0];
    const n = first.length;
    const dt = 1 / sampleRate;
    const now = this.now();
    this.skip(now);
    const slack = now - this.q - this.need;
    const give = Math.max(EASE, CATCH * Math.max(0, 1 - Math.abs(this.vel) / 0.1));
    const rate = slack > 0.001 ? 1 + give : slack < -0.001 ? 1 - give : 1;
    if (!this.on && this.gain < 1e-4) {
      this.gain = 0;
      this.q += n * dt * rate;
      return true;
    }
    const k = 2 * OMEGA;
    const w2 = OMEGA * OMEGA;
    const fade = 1 - Math.exp(-dt / 0.006);
    for (let i = 0; i < n; i++) {
      this.q += dt * rate;
      if (this.q > this.until) this.on = false;
      const target = this.target(this.q);
      // The read point follows on a critically damped spring, so the pitch is the speed of the ribbon.
      this.vel += (w2 * (target - this.pos) - k * this.vel) * dt;
      const d = this.vel * dt;
      const speed = Math.abs(this.vel);
      // A fast pass skips samples. Averaging across each skip keeps it from turning to hiss.
      const taps = Math.min(16, Math.max(1, Math.ceil(speed * 0.7)));
      let s = 0;
      for (let j = 0; j < taps; j++) s += this.read(this.pos + (d * j) / taps);
      this.pos += d;
      // Slow movement stays audible: tape pulled slowly is low and quiet, not silent.
      const want = this.on ? Math.min(1, Math.max(0, (speed - 0.012) / 0.1)) / (1 + (speed * speed) / 3600) : 0;
      this.gain += (want - this.gain) * fade;
      first[i] = (s / taps) * this.gain;
    }
    for (let c = 1; c < out.length; c++) out[c].set(first);
    return true;
  }
}
registerProcessor('glasshead-scrub', GlassHeadScrub);
`;type Pcm = { rate: number; samples: Int16Array };
type Slot = Pcm | 'loading' | 'sent' | 'failed';

// Longer files are left silent in the hand: decoded, an hour of sound is hundreds of megabytes.
const MAX_SECONDS = 900;

async function decode(src: string, signal: AbortSignal): Promise<Pcm> {
  const res = await fetch(src, { signal });
  if (!res.ok) throw new Error(`Could not load ${src}`);
  const data = await res.arrayBuffer();
  const Offline: typeof OfflineAudioContext =
    window.OfflineAudioContext ?? (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  let audio: AudioBuffer;
  try {
    audio = await new Offline(1, 2, 32000).decodeAudioData(data.slice(0));
  } catch {
    audio = await new Offline(1, 2, 44100).decodeAudioData(data);
  }
  const a = audio.getChannelData(0);
  const b = audio.numberOfChannels > 1 ? audio.getChannelData(1) : a;
  const samples = new Int16Array(audio.length);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.max(-32767, Math.min(32767, Math.round((a[i] + b[i]) * 16383.5)));
  return { rate: audio.sampleRate, samples };
}

type Report = { type: 'start' | 'move' | 'stop'; pos: number; time: number };

export class GlassHeadScrub {
  /** True once a hand has come near. From then on the tracks around the lens are kept decoded. */
  primed = false;

  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private opening = false;
  private life = 0;
  private srcs: (string | undefined)[] = [];
  private durations: number[] = [];
  private offsets: number[] = [0];
  private slots = new Map<number, Slot>();
  private abort = new AbortController();
  private active = false;
  private touch = false;
  private near = false;
  private rest = 0;
  private skew: number | null = null;
  /** Reports of the current press made while the sound was still waking, sent once its clock runs. */
  private held: Report[] = [];

  setTracks(srcs: (string | undefined)[], durations: number[]) {
    this.abort.abort();
    this.abort = new AbortController();
    this.srcs = srcs;
    this.durations = durations.map((d) => Math.max(0.1, d));
    this.offsets = [0];
    for (const d of this.durations) this.offsets.push(this.offsets[this.offsets.length - 1] + d);
    this.slots.clear();
    this.node?.port.postMessage({ type: 'layout', offsets: this.offsets });
  }

  /** Decode the track at `index` and its neighbours, and let go of the rest. */
  prime(index: number) {
    this.primed = true;
    const keep = [index - 1, index, index + 1];
    for (const [i, slot] of this.slots) {
      if (keep.includes(i)) continue;
      if (slot === 'sent') this.node?.port.postMessage({ type: 'drop', index: i });
      this.slots.delete(i);
    }
    for (const i of keep) {
      const src = this.srcs[i];
      if (!src || this.slots.has(i) || this.durations[i] > MAX_SECONDS) continue;
      this.slots.set(i, 'loading');
      const signal = this.abort.signal;
      decode(src, signal)
        .then((pcm) => {
          if (signal.aborted || this.slots.get(i) !== 'loading') return;
          this.slots.set(i, pcm);
          this.flush();
        })
        .catch(() => {
          if (!signal.aborted && this.slots.get(i) === 'loading') this.slots.set(i, 'failed');
        });
    }
  }

  /** Call from a press or a key. Browsers only let sound start from one. */
  unlock(pointerType?: string) {
    if (pointerType === 'touch') this.touch = true;
    if (this.ctx) {
      this.resume();
      if (!this.active) this.settle();
      return;
    }
    if (!this.allowed()) return;
    void this.open();
  }

  /**
   * A pointer is over the ribbon. Waking the sound takes a moment, so it is done now rather than on
   * the press, and the first movement of the hand is heard on time.
   */
  warm() {
    this.near = true;
    clearTimeout(this.rest);
    if (this.ctx) this.resume();
    else if (this.allowed()) void this.open();
  }

  /** The pointer has left. The sound goes back to sleep a little later. */
  cool() {
    this.near = false;
    if (!this.active) this.settle();
  }

  /**
   * A hand has taken the ribbon at `pos`, in seconds from the start of the queue.
   * `time` is when, on the clock of `performance.now()` and of event timestamps.
   */
  start(pos: number, time: number) {
    this.active = true;
    clearTimeout(this.rest);
    this.held = [];
    this.resume();
    this.send({ type: 'start', pos, time });
  }

  move(pos: number, time: number) {
    if (this.active) this.send({ type: 'move', pos, time });
  }

  /** The hand let go at `time`. What it did up to then is still played out. */
  stop(time = performance.now()) {
    if (!this.active) return;
    this.active = false;
    this.send({ type: 'stop', pos: 0, time });
    this.settle();
  }

  close() {
    this.life++;
    clearTimeout(this.rest);
    this.abort.abort();
    this.abort = new AbortController();
    this.slots.clear();
    this.node?.disconnect();
    this.node = null;
    void this.ctx?.close();
    this.ctx = null;
    this.opening = false;
    this.active = false;
    this.held = [];
  }

  private allowed() {
    const activation = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
    return !activation || activation.hasBeenActive;
  }

  private resume() {
    if (this.ctx?.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  private send(report: Report) {
    if (!this.node || this.ctx?.state !== 'running') {
      // A stamp read now would be on a clock that is not moving yet. Keep the press until it is.
      if (report.type === 'start') this.held = [report];
      else if (this.held.length && this.held.length < 2048) this.held.push(report);
      return;
    }
    this.post(report);
  }

  private post(report: Report) {
    this.node?.port.postMessage({ type: report.type, pos: report.pos, at: this.stamp(report.time) });
  }

  private release() {
    if (!this.node || this.ctx?.state !== 'running') return;
    const held = this.held;
    this.held = [];
    for (const report of held) this.post(report);
  }

  /** A time on the page's clock, as a time on the sound's clock. */
  private stamp(time: number) {
    const ctx = this.ctx;
    if (!ctx) return 0;
    // The output timestamp pairs the two clocks at one instant. Reading the sound's clock alone is
    // only good to the size of its last block, which can be over 10 ms.
    const out = ctx.getOutputTimestamp?.();
    const raw = out?.performanceTime && out.contextTime ? out.contextTime - out.performanceTime / 1000 : ctx.currentTime - performance.now() / 1000;
    this.skew = this.skew === null || Math.abs(raw - this.skew) > 0.05 ? raw : this.skew + (raw - this.skew) * 0.05;
    return time / 1000 + this.skew;
  }

  private settle() {
    clearTimeout(this.rest);
    // A touch cannot wake the sound again until the finger lifts, so there it stays awake.
    if (this.touch || this.near) return;
    this.rest = window.setTimeout(() => {
      if (!this.active && !this.near && this.ctx?.state === 'running') void this.ctx.suspend();
    }, 1500);
  }

  private flush() {
    const node = this.node;
    if (!node) return;
    for (const [i, slot] of this.slots) {
      if (typeof slot === 'string') continue;
      node.port.postMessage({ type: 'buffer', index: i, rate: slot.rate, samples: slot.samples }, [slot.samples.buffer]);
      this.slots.set(i, 'sent');
    }
  }

  private async open() {
    if (this.ctx || this.opening) return;
    const Ctx: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    this.opening = true;
    const life = this.life;
    const ctx = new Ctx({ latencyHint: 'interactive' });
    try {
      const url = URL.createObjectURL(new Blob([scrubWorklet], { type: 'text/javascript' }));
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      if (life !== this.life) throw new Error('closed');
      const node = new AudioWorkletNode(ctx, 'glasshead-scrub', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
      node.connect(ctx.destination);
      this.ctx = ctx;
      this.node = node;
      this.opening = false;
      node.port.postMessage({ type: 'layout', offsets: this.offsets });
      this.flush();
      ctx.addEventListener('statechange', () => {
        if (ctx !== this.ctx) return;
        // The two clocks are paired again after every sleep.
        this.skew = null;
        if (ctx.state === 'running') this.release();
      });
      this.resume();
      this.release();
      if (!this.active) this.settle();
    } catch {
      // No worklets here (a page not served securely, an old browser): the ribbon is silent in the hand.
      this.opening = false;
      void ctx.close();
    }
  }
}
