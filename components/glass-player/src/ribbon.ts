'use client';

export type RibbonFrame = {
  /** Seconds of ribbon under the lens. */
  pos: number;
  /** Ribbon speed, seconds of music per second. */
  vel: number;
  span: number;
  lightX: number;
  lightY: number;
  light: boolean;
  dim: number;
};

export type RibbonTracks = {
  offsets: number[];
  total: number;
  tints: [number, number, number][];
  peaks: (number[] | undefined)[];
};

export interface RibbonRenderer {
  readonly kind: 'webgl' | '2d';
  resize(width: number, height: number, dpr: number): void;
  setTracks(tracks: RibbonTracks): void;
  draw(frame: RibbonFrame): void;
  destroy(): void;
}

const MAX = 16;
const TEX = 8192;

// Shared geometry, as fractions of the canvas height.
const HALF = 0.23;
const LENS = 0.46;

function bake(t: RibbonTracks) {
  const data = new Uint8Array(TEX);
  let i = 0;
  for (let x = 0; x < TEX; x++) {
    const g = ((x + 0.5) / TEX) * t.total;
    while (i < t.offsets.length - 2 && g >= t.offsets[i + 1]) i++;
    const p = t.peaks[i];
    let v = 0.5;
    if (p && p.length > 1) {
      const f = ((g - t.offsets[i]) / (t.offsets[i + 1] - t.offsets[i])) * (p.length - 1);
      const a = Math.min(p.length - 1, Math.max(0, Math.floor(f)));
      const b = Math.min(p.length - 1, a + 1);
      v = p[a] + (p[b] - p[a]) * (f - a);
    }
    data[x] = Math.round(Math.min(1, Math.max(0, v)) * 255);
  }
  return data;
}

const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uDpr, uPos, uSpan, uVel, uTotal, uLightTheme, uDim;
uniform vec2 uLight;
uniform int uCount;
uniform float uOffsets[${MAX + 1}];
uniform vec3 uTints[${MAX}];
uniform sampler2D uPeaks;
out vec4 outColor;

float peakAt(float g) { return texture(uPeaks, vec2(clamp(g / uTotal, 0.0, 1.0), 0.5)).r; }
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float grain(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float edgeOf(float g) {
  float p = 0.25 * peakAt(g - 0.045) + 0.5 * peakAt(g) + 0.25 * peakAt(g + 0.045);
  return 0.15 + 0.70 * pow(p, 0.85);
}
float reliefAt(float g, float v) {
  float a = edgeOf(g);
  return smoothstep(a + 0.11, a - 0.11, abs(v));
}

vec3 lightDir() { return normalize(vec3(uLight.x * 0.55 - 0.38, uLight.y * 0.55 - 0.62, 0.72)); }

// The ribbon and its shadow at one pixel, premultiplied. shift is in seconds of ribbon.
vec4 ribbonAt(vec2 q, float shift) {
  float hh = uRes.y * ${HALF};
  float mid = uRes.y * 0.5;
  float pps = uRes.x / uSpan;
  float g = uPos + (q.x - uRes.x * 0.5) / pps + shift;
  float v = (q.y - mid) / hh;
  float aa = 1.0 / hh;
  // Clear leader runs on past both ends of the music, so the first and last splice have something to join.
  float lead = uSpan * 0.62;
  float ends = smoothstep(-lead - 0.6 / pps, -lead + 0.6 / pps, g) * smoothstep(uTotal + lead + 0.6 / pps, uTotal + lead - 0.6 / pps, g);
  float music = step(0.0, g) * step(g, uTotal);
  float body = smoothstep(1.0 + aa, 1.0 - aa, abs(v)) * ends;

  float vs = (q.y - mid - hh * 0.16) / hh;
  float shadow = (uLightTheme > 0.5 ? 0.20 : 0.42) * smoothstep(1.34, 0.86, abs(vs)) * ends;

  vec3 tint = uTints[0];
  float seamD = 1e6;
  for (int i = 0; i < ${MAX}; i++) {
    if (i >= uCount) break;
    if (g >= uOffsets[i]) tint = uTints[i];
    seamD = min(seamD, abs(g + v * 2.6 * uDpr / pps - uOffsets[i]));
  }
  seamD = min(seamD, abs(g + v * 2.6 * uDpr / pps - uTotal));

  float dg = 1.5 / pps;
  float h = reliefAt(g, v) * music;
  float hx = (reliefAt(g + dg, v) - reliefAt(g - dg, v)) * music;
  float hy = (reliefAt(g, v + 0.045) - reliefAt(g, v - 0.045)) * music;
  // Brushed grain, long along the ribbon and fixed to it, so it travels with the music.
  float lines = grain(vec2(g * pps / uDpr * 0.035, q.y / uDpr * 0.9)) * 2.0 - 1.0;
  // The raised body is rounded like a bead of lacquer, so it carries a highlight along its upper side.
  float dome = clamp(v / edgeOf(g), -1.0, 1.0);
  vec3 n = normalize(vec3(-hx * 2.6, -hy * 2.2 + dome * 0.62 * h - lines * (0.03 + 0.05 * h), 1.0));
  vec3 L = lightDir();
  float diff = dot(n, L);
  float spec = pow(max(dot(n, normalize(L + vec3(0.0, 0.0, 1.0))), 0.0), 48.0);

  float played = smoothstep(0.04, -0.04, g - uPos) * (1.0 - uDim);
  vec3 milk = uLightTheme > 0.5 ? vec3(0.84, 0.86, 0.91) : vec3(0.50, 0.54, 0.64);
  // Unplayed ribbon keeps its colour but sits unlit and matte. Played ribbon is deep lacquer with a bright raised body.
  vec3 frost = uLightTheme > 0.5
    ? mix(tint, vec3(0.93, 0.94, 0.96), 0.56) * (0.86 + 0.14 * h)
    : mix(pow(tint, vec3(1.5)) * 0.40, tint * 0.58, h);
  vec3 gloss = mix(pow(tint, vec3(1.8)) * 0.72, tint * 1.06, h);
  vec3 col = mix(frost, gloss, played);
  col = mix(milk * 0.62, col, music);
  col *= 0.62 + 0.52 * diff;

  float bandY = -0.50 + uLight.y * 0.22;
  float band = exp(-pow((v - bandY) / 0.15, 2.0));
  float hair = exp(-pow((v - bandY + 0.03) / 0.035, 2.0));
  col += spec * mix(0.16, 0.75, played);
  col += (band * 0.11 + hair * 0.14) * played;
  col += band * 0.05 * (1.0 - played);
  col *= 1.0 - 0.42 * smoothstep(0.78, 1.0, abs(v));
  col += 0.10 * smoothstep(0.90, 0.95, -v) * smoothstep(1.0, 0.96, -v);

  float seam = smoothstep(1.7 * uDpr / pps, 0.7 * uDpr / pps, seamD);
  vec3 steel = vec3(0.88, 0.90, 0.94) * (0.50 + 0.50 * exp(-pow((v - bandY) / 0.5, 2.0)));
  col = mix(col, steel, seam * 0.92);

  float cover = body * mix(0.42, 1.0, music);
  return vec4(col * cover, cover) + (1.0 - cover) * vec4(0.0, 0.0, 0.0, shadow * mix(0.5, 1.0, music));
}

vec4 ribbon(vec2 q) {
  float blur = uVel * 0.012;
  float px = abs(blur) * uRes.x / uSpan;
  if (px < 0.8 * uDpr) return ribbonAt(q, 0.0);
  vec4 acc = vec4(0.0);
  float j = hash(q);
  for (int i = 0; i < 12; i++) acc += ribbonAt(q, ((float(i) + j) / 12.0 - 0.5) * blur);
  return acc / 12.0;
}

void main() {
  vec2 p = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 c = uRes * 0.5;
  float R = uRes.y * ${LENS};
  vec2 d = p - c;
  float r = length(d);
  float k = r / R;
  vec2 Ld = normalize(lightDir().xy);
  bool lightTheme = uLightTheme > 0.5;

  vec4 outside = vec4(0.0);
  if (r > R - 2.0 * uDpr) {
    outside = ribbon(p);
    // The lens throws a shadow away from the light, with a bright edge where it gathers light.
    vec2 sc = c - Ld * R * 0.11;
    float rs = length(p - sc);
    float sh = smoothstep(R * 1.20, R * 0.96, rs) * (lightTheme ? 0.26 : 0.46);
    outside = vec4(outside.rgb * (1.0 - sh), outside.a + (1.0 - outside.a) * sh);
    float far = pow(max(dot(normalize(p - sc), -Ld), 0.0), 2.5);
    float ca = exp(-pow((rs - R * 1.035) / (R * 0.035), 2.0)) * far;
    outside.rgb += ca * (0.34 * outside.a + 0.06);
    outside.a = min(1.0, outside.a + ca * 0.06);
  }

  vec4 inside = vec4(0.0);
  if (k < 1.0) {
    float s = mix(0.64, 0.98, pow(k, 5.0));
    float ch = 0.02 * k * k;
    vec4 cr = ribbon(c + d * s * (1.0 - ch));
    vec4 cg = ribbon(c + d * s);
    vec4 cb = ribbon(c + d * s * (1.0 + ch));
    inside = vec4(cr.r, cg.g, cb.b, (cr.a + cg.a + cb.a) / 3.0);

    // The body of the glass: a faint tint, darker where it is thickest to look through.
    float tintA = lightTheme ? 0.035 : 0.06;
    vec3 tintC = lightTheme ? vec3(0.42, 0.50, 0.62) : vec3(0.78, 0.86, 1.0);
    inside = vec4(inside.rgb * (1.0 - tintA) + tintC * tintA, inside.a + (1.0 - inside.a) * tintA);
    float thick = smoothstep(0.84, 1.0, k) * (lightTheme ? 0.16 : 0.20);
    inside = vec4(inside.rgb * (1.0 - thick), inside.a + (1.0 - inside.a) * thick);

    float nd = dot(d / max(r, 1e-4), Ld);
    float edge = smoothstep(1.0, 0.982, k) * smoothstep(0.945, 0.982, k);
    float rim = edge * (0.22 + 0.78 * pow(max(nd, 0.0), 2.0) + 0.30 * pow(max(-nd, 0.0), 6.0));
    float bevel = exp(-pow((k - 0.895) / 0.011, 2.0)) * (0.07 + 0.55 * pow(max(-nd, 0.0), 3.0));
    float sweep = exp(-pow((k - 0.70) / 0.065, 2.0)) * smoothstep(0.62, 0.97, nd);
    float add = rim * 0.95 + bevel * 0.62 + sweep * 0.17;
    if (lightTheme) {
      float line = edge * (0.30 + 0.5 * pow(max(-nd, 0.0), 2.0)) * 0.5;
      inside = vec4(inside.rgb * (1.0 - line), inside.a + (1.0 - inside.a) * line);
    }
    inside = vec4(inside.rgb + add, min(1.0, inside.a + add));
  }

  float m = smoothstep(R, R - 1.5 * uDpr, r);
  outColor = mix(outside, inside, m);
}`;

function createWebGL(canvas: HTMLCanvasElement): RibbonRenderer | null {
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, antialias: false, alpha: true });
  if (!gl) return null;
  const compile = (type: number, src: string) => {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.error(gl.getShaderInfoLog(sh));
      return null;
    }
    return sh;
  };
  const vs = compile(gl.VERTEX_SHADER, VERT);
  const fs = compile(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return null;
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error(gl.getProgramInfoLog(prog));
    return null;
  }
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, TEX, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(TEX).fill(128));
  const u = (name: string) => gl.getUniformLocation(prog, name);
  const U = {
    res: u('uRes'), dpr: u('uDpr'), pos: u('uPos'), span: u('uSpan'), vel: u('uVel'), total: u('uTotal'),
    theme: u('uLightTheme'), dim: u('uDim'), light: u('uLight'), count: u('uCount'), offsets: u('uOffsets'), tints: u('uTints'),
  };
  gl.uniform1i(u('uPeaks'), 0);
  gl.uniform1f(U.total, 1);
  gl.uniform1i(U.count, 0);
  let dpr = 1;

  return {
    kind: 'webgl',
    resize(width, height, ratio) {
      dpr = ratio;
      canvas.width = Math.max(1, Math.round(width * ratio));
      canvas.height = Math.max(1, Math.round(height * ratio));
      gl.viewport(0, 0, canvas.width, canvas.height);
    },
    setTracks(t) {
      const count = Math.min(MAX, t.tints.length);
      const offsets = new Float32Array(MAX + 1);
      const tints = new Float32Array(MAX * 3);
      for (let i = 0; i <= count; i++) offsets[i] = t.offsets[i] ?? t.total;
      for (let i = 0; i < count; i++) tints.set(t.tints[i], i * 3);
      gl.uniform1i(U.count, count);
      gl.uniform1fv(U.offsets, offsets);
      gl.uniform3fv(U.tints, tints);
      gl.uniform1f(U.total, Math.max(0.1, t.total));
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TEX, 1, gl.RED, gl.UNSIGNED_BYTE, bake(t));
    },
    draw(f) {
      gl.uniform2f(U.res, canvas.width, canvas.height);
      gl.uniform1f(U.dpr, dpr);
      gl.uniform1f(U.pos, f.pos);
      gl.uniform1f(U.span, f.span);
      gl.uniform1f(U.vel, f.vel);
      gl.uniform1f(U.theme, f.light ? 1 : 0);
      gl.uniform1f(U.dim, f.dim);
      gl.uniform2f(U.light, f.lightX, f.lightY);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    destroy() {
      gl.deleteTexture(tex);
      gl.deleteBuffer(buf);
      gl.deleteProgram(prog);
    },
  };
}

/** The plain version: the same ribbon and a lens that magnifies, without refraction or smear. */
function create2D(canvas: HTMLCanvasElement): RibbonRenderer {
  const main = canvas.getContext('2d')!;
  const band = document.createElement('canvas');
  const ctx = band.getContext('2d')!;
  let dpr = 1;
  let tracks: RibbonTracks = { offsets: [0], total: 0, tints: [], peaks: [] };
  let baked = new Uint8Array(TEX).fill(128);
  const css = (c: [number, number, number], k: number, mixTo?: [number, number, number], m = 0) => {
    const ch = (i: number) => Math.round(255 * Math.min(1, (mixTo ? c[i] + (mixTo[i] - c[i]) * m : c[i]) * k));
    return `rgb(${ch(0)} ${ch(1)} ${ch(2)})`;
  };
  return {
    kind: '2d',
    resize(width, height, ratio) {
      dpr = ratio;
      canvas.width = Math.max(1, Math.round(width * ratio));
      canvas.height = Math.max(1, Math.round(height * ratio));
      band.width = canvas.width;
      band.height = canvas.height;
    },
    setTracks(t) {
      tracks = t;
      baked = bake(t);
    },
    draw(f) {
      const W = canvas.width;
      const H = canvas.height;
      const hh = H * HALF;
      const mid = H / 2;
      const pps = W / f.span;
      const grey: [number, number, number] = f.light ? [0.8, 0.82, 0.86] : [0.3, 0.32, 0.38];
      ctx.clearRect(0, 0, W, H);
      const step = Math.max(1, Math.round(dpr));
      for (let x = 0; x < W; x += step) {
        const g = f.pos + (x - W / 2) / pps;
        const lead = f.span * 0.62;
        if (g < -lead || g > tracks.total + lead) continue;
        if (g < 0 || g > tracks.total) {
          ctx.fillStyle = f.light ? 'rgba(150,158,176,0.5)' : 'rgba(128,138,163,0.42)';
          ctx.fillRect(x, mid - hh, step, hh * 2);
          continue;
        }
        let i = 0;
        while (i < tracks.tints.length - 1 && g >= tracks.offsets[i + 1]) i++;
        const tint = tracks.tints[i] ?? [0.5, 0.5, 0.5];
        const amp = baked[Math.min(TEX - 1, Math.floor((g / tracks.total) * TEX))] / 255;
        const played = g < f.pos && f.dim < 0.5;
        const seam = i > 0 && Math.abs(g - tracks.offsets[i]) < (1.2 * dpr) / pps;
        ctx.fillStyle = seam ? 'rgb(214 219 228)' : played ? css(tint, 0.6) : css(tint, 0.82, grey, 0.66);
        ctx.fillRect(x, mid - hh, step, hh * 2);
        if (seam) continue;
        const a = (0.15 + 0.7 * Math.pow(amp, 0.85)) * hh;
        ctx.fillStyle = played ? css(tint, 1) : css(tint, 0.95, grey, 0.66);
        ctx.fillRect(x, mid - a, step, a * 2);
      }
      const sheen = ctx.createLinearGradient(0, mid - hh, 0, mid + hh);
      sheen.addColorStop(0, 'rgba(255,255,255,0.20)');
      sheen.addColorStop(0.3, 'rgba(255,255,255,0.04)');
      sheen.addColorStop(1, 'rgba(0,0,0,0.30)');
      ctx.globalCompositeOperation = 'source-atop';
      ctx.fillStyle = sheen;
      ctx.fillRect(0, mid - hh, W, hh * 2);
      ctx.globalCompositeOperation = 'source-over';
      main.clearRect(0, 0, W, H);
      main.drawImage(band, 0, 0);

      const R = H * LENS;
      const M = 1.5;
      main.save();
      main.beginPath();
      main.arc(W / 2, mid, R, 0, Math.PI * 2);
      main.clip();
      main.clearRect(W / 2 - R, mid - R, 2 * R, 2 * R);
      main.drawImage(band, W / 2 - R / M, mid - R / M, (2 * R) / M, (2 * R) / M, W / 2 - R, mid - R, 2 * R, 2 * R);
      main.fillStyle = f.light ? 'rgba(90,110,140,0.05)' : 'rgba(200,220,255,0.06)';
      main.fillRect(W / 2 - R, mid - R, 2 * R, 2 * R);
      main.restore();
      const rim = main.createLinearGradient(W / 2 - R, mid - R, W / 2 + R, mid + R);
      rim.addColorStop(0, 'rgba(255,255,255,0.95)');
      rim.addColorStop(0.5, f.light ? 'rgba(40,50,70,0.25)' : 'rgba(255,255,255,0.18)');
      rim.addColorStop(1, 'rgba(255,255,255,0.45)');
      main.strokeStyle = rim;
      main.lineWidth = 2 * dpr;
      main.beginPath();
      main.arc(W / 2, mid, R - dpr, 0, Math.PI * 2);
      main.stroke();
      main.strokeStyle = 'rgba(255,255,255,0.5)';
      main.lineWidth = 3 * dpr;
      main.lineCap = 'round';
      main.beginPath();
      main.arc(W / 2, mid, R * 0.72, Math.PI * 1.08, Math.PI * 1.38);
      main.stroke();
    },
    destroy() {},
  };
}

export function createRibbon(canvas: HTMLCanvasElement, prefer: 'auto' | '2d' = 'auto'): RibbonRenderer {
  if (prefer === 'auto') {
    const gl = createWebGL(canvas);
    if (gl) return gl;
  }
  return create2D(canvas);
}
