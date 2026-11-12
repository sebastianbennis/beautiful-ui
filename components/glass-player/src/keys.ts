'use client';

export type KeysFrame = {
  /** Five keys, four numbers each, in CSS pixels of the canvas: centre x, centre y, half width, half height. */
  rects: Float32Array;
  /** Per key: depth (0 up, 1 fully down), light level, how far the light has spread, how switched off it is. */
  state: Float32Array;
  /** Per key: where it was touched, from its centre in CSS pixels, then how hard it is held. */
  touch: Float32Array;
  unit: number;
  lightX: number;
  lightY: number;
  light: boolean;
  tint: [number, number, number];
  /** The pointer over the keys in CSS pixels of the canvas, and how present it is. */
  pointer: [number, number, number];
};

export interface KeysRenderer {
  resize(width: number, height: number, dpr: number): void;
  draw(frame: KeysFrame): void;
  destroy(): void;
}

const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

// Five slabs of thick glass seen from above. Each has a rounded shoulder, sits in a seat in the deck,
// throws a shadow that tightens as it goes down, and carries the ribbon's colour inside it when lit.
const FRAG = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uDpr, uUnit, uLightTheme;
uniform vec2 uLight;
uniform vec3 uPointer;
uniform vec3 uTint;
uniform vec4 uRect[5];
uniform vec4 uState[5];
uniform vec4 uTouch[5];
out vec4 outColor;

vec3 lightDir() { return normalize(vec3(uLight.x * 0.55 - 0.38, uLight.y * 0.55 - 0.62, 0.72)); }

float box(vec2 q, vec2 hw, float r) {
  vec2 d = abs(q) - hw + r;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
}
vec2 boxGrad(vec2 q, vec2 hw, float r) {
  vec2 d = abs(q) - hw + r;
  vec2 s = vec2(q.x < 0.0 ? -1.0 : 1.0, q.y < 0.0 ? -1.0 : 1.0);
  if (d.x > 0.0 && d.y > 0.0) return s * normalize(d);
  return d.x > d.y ? vec2(s.x, 0.0) : vec2(0.0, s.y);
}
vec4 over(vec4 top, vec4 under) { return top + under * (1.0 - top.a); }

void main() {
  vec2 p = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec3 L = lightDir();
  vec3 L0 = normalize(vec3(-0.38, -0.62, 0.72));
  vec2 Ld = normalize(L.xy);
  bool day = uLightTheme > 0.5;
  float u = uUnit;

  float shade = 0.0;
  vec3 glow = vec3(0.0);
  for (int i = 0; i < 5; i++) {
    vec4 R = uRect[i];
    vec4 S = uState[i];
    if (R.z <= 0.0) continue;
    float lift = max(0.0, 1.0 - S.x) * (1.0 - 0.7 * S.w);
    vec2 c = R.xy + vec2(0.0, S.x * 0.12 * u);
    vec2 hw = R.zw * (1.0 - 0.012 * S.x);
    float r = min(2.0 * u, min(hw.x, hw.y));
    float sd = box(p - c, hw, r);
    if (sd > u * 4.5) continue;

    float seat = smoothstep(2.2 * uDpr, 0.4 * uDpr, sd) * (day ? 0.16 : 0.5);
    vec2 so = -Ld * u * (0.16 + 0.8 * lift);
    float sds = box(p - c - so, hw, r);
    float blur = u * (0.3 + 1.5 * lift);
    float amb = smoothstep(blur, -blur * 0.7, sds) * (day ? 0.22 : 0.5);
    float con = smoothstep(u * 0.34, -u * 0.12, box(p - c + Ld * u * 0.1, hw, r)) * (day ? 0.2 : 0.5);
    if (day) {
      // Clear glass lets the light through, so the deck under it stays bright.
      float under = 1.0 - 0.78 * smoothstep(0.0, -0.9 * u, sd);
      amb *= under;
      con *= under;
    }
    shade = max(shade, 1.0 - (1.0 - seat) * (1.0 - amb) * (1.0 - con));

    // A lit key spills a little of its colour onto the deck right beside it.
    glow += uTint * S.y * exp(-max(sd, 0.0) / (u * 0.42)) * step(0.0, sd) * (day ? 0.0 : 0.11);
  }
  vec3 shadeC = day ? vec3(0.17, 0.21, 0.33) : vec3(0.008, 0.012, 0.03);
  vec4 col = vec4(shadeC * shade + glow * (day ? 1.0 - shade * 0.5 : 1.0), min(1.0, shade + dot(glow, vec3(0.2))));

  for (int i = 0; i < 5; i++) {
    vec4 R = uRect[i];
    vec4 S = uState[i];
    vec4 T = uTouch[i];
    if (R.z <= 0.0) continue;
    vec2 c = R.xy + vec2(0.0, S.x * 0.12 * u);
    vec2 hw = R.zw * (1.0 - 0.012 * S.x);
    float r = min(2.0 * u, min(hw.x, hw.y));
    vec2 q = p - c;
    float sd = box(q, hw, r);
    if (sd > uDpr) continue;
    float cover = smoothstep(0.7 * uDpr, -0.7 * uDpr, sd);
    float on = 1.0 - 0.62 * S.w;

    float e = max(-sd, 0.0);
    float b = 0.95 * u;
    float t = clamp(e / b, 0.0, 1.0);
    float slope = min((1.0 - t) / sqrt(max(1.0 - (1.0 - t) * (1.0 - t), 0.03)), 2.6);
    vec2 g = boxGrad(q, hw, r);
    vec2 o = T.xy * uDpr;
    // Held off centre, the slab leans toward the finger.
    vec2 lean = o / hw * T.z * 0.09;
    vec3 n = normalize(vec3(g * slope * 0.95 + q / hw * vec2(0.07, 0.12) + lean, 1.0));
    vec3 V = vec3(0.0, 0.0, 1.0);

    // The shoulders catch the lamp wherever the pointer takes it. The flat top keeps the sheen it has at rest:
    // if it followed the lamp too, every key would grey over like satin plastic whenever the pointer came near.
    vec3 nTop = normalize(vec3(g * slope * 0.95 + q / hw * vec2(0.07, 0.12), 1.0));
    float specTop = pow(max(dot(nTop, normalize(L0 + V)), 0.0), 36.0);
    float spec = mix(pow(max(dot(n, normalize(L + V)), 0.0), 36.0), specTop, smoothstep(0.62, 1.0, t));
    float kick = pow(max(dot(g, -Ld), 0.0), 2.0) * pow(1.0 - t, 1.5) * step(0.001, 1.0 - t);
    vec2 toP = uPointer.xy * uDpr - p;
    vec3 Lp = normalize(vec3(toP, u * 4.5));
    float near = exp(-dot(toP, toP) / pow(u * 15.0, 2.0)) * uPointer.z;
    float specP = pow(max(dot(n, normalize(Lp + V)), 0.0), 26.0) * near;
    float edgeP = pow(max(dot(g, normalize(toP + 0.001)), 0.0), 2.0) * pow(1.0 - t, 1.2) * step(0.001, 1.0 - t) * near;

    // The body: smoked in the dark, clear on porcelain. Thicker to look through at the shoulder.
    float toward = 0.5 + 0.5 * clamp(dot(q / hw, Ld) / 1.3, -1.0, 1.0);
    vec4 glass = day
      ? vec4(vec3(1.0), 1.0) * (0.16 + 0.26 * toward) * (0.55 + 0.45 * on)
      : vec4(vec3(0.02, 0.028, 0.05), 1.0) * (0.64 - 0.16 * toward) * on;
    float thick = pow(1.0 - t, 2.0) * (day ? 0.12 : 0.3) * on;
    glass = over(vec4(day ? vec3(0.3, 0.36, 0.5) * thick : vec3(0.0), thick), glass);
    float veil = (day ? 0.0 : 0.012 + 0.03 * toward) * on;
    glass = vec4(glass.rgb + veil, min(1.0, glass.a + veil));

    // The colour arrives where the key was touched and spreads to its edges.
    float soft = hw.y * 1.3;
    float reach = S.z * (length(abs(o) + hw) + soft);
    float dist = length(q - o);
    float m = S.y * smoothstep(reach, reach - soft, dist);
    float front = S.y * (1.0 - S.z) * exp(-pow((dist - reach + soft * 0.5) / (soft * 0.3), 2.0));
    float down = smoothstep(-1.0, 1.0, q.y / hw.y);
    if (day) {
      float am = m * (0.2 + 0.26 * down + 0.3 * pow(1.0 - t, 1.5)) + front * 0.25;
      glass = over(vec4(mix(uTint, uTint * uTint, 0.25) * am, am), glass);
    } else {
      vec3 em = uTint * (m * (0.12 + 0.3 * down * down + 0.3 * pow(1.0 - t, 1.7)) + front * 0.3);
      glass = vec4(glass.rgb + em, min(1.0, glass.a + dot(em, vec3(0.4))));
    }

    // Light on the glass: the shoulder facing the lamp, the far shoulder lit from inside, the foot of the shoulder, the pointer.
    float foot = exp(-pow((e - b) / (0.075 * u), 2.0));
    float footHi = foot * (0.012 + 0.2 * pow(max(dot(g, -Ld), 0.0), 2.0));
    float hair = smoothstep(0.0, 1.1 * uDpr, e) * smoothstep(2.6 * uDpr, 1.1 * uDpr, e) * (0.16 + 0.84 * pow(max(dot(g, Ld), 0.0), 1.5));
    // Light that entered the slab pools on the side away from the lamp, in the key's own colour when lit.
    float away = clamp(dot(q / hw, -Ld) / 1.25, 0.0, 1.0);
    float gather = pow(away, 2.2) * exp(-max(e - b, 0.0) / (u * 1.5)) * smoothstep(0.0, b, e);
    // The lamp itself, mirrored as a thin line just inside the shoulder that faces it.
    float win = exp(-pow((e - b - 0.34 * u) / (0.1 * u), 2.0)) * pow(max(dot(g, Ld), 0.0), 3.0);
    float add = (spec * (day ? 0.5 : 0.72) + kick * (day ? 0.3 : 0.13) + footHi + hair * (day ? 0.9 : 0.5) + win * (day ? 0.7 : 0.14)) * on
      + specP * (day ? 0.08 : 0.025) + edgeP * (day ? 0.5 : 0.42);
    vec3 pool = mix(vec3(1.0), uTint * 1.3, m) * gather * (day ? 0.45 : 0.13 + 0.25 * m) * on;
    if (day) {
      // Clear glass shows by its dark lines: the shoulder away from the lamp and the rim.
      float line = (pow(max(dot(g, -Ld), 0.0), 1.5) * pow(1.0 - t, 1.2) * 0.2 + foot * 0.05 * pow(max(dot(g, Ld), 0.0), 2.0)) * on;
      glass = over(vec4(vec3(0.2, 0.25, 0.4) * line, line), glass);
      float rim = smoothstep(1.5 * uDpr, 0.0, e) * (0.1 + 0.16 * pow(max(dot(g, -Ld), 0.0), 1.5));
      glass = over(vec4(vec3(0.2, 0.25, 0.4) * rim, rim), glass);
    }
    glass = vec4(glass.rgb + add + pool, min(1.0, glass.a + add + max(pool.r, max(pool.g, pool.b))));
    col = over(glass * cover, col);
  }
  outColor = col;
}`;

/** The glass keys. Returns null when WebGL2 is missing, and the keys stay as they are drawn in CSS. */
export function createKeys(canvas: HTMLCanvasElement): KeysRenderer | null {
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
  const u = (name: string) => gl.getUniformLocation(prog, name);
  const U = {
    res: u('uRes'), dpr: u('uDpr'), unit: u('uUnit'), theme: u('uLightTheme'), light: u('uLight'),
    pointer: u('uPointer'), tint: u('uTint'), rect: u('uRect'), state: u('uState'), touch: u('uTouch'),
  };
  let dpr = 1;
  const rects = new Float32Array(20);

  return {
    resize(width, height, ratio) {
      dpr = ratio;
      canvas.width = Math.max(1, Math.round(width * ratio));
      canvas.height = Math.max(1, Math.round(height * ratio));
      gl.viewport(0, 0, canvas.width, canvas.height);
    },
    draw(f) {
      for (let i = 0; i < 20; i++) rects[i] = f.rects[i] * dpr;
      gl.uniform2f(U.res, canvas.width, canvas.height);
      gl.uniform1f(U.dpr, dpr);
      gl.uniform1f(U.unit, f.unit * dpr);
      gl.uniform1f(U.theme, f.light ? 1 : 0);
      gl.uniform2f(U.light, f.lightX, f.lightY);
      gl.uniform3f(U.pointer, f.pointer[0], f.pointer[1], f.pointer[2]);
      gl.uniform3f(U.tint, f.tint[0], f.tint[1], f.tint[2]);
      gl.uniform4fv(U.rect, rects);
      gl.uniform4fv(U.state, f.state);
      gl.uniform4fv(U.touch, f.touch);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    destroy() {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.deleteBuffer(buf);
      gl.deleteProgram(prog);
    },
  };
}
