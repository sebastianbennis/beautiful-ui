'use client';

// The sky behind the banner. In a storm: backlit rain in depth, cloud that only shows when lightning
// is inside it, and mist low over the water. In clear weather: the sun, and cumulus drifting over
// the far edge of the water. It is soft, so it draws at low resolution.

import { FRONT_GLSL, PUFF_SIZE, puffTile } from './daylight';

const VERTEX = `#version 300 es
void main() {
  vec2 v = vec2(float(gl_VertexID == 1) * 4.0 - 1.0, float(gl_VertexID == 2) * 4.0 - 1.0);
  gl_Position = vec4(v, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;

uniform vec2 uRes;
uniform float uTime;
uniform float uFlash;
uniform float uFlashX;
uniform float uWater;
uniform vec3 uSky;
uniform vec3 uGlow;
uniform sampler2D uPuff;
uniform vec3 uZenith;
uniform vec3 uHaze;
uniform vec3 uCloud;
uniform vec3 uCloudShade;
uniform vec2 uSun;
uniform float uGlimmer;
${FRONT_GLSL}
out vec4 fragColor;

float sq(float x) {
  return x * x;
}

float hash(float n) {
  return fract(sin(n * 127.1) * 43758.5453);
}

float hash2(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2(1.0, 0.0)), f.x), mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), f.x), f.y);
}

float cloud(vec2 p, int octaves) {
  float v = 0.0;
  float a = 0.55;
  for (int i = 0; i < octaves; i++) {
    v += a * noise(p);
    p = mat2(1.6, 1.2, -1.2, 1.6) * p + 7.1;
    a *= 0.5;
  }
  return v;
}

// One sheet of rain. Each thin column carries a few long streaks that fall at their own speed.
float sheet(vec2 uv, float t, float columns, float speed, float len, float width, float density, float seed) {
  vec2 p = vec2(uv.x * columns, uv.y);
  float id = floor(p.x);
  float r = hash(id * 0.731 + seed);
  if (r > density) return 0.0;
  float fx = fract(p.x) - 0.5 - (hash(id + seed * 1.7) - 0.5) * 0.7;
  float rate = speed * (0.82 + 0.36 * hash(id + seed * 3.1));
  float y = fract(uv.y * 0.9 - t * rate + hash(id + seed * 5.3) * 17.0);
  float body = smoothstep(0.0, 0.016, y) * (1.0 - smoothstep(0.016, len, y));
  float line = 1.0 - smoothstep(0.0, width, abs(fx));
  return body * line * (0.45 + 0.55 * hash(id + seed * 9.1));
}

vec3 stormSky(vec2 frag, vec2 uv, float aspect, float t) {
  // The light comes from low and behind, the only way rain is ever really visible.
  float horizon = 1.0 - uWater;
  float low = exp(-sq((uv.y - horizon) / 0.42));
  float pool = exp(-sq((frag.x - 0.56) / 0.58));
  float back = low * (0.32 + 0.68 * pool);

  vec3 col = uSky;
  col += uGlow * back * 0.034;

  // Cloud is almost invisible until lightning burns inside it.
  vec2 cp = vec2(uv.x * 1.15, uv.y * 2.0);
  float warp = cloud(cp * 1.4 + vec2(t * 0.012, 0.0), 3);
  float c = cloud(cp + vec2(warp * 0.9 - t * 0.016, warp * 0.5), 4);
  float top = smoothstep(0.82, 0.0, uv.y);
  float billow = smoothstep(0.42, 0.92, c);
  col += uGlow * billow * top * 0.02;

  // Curtains of far-off rain, hanging from the cloud and leaning with the wind.
  float veil = cloud(vec2((uv.x + (uv.y - horizon) * 0.42) * 4.6 + t * 0.006, uv.y * 0.5 - t * 0.02), 3);
  float hang = smoothstep(horizon + 0.02, horizon - 0.1, uv.y) * smoothstep(0.12, 0.6, uv.y);
  col += uGlow * smoothstep(0.4, 0.78, veil) * hang * (0.006 + 0.03 * back);

  float flashAt = uFlashX * aspect;
  float burn = exp(-sq((uv.x - flashAt) / (0.36 + c * 0.42)));
  float bright = pow(smoothstep(0.42, 0.92, c), 1.6);
  col += uGlow * uFlash * top * (0.62 * burn * bright + 0.1 * burn + 0.08 * bright);
  col += uGlow * uFlash * 0.022;

  // Rain in depth: fine and dense far off, sparse and soft close to the glass.
  vec2 r = vec2(uv.x + uv.y * 0.085, uv.y);
  float far = sheet(r, t, 520.0, 1.45, 0.055, 0.2, 0.55, 3.0);
  float mid = sheet(r + 0.3, t, 250.0, 1.75, 0.09, 0.17, 0.42, 11.0);
  float near_ = sheet(r + 0.7, t, 96.0, 2.25, 0.16, 0.14, 0.3, 23.0);
  float glass = sheet(r + 1.3, t, 34.0, 2.9, 0.26, 0.2, 0.2, 41.0);
  float rain = far * 0.3 + mid * 0.5 + near_ * 0.72 + glass * 0.1;
  float above = smoothstep(horizon + 0.012, horizon - 0.02, uv.y);
  float lit = 0.05 + back * 0.8 + uFlash * 1.2;
  col += uGlow * rain * lit * above * 0.34;

  // Mist lying on the water, drifting slowly.
  float drift = cloud(vec2(uv.x * 2.2 + t * 0.03, uv.y * 6.0 - t * 0.01), 3);
  float mist = exp(-sq((uv.y - horizon + 0.03) / 0.09)) * smoothstep(0.25, 0.8, drift);
  col += uGlow * mist * (0.035 + uFlash * 0.4) * above;

  return col;
}

// How high a bank of cumulus stands above the far edge of the water at x.
float skyline(float x, float seed, float t) {
  float wide = noise(vec2(x * 1.15 + t * 0.002 + seed, 3.0 + seed));
  float mid = noise(vec2(x * 3.2 - t * 0.003, 7.0 + seed));
  float near_ = noise(vec2(x * 8.1, 11.0 + seed));
  return 0.006 + 0.1 * smoothstep(0.3, 0.86, wide) + 0.042 * mid * smoothstep(0.2, 0.6, wide) + 0.012 * near_;
}

// A far bank of cumulus, premultiplied: round on top, paler and bluer where it nears the water.
vec4 farBank(vec2 uv, float horizon, float seed, float scale, float haze, float t) {
  float top = horizon - skyline(uv.x / scale, seed, t) * scale;
  // Two samples at unrelated sizes, so the tile can never be seen repeating along the horizon.
  vec2 at = (uv + vec2(seed * 0.37 + t * 0.0016, seed)) / scale;
  float lobes = max(texture(uPuff, at * 2.3).r, texture(uPuff, at * 1.57 + vec2(0.41, 0.13)).r * 0.96);
  float small_ = texture(uPuff, at * 3.1 + vec2(0.17, 0.59)).g;
  float f = uv.y - top + (lobes * 0.8 + small_ * 0.2 - 0.52) * 0.06 * scale;
  float a = smoothstep(0.0, 0.007, f);
  if (a <= 0.001) return vec4(0.0);
  float height = clamp((uv.y - top) / max(horizon - top, 0.001), 0.0, 1.0);
  float soft = cloud(at * 7.0, 3);
  float lit = smoothstep(0.32, 0.66, soft + (0.5 - height) * 0.34);
  vec3 c = mix(mix(uCloudShade, uCloud, 0.3), uCloud, lit);
  c = mix(c, uHaze, haze);
  return vec4(c * a, a);
}

vec3 clearSky(vec2 frag, vec2 uv, float aspect, float t) {
  float horizon = 1.0 - uWater;
  float up = clamp((horizon - uv.y) / max(horizon, 0.01), 0.0, 1.0);
  vec3 col = mix(uHaze, uZenith, pow(up, 0.72));

  // No camera holds the sun: a blown-out core that burns off into a very wide glare.
  vec2 sun = vec2(uSun.x * aspect, uSun.y);
  // On a tall phone screen the same sun would fill the width, so it sits further away.
  float dist = length(uv - sun) * mix(1.75, 1.0, smoothstep(0.5, 1.25, aspect));
  vec3 sunlight = vec3(1.0, 0.95, 0.86);
  float boost = 1.0 + 0.8 * uGlimmer;
  col += sunlight * (5.0 * exp(-sq(dist / 0.026)) + 0.62 * exp(-dist / 0.06) + 0.36 * exp(-dist / 0.2) + 0.1 * exp(-dist / 0.55)) * boost;

  // A veil of very high, thin cloud.
  float thin = smoothstep(0.46, 0.74, cloud(vec2(uv.x * 1.3 + t * 0.003, uv.y * 8.0 - t * 0.002), 3));
  col = mix(col, uCloud, thin * 0.16 * smoothstep(0.05, 0.55, up));

  // Two banks standing on the far edge of the water, the farther one almost lost in the haze.
  vec4 back = farBank(uv, horizon, 5.0, 0.72, 0.62, t);
  col = col * (1.0 - back.a) + back.rgb;
  vec4 front_ = farBank(uv, horizon, 1.0, 1.0, 0.2, t);
  col = col * (1.0 - front_.a) + front_.rgb;

  // The last of the distance washes into the haze just above the water.
  col = mix(col, uHaze, 0.55 * exp(-sq((uv.y - horizon) / 0.03)));
  return col;
}

void main() {
  vec2 frag = gl_FragCoord.xy / uRes;
  vec2 uv = vec2(frag.x * uRes.x / uRes.y, 1.0 - frag.y);
  float aspect = uRes.x / uRes.y;
  float t = uTime;

  float k = dayAt(vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y));
  vec3 col = vec3(0.0);
  if (k < 0.999) col = stormSky(frag, uv, aspect, t);
  if (k > 0.001) col = mix(col, clearSky(frag, uv, aspect, t), k);
  // Light catches the edge between the two.
  col += vec3(1.0, 0.94, 0.84) * 4.0 * k * (1.0 - k) * 0.1;

  float grain = (hash2(gl_FragCoord.xy + fract(t) * 91.0) - 0.5) / 180.0;
  fragColor = vec4(pow(max(col, vec3(0.0)), vec3(1.0 / 2.2)) + grain, 1.0);
}`;

type Rgb = [number, number, number];

/** Where the edge between the two weathers has reached, in pixels. */
export interface FrontState {
  on: boolean;
  x: number;
  y: number;
  r: number;
  soft: number;
  amp: number;
  /** The weather outside the front: 0 storm, 1 clear. */
  base: number;
}

export class Weather {
  readonly ok: boolean = false;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private loc: Record<string, WebGLUniformLocation | null> = {};
  private readonly canvas: HTMLCanvasElement;
  private sky: Rgb = [0.0011, 0.0013, 0.0018];
  private glow: Rgb = [0.5, 0.56, 0.68];
  private zenith: Rgb = [0.14, 0.34, 0.7];
  private haze: Rgb = [0.74, 0.85, 0.92];
  private cloudWhite: Rgb = [1, 0.99, 0.97];
  private cloudShade: Rgb = [0.5, 0.6, 0.76];
  private w = 0;
  private h = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ok = this.setup();
  }

  private setup(): boolean {
    const gl = this.canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false });
    if (!gl) return false;
    const compile = (type: number, source: string): WebGLShader | null => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.warn('pendant: storm shader failed to compile', gl.getShaderInfoLog(shader));
        return null;
      }
      return shader;
    };
    const vertex = compile(gl.VERTEX_SHADER, VERTEX);
    const fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT);
    const program = gl.createProgram();
    if (!vertex || !fragment || !program) return false;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return false;
    gl.useProgram(program);
    gl.bindVertexArray(gl.createVertexArray());
    this.loc = Object.fromEntries(
      ['uRes', 'uTime', 'uFlash', 'uFlashX', 'uWater', 'uSky', 'uGlow', 'uPuff', 'uZenith', 'uHaze', 'uCloud', 'uCloudShade', 'uSun', 'uGlimmer', 'uFront', 'uFrontEdge', 'uDayBase'].map((n) => [
        n,
        gl.getUniformLocation(program, n),
      ]),
    );
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, PUFF_SIZE, PUFF_SIZE, 0, gl.RGBA, gl.FLOAT, puffTile());
    this.gl = gl;
    this.program = program;
    return true;
  }

  setColours(sky: Rgb, glow: Rgb): void {
    this.sky = sky;
    this.glow = glow;
  }

  setDayColours(zenith: Rgb, haze: Rgb, cloud: Rgb, shade: Rgb): void {
    this.zenith = zenith;
    this.haze = haze;
    this.cloudWhite = cloud;
    this.cloudShade = shade;
  }

  resize(width: number, height: number): void {
    // The storm is soft, so it never needs more than one pixel per CSS pixel.
    const w = Math.round(width);
    const h = Math.round(height);
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this.w = w;
    this.h = h;
    this.gl?.viewport(0, 0, w, h);
  }

  draw(time: number, flash: number, flashX: number, water: number, front: FrontState, sun: [number, number], glimmer: number): void {
    const gl = this.gl;
    if (!gl || this.w === 0) return;
    const l = this.loc;
    gl.uniform2f(l.uRes, this.w, this.h);
    gl.uniform1f(l.uTime, time);
    gl.uniform1f(l.uFlash, flash);
    gl.uniform1f(l.uFlashX, flashX);
    gl.uniform1f(l.uWater, water);
    gl.uniform3fv(l.uSky, this.sky);
    gl.uniform3fv(l.uGlow, this.glow);
    gl.uniform3fv(l.uZenith, this.zenith);
    gl.uniform3fv(l.uHaze, this.haze);
    gl.uniform3fv(l.uCloud, this.cloudWhite);
    gl.uniform3fv(l.uCloudShade, this.cloudShade);
    gl.uniform2f(l.uSun, sun[0], sun[1]);
    gl.uniform1f(l.uGlimmer, glimmer);
    gl.uniform4f(l.uFront, front.x, front.y, front.on ? Math.max(front.r, 0.001) : 0, 0);
    gl.uniform2f(l.uFrontEdge, Math.max(front.soft, 1), front.amp);
    gl.uniform1f(l.uDayBase, front.base);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  destroy(): void {
    if (this.gl && this.program) this.gl.deleteProgram(this.program);
    this.gl = null;
    this.program = null;
  }
}

/** A bolt, drawn once per strike. Only its opacity changes after that. */
export function drawBolt(canvas: HTMLCanvasElement, width: number, height: number, x: number, ground: number, random: () => number): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const c = canvas.getContext('2d');
  if (!c) return;
  c.scale(dpr, dpr);
  c.clearRect(0, 0, width, height);
  c.lineCap = 'round';
  c.lineJoin = 'round';

  // Midpoint displacement gives lightning its long runs and sudden kinks.
  const walk = (x0: number, y0: number, x1: number, y1: number, rough: number, depth: number): Array<[number, number]> => {
    if (depth === 0) return [[x0, y0], [x1, y1]];
    const mx = (x0 + x1) / 2 + (random() - 0.5) * rough;
    const my = (y0 + y1) / 2 + (random() - 0.5) * rough * 0.24;
    return [...walk(x0, y0, mx, my, rough * 0.56, depth - 1).slice(0, -1), ...walk(mx, my, x1, y1, rough * 0.56, depth - 1)];
  };

  const trace = (points: Array<[number, number]>, width_: number, glow: number): void => {
    c.beginPath();
    points.forEach(([px, py], i) => (i === 0 ? c.moveTo(px, py) : c.lineTo(px, py)));
    c.shadowColor = 'rgba(190, 210, 255, 0.9)';
    c.shadowBlur = glow;
    c.strokeStyle = 'rgba(244, 248, 255, 0.96)';
    c.lineWidth = width_;
    c.stroke();
  };

  const main = walk(x + (random() - 0.5) * 80, -10, x, ground, Math.min(260, height * 0.26), 6);
  trace(main, 2.6, 30);
  trace(main, 1.2, 8);

  const branches = 3 + Math.floor(random() * 3);
  for (let i = 0; i < branches; i++) {
    const at = 8 + Math.floor(random() * (main.length - 22));
    const [bx, by] = main[at];
    const side = random() < 0.5 ? -1 : 1;
    const reach = (ground - by) * (0.2 + random() * 0.36);
    const branch = walk(bx, by, bx + side * reach * (0.36 + random() * 0.5), by + reach, 90, 4);
    trace(branch, 1, 12);
  }
}
