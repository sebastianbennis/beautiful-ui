// Turning a real file into something pins can press up. A decoded frame where
// the browser can read the video, and otherwise the file's own data rate over
// time, read straight from the container without decoding a single frame.

export interface Picture {
  /** 0 is the white of the picture, 1 the black, tuned so any film reads in relief */
  tone: Float32Array;
  rgb: Uint8Array;
  w: number;
  h: number;
  /** the film's own shape, so a 2.39:1 or a vertical file leaves the outer pins flush */
  aspect: number;
  levels: [number, number];
  /** drawn from the data rate, not from frames */
  terrain: boolean;
  /** the moment in the film this picture was taken from, where playback will carry on */
  at: number;
}

export const RASTER_W = 420;

const VIDEO_EXT = /\.(mp4|mov|m4v|mxf|braw|r3d|mkv|webm|avi|mts|m2ts|mpg|mpeg|ts|wmv|ogv)$/i;

export function isVideoName(name: string): boolean {
  return VIDEO_EXT.test(name);
}

/** Before the drop only a type is known, and pro formats often arrive with none. */
export function couldBeVideo(type: string): boolean {
  return type === '' || type === 'application/octet-stream' || type.startsWith('video/') || type === 'application/mxf';
}

export function isVideoFile(file: File): boolean {
  return file.type.startsWith('video/') || isVideoName(file.name);
}

function waitFor(el: HTMLVideoElement, event: string, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => done(new Error('timeout')), ms);
    const onOk = () => done();
    const onError = () => done(new Error('decode'));
    const done = (err?: Error) => {
      window.clearTimeout(timer);
      el.removeEventListener(event, onOk);
      el.removeEventListener('error', onError);
      if (err) reject(err);
      else resolve();
    };
    el.addEventListener(event, onOk);
    el.addEventListener('error', onError);
  });
}

function luma(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const a = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += src[y * w + Math.max(0, Math.min(w - 1, x))];
    for (let x = 0; x < w; x++) {
      a[y * w + x] = sum / (2 * r + 1);
      sum += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += a[Math.max(0, Math.min(h - 1, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / (2 * r + 1);
      sum += a[Math.min(h - 1, y + r + 1) * w + x] - a[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

function percentile(values: Float32Array, p: number): number {
  const sorted = Float32Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

/** Any frame, stretched to the full range and given a little local contrast. */
export function toneMap(
  lum: Float32Array,
  w: number,
  h: number,
  given?: [number, number],
  amount = 0.3,
): { tone: Float32Array; levels: [number, number] } {
  const levels: [number, number] = given ?? [percentile(lum, 0.02), percentile(lum, 0.985)];
  const span = Math.max(levels[1] - levels[0], 0.08);
  const stretched = new Float32Array(lum.length);
  for (let k = 0; k < lum.length; k++) stretched[k] = Math.max(0, Math.min(1, (lum[k] - levels[0]) / span));
  const wide = boxBlur(stretched, w, h, Math.max(1, Math.round(w * 0.11)));
  const fine = boxBlur(stretched, w, h, Math.max(1, Math.round(w * 0.012)));
  const tone = new Float32Array(lum.length);
  for (let k = 0; k < lum.length; k++) {
    const s = stretched[k];
    // a broad lift so any film reads, and a fine one so its edges stay crisp in pins
    tone[k] = 1 - Math.max(0, Math.min(1, s + amount * (s - wide[k]) + 0.9 * (s - fine[k])));
  }
  return { tone, levels };
}

function capture(video: HTMLVideoElement, ctx: CanvasRenderingContext2D, w: number, h: number): { lum: Float32Array; rgb: Uint8Array; spread: number } {
  ctx.drawImage(video, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const lum = new Float32Array(w * h);
  const rgb = new Uint8Array(w * h * 3);
  let sum = 0;
  let sq = 0;
  for (let k = 0; k < w * h; k++) {
    const r = px[k * 4];
    const g = px[k * 4 + 1];
    const b = px[k * 4 + 2];
    const v = luma(r, g, b);
    lum[k] = v;
    rgb[k * 3] = r;
    rgb[k * 3 + 1] = g;
    rgb[k * 3 + 2] = b;
    sum += v;
    sq += v * v;
  }
  const mean = sum / (w * h);
  return { lum, rgb, spread: Math.sqrt(Math.max(sq / (w * h) - mean * mean, 0)) };
}

/** Throws when the browser cannot decode the file, which is the terrain path. */
export async function readPoster(url: string): Promise<Picture> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;
  try {
    await waitFor(video, 'loadeddata', 8000);
    if (!video.videoWidth) throw new Error('no picture');
    const aspect = video.videoWidth / video.videoHeight;
    const w = RASTER_W;
    const h = Math.max(1, Math.round(w / aspect));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('no 2d');

    let best: ReturnType<typeof capture> | null = null;
    let bestAt = 0;
    for (const share of [0.3, 0.55, 0.15]) {
      const time = Math.min((video.duration || 1) * share, Math.max((video.duration || 1) - 0.1, 0));
      video.currentTime = time;
      await waitFor(video, 'seeked', 5000);
      const frame = capture(video, ctx, w, h);
      if (!best || frame.spread > best.spread) {
        best = frame;
        bestAt = time;
      }
      if (best.spread > 0.16) break;
    }
    if (!best) throw new Error('no frame');
    const { tone, levels } = toneMap(best.lum, w, h);
    return { tone, rgb: best.rgb, w, h, aspect, levels, terrain: false, at: bestAt };
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}

// MP4 and MOV keep a table of every frame's size. That table is the film's data
// rate, and it can be read from a file the browser could never decode.

async function bytes(file: File, start: number, end: number): Promise<DataView> {
  return new DataView(await file.slice(start, end).arrayBuffer());
}

function fourcc(view: DataView, at: number): string {
  return String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
}

async function findMoov(file: File): Promise<DataView | null> {
  let at = 0;
  for (let guard = 0; guard < 64 && at + 8 <= file.size; guard++) {
    const head = await bytes(file, at, at + 16);
    let size = head.getUint32(0);
    const type = fourcc(head, 4);
    let body = 8;
    if (size === 1 && head.byteLength >= 16) {
      size = head.getUint32(8) * 2 ** 32 + head.getUint32(12);
      body = 16;
    } else if (size === 0) {
      size = file.size - at;
    }
    if (size < 8) return null;
    if (type === 'moov') {
      if (size > 256 * 1024 * 1024) return null;
      return bytes(file, at + body, at + size);
    }
    at += size;
  }
  return null;
}

function children(view: DataView, start: number, end: number, each: (type: string, from: number, to: number) => void): void {
  let at = start;
  while (at + 8 <= end) {
    let size = view.getUint32(at);
    let body = 8;
    if (size === 1 && at + 16 <= end) {
      size = view.getUint32(at + 8) * 2 ** 32 + view.getUint32(at + 12);
      body = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < 8 || at + size > end) return;
    each(fourcc(view, at + 4), at + body, at + size);
    at += size;
  }
}

function videoSampleSizes(moov: DataView): Uint32Array | null {
  let found: Uint32Array | null = null;
  children(moov, 0, moov.byteLength, (t, a, b) => {
    if (t !== 'trak' || found) return;
    children(moov, a, b, (t2, a2, b2) => {
      if (t2 !== 'mdia') return;
      let isVideo = false;
      let sizes: Uint32Array | null = null;
      children(moov, a2, b2, (t3, a3, b3) => {
        if (t3 === 'hdlr' && a3 + 12 <= b3) isVideo = fourcc(moov, a3 + 8) === 'vide';
        if (t3 !== 'minf') return;
        children(moov, a3, b3, (t4, a4, b4) => {
          if (t4 !== 'stbl') return;
          children(moov, a4, b4, (t5, a5) => {
            if (t5 !== 'stsz') return;
            const uniform = moov.getUint32(a5 + 4);
            const count = moov.getUint32(a5 + 8);
            const out = new Uint32Array(count);
            for (let i = 0; i < count; i++) out[i] = uniform || moov.getUint32(a5 + 12 + i * 4);
            sizes = out;
          });
        });
      });
      if (isVideo && sizes) found = sizes;
    });
  });
  return found;
}

/** The file's data rate over its length, one value per step, or null if it has no table. */
export async function readDataRate(file: File, steps: number): Promise<Float32Array | null> {
  try {
    const moov = await findMoov(file);
    if (!moov) return null;
    const sizes = videoSampleSizes(moov);
    if (!sizes || sizes.length < 2) return null;
    const rate = new Float32Array(steps);
    const counts = new Float32Array(steps);
    for (let i = 0; i < sizes.length; i++) {
      const b = Math.min(steps - 1, Math.floor((i / sizes.length) * steps));
      rate[b] += sizes[i];
      counts[b] += 1;
    }
    for (let i = 0; i < steps; i++) rate[i] /= Math.max(counts[i], 1);
    const low = percentile(rate, 0.04);
    const high = percentile(rate, 0.985);
    const span = Math.max(high - low, 1);
    for (let i = 0; i < steps; i++) rate[i] = Math.max(0, Math.min(1, (rate[i] - low) / span));
    return rate;
  } catch {
    return null;
  }
}

/** A skyline of the file itself, or an even slab when even the table is missing. */
export function terrainPicture(rate: Float32Array | null): Picture {
  const w = RASTER_W;
  const h = Math.round(w / (16 / 9));
  const tone = new Float32Array(w * h);
  const rgb = new Uint8Array(w * h * 3);
  for (let x = 0; x < w; x++) {
    const v = rate ? rate[Math.min(rate.length - 1, Math.floor((x / w) * rate.length))] : 0.5;
    const ridge = (0.22 + 0.66 * v) * h;
    for (let y = 0; y < h; y++) {
      const up = h - y;
      if (rate) {
        const inside = up < ridge ? 1 : 0;
        const toRidge = Math.max(0, (ridge - up) / h);
        tone[y * w + x] = inside * (0.92 - 0.62 * Math.min(toRidge * 2.4, 1));
      } else {
        tone[y * w + x] = 0.5 + 0.28 * (y / h);
      }
    }
  }
  return { tone, rgb, w, h, aspect: 16 / 9, levels: [0, 1], terrain: true, at: 0 };
}
