// The upload engine. It knows nothing about how bytes reach a server: the host
// passes one function that sends one part. Everything else is here: part size,
// six workers, retries with backoff, surviving a dead connection, and
// remembering what is safe across a reload.

export interface UploadPart {
  index: number;
  start: number;
  end: number;
  size: number;
  file: File;
  blob(): Blob;
}

export type UploadPartFn = (part: UploadPart, signal: AbortSignal, onBytes: (sent: number) => void) => Promise<void>;

/** Throw this from uploadPart when the network itself is gone, not just one part. */
export class PinBedOffline extends Error {
  constructor() {
    super('offline');
    this.name = 'PinBedOffline';
  }
}

export type UploadPhase = 'sending' | 'paused' | 'offline' | 'failed' | 'done' | 'cancelled';

export interface UploaderOptions {
  workers?: number;
  partSize?: number;
  now?: () => number;
  persist?: boolean;
  onChange?: () => void;
  onLanded?: (part: number) => void;
  onFailed?: (part: number) => void;
}

const MiB = 1024 * 1024;

/** How many times one part may fail once nothing else is left to send. */
const MAX_TRIES = 6;
/** This many failures in a row, with nothing landing between them, means the server is refusing everything. */
const MAX_IN_A_ROW = 18;
const LONGEST_WAIT = 30000;
const SAMPLE_EVERY = 500;

/** S3 allows 10,000 parts. Staying near 360 keeps a retry cheap and gives every column real parts. */
export function choosePartSize(size: number): number {
  const wanted = Math.max(size / 360, 16 * MiB);
  let part = 16 * MiB;
  while (part < wanted) part *= 2;
  return Math.max(part, Math.ceil(size / 9000));
}

export function fileKey(file: Pick<File, 'name' | 'size' | 'lastModified'>): string {
  return `pinbed:${file.name}:${file.size}:${file.lastModified}`;
}

/** What has become of a part. Plain numbers, so the file compiles under any TypeScript setting. */
const S = { Waiting: 0, Flying: 1, Safe: 2 } as const;

interface Remembered {
  parts: string;
  count: number;
  partSize: number;
}

function encodeBits(state: Uint8Array): string {
  let out = '';
  for (let i = 0; i < state.length; i += 4) {
    let v = 0;
    for (let b = 0; b < 4; b++) if (state[i + b] === S.Safe) v |= 1 << b;
    out += v.toString(16);
  }
  return out;
}

export class Uploader {
  readonly file: File;
  readonly partSize: number;
  readonly count: number;
  phase: UploadPhase = 'sending';
  retryIn = 0;
  private state: Uint8Array;
  private flying: Float64Array;
  private controllers = new Map<number, AbortController>();
  private retries = new Map<number, number>();
  private notBefore = new Map<number, number>();
  private failuresInARow = 0;
  private waitTimer = 0;
  private inFlight = 0;
  private lastSample = -Infinity;
  private gaps = new Set<number>();
  private queue: number[] = [];
  private transport: UploadPartFn;
  private workers: number;
  private opts: UploaderOptions;
  private now: () => number;
  private safeBytes = 0;
  private rate = 0;
  private samples: { at: number; bytes: number }[] = [];
  private offlineTimer = 0;
  private retryTick = 0;
  private offlineTries = 0;
  private running = 0;
  private lastLanded = -1;
  private listener = () => {
    if (this.phase === 'offline') this.reconnect();
  };

  constructor(file: File, transport: UploadPartFn, opts: UploaderOptions = {}) {
    this.file = file;
    this.transport = transport;
    this.opts = opts;
    this.workers = opts.workers ?? 6;
    this.now = opts.now ?? (() => performance.now());
    this.partSize = opts.partSize ?? choosePartSize(file.size);
    this.count = Math.max(1, Math.ceil(file.size / this.partSize));
    this.state = new Uint8Array(this.count);
    this.flying = new Float64Array(this.count);
    this.restore();
    for (let i = 0; i < this.count; i++) if (this.state[i] !== S.Safe) this.queue.push(i);
    if (typeof window !== 'undefined') window.addEventListener('online', this.listener);
  }

  private bounds(i: number): [number, number] {
    const start = i * this.partSize;
    return [start, Math.min(start + this.partSize, this.file.size)];
  }

  private restore(): void {
    if (this.opts.persist === false) return;
    try {
      const raw = localStorage.getItem(fileKey(this.file));
      if (!raw) return;
      const r = JSON.parse(raw) as Remembered;
      if (r.count !== this.count || r.partSize !== this.partSize) return;
      for (let i = 0; i < this.count; i++) {
        const v = parseInt(r.parts[i >> 2] ?? '0', 16);
        if (v & (1 << (i & 3))) {
          this.state[i] = S.Safe;
          const [a, b] = this.bounds(i);
          this.safeBytes += b - a;
        }
      }
    } catch {
      /* a damaged note just means starting over */
    }
  }

  private remember(): void {
    if (this.opts.persist === false) return;
    try {
      const r: Remembered = { parts: encodeBits(this.state), count: this.count, partSize: this.partSize };
      localStorage.setItem(fileKey(this.file), JSON.stringify(r));
    } catch {
      /* private mode: the upload still works, it just cannot be resumed */
    }
  }

  forget(): void {
    try {
      localStorage.removeItem(fileKey(this.file));
    } catch {
      /* nothing to clear */
    }
  }

  start(): void {
    this.restartMeasure();
    this.pump();
  }

  private pump(): void {
    if (this.phase !== 'sending') return;
    const clock = performance.now();
    while (this.running < this.workers) {
      const next = this.queue.findIndex((i) => (this.notBefore.get(i) ?? 0) <= clock);
      if (next < 0) break;
      void this.send(this.queue.splice(next, 1)[0]);
    }
    window.clearTimeout(this.waitTimer);
    if (this.queue.length && this.running < this.workers) {
      // everything left is waiting out a retry delay
      const soonest = Math.min(...this.queue.map((i) => this.notBefore.get(i) ?? 0));
      this.waitTimer = window.setTimeout(() => this.pump(), Math.max(soonest - clock, 0) + 5);
    }
    if (!this.running && !this.queue.length && this.safeBytes >= this.file.size) {
      this.phase = 'done';
      this.forget();
      if (typeof window !== 'undefined') window.removeEventListener('online', this.listener);
      this.opts.onChange?.();
    }
  }

  private async send(i: number): Promise<void> {
    const [start, end] = this.bounds(i);
    const controller = new AbortController();
    this.controllers.set(i, controller);
    this.state[i] = S.Flying;
    this.setFlying(i, 0);
    this.running++;
    const part: UploadPart = {
      index: i,
      start,
      end,
      size: end - start,
      file: this.file,
      blob: () => this.file.slice(start, end),
    };
    try {
      await this.transport(part, controller.signal, (sent) => {
        if (controller.signal.aborted) return;
        this.setFlying(i, Math.min(sent, end - start));
        this.measure();
        this.opts.onChange?.();
      });
      // Resolved means the server has it, even if a pause arrived at the same moment.
      this.state[i] = S.Safe;
      this.setFlying(i, 0);
      this.safeBytes += end - start;
      this.gaps.delete(i);
      this.retries.delete(i);
      this.notBefore.delete(i);
      this.failuresInARow = 0;
      this.lastLanded = i;
      this.offlineTries = 0;
      this.measure();
      this.remember();
      this.opts.onLanded?.(i);
    } catch (error) {
      this.state[i] = S.Waiting;
      this.setFlying(i, 0);
      if (controller.signal.aborted) {
        if (!this.queue.includes(i)) this.queue.unshift(i);
      } else if (this.isOffline(error)) {
        this.queue.unshift(i);
        this.goOffline();
      } else {
        this.partFailed(i);
      }
    } finally {
      this.controllers.delete(i);
      this.running--;
      this.opts.onChange?.();
      this.pump();
    }
  }

  private setFlying(i: number, bytes: number): void {
    this.inFlight += bytes - this.flying[i];
    this.flying[i] = bytes;
  }

  private partFailed(i: number): void {
    const tries = (this.retries.get(i) ?? 0) + 1;
    this.retries.set(i, tries);
    this.failuresInARow++;
    this.gaps.add(i);
    this.opts.onFailed?.(i);
    // A failed part goes to the back of the line and waits a little longer each
    // time, so the front keeps moving and a struggling server is given room.
    this.notBefore.set(i, performance.now() + Math.min(1000 * 2 ** (tries - 1), LONGEST_WAIT));
    this.queue.push(i);
    const lastOneLeft = tries >= MAX_TRIES && this.running <= 1 && this.queue.every((p) => (this.retries.get(p) ?? 0) >= MAX_TRIES);
    if (lastOneLeft || this.failuresInARow >= MAX_IN_A_ROW) this.stop();
  }

  /** The server will not take this file. Keep what is safe and let the person decide. */
  private stop(): void {
    if (this.phase !== 'sending') return;
    this.phase = 'failed';
    window.clearTimeout(this.waitTimer);
    this.abortFlying();
  }

  private isOffline(error: unknown): boolean {
    if (error instanceof PinBedOffline) return true;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
    return error instanceof TypeError;
  }

  /** Speed over about the last minute, counting bytes still on their way, so an estimate shows within seconds. */
  private measure(): void {
    const at = this.now();
    if (at - this.lastSample < SAMPLE_EVERY) return;
    this.lastSample = at;
    const bytes = this.safeBytes + this.inFlight;
    this.samples.push({ at, bytes });
    while (this.samples.length > 120 && at - this.samples[1].at > 60000) this.samples.shift();
    const first = this.samples[0];
    if (this.samples.length < 7 || at - first.at < 4000) return;
    const rate = ((bytes - first.bytes) / (at - first.at)) * 1000;
    if (rate > 0) this.rate = rate;
  }

  private restartMeasure(): void {
    this.lastSample = -Infinity;
    this.samples = [{ at: this.now(), bytes: this.safeBytes + this.inFlight }];
  }

  private abortFlying(): void {
    for (const c of this.controllers.values()) c.abort();
  }

  private goOffline(): void {
    if (this.phase !== 'sending') return;
    this.phase = 'offline';
    window.clearTimeout(this.waitTimer);
    this.abortFlying();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const delay = Math.min(2 ** this.offlineTries, 12);
    this.offlineTries++;
    this.retryIn = delay;
    window.clearInterval(this.retryTick);
    window.clearTimeout(this.offlineTimer);
    this.retryTick = window.setInterval(() => {
      this.retryIn = Math.max(0, this.retryIn - 1);
      this.opts.onChange?.();
    }, 1000);
    this.offlineTimer = window.setTimeout(() => this.reconnect(), delay * 1000);
    this.opts.onChange?.();
  }

  private reconnect(): void {
    if (this.phase !== 'offline') return;
    window.clearInterval(this.retryTick);
    window.clearTimeout(this.offlineTimer);
    this.phase = 'sending';
    this.restartMeasure();
    this.opts.onChange?.();
    this.pump();
  }

  pause(): void {
    if (this.phase !== 'sending' && this.phase !== 'offline') return;
    window.clearInterval(this.retryTick);
    window.clearTimeout(this.offlineTimer);
    window.clearTimeout(this.waitTimer);
    this.phase = 'paused';
    this.abortFlying();
    this.opts.onChange?.();
  }

  resume(): void {
    if (this.phase !== 'paused') return;
    this.phase = 'sending';
    this.restartMeasure();
    this.opts.onChange?.();
    this.pump();
  }

  /** After sending has stopped: forgets the failures and tries everything still missing. */
  retry(): void {
    if (this.phase !== 'failed') return;
    this.retries.clear();
    this.notBefore.clear();
    this.failuresInARow = 0;
    this.phase = 'sending';
    this.restartMeasure();
    this.opts.onChange?.();
    this.pump();
  }

  cancel(): void {
    this.phase = 'cancelled';
    window.clearInterval(this.retryTick);
    window.clearTimeout(this.offlineTimer);
    window.clearTimeout(this.waitTimer);
    this.abortFlying();
    this.queue.length = 0;
    this.forget();
    window.removeEventListener('online', this.listener);
    this.opts.onChange?.();
  }

  get bytesSafe(): number {
    return this.safeBytes;
  }

  get fraction(): number {
    return this.safeBytes / Math.max(this.file.size, 1);
  }

  get lastPart(): number {
    return this.lastLanded;
  }

  secondsLeft(): number | null {
    if (this.rate <= 0) return null;
    return Math.max(this.file.size - this.safeBytes - this.inFlight, 0) / this.rate;
  }

  /** How far each column of the bed is filled, from what has actually landed. */
  columns(out: Float32Array): void {
    const n = out.length;
    const each = this.file.size / n;
    out.fill(0);
    for (let i = 0; i < this.count; i++) {
      const [start, end] = this.bounds(i);
      const landed = this.state[i] === S.Safe ? end - start : this.state[i] === S.Flying ? this.flying[i] : 0;
      if (landed <= 0) continue;
      const a = Math.floor(start / each);
      const b = Math.min(n - 1, Math.floor((end - 1) / each));
      const share = landed / (end - start);
      for (let c = a; c <= b; c++) {
        const left = Math.max(start, c * each);
        const right = Math.min(end, (c + 1) * each);
        out[c] += (Math.max(right - left, 0) * share) / each;
      }
    }
    for (let c = 0; c < n; c++) if (out[c] > 1) out[c] = 1;
    // a failed part leaves a clean gap in the picture until its retry lands
    for (const part of this.gaps) {
      if (this.state[part] === S.Safe) continue;
      const [start, end] = this.bounds(part);
      const a = Math.floor(start / each);
      const b = Math.min(n - 1, Math.floor((end - 1) / each));
      for (let c = a; c <= b; c++) out[c] = 0;
    }
  }

  columnOf(part: number, columns: number): number {
    const [start, end] = this.bounds(part);
    return Math.min(columns - 1, Math.floor(((start + end) / 2 / this.file.size) * columns));
  }
}

export function remembered(file: Pick<File, 'name' | 'size' | 'lastModified'>, partSize: number): number {
  try {
    const raw = localStorage.getItem(fileKey(file));
    if (!raw) return 0;
    const r = JSON.parse(raw) as Remembered;
    let safe = 0;
    for (let i = 0; i < r.count; i++) {
      const v = parseInt(r.parts[i >> 2] ?? '0', 16);
      if (v & (1 << (i & 3))) safe += partSize;
    }
    return Math.min(safe, file.size);
  } catch {
    return 0;
  }
}

const GB = 1e9;

export function formatBytes(n: number): string {
  if (n >= GB) return `${(n / GB).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  return n <= 0 ? '0 KB' : `${Math.max(n / 1e3, 1).toFixed(0)} KB`;
}

export function formatLeft(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return 'Working out the time left';
  const s = Math.round(seconds);
  if (s < 5) return 'Almost there';
  if (s < 60) return `${s} s left`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min left`;
  const h = Math.floor(m / 60);
  return `${h} h ${String(m % 60).padStart(2, '0')} min left`;
}

/** Keeps the end of a name, which is where the version and format live. */
export function middleTruncate(name: string, max: number): string {
  if (name.length <= max) return name;
  const tail = Math.round(max * 0.56);
  return `${name.slice(0, max - tail - 1)}…${name.slice(-tail)}`;
}
