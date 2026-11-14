/** GLSL: the light of the pointer's lamp as the walls catch it, the shape of the body as it divides, its shadow, and the final picture. */

const WALL = /* glsl */ `
const float PI = 3.14159265;

// A point this far round the outline of a rounded rectangle (half width, half height, corner radius),
// the outward normal there, and how tightly the outline turns.
void wallAt(vec3 box, float s, out vec2 p, out vec2 n, out float k) {
  float a = box.x, b = box.y, r = box.z;
  float fx = 2.0 * (a - r), fy = 2.0 * (b - r), q = 0.5 * PI * r;
  float rr = max(r, 1e-4);
  k = 0.0;
  if (s < fx) { p = vec2(-(a - r) + s, -b); n = vec2(0.0, -1.0); return; }
  s -= fx;
  k = 1.0 / rr;
  if (s < q) { float t = s / rr; n = vec2(sin(t), -cos(t)); p = vec2(a - r, -(b - r)) + r * n; return; }
  s -= q;
  k = 0.0;
  if (s < fy) { p = vec2(a, -(b - r) + s); n = vec2(1.0, 0.0); return; }
  s -= fy;
  k = 1.0 / rr;
  if (s < q) { float t = s / rr; n = vec2(cos(t), sin(t)); p = vec2(a - r, b - r) + r * n; return; }
  s -= q;
  k = 0.0;
  if (s < fx) { p = vec2((a - r) - s, b); n = vec2(0.0, 1.0); return; }
  s -= fx;
  k = 1.0 / rr;
  if (s < q) { float t = s / rr; n = vec2(-sin(t), cos(t)); p = vec2(-(a - r), b - r) + r * n; return; }
  s -= q;
  k = 0.0;
  if (s < fy) { p = vec2(-a, (b - r) - s); n = vec2(-1.0, 0.0); return; }
  s -= fy;
  k = 1.0 / rr;
  float t = s / rr; n = vec2(-cos(t), -sin(t)); p = vec2(-(a - r), -(b - r)) + r * n;
}
`;

const CAVITY = /* glsl */ `
uniform vec3 uCav;    // the widest line of the body, a little in from the edge: half width, half height, corner radius
uniform float uWall;  // how tall the wall is that turns the light back

// From a point inside, along a unit direction, to the wall. n is the outward normal there.
float exitDist(vec2 p, vec2 d, out vec2 n) {
  vec2 c = uCav.xy - uCav.z;
  float r = uCav.z;
  float best = 1e9;
  n = vec2(0.0, 1.0);
  if (abs(d.x) > 1e-6) {
    float sx = sign(d.x);
    float t = (sx * uCav.x - p.x) / d.x;
    if (t > 1e-3 && t < best && abs(p.y + t * d.y) <= c.y) { best = t; n = vec2(sx, 0.0); }
  }
  if (abs(d.y) > 1e-6) {
    float sy = sign(d.y);
    float t = (sy * uCav.y - p.y) / d.y;
    if (t > 1e-3 && t < best && abs(p.x + t * d.x) <= c.x) { best = t; n = vec2(0.0, sy); }
  }
  if (r > 0.0) {
    for (int i = 0; i < 4; i++) {
      vec2 s = vec2((i & 1) == 1 ? 1.0 : -1.0, (i & 2) == 2 ? 1.0 : -1.0);
      vec2 o = p - s * c;
      float bq = dot(o, d);
      float disc = bq * bq - dot(o, o) + r * r;
      if (disc >= 0.0) {
        float t = -bq + sqrt(disc);
        vec2 h = o + t * d;
        if (t > 1e-3 && t < best && h.x * s.x >= 0.0 && h.y * s.y >= 0.0) { best = t; n = h / r; }
      }
    }
  }
  return best;
}
`;

/**
 * The body: a solid piece of clear crystal, round over the top and round underneath, lying on the page.
 * Seen from straight above, z is up, and z = 0 is the body's widest line.
 */
const BODY = /* glsl */ `
const float IOR = 1.52;
uniform vec2 uHalf;    // half the body's width and height
uniform float uRad;    // its corner radius
uniform float uBevel;  // how far in from the edge the surface is still curving
uniform float uRise;   // half its thickness

float sdBox(vec2 p, vec2 h, float r) {
  vec2 q = abs(p) - h + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

vec2 boxNormal(vec2 p, vec2 h, float r) {
  vec2 q = abs(p) - h + r;
  vec2 s = vec2(p.x < 0.0 ? -1.0 : 1.0, p.y < 0.0 ? -1.0 : 1.0);
  if (q.x > 0.0 && q.y > 0.0) return normalize(q) * s;
  return q.x > q.y ? vec2(s.x, 0.0) : vec2(0.0, s.y);
}

// How high the surface stands above the widest line this far in from the edge, and how steeply it climbs.
vec2 dome(float d) {
  float q = 1.0 - clamp(d / uBevel, 0.0, 1.0);
  float f = sqrt(max(1.0 - q * q, 0.0));
  return vec2(uRise * f, uRise / uBevel * q / max(f, 0.05));
}

// How much light a clear surface throws back. eta: the index it is going into over the one it is in.
float fresnel(float c, float eta) {
  c = clamp(c, 0.0, 1.0);
  float s2 = (1.0 - c * c) / (eta * eta);
  if (s2 >= 1.0) return 1.0;
  float t = sqrt(1.0 - s2);
  float rs = (c - eta * t) / (c + eta * t);
  float rp = (eta * c - t) / (eta * c + t);
  return 0.5 * (rs * rs + rp * rp);
}
`;

/**
 * The light of the pointer's lamp, as the walls catch it. The mesh is the wall unrolled: x runs round it, y runs up it.
 * Each vertex is moved to the spot where its ray ends up after bouncing, so the mesh
 * folds exactly where real light folds, and how much it is squeezed is how bright it is.
 */
export const CAUSTIC_VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aUV;
${WALL}
${CAVITY}
uniform vec3 uLamp;    // x, y and height
uniform float uPower;
uniform float uSoft;   // the lamp is not a point: softens the 1/d2 falloff
uniform float uRho;    // how much light survives a bounce
uniform vec2 uView;    // half the canvas, in the same pixels
out float vE;
out float vOk;
out float vWall;
out vec2 vUV;

void main() {
  float a = uCav.x, b = uCav.y, r = uCav.z;
  float perim = 4.0 * (a - r) + 4.0 * (b - r) + 2.0 * PI * r;
  vec2 W, n;
  float turn;
  wallAt(uCav, aUV.x * perim, W, n, turn);
  float z = aUV.y * uWall;
  vWall = perim * uWall;

  vec2 dh = W - uLamp.xy;
  float D = max(length(dh), 1e-3);
  vec2 dn = dh / D;
  float facing = dot(dn, n);       // above zero: the ray meets the inside of the wall
  float drop = uLamp.z - z;        // above zero: the ray is still coming down
  float ok = step(0.0, facing) * step(0.0, drop);

  // A lamp outside has to clear the top of the near wall first.
  vec2 nn;
  float te = exitDist(W - n * 0.02, -dn, nn);
  float zEntry = z + drop * (te / D);
  float clear = te < D ? smoothstep(uWall * 0.96, uWall * 1.1, zEntry) : 1.0;

  float d3 = sqrt(D * D + drop * drop);
  // Light that only skims along the wall is not thrown back, and what lands on its
  // top edge scatters instead of drawing a hard line.
  float skim = smoothstep(0.06, 0.32, facing);
  float lip = 1.0 - smoothstep(0.45, 1.0, aUV.y);
  float E = uPower * clear * skim * lip * max(facing, 0.0) * (D / d3) / (d3 * d3 + uSoft * uSoft);

  vec2 dir = dn - 2.0 * facing * n;
  float slope = max(drop, 1e-4) / D;
  float left = z / slope;          // how far it still flies before it comes to rest
  vec2 p = W - n * 0.02;
  bool landed = false;
  for (int i = 0; i < 10; i++) {
    float t = exitDist(p, dir, nn);
    if (t >= left) { p += dir * left; landed = true; break; }
    p += dir * t - nn * 0.02;
    dir -= 2.0 * dot(dir, nn) * nn;
    left -= t;
    E *= uRho;
  }
  if (!landed) ok = 0.0;

  vE = E * perim * uWall;
  vOk = ok;
  vUV = aUV;
  gl_Position = vec4(p / uView * vec2(1.0, -1.0), 0.0, 1.0);
}
`;

export const CAUSTIC_FS = /* glsl */ `#version 300 es
precision highp float;
in float vE;
in float vOk;
in float vWall;
in vec2 vUV;
uniform float uPix;   // device pixels per pixel
out vec4 o;
void main() {
  if (vOk < 0.999) discard;
  // How much wall is squeezed into this pixel.
  float squeeze = abs(dFdx(vUV.x) * dFdy(vUV.y) - dFdx(vUV.y) * dFdy(vUV.x)) * uPix * uPix;
  // Clear glass shows light only where it gathers. Light that is merely spread about stays unseen,
  // so what is left is the fine bright curves where it folds over itself.
  float gathered = smoothstep(0.6, 2.6, vWall * squeeze);
  o = vec4(min(vE * squeeze * gathered, 9.0), 0.0, 0.0, 0.0);
}
`;

export const QUAD_VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

/**
 * The shape of the body, written down for the picture to read: how high its surface stands at every
 * point, which way it slopes, and how far it is to the edge of the piece that point belongs to.
 * At rest the body is one piece. After a press it comes apart into cells, the way tissue looks
 * under a microscope: furrows open between their hearts in a wave that starts where it was pressed,
 * and each cell rounds off into a small body of its own.
 */
export const SHAPE_FS = /* glsl */ `#version 300 es
precision highp float;
${BODY}
uniform vec2 uRes;
uniform float uPix;
uniform vec4 uCell[32];  // x, y: the heart of a cell. z: the light it keeps. w: the light passing through it
uniform float uOwn[32];  // a number of each cell's own
uniform int uCount;
uniform vec2 uPress;     // where the body was pressed
uniform float uAge;      // ms since then
uniform float uShut;     // ms since the cells began to close up again, below zero while they have not
uniform float uSpeed;    // how fast the wave travels, in pixels a ms
uniform float uOpening;  // how long a furrow takes to open once the wave reaches it, in ms
uniform float uCrease;   // how wide the shoulder of a furrow is
layout(location = 0) out vec4 oShape;
layout(location = 1) out vec4 oCell;
layout(location = 2) out vec4 oMore;

float ease(float x) { x = clamp(x, 0.0, 1.0); return 1.0 - (1.0 - x) * (1.0 - x) * (1.0 - x); }

void main() {
  vec2 P = (gl_FragCoord.xy - 0.5 * uRes) / uPix;
  P.y = -P.y;
  float sd = sdBox(P, uHalf, uRad);
  // A hair beyond the edge the shape is still written down, as the edge itself, so the outermost
  // pixels of the picture have something true to read.
  if (sd >= 2.0 / uPix) { oShape = vec4(0.0); oCell = vec4(0.0); oMore = vec4(0.0, 1.0, 0.0, 0.0); return; }

  // The undivided body.
  float dEdge = max(-sd, 0.0);
  vec2 dm = dome(dEdge);
  vec2 uphill = -boxNormal(P, uHalf, uRad) * dm.y;

  float keep = 1.0;          // how much of that height the furrows leave
  vec2 keepUp = vec2(0.0);
  float light = 0.0, flash = 0.0, own = 0.5, spark = 0.0, apart = 0.0;
  // How far the body has closed up again here. Whole, it counts as closed.
  float closed = 1.0;
  if (uCount > 1) {
    // The wave: nothing has happened yet beyond it, and behind it the furrows are open.
    float far = distance(P, uPress);
    float since = uAge - far / uSpeed;
    apart = ease(since / uOpening);
    closed = uShut >= 0.0 ? ease((uShut - far / (uSpeed * 1.8)) / (uOpening * 0.9)) : 0.0;
    apart *= 1.0 - closed;
  }
  if (apart > 0.0) {
    // Seen a little bent, so no furrow runs dead straight.
    float k = 6.2832 / (uCrease * 6.5);
    vec2 W = P + uCrease * 0.42 * vec2(sin(P.y * k + 1.3), sin(P.x * k * 1.13 + 4.1));
    int me = 0;
    float best = 1e18;
    for (int i = 0; i < 32; i++) {
      if (i >= uCount) break;
      vec2 q = W - uCell[i].xy;
      float dd = dot(q, q);
      if (dd < best) { best = dd; me = i; }
    }
    vec2 heart = uCell[me].xy;
    float reach = uCrease * max(apart, 1e-3);
    float sum = 0.0, share = 1.0, least = 1e9;
    vec2 away = vec2(0.0);
    light = uCell[me].z;
    spark = uCell[me].w;
    own = uOwn[me];
    for (int j = 0; j < 32; j++) {
      if (j >= uCount) break;
      if (j == me) continue;
      vec2 e = uCell[j].xy - heart;
      vec2 n = e / max(length(e), 1e-3);
      // How far it is to the furrow between this cell and that one.
      float b = max(dot(0.5 * (heart + uCell[j].xy) - W, n), 0.0);
      float w = exp(-3.6 * min(b / reach, 14.0));
      sum += w;
      away -= w * n / reach;
      least = min(least, b);
      // Neighbours share a little of their light across the furrow.
      float near = exp(-b / (uHalf.y * 0.07));
      light += uCell[j].z * near;
      spark += uCell[j].w * near;
      own += uOwn[j] * near;
      share += near;
    }
    light /= share;
    spark /= share;
    own /= share;
    dEdge = min(dEdge, least / max(apart, 1e-3));
    // The light inside finds the gaps as they open: bright seams at the head of the wave, gone a moment later.
    float since = uAge - distance(P, uPress) / uSpeed;
    if (since > 0.0 && since < 170.0 && uShut < 0.0) flash = smoothstep(0.0, 16.0, since) * pow(1.0 - since / 170.0, 1.6) * exp(-least / max(uHalf.y * 0.02, 0.8));
    if (sum > 1e-6) {
      // Where furrows meet, the least of them rules, taken softly, so corners come out round.
      float t = clamp(-log(sum) / 3.6, 0.0, 1.0);
      float q = 1.0 - t;
      float f = sqrt(max(1.0 - q * q, 0.0));
      float depth = smoothstep(0.0, 0.45, apart);
      keep = 1.0 - depth * 0.86 * (1.0 - f);
      if (t < 1.0) keepUp = depth * 0.86 * (q / max(f, 0.07)) * (away / sum);
    }
  }
  oShape = vec4(dm.x * keep, uphill * keep + dm.x * keepUp, dEdge);
  oCell = vec4(light, flash, own, spark);
  oMore = vec4(apart, closed, 0.0, 0.0);
}
`;

/** How much of the page's own light reaches each spot of the page: the body's shadow. */
export const GROUND_FS = /* glsl */ `#version 300 es
precision highp float;
${BODY}
uniform vec2 uRes;
uniform float uPix;
uniform vec3 uSun;   // points to the page's light
out vec4 o;
void main() {
  vec2 Q = (gl_FragCoord.xy - 0.5 * uRes) / uPix;
  Q.y = -Q.y;
  // Walk from the page up towards the light and note how nearly the body gets in the way.
  float span = 2.0 * uRise / uSun.z;
  float m = 1e9;
  for (int i = 0; i < 14; i++) {
    float t = (float(i) + 0.5) / 14.0;
    vec3 p = vec3(Q, -uRise) + uSun * (span * t);
    float q = 1.0 + sdBox(p.xy, uHalf, uRad) / uBevel;
    float e = (length(vec2(max(q, 0.0), p.z / uRise)) - 1.0) * min(uBevel, uRise);
    // The further the body is above the page, the softer the edge of its shadow.
    m = min(m, e / (0.1 + t));
  }
  float vis = smoothstep(-0.25, 0.4, m / uRise);
  // Where the body is a flat slab the light goes straight through it.
  vec2 E = Q + uSun.xy * span;
  float slab = smoothstep(0.0, 3.0, min(-sdBox(Q, uHalf, uRad), -sdBox(E, uHalf, uRad)) - uBevel);
  vis = max(vis, 0.9 * slab);
  o = vec4(0.0, 0.0, 0.0, vis);
}
`;

/** The picture: the crystal, what it mirrors, the light inside it, and the light and shadow it lays on the page. */
export const FINAL_FS = /* glsl */ `#version 300 es
precision highp float;
${BODY}
uniform vec2 uRes;       // canvas size in device pixels
uniform float uPix;      // device pixels per pixel
uniform sampler2D uLight;  // r: light the walls caught
uniform sampler2D uStill;  // a: how much of the page's own light reaches the page here. Worked out once
uniform sampler2D uShape;  // r: how high the surface stands. g, b: which way is uphill. a: how far to the edge of its own piece
uniform sampler2D uCells;  // r: the light the cell keeps. g: the flash of a furrow opening. b: a number of the cell's own. a: the light passing through it
uniform sampler2D uMore;   // r: how far apart the body has come here, 0 where it is still whole. g: how far it has closed up again
uniform float uCrease;   // how wide the shoulder of a furrow is
uniform float uHeld;     // how much light the pieces hold between them
uniform vec2 uTravel;    // which way the page's light runs across the page
uniform float uSun;      // how strong the page's light is just now
uniform vec3 uFace;      // the colour of the glass
uniform vec3 uGlow;      // the colour of light
uniform vec3 uShade;     // the colour of shadow
uniform vec3 uLampB;     // the pointer's lamp: x, y, and how bright it is
uniform float uLit;      // the body is full of light
uniform float uDull;     // the light has gone out
uniform float uOff;      // disabled
uniform float uFocus;
uniform float uSink;     // pressed
uniform float uDay;      // 1 in the light theme
out vec4 o;

vec2 uvOf(vec2 p) { return (vec2(p.x, -p.y) * uPix + 0.5 * uRes) / uRes; }
vec3 toScreen(vec3 c) { return pow(clamp(c, 0.0, 1.0), vec3(1.0 / 2.2)); }
vec4 shapeAt(vec2 p) { return textureLod(uShape, uvOf(p), 0.0); }

// A ray inside the glass, at S and height z, travelling down along T: the point where it meets
// the underside, and the normal there, pointing back into the glass.
void sink(vec2 S, float z, vec3 T, out vec3 B, out vec3 n) {
  float lo = 0.0;
  float hi = (z + uRise) / max(-T.z, 1e-3);
  for (int i = 0; i < 10; i++) {
    float s = 0.5 * (lo + hi);
    float gap = z + T.z * s + shapeAt(S + T.xy * s).r;
    if (gap > 0.0) lo = s; else hi = s;
  }
  float s = 0.5 * (lo + hi);
  B = vec3(S + T.xy * s, z + T.z * s);
  n = normalize(vec3(shapeAt(B.xy).gb, 1.0));
}

// A ray inside the glass travelling up along D from B: where it meets the top, and the normal there.
bool climb(vec3 B, vec3 D, out vec3 C, out vec3 N) {
  C = B;
  N = vec3(0.0, 0.0, 1.0);
  if (D.z < 0.04) return false;
  float lo = 0.0;
  float hi = (uRise - B.z) / D.z;
  for (int i = 0; i < 10; i++) {
    float s = 0.5 * (lo + hi);
    float gap = shapeAt(B.xy + D.xy * s).r - (B.z + D.z * s);
    if (gap > 0.0) lo = s; else hi = s;
  }
  C = B + D * (0.5 * (lo + hi));
  N = normalize(vec3(-shapeAt(C.xy).gb, 1.0));
  return true;
}
float grain(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

// A panel of light hanging in the room: is the ray from O along D looking at it? q is where on the panel.
float panel(vec3 O, vec3 D, vec3 C, vec3 U, vec3 W, vec2 size, float corner, float edge, out vec2 q) {
  q = vec2(0.0);
  vec3 n = cross(U, W);
  float den = dot(D, n);
  if (abs(den) < 1e-4) return 0.0;
  float t = dot(C - O, n) / den;
  if (t <= 0.0) return 0.0;
  vec3 hit = O + D * t - C;
  q = vec2(dot(hit, U), dot(hit, W)) / size;
  return 1.0 - smoothstep(-edge, edge, sdBox(q * size, size, corner));
}

// A long light low along the back of the room, seen in the body's shoulder. It is nearest at the
// lit end and runs away from it, so its reflection is a stroke that starts full and thins to
// nothing: white at its core, crisp on the side towards the edge, feathered on the side towards the middle.
float stroke(vec3 O, vec3 D) {
  float R = uHalf.y;
  float run = max(uHalf.x - uHalf.y, R * 0.6);
  vec3 at = vec3(0.0, -7.66 * R, 1.02 * R);
  vec3 n = normalize(at);
  vec3 up = vec3(0.0, n.z, -n.y);
  float den = dot(D, n);
  if (abs(den) < 1e-4) return 0.0;
  float t = dot(at - O, n) / den;
  if (t <= 0.0) return 0.0;
  vec3 hit = O + D * t - at;
  float along = (hit.x + run - 0.05 * R) / (run * 1.62);
  // A round nose at the lit end, then a long taper.
  float swell = sqrt(clamp(along / 0.045, 0.0, 1.0)) * pow(max(1.0 - along, 0.0), 1.25);
  float across = dot(hit, up) / max(0.74 * R * swell, 1e-3);
  float outer = smoothstep(-1.3, -0.7, across);
  float core = outer * (1.0 - smoothstep(0.55, 1.25, across));
  float skirt = outer * (1.0 - smoothstep(0.0, 4.2, across));
  return (core + 0.2 * skirt) * smoothstep(0.0, 0.16, swell);
}

// What the glass mirrors: a dark studio with one window up and to the left, the glow round that
// window, one long light low along the back, and the page lying all round.
vec3 room(vec3 O, vec3 D) {
  float R = uHalf.y;
  vec3 K = normalize(vec3(-0.6, -0.56, 0.57));
  vec3 Ku = normalize(vec3(-K.y, K.x, 0.0));
  vec3 Kv = cross(K, Ku);
  vec3 at = vec3(-(uHalf.x - uHalf.y), 0.0, 0.0) + K * R * 10.0;
  vec2 q;
  float win = panel(O, D, at, Ku, Kv, vec2(4.4, 2.6) * R, 0.7 * R, 0.4 * R, q);
  // Brightest along its lower edge, falling away up the pane.
  win *= mix(1.0, 0.22, smoothstep(-0.7, 1.0, q.y));
  float strip = stroke(O, D);
  float halo = pow(max(dot(normalize(D), K), 0.0), 5.0);
  float sky = mix(0.01, 0.5, uDay) * smoothstep(-0.1, 0.7, D.z) + halo * mix(0.55, 0.5, uDay);
  float page = mix(0.01, 0.55, uDay) * (1.0 - smoothstep(-0.3, 0.05, D.z));
  return vec3(sky + page) + mix(vec3(1.0), uGlow, 0.4) * (win * mix(34.0, 30.0, uDay) + strip * mix(23.0, 25.0, uDay));
}

// How much of a light leaves the body through the wall facing this way. The light runs along
// dir, and has come this far from its lamp.
float leaving(vec2 wallNormal, vec2 dir, float far, float sharp) {
  // Straight under a lamp little goes sideways, and a lamp far off has spread thin.
  float reach = smoothstep(uHalf.y * 0.8, uHalf.y * 3.0, far) / (1.0 + pow(far / (uHalf.y * 7.0), 2.0));
  return pow(max(dot(wallNormal, dir), 0.0), sharp) * reach;
}

// The page's light runs through the body and gathers against its far wall in a crescent: crisp on
// the side towards the edge, feathered towards the middle, full half way along and thinning to
// nothing at both ends. g is the way out through the nearest wall, dOut how far in from it.
float gather(vec2 g, float dOut, vec2 dir) {
  // 1 where the wall faces straight along the light, 0 a third of a turn to either side.
  float t = clamp(2.0 * dot(g, dir) - 1.0, 0.0, 1.0);
  float from = uBevel * 0.085;
  float x = max(dOut - from, 0.0) / max(uBevel * 0.36 * pow(t, 1.15), 1e-3);
  float crisp = smoothstep(-0.7 / uPix, 0.7 / uPix, dOut - from);
  return crisp * exp(-3.4 * x) * smoothstep(0.0, 0.75, t);
}

// What lies on the page around the body: its shadow, and the light that came through it.
vec4 ground(vec2 Q, float lightOn) {
  float direct = texture(uStill, uvOf(Q)).a;
  vec2 room_ = 0.5 * uRes / uPix - abs(Q);
  // Everything on the page fades out before the canvas ends, however little room it was given.
  float spare = 0.5 * uRes.x / uPix - uHalf.x;
  float edge = smoothstep(0.0, max(min(uHalf.y * 0.7, spare * 0.8), 0.01), min(room_.x, room_.y));
  float away = max(sdBox(Q, uHalf, uRad), 0.0);
  float thrown = (1.0 - direct) * exp(-away / (uHalf.y * 0.55));
  float contact = exp(-away / (uHalf.y * 0.07));
  float aS = clamp(thrown * mix(0.6, 0.3, uDay) + contact * mix(0.22, 0.24, uDay), 0.0, 1.0) * edge;

  // Light leaves the body on the side away from its lamp and lands just beyond: a thin dark gap,
  // then a bright edge where the light folds over, then a soft tail.
  vec2 n = boxNormal(Q, uHalf, uRad);
  float gap = max(uHalf.y * 0.035, 1.0);
  float past = max(away - gap, 0.0) / uHalf.y;
  float fold = smoothstep(gap - 0.6 / uPix, gap + 0.6 / uPix, away) * (2.6 * exp(-past / 0.035) + 0.34 * exp(-past / 0.2));
  float sun = pow(max(dot(n, uTravel), 0.0), 4.0) * uSun;
  vec2 fromLamp = Q - uLampB.xy;
  float lamp = leaving(n, normalize(fromLamp), length(fromLamp), 5.0) * uLampB.z * 1.1;
  // Holding light, the body lights the page close round it, and no further.
  float spill = fold * (sun + lamp) * mix(0.42, 0.5, uDay) * lightOn + (uLit * 0.5 + uHeld * 0.3 * lightOn) * exp(-away / (uHalf.y * 0.26));
  float aL = (1.0 - exp(-spill)) * edge;
  // Light that has been through coloured glass has taken a little of its colour.
  vec3 lc = toScreen(mix(uGlow, uGlow * uFace / max(max(uFace.r, uFace.g), max(uFace.b, 1e-3)), 0.22));
  vec4 c = vec4(toScreen(uShade) * aS, aS);
  return c * (1.0 - aL) + vec4(lc, 1.0) * aL;
}

void main() {
  vec2 P0 = (gl_FragCoord.xy - 0.5 * uRes) / uPix;
  P0.y = -P0.y;
  float lightOn = (1.0 - uOff) * (1.0 - 0.75 * uDull);
  vec4 page = ground(P0, lightOn);

  // Pressed, the body sits a touch deeper.
  vec2 P = P0 / (1.0 - 0.014 * uSink);
  float aa = 0.75 / uPix;
  float sd = sdBox(P, uHalf, uRad);
  float cover = 1.0 - smoothstep(-aa, aa, sd);
  if (cover <= 0.0) { o = page; return; }

  vec4 shape = shapeAt(P);
  vec4 cell = textureLod(uCells, uvOf(P), 0.0);
  vec4 more = textureLod(uMore, uvOf(P), 0.0);
  float apart = more.r;   // how far the body has come apart here
  // Done, the light fills the body in the same wave that closes it up.
  float full = uLit * smoothstep(0.86, 1.0, more.g);
  // A cell is itself once its walls have opened, and stays itself until they have closed again.
  float formed = smoothstep(0.4, 0.95, apart / max(1.0 - more.g, 0.05));
  float itself = min(formed, smoothstep(0.0, 0.5, apart));
  float high = shape.r;
  float d = shape.a;                 // how far it is to the edge of the piece this point belongs to
  float dOut = max(-sd, 0.0);        // and to the edge of the whole body
  vec3 N = normalize(vec3(-shape.gb, 1.0));
  vec3 V = vec3(0.0, 0.0, -1.0);
  float F = fresnel(N.z, IOR);
  vec3 T = refract(V, N, 1.0 / IOR);
  vec3 R = reflect(V, N);

  // The caught light lies on the body's widest line, and is seen through the top.
  vec2 Pm = P + T.xy * (high / max(-T.z, 0.05));
  // Drawn a little soft: an edge of light inside glass is never a hard line.
  vec2 px = 1.3 / uRes;
  vec2 um = uvOf(Pm);
  float L = 0.28 * textureLod(uLight, um, 1.0).r + 0.18 * (textureLod(uLight, um + vec2(px.x, px.y), 1.0).r + textureLod(uLight, um + vec2(-px.x, px.y), 1.0).r + textureLod(uLight, um + vec2(px.x, -px.y), 1.0).r + textureLod(uLight, um + vec2(-px.x, -px.y), 1.0).r);

  // Under that, the underside of the body. Some of the eye's ray goes on through it to the page.
  vec3 B, nB;
  sink(P, high, T, B, nB);
  float Fb = fresnel(dot(-T, nB), 1.0 / IOR);
  vec3 T2 = refract(T, nB, IOR);
  bool sees = dot(T2, T2) > 0.5 && T2.z < -0.03;
  vec2 Pg = sees ? B.xy + T2.xy * ((B.z + uRise) / -T2.z) : B.xy;
  float direct = texture(uStill, uvOf(Pg)).a;

  // The rest is thrown back up by the underside and leaves through the top: the room, a second time, upside down.
  vec3 D = reflect(T, nB);
  vec3 C, nC;
  // Light that meets the top too flat cannot get out again, and shows the depth of the glass itself.
  // In real glass that happens along a hard line. In the whole body it is drawn soft, because so
  // near the rim a hard line reads as a crack.
  vec3 trapped = vec3(mix(0.01, 0.3, uDay));
  vec3 again = trapped;
  if (climb(B, D, C, nC)) {
    vec3 Dout = refract(D, -nC, IOR);
    float square = dot(D, nC);
    float gets = (1.0 - fresnel(square, 1.0 / IOR)) * mix(smoothstep(0.753, 0.97, square), 1.0, smoothstep(0.0, 0.3, apart));
    if (dot(Dout, Dout) > 0.5) again = mix(trapped * (1.0 - smoothstep(0.0, 0.3, apart)), min(room(C, Dout), vec3(0.9)), gets);
  }

  // Light runs through a piece of glass and gathers hard up against the wall furthest from its lamp.
  // Whole, the body is one such piece. Divided, every piece does it for itself.
  vec2 gBody = boxNormal(P, uHalf, uRad);
  vec2 gPiece = normalize(-shape.gb + vec2(1e-5, 0.0));
  float wallBody = exp(-dOut / (uHalf.y * 0.5)) * (1.0 - smoothstep(uBevel * 0.55, uBevel, dOut)) * smoothstep(0.0, uHalf.y * 0.07, dOut);
  float soft = uCrease * 1.5;
  float wallPiece = exp(-d / (soft * 0.5)) * (1.0 - smoothstep(uCrease * 0.6, uCrease * 1.1, d)) * smoothstep(0.0, soft * 0.07, d);
  float along = dot(P, uTravel) / (abs(uTravel.x) * uHalf.x + abs(uTravel.y) * uHalf.y);
  float pool = smoothstep(-0.35, 1.0, along);
  float sunBody = pow(max(dot(gBody, uTravel), 0.0), 2.4) * wallBody + 0.4 * pool * pool * smoothstep(0.0, uHalf.y * 0.3, dOut);
  float sunPiece = pow(max(dot(gPiece, uTravel), 0.0), 2.4) * wallPiece;
  float sun = mix(sunBody, sunPiece, apart) * uSun;
  vec2 g = gBody;
  float wall = wallBody;
  // Deep in a furrow the glass sees its neighbour, not the room.
  float pit = apart * (1.0 - smoothstep(0.0, uCrease * mix(0.6, 0.95, uDay), d)) * smoothstep(0.0, 1.5, dOut - d);
  // The pointer's lamp does the same from wherever it is, and lights the glass under itself a little.
  vec2 fromLamp = P - uLampB.xy;
  float farL = length(fromLamp);
  float lamp = (leaving(g, fromLamp / max(farL, 1e-3), farL, 1.5) * wall * 1.6 + 0.3 * exp(-farL * farL / (uHalf.y * uHalf.y * 1.2)) * smoothstep(0.0, uHalf.y * 0.3, d)) * uLampB.z;

  // Light that has been through coloured glass has taken its colour.
  vec3 tint = mix(vec3(1.0), uFace / max(max(uFace.r, uFace.g), max(uFace.b, 1e-3)), 0.75);
  // No two pieces are quite the same depth of colour.
  // By day a cell with no light in it is darker than the whole body was, so the lit ones can be told from it.
  vec3 deep = uFace * (mix(0.62, 0.78, uDay) + 0.3 * direct) * mix(1.0, (0.86 + 0.28 * cell.b) * mix(1.0, 0.62, uDay), itself);
  deep = mix(deep, vec3(dot(deep, vec3(0.33))) * 0.9, 0.5 * uDull + 0.35 * uOff);
  float seen = (sun + lamp) * mix(0.2, 0.3, uDay) * lightOn;
  vec3 thru = deep + tint * uGlow * seen;
  // In daylight a cluster of cells would throw the bright room back in patches. Each cell mostly sees its neighbours instead.
  vec3 body = mix(thru, again * tint * tint * mix(1.0, 0.3, smoothstep(0.0, 0.25, apart) * uDay), Fb * (1.0 - uOff) * (1.0 - pit));

  // Where light is thin it has the colour of the glass. Where it is strong it is simply light.
  vec3 faint = uGlow * tint * mix(tint, vec3(1.0), 0.35);
  // The crescent of the page's light at the far end of the whole body. It goes as the body comes apart.
  float hot = gather(gBody, dOut, uTravel) * uSun * (1.0 + 0.4 * uSink) * (1.0 - smoothstep(0.0, 0.4, apart)) * lightOn;
  body = mix(body, mix(faint, uGlow, smoothstep(0.35, 1.0, hot)), min(hot, 1.0) * 0.92);

  // A little caught light lifts the glass in its own colour. A lot of it is simply the colour of light.
  // In clear glass only the places where light folds over itself show: the fine bright curves.
  // However much gathers, a curve stays a fine line with a bright core.
  float lit = L / (1.0 + 0.9 * L) * 3.4 * lightOn;
  body *= 1.0 + lit * 0.9;
  float caught = 1.0 - exp(-lit * lit * 1.1);
  body = mix(body, mix(faint, uGlow, smoothstep(0.25, 0.9, caught)), caught);
  // Pressed, the lamp all but touches the glass, and a point of light gathers in it right there.
  float point = uSink * exp(-farL * farL / (uHalf.y * uHalf.y * 0.05)) * min(uLampB.z, 1.0) * lightOn;
  body = mix(body, uGlow, clamp(point, 0.0, 1.0) * 0.95);
  body += faint * uSink * 0.5 * exp(-farL * farL / (uHalf.y * uHalf.y * 0.7)) * min(uLampB.z, 1.0) * lightOn * smoothstep(0.0, uHalf.y * 0.2, dOut);

  // A piece that keeps light glows from its depth in the colour of the glass.
  float depthOf = smoothstep(0.0, uCrease * 0.95, d);
  float keeps = cell.r * lightOn * formed;
  body = mix(body, uGlow * tint * tint * mix(0.17, 0.3, uDay) * (0.55 + 0.6 * depthOf), 1.0 - exp(-keeps * 2.4));
  // The piece the light is passing through holds the light itself: white in its depth,
  // the colour of the glass towards its walls, and gathered against the far one.
  float passes = cell.a * lightOn * formed;
  float heart = smoothstep(0.0, uCrease * 1.7, d);
  body = mix(body, mix(faint * 0.55, uGlow, smoothstep(0.3, 1.0, heart * passes)), (1.0 - exp(-passes * 2.2)) * (0.3 + 0.62 * heart));
  body += uGlow * (keeps * 0.5 + passes) * pow(max(dot(gPiece, uTravel), 0.0), 3.0) * exp(-d / (soft * 0.2)) * smoothstep(0.0, soft * 0.08, d) * 0.9;
  // A furrow opens with a flash: the light inside finds the gap. White at the head of the wave,
  // the colour of the glass as it dies away behind.
  float seam = clamp(cell.g * lightOn * 2.2, 0.0, 1.0);
  body = mix(body, mix(faint * 0.7, uGlow, smoothstep(0.3, 0.85, seam)), seam);
  // Full of light, it is brightest in its depth and keeps the colour of the glass towards its edge.
  body = mix(body, mix(uGlow * mix(tint, vec3(1.0), 0.35), uGlow, smoothstep(0.0, uHalf.y * 0.55, dOut)), full * mix(0.78, 1.0, smoothstep(0.0, uHalf.y * 0.5, dOut)));

  vec3 env = room(vec3(P, high), R);
  // Disabled, the surface is frosted: it mirrors nothing sharply.
  env = mix(env, vec3(mix(0.05, 0.5, uDay)), uOff) * (1.0 - 0.94 * pit) * mix(1.0, 0.6, smoothstep(0.0, 0.25, apart) * uDay);
  float Fr = mix(F, 0.07, uOff);
  vec3 c = body * (1.0 - Fr) + env * Fr;

  // The edge of the glass gathers light: a fine line just inside it, brightest facing the light
  // and again at the far end, where the light leaves.
  float toward = dot(gBody, -uTravel);
  float where_ = pow(max(toward, 0.0), 2.5) + 0.3 * pow(max(-toward, 0.0), 4.0);
  float fine = max(uHalf.y * 0.016, 0.6);
  float line = exp(-pow((dOut - fine * 2.2) / fine, 2.0));
  c += uGlow * line * where_ * mix(0.9, 0.6, uDay) * lightOn;
  // Keyboard focus: the edge of the glass carries light all the way round.
  c += uGlow * uFocus * 0.55 * exp(-dOut / (uHalf.y * 0.09));

  c = toScreen(c) + (grain(gl_FragCoord.xy) - 0.5) / 255.0;
  o = mix(page, vec4(c, 1.0), cover);
}
`;
