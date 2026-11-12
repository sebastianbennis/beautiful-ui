import type { GlassHeadState } from './types';

type TravelKind = 'stop' | 'skip' | 'seek';

type Mode =
  | { kind: 'follow' }
  | { kind: 'travel'; from: number; to: number; start: number; dur: number; antic: number; back: number }
  | { kind: 'drag' }
  | { kind: 'coast'; v: number };

// Overshoot of a back ease-out is about 4c^3 / 27(c+1)^2 of the distance. Solve c for a wanted fraction.
function backFor(fraction: number) {
  let lo = 0;
  let hi = 3;
  for (let i = 0; i < 18; i++) {
    const c = (lo + hi) / 2;
    if ((4 * c * c * c) / (27 * (c + 1) * (c + 1)) < fraction) lo = c;
    else hi = c;
  }
  return lo;
}

/**
 * The transport. The queue is one ribbon measured in seconds, `shown` is the point of it under
 * the lens, and the audio element follows this clock so a run is the same every time.
 */
export class GlassHeadEngine {
  durations: number[] = [];
  offsets: number[] = [0];
  total = 0;
  index = 0;
  time = 0;
  state: GlassHeadState = 'stopped';
  shown = 0;
  velocity = 0;
  span = 14;
  reduced = false;
  loading = false;
  /** Counts jumps made without travel, so the view can cross-fade them. */
  jumps = 0;
  failed = new Set<number>();

  private mode: Mode = { kind: 'follow' };
  private last = -1;
  private listeners = new Set<() => void>();
  private audio: HTMLAudioElement | null = null;
  private srcs: (string | undefined)[] = [];
  private loaded = -1;
  private lastSeek = -1e9;
  /** Set when the position was chosen, not drifted into, so the audio lands on it exactly. */
  private exact = false;
  private detach: (() => void) | null = null;

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit() {
    this.listeners.forEach((fn) => fn());
  }

  setTracks(durations: number[], srcs: (string | undefined)[]) {
    this.durations = durations.map((d) => Math.max(0.1, d));
    this.srcs = srcs;
    this.offsets = [0];
    for (const d of this.durations) this.offsets.push(this.offsets[this.offsets.length - 1] + d);
    this.total = this.offsets[this.offsets.length - 1];
    this.index = Math.min(this.index, Math.max(0, this.durations.length - 1));
    this.time = Math.min(this.time, this.durations[this.index] ?? 0);
    this.failed.clear();
    this.loaded = -1;
    this.mode = { kind: 'follow' };
    this.shown = this.target();
    this.emit();
  }

  attachAudio(audio: HTMLAudioElement | null) {
    this.detach?.();
    this.detach = null;
    this.audio = audio;
    this.loaded = -1;
    if (!audio) return;
    const waiting = () => this.setLoading(true);
    const ready = () => this.setLoading(false);
    const error = () => {
      if (this.loaded < 0) return;
      this.failed.add(this.loaded);
      this.loading = false;
      if (this.state === 'playing' && this.loaded === this.index) this.state = 'paused';
      this.emit();
    };
    audio.addEventListener('waiting', waiting);
    audio.addEventListener('playing', ready);
    audio.addEventListener('canplay', ready);
    audio.addEventListener('error', error);
    this.detach = () => {
      audio.pause();
      audio.removeEventListener('waiting', waiting);
      audio.removeEventListener('playing', ready);
      audio.removeEventListener('canplay', ready);
      audio.removeEventListener('error', error);
    };
  }

  /** Call before the first frame after a rest, so the gap is not counted as playing time. */
  wake() {
    this.last = -1;
  }

  private setLoading(value: boolean) {
    if (this.loading === value) return;
    this.loading = value;
    this.emit();
  }

  get busy() {
    return this.mode.kind !== 'follow';
  }

  get scrubbing() {
    return this.mode.kind === 'drag' || this.mode.kind === 'coast';
  }

  /** True while a hand is on the ribbon, false once it has been thrown. */
  get held() {
    return this.mode.kind === 'drag';
  }

  private target() {
    return (this.offsets[this.index] ?? 0) + this.time;
  }

  /** Which track sits at a point of the ribbon, and how far into it. */
  locate(pos: number) {
    const p = Math.min(Math.max(pos, 0), Math.max(0, this.total - 0.05));
    let i = 0;
    while (i < this.durations.length - 1 && p >= this.offsets[i + 1]) i++;
    return { index: i, time: p - this.offsets[i] };
  }

  /** The time to print: where the ribbon is while a hand moves it, the true position otherwise. */
  displayTime() {
    return this.scrubbing ? this.locate(this.shown).time : this.time;
  }

  play() {
    if (!this.durations.length || this.state === 'playing') return;
    if (this.mode.kind === 'coast') this.commit();
    if (this.failed.delete(this.index)) this.loaded = -1;
    this.state = 'playing';
    this.syncAudio();
    this.emit();
  }

  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.syncAudio();
    this.emit();
  }

  stop() {
    if (!this.durations.length) return;
    this.state = 'stopped';
    this.time = 0;
    this.exact = true;
    this.travel(this.target(), 'stop');
    this.syncAudio();
    this.emit();
  }

  back() {
    if (!this.durations.length) return;
    if (this.time <= 3 && this.index > 0) this.index--;
    this.time = 0;
    this.exact = true;
    this.travel(this.target(), 'skip');
    this.syncAudio();
    this.emit();
  }

  forward() {
    if (this.index >= this.durations.length - 1) return;
    this.index++;
    this.time = 0;
    this.exact = true;
    this.travel(this.target(), 'skip');
    this.syncAudio();
    this.emit();
  }

  select(index: number) {
    if (index < 0 || index >= this.durations.length) return;
    this.index = index;
    this.time = 0;
    this.exact = true;
    this.travel(this.target(), 'skip');
    this.syncAudio();
    this.emit();
  }

  seek(seconds: number) {
    if (!this.durations.length) return;
    this.time = Math.min(Math.max(seconds, 0), this.durations[this.index] - 0.05);
    this.exact = true;
    this.travel(this.target(), 'seek');
    this.syncAudio();
    this.emit();
  }

  dragStart() {
    this.mode = { kind: 'drag' };
    this.syncAudio();
    this.emit();
  }

  dragMove(seconds: number) {
    if (this.mode.kind !== 'drag') return;
    this.shown = Math.min(Math.max(this.shown + seconds, 0), Math.max(0, this.total - 0.05));
  }

  /** `v` is the ribbon's speed at release, in seconds of music per second. */
  dragEnd(v: number) {
    if (this.mode.kind !== 'drag') return;
    const max = this.span * 12;
    const speed = Math.min(Math.max(v, -max), max);
    if (this.reduced || Math.abs(speed) < this.span * 0.02) this.commit();
    else this.mode = { kind: 'coast', v: speed };
  }

  private commit() {
    const at = this.locate(this.shown);
    this.index = at.index;
    this.time = at.time;
    this.exact = true;
    this.mode = { kind: 'follow' };
    this.shown = this.target();
    this.syncAudio();
    this.emit();
  }

  private travel(to: number, kind: TravelKind) {
    const from = this.shown;
    const dist = Math.abs(to - from);
    if (dist < 1e-3) {
      this.mode = { kind: 'follow' };
      this.shown = to;
      return;
    }
    if (this.reduced) {
      this.mode = { kind: 'follow' };
      this.shown = to;
      this.jumps++;
      return;
    }
    const dir = Math.sign(to - from);
    const dur =
      kind === 'stop' ? 700 + 600 * Math.min(1, dist / 60) : kind === 'skip' ? 520 + 280 * Math.min(1, dist / 90) : 260;
    const antic = kind === 'stop' && dist > this.span * 0.1 ? -dir * this.span * 0.012 : 0;
    const over = kind === 'seek' ? 0 : Math.min(0.1, (this.span * 0.016) / dist);
    this.mode = { kind: 'travel', from, to, start: -1, dur, antic, back: backFor(over) };
  }

  /** Advance to `now` (milliseconds). Returns true while another frame is needed. */
  tick(now: number) {
    const dt = this.last < 0 ? 0 : Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    const before = this.shown;
    const mode = this.mode;

    if (mode.kind === 'follow') {
      if (this.state === 'playing') {
        this.time += dt;
        let changed = false;
        while (this.state === 'playing' && this.time >= this.durations[this.index]) {
          changed = true;
          if (this.index < this.durations.length - 1) {
            this.time -= this.durations[this.index];
            this.index++;
          } else {
            this.state = 'stopped';
            this.index = 0;
            this.time = 0;
            this.travel(0, 'stop');
          }
        }
        if (changed) this.emit();
      }
      if (this.mode.kind === 'follow') this.shown = this.target();
    } else if (mode.kind === 'travel') {
      if (mode.start < 0) mode.start = now;
      const u = Math.min(1, (now - mode.start) / mode.dur);
      // The main move waits a beat so the small step the wrong way can be seen first.
      const v = Math.pow(Math.max(0, (u - 0.06) / 0.94), 1.6);
      const c = mode.back;
      const eased = 1 + (c + 1) * Math.pow(v - 1, 3) + c * Math.pow(v - 1, 2);
      const lead = u < 0.16 ? mode.antic * Math.sin((Math.PI * u) / 0.16) : 0;
      this.shown = mode.from + (mode.to - mode.from) * eased + lead;
      if (u >= 1) {
        this.shown = mode.to;
        this.mode = { kind: 'follow' };
        this.emit();
      }
    } else if (mode.kind === 'coast') {
      mode.v *= Math.exp(-dt / 0.325);
      const next = this.shown + mode.v * dt;
      const max = Math.max(0, this.total - 0.05);
      this.shown = Math.min(Math.max(next, 0), max);
      if (next <= 0 || next >= max || Math.abs(mode.v) < this.span * 0.012) this.commit();
    }

    this.velocity = dt > 0 ? (this.shown - before) / dt : 0;
    this.syncAudio(now);
    return this.state === 'playing' || this.mode.kind !== 'follow' || Math.abs(this.velocity) > 1e-4;
  }

  private syncAudio(now = this.last) {
    const audio = this.audio;
    if (!audio) return;
    const src = this.srcs[this.index];
    const should = this.state === 'playing' && this.mode.kind === 'follow' && !!src && !this.failed.has(this.index);
    if (!should) {
      if (!audio.paused) audio.pause();
      if (this.loading && this.state !== 'playing') this.setLoading(false);
      return;
    }
    if (this.loaded !== this.index) {
      this.loaded = this.index;
      audio.src = src;
      this.lastSeek = -1e9;
    }
    // Small drift while playing is left alone, since every seek is heard. A chosen position is not.
    const drift = Math.abs(audio.currentTime - this.time);
    if (audio.readyState >= 1 && ((this.exact && drift > 0.02) || (drift > 0.35 && now - this.lastSeek > 600))) {
      this.lastSeek = now;
      try {
        audio.currentTime = this.time;
      } catch {
        // Not seekable yet. The next frame tries again.
      }
    }
    if (audio.readyState >= 1) this.exact = false;
    if (audio.paused) audio.play().catch(() => {});
  }

  dispose() {
    this.detach?.();
    this.listeners.clear();
  }
}
