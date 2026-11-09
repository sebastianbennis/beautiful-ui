// Liquid black, drawn per pixel. The shapes are signed distance fields that melt into one another
// and into the edge of the banner. Their height gives a normal, and the normal reflects a small
// studio of lights. Nothing here is an image.

import { FRONT_GLSL } from './daylight';

export const MASS_COUNT = 3;
export const DROP_COUNT = 2;
export const DRIP_COUNT = 8;
export const BEAD_COUNT = 14;
export const FIELD_WIDTH = 256;
/** Wave and fog for the layer hanging from the top, then for the layer rising from the bottom. */
export const FIELD_ROWS = 4;

export const VERTEX_SHADER = `#version 300 es
void main() {
  vec2 v = vec2(float(gl_VertexID == 1) * 4.0 - 1.0, float(gl_VertexID == 2) * 4.0 - 1.0);
  gl_Position = vec4(v, 0.0, 1.0);
}`;

export const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp sampler2D;

#define MASSES ${MASS_COUNT}
#define DROPS ${DROP_COUNT}
#define DRIPS ${DRIP_COUNT}
#define BEADS ${BEAD_COUNT}
#define FIELD ${FIELD_WIDTH}
#define PI 3.14159265

uniform vec2 uView;
uniform float uDpr;
uniform float uScale;
uniform float uFlip;

uniform vec4 uMass[MASSES];
uniform float uMassOn[MASSES];
uniform vec4 uDrop[DROPS];
uniform vec4 uDrip[DRIPS];
uniform vec4 uDripB[DRIPS];
uniform vec4 uBead[BEADS];

uniform sampler2D uField;
uniform int uRow;
uniform vec3 uWaveSpan;
uniform float uFog;
uniform float uTime;

uniform float uMerge;
uniform float uShoulder;

uniform vec4 uAct;
uniform vec3 uActInfo;

uniform vec2 uTilt;
uniform vec4 uGlow;
uniform float uGlowH;

uniform vec3 uSurface;
uniform vec3 uLight;
uniform vec3 uAction;
uniform float uSpec;
uniform float uShadow;
uniform float uFlash;

uniform sampler2D uPuff;
uniform vec3 uCloud;
uniform vec3 uCloudShade;
uniform vec3 uZenith;
uniform vec3 uHaze;
uniform vec3 uActionDay;
// The drop that holds the other weather: x, y, radius, on.
uniform vec4 uOrb;
// Where its neck starts, how attached it is, which weather it holds (1 is clear), hover.
uniform vec4 uOrbB;
${FRONT_GLSL}
out vec4 fragColor;

// How far the weather has turned at the pixel being drawn: 0 storm, 1 clear.
float gDay = 0.0;

float smin(float a, float b, float k) {
  if (k < 0.01) return min(a, b);
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

// Blends with no jump in curvature. Where a mirror sits on a join, a jump in curvature draws a
// hard line in the reflection however smooth the shape looks.
float sminC2(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * h * k / 6.0;
}

// A cubic B-spline through the cells of a row. Linear steps would show as facets in a mirror.
float fieldAt(float x, int row) {
  if (uWaveSpan.y <= 0.0) return 0.0;
  float u = clamp((x - uWaveSpan.x) / uWaveSpan.y, 0.0, 1.0) * float(FIELD - 1);
  int i = int(floor(u));
  float f = u - float(i);
  float a = texelFetch(uField, ivec2(max(i - 1, 0), row), 0).r;
  float b = texelFetch(uField, ivec2(i, row), 0).r;
  float c = texelFetch(uField, ivec2(min(i + 1, FIELD - 1), row), 0).r;
  float d = texelFetch(uField, ivec2(min(i + 2, FIELD - 1), row), 0).r;
  float f2 = f * f;
  float f3 = f2 * f;
  return ((1.0 - 3.0 * f + 3.0 * f2 - f3) * a + (4.0 - 6.0 * f2 + 3.0 * f3) * b + (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) * c + f3 * d) / 6.0;
}

vec2 sheared(vec2 p) {
  return vec2(p.x, p.y - fieldAt(p.x, uRow) * smoothstep(0.0, uWaveSpan.z * 1.4, p.y));
}

// A form attached to the edge, built from three half planes melted together. A true box has a
// medial axis, and a mirror shows that axis as a hard crease. This has none.
float sdMass(vec2 p, int i) {
  vec4 m = uMass[i];
  float k = m.w * 1.7;
  return -smin(smin(p.x - (m.x - m.y), (m.x + m.y) - p.x, k), m.z - p.y, k);
}

// A good approximation of the distance to an ellipse. Drops are always round at the foot.
float sdEllipse(vec2 p, vec2 ab) {
  float k0 = length(p / ab);
  float k1 = length(p / (ab * ab));
  float floor_ = -0.9 * min(ab.x, ab.y);
  if (k1 < 0.00001) return floor_;
  // Close to the centre this estimate depends on direction, and a mirror shows that as a bright
  // dash. A smooth floor under it removes the jump and leaves the rest of the shape alone.
  return -smin(-k0 * (k0 - 1.0) / k1, -floor_, -floor_ / 9.0);
}

float sdForms(vec2 p) {
  float d = 1e5;
  for (int i = 0; i < MASSES; i++) {
    if (uMassOn[i] < 0.001) continue;
    d = smin(d, sdMass(p, i), 18.0 * uScale);
  }
  for (int i = 0; i < DROPS; i++) {
    if (uDrop[i].w < 0.5) continue;
    d = smin(d, sdEllipse(p - uDrop[i].xy, uDrop[i].zw), uMerge);
  }
  return d;
}

// Round lumps creeping slowly, so a cloud is never quite still: big, medium and fine.
vec3 puffAt(vec2 p) {
  vec2 q = p / (430.0 * uScale);
  vec2 drift = uTime * vec2(0.0036, 0.0014);
  vec3 a = texture(uPuff, q + drift).rgb;
  float b = texture(uPuff, q * 0.77 + vec2(0.37, 0.71) - drift * 0.6).r;
  return vec3(max(a.r, b * 0.94), a.gb);
}

// The forms themselves. In clear weather their edge pushes out into the lobes of a cumulus.
float sdBody(vec2 point) {
  vec2 p = sheared(point);
  float forms = sdForms(p);
  if (gDay > 0.001 && forms < 1e4) {
    vec3 lumps = puffAt(point);
    // Very broad swells break up the outline, so a big panel never reads as a box.
    float swell = texture(uPuff, point / (1180.0 * uScale) + vec2(0.13, 0.57)).r;
    forms -= gDay * uScale * (6.0 + 29.0 * lumps.r + 7.0 * lumps.g + 16.0 * swell);
  }
  // The plane sits just past the edge of the screen, so its rim light never draws on the top row.
  return smin(forms, p.y + 3.0, uShoulder * (1.0 - 0.8 * gDay));
}

float neckAt(float y, vec4 a, vec4 b) {
  return b.x + (b.y - b.x) * exp(-max(y, 0.0) / (6.0 * uScale + a.z * 0.14));
}

// A pendant drop: a flared root, a neck that thins with length, and a round bulb at the end.
float sdDrip(vec2 p, int i) {
  vec4 a = uDrip[i];
  vec4 b = uDripB[i];
  float y = p.y - a.y;
  float length_ = max(a.z, 0.5);
  float along = clamp(y / length_, 0.0, 1.0);
  float axis = a.x + b.z * along * along;
  float bulbY = max(length_ - a.w, 0.0);
  float bulbAlong = clamp(bulbY / length_, 0.0, 1.0);
  float bulb = length(p - vec2(a.x + b.z * bulbAlong * bulbAlong, a.y + bulbY)) - a.w;
  // Rounded across its middle. A plain distance has a crease down the centre of the neck, and at
  // the root, where the surface is broad, a mirror shows that crease as a sharp spike.
  float half_ = neckAt(y, a, b);
  float u = p.x - axis;
  float neck = sqrt(u * u + 0.3025 * half_ * half_) - 1.141 * half_;
  neck = max(neck, y - bulbY);
  // A jet stands on open water, so its foot has to stop somewhere. A hanging drip runs a little
  // way up into its form and then ends, so far above its root it has no effect at all.
  neck = uFlip < 0.0 ? max(neck, -y) : max(neck, -y - 14.0 * uScale);
  float formed = smin(neck, bulb, a.w * clamp(0.28 + 1.5 * b.x / a.w, 0.28, 0.95));

  // Before there is room for a neck, a drip is only a swelling of the edge, one smooth shape.
  float early = 1.0 - smoothstep(a.w * 1.8, a.w * 3.8, a.z);
  if (early < 0.001 || uFlip < 0.0) return formed;
  // A level set, not a true distance: a true ellipse has a crease along its long axis.
  vec2 reach_ = vec2(max(a.w * 1.4, 1.0), max(a.z, 1.0));
  vec2 q = (p - a.xy) / reach_;
  return mix(formed, (sqrt(dot(q, q) + 0.05) - 1.025) * reach_.x, early);
}

float sdBead(vec2 p, int i) {
  vec4 b = uBead[i];
  return sdEllipse(p - b.xy, vec2(b.z * (1.0 - 0.5 * b.w), b.z * (1.0 + b.w)));
}

float sdBlack(vec2 point) {
  vec2 p = sheared(point);
  float d = sdBody(point);
  float k = 30.0 * uScale;
  for (int i = 0; i < DRIPS; i++) {
    if (uDripB[i].w < 0.004) continue;
    // Past the blend radius a drip changes nothing, so most pixels never have to work it out.
    vec4 a = uDrip[i];
    vec4 b = uDripB[i];
    if (abs(p.x - a.x) > max(a.w, b.y) + abs(b.z) + k + 2.0 || p.y < a.y - k - 8.0 * uScale || p.y > a.y + a.z + a.w + k) continue;
    // Drips belong to the storm. Where the sky has cleared there is nothing to hang from.
    float keep = uFlip > 0.0 ? 1.0 - smoothstep(0.0, 0.5, gDay) : 1.0;
    d += (sminC2(d, sdDrip(p, i), k) - d) * b.w * keep;
  }
  for (int i = 0; i < BEADS; i++) {
    vec4 b = uBead[i];
    if (b.z < 0.05 || abs(point.x - b.x) > abs(d) + b.z * 2.2 + 2.0 || abs(point.y - b.y) > abs(d) + b.z * 2.2 + 2.0) continue;
    d = min(d, sdBead(point, i));
  }
  return d;
}

// A jet standing in open water melts into it at the foot. One growing from a form joins that form.
float jetFoot(vec2 p) {
  float k = 1.0;
  for (int i = 0; i < DRIPS; i++) {
    if (uDripB[i].w < 0.004) continue;
    vec4 a = uDrip[i];
    if (abs(p.x - a.x) > 40.0 * uScale || sdForms(vec2(a.x, a.y - 4.0 * uScale)) < 6.0 * uScale) continue;
    k = min(k, smoothstep(0.0, 9.0 * uScale, p.y - a.y));
  }
  return k;
}

float sdActionForm(vec2 p) {
  float r = min(uActInfo.x, min(uAct.z, uAct.w));
  float k = r * 1.7;
  return -smin(smin(p.x - (uAct.x - uAct.z), (uAct.x + uAct.z) - p.x, k), (uAct.y + uAct.w) - p.y, k);
}

float sdAction(vec2 p) {
  float d = uActInfo.y < 0.001 ? 1e5 : smin(sdActionForm(p), p.y, uShoulder * 0.92);
  if (uOrbB.y > 0.001 && uOrb.w > 0.001) {
    // The thin neck the drop hangs by: flared where it leaves the form, narrow in the middle.
    float y = p.y - uOrbB.x;
    float span = max(uOrb.y - uOrb.z * 0.7 - uOrbB.x, 1.0);
    float u = clamp(y / span, 0.0, 1.0);
    float half_ = (1.5 * uScale + 6.0 * uScale * exp(-y / (4.0 * uScale)) + 2.6 * uScale * u * u * u) * uOrbB.y;
    float neck = max(abs(p.x - uOrb.x) - half_, max(-y - 8.0 * uScale, y - span - uOrb.z * 0.5));
    d = smin(d, neck, 5.0 * uScale);
  }
  return d;
}

// How round the surface is here. Heavy forms use a wide curve. A neck or a bead is exactly as
// round as it is thick, which is what makes it read as a real drop and not a flat cut-out.
float localRound(vec2 point) {
  float round_ = 54.0 * uScale;
  vec2 p = sheared(point);
  for (int i = 0; i < DRIPS; i++) {
    if (uDripB[i].w < 0.004) continue;
    vec4 a = uDrip[i];
    vec4 b = uDripB[i];
    float y = p.y - a.y;
    if (y < 0.0 || y > a.z + 8.0 * uScale || abs(p.x - a.x) > a.w + b.y + abs(b.z) + 16.0 * uScale) continue;
    float along = clamp(y / max(a.z, 1.0), 0.0, 1.0);
    float bulbY = max(a.z - a.w, 0.0);
    float local_ = mix(neckAt(y, a, b), a.w, smoothstep(bulbY - a.w * 1.7, bulbY, y));
    float across = 1.0 - smoothstep(local_ + 2.0 * uScale, local_ + 12.0 * uScale, abs(p.x - (a.x + b.z * along * along)));
    // A drip that has only just started is still part of the edge it grows from. Giving it its
    // own roundness too early draws a little lens stuck to the lip.
    float free_ = smoothstep(a.w * 1.8, a.w * 3.8, a.z);
    round_ = min(round_, mix(round_, max(local_, 0.7), smoothstep(a.z * 0.14, a.z * 0.52, y) * across * free_));
  }
  for (int i = 0; i < BEADS; i++) {
    vec4 b = uBead[i];
    if (b.z < 0.05 || abs(point.x - b.x) > b.z * 1.5 + 5.0 || abs(point.y - b.y) > b.z * 1.5 + 5.0) continue;
    round_ = min(round_, mix(round_, max(b.z, 0.7), 1.0 - smoothstep(b.z * 1.5, b.z * 1.5 + 4.0, length(point - b.xy))));
  }
  return round_;
}

float heightFrom(vec2 p, float d, float round_) {
  if (uFlip > 0.0) d = smin(d, p.y + 26.0 * uScale, 34.0 * uScale);
  float t = clamp(d / round_, 0.0, 1.0);
  float h = round_ * sqrt(max(1.0 - (1.0 - t) * (1.0 - t), 0.0));
  h += (0.55 * sin(p.x * 0.021 / uScale + 1.1) + 0.3 * sin((p.x * 0.047 - p.y * 0.02) / uScale + 0.4)) * smoothstep(0.0, 30.0 * uScale, d) * uScale;
  return h;
}

float roundBox(vec2 q, vec2 c, vec2 h, float r, float s) {
  vec2 d = abs(q - c) - h + r;
  float dd = length(max(d, vec2(0.0))) + min(max(d.x, d.y), 0.0) - r;
  return 1.0 - smoothstep(-s, s, dd);
}

vec2 stroke(vec2 q, float cx, float cy, float xw, float h, float dir, float pixel) {
  float u = (q.x - cx) / xw;
  float w = h * max(1.0 - u * u, 0.0);
  float dd = abs(q.y - cy) - w;
  float e = max(0.006, pixel);
  float cover = 1.0 - smoothstep(-e, e, dd);
  float across = w > 0.0001 ? clamp(0.5 + dir * (q.y - cy) / (2.0 * w), 0.0, 1.0) : 0.0;
  return vec2(cover, across);
}

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

float noiseLine(float x) {
  float i = floor(x);
  float f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(fract(sin(i * 127.1) * 43758.5453), fract(sin((i + 1.0) * 127.1) * 43758.5453), f);
}

// The lights are laid out around the view axis, so what they draw follows the outline of whatever
// it lands on. On a drop the low light is a curved crescent. It can never become a straight cut.
vec3 studio(vec2 q, float pixel, float curved, float broad, float lipZone) {
  vec3 warm = vec3(1.0, 0.97, 0.92);
  vec3 cool = vec3(0.93, 0.96, 1.0);
  float rr = length(q);
  float angle = atan(q.y, q.x);
  float low = angle - PI * 0.5;
  if (low < -PI) low += 2.0 * PI;

  vec3 c = vec3(0.004, 0.0044, 0.0052);
  c += vec3(0.02, 0.021, 0.025) * smoothstep(0.75, -0.6, q.y);

  float e = max(0.014, pixel);

  // The crescent: crisp on its inner curve, brightest there, and running out to the very edge.
  float off = low - 0.1;
  float bias = uFlip > 0.0 ? 0.0 : 0.72;
  float inner = 1.2 + bias + 1.5 * pow(abs(off) / 0.5, 2.0);
  float crescent = smoothstep(inner - e, inner + e, rr) * smoothstep(1.4, 0.8, abs(off));
  float broken_ = 0.42 + 0.58 * smoothstep(0.3, 0.72, noiseLine(q.x * 7.0 + q.y * 0.6 + 1.7));
  c += cool * crescent * broken_ * (0.03 + 1.7 * exp(-max(rr - inner, 0.0) * 4.2));

  // The wide, soft light under it, which gives every lower edge a little body of tone.
  c += cool * 0.16 * exp(-(low * low) / 1.5625) * smoothstep(1.1, 3.0, rr);

  // A paned window high on the left. On a bead it is the highlight that says wet.
  c += warm * mix(3.6, 0.8 * lipZone, broad) * roundBox(q, vec2(-0.5, -0.5), mix(vec2(0.1, 0.13), vec2(0.21, 0.25), broad), mix(0.08, 0.1, broad), e);

  // The glint that says a bead is wet. On a broad swell it would just be a stray dot.
  c += vec3(1.0) * 16.0 * curved * (1.0 - broad) * (1.0 - smoothstep(0.012, 0.022, length(q - vec2(0.62, -0.3))));

  // The lip of a form hanging from the top edge. These two long lights belong up there only.
  // Anywhere else they would land on a swell as an arc, or shrink on a drip to a sharp mark.
  float lip = uFlip > 0.0 ? broad * lipZone : 0.0;
  vec2 a = stroke(q, -0.15, -0.36, 0.2, 0.115, 1.0, pixel);
  c += warm * lip * a.x * (0.05 + 3.4 * pow(1.0 - a.y, 2.4));
  vec2 b = stroke(q, 0.2, -0.3, 0.085, 0.04, 1.0, pixel);
  c += cool * lip * b.x * (0.04 + 1.9 * pow(1.0 - b.y, 2.0));

  // Rim light, broken so it reads as a light and not an outline.
  float broken = 0.14 + 0.86 * smoothstep(-0.2, 0.75, sin(angle * 2.0 + 0.6));
  float key = 0.4 + 0.6 * smoothstep(-0.5, 0.45, q.x / max(rr, 0.001) * 3.0 + q.x);
  c += warm * 1.8 * broken * key * smoothstep(2.3, 2.9, rr) * smoothstep(8.0, 3.6, rr);

  // Lightning: for an instant the whole storm is one enormous softbox.
  c += cool * uFlash * (0.5 + 2.4 * smoothstep(0.05, 1.5, rr));
  return c * uLight;
}

float edge(float d) {
  float aa = 0.75 / uDpr;
  return smoothstep(aa, -aa, d);
}

// Each form sees the whole studio across its own width, however narrow it is.
vec2 eyeFor(vec2 p) {
  vec2 main_ = vec2(uMass[0].x, max(uMass[0].y * 1.44, 110.0 * uScale));
  if (uMassOn[1] < 0.001) return main_;
  vec2 side = vec2(uMass[1].x, max(uMass[1].y * 1.44, 110.0 * uScale));
  float near_ = smoothstep(uMass[1].y + 150.0 * uScale, uMass[1].y + 20.0 * uScale, abs(p.x - uMass[1].x));
  return mix(main_, side, near_);
}

vec3 lookup(vec3 r, float pixel, float curved, float broad, float lipZone) {
  vec2 q = r.xy / (1.0 + max(r.z, -0.96)) + uTilt;
  if (uSpec < 0.0001) return studio(q, pixel, curved, broad, lipZone);
  // Each colour sees the room from a hair's breadth apart, like light leaving a polished edge.
  return vec3(studio(q * (1.0 + uSpec), pixel, curved, broad, lipZone).r, studio(q, pixel, curved, broad, lipZone).g, studio(q * (1.0 - uSpec), pixel, curved, broad, lipZone).b);
}

float hash21(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x), f.y);
}

// Banks of mist lying along the bar. One sheet of noise bends the next, so they roll over slowly
// instead of sliding past.
float mistBanks(vec2 p) {
  vec2 q = p / (vec2(104.0, 46.0) * uScale);
  float t = uTime;
  vec2 bend = vec2(valueNoise(q * 0.8 + vec2(t * 0.03, 4.1)), valueNoise(q * 0.8 + vec2(7.3, -t * 0.024))) - 0.5;
  float wide = valueNoise(q + bend * 1.5 + vec2(t * 0.045, 1.3));
  float fine = valueNoise(q * 2.6 - bend * 1.1 - vec2(t * 0.06, 0.0));
  return wide * 0.7 + fine * 0.3;
}

float cloudHeight(vec2 p) {
  float inside = max(-sdBody(p), 0.0);
  float t = clamp(inside / (58.0 * uScale), 0.0, 1.0);
  float body = sqrt(max(1.0 - (1.0 - t) * (1.0 - t), 0.0));
  vec3 lumps = puffAt(p);
  // Billows belong at the edge. Deep inside, where the words sit, the cloud is calm and bright.
  float rim_ = exp(-inside / (34.0 * uScale));
  return uScale * (46.0 * body + 34.0 * lumps.r * mix(0.03, 1.0, rim_) + 15.0 * lumps.g * rim_ + 4.5 * lumps.b * rim_ * rim_);
}

// A cumulus: bright where it faces the sun, blue in its folds and along its belly.
vec3 shadeCloud(vec2 p, float d) {
  float s = uScale;
  float e = 2.0 * s;
  vec2 ex = vec2(e, 0.0);
  vec2 ey = vec2(0.0, e);
  float h = cloudHeight(p);
  float dx = (cloudHeight(p + ex) - cloudHeight(p - ex)) / (2.0 * e);
  float dy = (cloudHeight(p + ey) - cloudHeight(p - ey)) / (2.0 * e);
  vec3 n = normalize(vec3(-dx, -dy, 1.0));
  vec3 toSun = normalize(vec3(0.36, -0.66 * uFlip, 0.66));

  // Lumps between this point and the sun lay a soft shadow across it.
  vec2 step_ = normalize(toSun.xy) * 15.0 * s;
  float blocked = max(cloudHeight(p + step_) - h - 5.0 * s, 0.0) / (20.0 * s) + max(cloudHeight(p + step_ * 2.2) - h - 11.0 * s, 0.0) / (30.0 * s);

  float wrap = dot(n, toSun) * 0.5 + 0.5;
  float lit = smoothstep(0.3, 0.94, wrap) * (1.0 - 0.62 * clamp(blocked, 0.0, 1.0));
  vec3 c = mix(uCloudShade, uCloud, lit);
  c += vec3(1.0, 0.94, 0.84) * 0.07 * pow(max(dot(n, toSun), 0.0), 3.0);
  return c;
}

// Water under a clear sky shows it upside down, with the bright room on top.
vec3 clearDrop(vec3 n, vec3 lit) {
  return mix(uHaze, uZenith, clamp(0.5 + 0.7 * n.y * uFlip, 0.0, 1.0)) * 0.94 + lit * 0.9;
}

// In a panel, the row under the pointer rests on a tapered stroke. How much of it, and where in it.
vec2 rowStroke(vec2 p) {
  if (uGlow.w <= 0.002) return vec2(0.0, 1.0);
  float u = (p.x - uGlow.x) / uGlow.z;
  float span = max(1.0 - u * u, 0.0);
  float foot = uGlow.y + uFlip * (uGlowH - 1.0 * uScale);
  float above = uFlip * (foot - p.y);
  float tall = 6.0 * uScale * span;
  float aa = 1.0 / uDpr;
  float inside = smoothstep(-aa, aa, above) * (1.0 - smoothstep(tall - aa, tall + aa, above)) * smoothstep(0.0, 0.06, span);
  return vec2(inside * uGlow.w, clamp(above / max(tall, 0.001), 0.0, 1.0));
}

vec4 shadeBlack(vec2 p) {
  float d = sdBlack(p);
  float cover = edge(d);

  bool cloud = false;
  vec3 cloudColour = vec3(0.0);
  float cloudCover = 0.0;
  if (gDay > 0.001) {
    cloud = sdBody(p) <= d + 0.01;
    if (cloud) {
      cloudCover = smoothstep(2.6 * uScale, -2.2 * uScale, d);
      if (cloudCover <= 0.0 && cover <= 0.0) return vec4(0.0);
      cloudColour = shadeCloud(p, d);
      vec2 row = rowStroke(p);
      cloudColour = mix(cloudColour, uZenith * 0.6, row.x * (0.05 + 0.42 * pow(1.0 - row.y, 2.4)));
      if (gDay > 0.999) return vec4(pow(cloudColour, vec3(1.0 / 2.2)) * cloudCover, cloudCover);
    }
  }
  if (cover <= 0.0 && !cloud) return vec4(0.0);

  float e = 0.35;
  float round0 = localRound(p);
  float h0 = heightFrom(p, -d, round0);
  vec2 ex = vec2(e, 0.0);
  vec2 ey = vec2(0.0, e);
  float hxp = heightFrom(p + ex, -sdBlack(p + ex), localRound(p + ex));
  float hxm = heightFrom(p - ex, -sdBlack(p - ex), localRound(p - ex));
  float hyp = heightFrom(p + ey, -sdBlack(p + ey), localRound(p + ey));
  float hym = heightFrom(p - ey, -sdBlack(p - ey), localRound(p - ey));
  vec3 n = normalize(vec3(-(hxp - hxm) / (2.0 * e), -(hyp - hym) / (2.0 * e), 1.0));
  float bend = (abs(hxp + hxm - 2.0 * h0) + abs(hyp + hym - 2.0 * h0)) / (e * e);
  float pixel = 1.1 * bend / uDpr;

  // Mist on the surface, behind the titles: reflections soften and lift. The pointer wipes it away.
  float fog = 0.0;
  float banks = 0.0;
  if (uFog > 0.001 && gDay < 0.999) {
    banks = mistBanks(p);
    // It thins out unevenly toward the rim, so an open panel never shows a straight line where it stops.
    float band = 1.0 - smoothstep(uWaveSpan.z - 34.0 * uScale, uWaveSpan.z + 14.0 * uScale, p.y + (banks - 0.5) * 46.0 * uScale);
    float wet = valueNoise(p / (15.0 * uScale) + 9.0) * 0.6 + valueNoise(p / (5.0 * uScale)) * 0.4;
    float moisture = clamp(fieldAt(p.x, uRow + 1), 0.0, 1.0);
    fog = uFog * smoothstep(0.03, 0.8, moisture + (wet - 0.5) * 0.3 * smoothstep(0.0, 0.4, moisture)) * band * (1.0 - gDay);
  }

  vec2 eye = eyeFor(p);
  vec3 v = normalize(vec3((p.x - eye.x) / eye.y, 0.0, -1.0));
  vec3 r = reflect(v, n);
  float fresnel = 0.62 + 0.38 * pow(clamp(1.0 - dot(-v, n), 0.0, 1.0), 5.0);

  float curved = smoothstep(0.14, 0.34, abs(n.x));
  float broad = smoothstep(10.0 * uScale, 34.0 * uScale, round0);
  // A jet of water is thin, and its two rim lights would otherwise fill it in solid white.
  float jet = uFlip < 0.0 && smin(sdForms(sheared(p)), p.y, uShoulder) > 0.0 ? 0.58 : 1.0;
  float lipZone = 1.0 - smoothstep(36.0 * uScale, 62.0 * uScale, p.y);
  vec3 lit = aces(lookup(r, pixel + fog * 0.05, curved, broad, lipZone) * fresnel * (1.0 - 0.55 * fog) * jet);
  vec3 c = uSurface + lit * (1.0 - uSurface);

  if (fog > 0.002) {
    float s = uScale;
    float bank = smoothstep(0.36, 0.74, banks);
    float grain = hash21(floor(p * uDpr));
    c += uLight * vec3(0.86, 0.92, 1.0) * fog * (0.0013 + 0.0145 * bank + 0.0009 * grain);

    // Condensation: fine beads that catch the light until a pointer wipes them off. They gather
    // toward the rims and leave the row of titles alone, so nothing competes with the letters.
    float row = abs(p.y - 0.5 * uWaveSpan.z) / max(0.5 * uWaveSpan.z, 1.0);
    float cell = 6.5 * s;
    vec2 id = floor(p / cell);
    vec2 inCell = fract(p / cell) - 0.5 - (vec2(hash21(id + 11.0), hash21(id + 37.0)) - 0.5) * 0.62;
    float size = 0.04 + 0.1 * hash21(id + 71.0);
    float bead = (1.0 - smoothstep(size * 0.45, size, length(inCell))) * step(0.66, hash21(id + 5.0));
    c += uLight * fog * bead * smoothstep(0.42, 0.74, row) * 0.075 * (0.3 + smoothstep(-0.12, 0.1, -inCell.y));
  }

  vec2 row = rowStroke(p);
  c += uLight * row.x * (0.02 + 0.62 * pow(1.0 - row.y, 2.4));

  if (uFlip < 0.0) {
    float fall = exp(-max(-d, 0.0) / (54.0 * uScale));
    c += uLight * vec3(0.8, 0.88, 1.0) * fall * (0.012 + 0.09 * uFlash);
  }

  if (gDay > 0.001) {
    if (cloud) {
      c = mix(c, cloudColour, gDay);
      cover = mix(cover, cloudCover, gDay);
    } else {
      c = mix(c, clearDrop(n, lit), gDay);
    }
  }

  c = pow(c, vec3(1.0 / 2.2));
  return vec4(c * cover, cover);
}

vec4 shadeAction(vec2 p) {
  float d = sdAction(p);
  float cover = edge(d);
  if (cover <= 0.0) return vec4(0.0);

  float e = 0.35;
  float round_ = 54.0 * uScale;
  vec2 ex = vec2(e, 0.0);
  vec2 ey = vec2(0.0, e);
  float h0 = heightFrom(p, -d, round_);
  float hxp = heightFrom(p + ex, -sdAction(p + ex), round_);
  float hxm = heightFrom(p - ex, -sdAction(p - ex), round_);
  float hyp = heightFrom(p + ey, -sdAction(p + ey), round_);
  float hym = heightFrom(p - ey, -sdAction(p - ey), round_);
  vec3 n = normalize(vec3(-(hxp - hxm) / (2.0 * e), -(hyp - hym) / (2.0 * e), 1.0));
  float bend = (abs(hxp + hxm - 2.0 * h0) + abs(hyp + hym - 2.0 * h0)) / (e * e);

  vec3 v = normalize(vec3((p.x - uAct.x) / max(uAct.z * 1.44, 110.0 * uScale), 0.0, -1.0));
  vec3 r = reflect(v, n);
  float wrap = 0.74 + 0.26 * clamp(dot(n, normalize(vec3(-0.1, -0.55, 0.83))), 0.0, 1.0);
  vec3 base = mix(uAction, uActionDay, gDay) * wrap * wrap;
  vec3 lit = aces(lookup(r, 1.1 * bend / uDpr, smoothstep(0.14, 0.34, abs(n.x)), 1.0, 1.0) * mix(0.22, 0.8, gDay));
  return vec4(pow(base + lit * (1.0 - base), vec3(1.0 / 2.2)) * cover, cover);
}

// A tiny clear day: blue going pale toward the foot, the sun, and one small cloud passing.
vec3 orbClear(vec2 q) {
  vec3 c = mix(uZenith * 0.72, uHaze * 0.82, smoothstep(-0.9, 0.95, q.y));
  float r = length(q - vec2(0.12, -0.32));
  c += vec3(1.0, 0.72, 0.34) * (0.55 * exp(-r * r / 0.14));
  c = mix(c, vec3(1.9, 1.38, 0.62), 1.0 - smoothstep(0.21, 0.26, r));
  vec2 o = q - vec2(-0.14 + 0.1 * sin(uTime * 0.31), 0.32);
  float lobes = min(min(length(o - vec2(-0.3, 0.07)) - 0.19, length(o - vec2(0.02, -0.06)) - 0.29), length(o - vec2(0.33, 0.08)) - 0.18);
  lobes = max(lobes, o.y - 0.24);
  vec3 white = mix(uCloudShade, uCloud, smoothstep(0.24, -0.16, o.y));
  return mix(c, white, 1.0 - smoothstep(-0.025, 0.025, lobes));
}

float segment(vec2 p, vec2 a, vec2 b) {
  vec2 ab = b - a;
  return length(p - a - ab * clamp(dot(p - a, ab) / dot(ab, ab), 0.0, 1.0));
}

// A tiny storm: a heavy sky, slanting rain, and now and then a bolt.
vec3 orbStorm(vec2 q) {
  float t = uTime;
  vec3 c = mix(vec3(0.012, 0.014, 0.02), vec3(0.075, 0.085, 0.105), smoothstep(-0.2, 1.0, q.y));
  float roof = q.y + 0.34 + 0.07 * sin(q.x * 5.0 + t * 0.4) + 0.035 * sin(q.x * 13.0 - t * 0.5);
  c = mix(c, vec3(0.05, 0.056, 0.07), smoothstep(0.03, -0.14, roof));

  vec2 r = vec2(q.x + q.y * 0.2, q.y);
  float streaks = 0.0;
  for (int i = 0; i < 2; i++) {
    float f = float(i);
    float columns = 9.0 + 6.0 * f;
    float id = floor(r.x * columns);
    float offset = fract(sin(id * 91.7 + f * 17.0) * 43758.5453);
    float y = fract(r.y * 0.7 - t * (1.5 + 0.5 * f + offset * 0.5) + offset * 11.0);
    float line = 1.0 - smoothstep(0.0, 0.2, abs(fract(r.x * columns) - 0.5));
    streaks += line * smoothstep(0.0, 0.04, y) * (1.0 - smoothstep(0.04, 0.34, y)) * (0.35 + 0.65 * offset);
  }
  c += vec3(0.62, 0.68, 0.8) * streaks * 0.3 * smoothstep(-0.32, 0.02, roof);

  float beat = fract(t / 2.9);
  float flash = max(exp(-beat * 30.0), 0.65 * exp(-max(beat - 0.1, 0.0) * 34.0) * step(0.1, beat));
  float bolt = min(min(segment(q, vec2(0.12, -0.5), vec2(-0.08, -0.08)), segment(q, vec2(-0.08, -0.08), vec2(0.1, -0.02))), segment(q, vec2(0.1, -0.02), vec2(-0.14, 0.52)));
  c += vec3(0.5, 0.56, 0.72) * flash * 0.34;
  c += vec3(1.0, 1.02, 1.1) * flash * (2.8 * (1.0 - smoothstep(0.012, 0.04, bolt)) + 0.5 * exp(-bolt * 11.0));
  return c;
}

float orbDistance(vec2 p) {
  return length((p - uOrb.xy) * vec2(1.0, 0.95)) - uOrb.z;
}

// A drop with the other weather inside it. The glass bends the picture toward its rim.
vec4 shadeOrb(vec2 p) {
  float aa = 0.8 / uDpr;
  float dist = orbDistance(p);
  float cover = smoothstep(aa, -aa, dist);
  if (cover <= 0.0) return vec4(0.0);
  vec2 q = (p - uOrb.xy) / uOrb.z;
  float rr = min(dot(q, q), 1.0);
  float z = sqrt(1.0 - rr);
  float hover = uOrbB.w;
  vec2 uv = q * (0.96 - 0.1 * hover + 0.36 * (1.0 - z));
  vec3 scene = uOrbB.z > 0.5 ? orbClear(uv) : orbStorm(uv);

  // Real drops darken toward the rim, then catch a thin line of light right at it.
  scene *= 1.0 - 0.6 * smoothstep(0.6, 1.0, sqrt(rr));
  vec3 rim = mix(uLight, uHaze, gDay);
  scene += rim * 0.75 * smoothstep(0.86, 1.0, sqrt(rr)) * (0.3 + 0.7 * smoothstep(-0.3, 0.8, q.y));
  scene += uLight * (0.14 + 0.14 * hover) * smoothstep(0.2, 0.9, q.y) * smoothstep(0.42, 0.8, sqrt(rr));

  // The window high on the left, the highlight that says wet.
  vec2 h = (q - vec2(-0.36, -0.46)) * vec2(1.0, 1.55);
  h = vec2(h.x * 0.82 + h.y * 0.57, -h.x * 0.57 + h.y * 0.82);
  scene += uLight * 1.5 * (1.0 - smoothstep(0.11, 0.19, length(h)));
  vec3 encoded = pow(max(scene, vec3(0.0)), vec3(1.0 / 2.2));
  return vec4(min(encoded, vec3(1.0)) * cover, cover);
}

void main() {
  vec2 screen = vec2(gl_FragCoord.x, uView.y * uDpr - gl_FragCoord.y) / uDpr;
  vec2 p = vec2(screen.x, uFlip > 0.0 ? screen.y : uView.y - screen.y);
  gDay = dayAt(screen);

  float dBlack = sdBlack(p);
  float dAction = sdAction(p);
  float dOrb = uOrb.w > 0.001 ? orbDistance(p) : 1e5;
  float d = min(min(dBlack, dAction), dOrb);

  // The soft dark beneath a heavy thing.
  float shadow = 0.0;
  if (uShadow > 0.001) {
    float reach = 46.0 * uScale;
    vec2 low = p - vec2(0.0, 12.0 * uScale);
    float below = min(sdForms(sheared(low)), uActInfo.y > 0.001 ? sdActionForm(low) : 1e5);
    float shade = smoothstep(reach, -8.0 * uScale, below);
    shadow = shade * shade * uShadow * (1.0 - gDay);
  }

  if (d > 1.5 + 2.6 * uScale * gDay) {
    fragColor = vec4(0.0, 0.0, 0.0, shadow);
    return;
  }

  // Supersample where reflections move fastest. Deep inside a form one sample is enough.
  float rim = 26.0 * uScale;
  int n = (gDay < 0.999 && dBlack > -rim) || abs(dAction) < rim ? 2 : 1;
  vec4 sum = vec4(0.0);
  for (int i = 0; i < n; i++) {
    for (int j = 0; j < n; j++) {
      vec2 o = ((vec2(float(i), float(j)) + 0.5) / float(n) - 0.5) / uDpr;
      vec4 body = shadeBlack(p + o);
      if (dAction < 1.5) {
        vec4 pearl = shadeAction(p + o);
        body = pearl + body * (1.0 - pearl.a);
      }
      sum += body;
    }
  }
  sum /= float(n * n);
  // Only a jet standing in open water fades at its foot. Cloud reaches past the form it grows from.
  if (uFlip < 0.0 && smin(sdForms(sheared(p)), p.y, uShoulder) > 0.0 && (gDay < 0.001 || sdBody(p) > 0.0)) sum *= jetFoot(p);
  if (dOrb < 1.5) {
    vec4 orb = shadeOrb(p);
    sum = orb + sum * (1.0 - orb.a);
  }

  float dither = (hash21(gl_FragCoord.xy) - 0.5) / 255.0;
  fragColor = vec4(sum.rgb + dither * sum.a, sum.a + (1.0 - sum.a) * shadow);
}`;
