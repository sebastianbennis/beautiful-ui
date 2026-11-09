// The water at the foot of the banner, seen from a low angle. In a storm it is a black sheet that
// mirrors the lights of the navigation. Under a clear sky it is blue with the sun lying on it.
// Rain and every falling drip leave rings on it.
// Everything is worked out on the plane of the water, then drawn in perspective.

import { FRONT_GLSL } from './daylight';
import { BEAD_COUNT } from './shader';

export const RING_COUNT = 16;
export const LAMP_COUNT = 5;

export const WATER_SHADER = `#version 300 es
precision highp float;

#define RINGS ${RING_COUNT}
#define LAMPS ${LAMP_COUNT}
#define BEADS ${BEAD_COUNT}
#define TAU 6.2831853

uniform vec2 uView;
uniform float uDpr;
uniform float uScale;
uniform float uLevel;
uniform float uGap;
uniform float uFocal;
uniform float uTime;
uniform float uFlash;
uniform float uFlashX;
uniform vec3 uSky;
uniform vec3 uGlow;
uniform vec3 uLight;
uniform vec3 uAction;
uniform vec3 uSurface;
uniform vec4 uRing[RINGS];
uniform vec4 uLamp[LAMPS];
uniform vec4 uMirror[BEADS];
uniform vec3 uZenith;
uniform vec3 uHaze;
uniform vec3 uDeep;
uniform vec3 uCloud;
uniform float uSunX;
uniform float uGlimmer;
${FRONT_GLSL}
out vec4 fragColor;

float sq(float x) {
  return x * x;
}

float hash21(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

vec2 hash22(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.103, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.xx + q.yz) * q.zy);
}

// A wave that is finer than a couple of pixels this far away can only shimmer, so it fades out
// before it can turn into noise.
float resolved(float lambda, float w) {
  return smoothstep(1.5, 4.0, lambda * w * w / uFocal);
}

// Value noise and its gradient.
vec3 noised(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  vec2 du = 6.0 * f * (1.0 - f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  float k1 = b - a;
  float k2 = c - a;
  float k3 = a - b - c + d;
  return vec3(a + k1 * u.x + k2 * u.y + k3 * u.x * u.y, du * (vec2(k1, k2) + k3 * u.yx));
}

// The wind on the water: noise stretched along the horizon, two sheets sliding against each
// other so it churns instead of scrolling. Noise, so its crests can never line up into stripes.
vec2 chop(vec2 p, float t, float w) {
  vec2 slope = vec2(0.0);
  vec2 f = vec2(0.72, 2.3);
  float amp = 1.0;
  for (int i = 0; i < 3; i++) {
    float k = resolved(2.0 / f.y, w);
    if (k > 0.001) {
      float rate = 0.34 + 0.16 * float(i);
      vec3 a = noised(p * f + vec2(float(i) * 3.3, t * rate));
      vec3 b = noised(p * f + vec2(17.0 - t * rate * 0.5, 5.1 - t * rate * 0.8));
      slope += (a.yz + b.yz) * f * amp * k;
    }
    f *= 1.87;
    amp *= 0.46;
  }
  return slope * 0.0062;
}

// One sheet of raindrops. Each cell of the plane takes a drop now and then, always somewhere new.
vec2 rain(vec2 p, float t, float cell, float seed, float lambda, float speed, float life) {
  vec2 q = p / cell;
  vec2 id = floor(q);
  vec2 slope = vec2(0.0);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 c = id + vec2(float(i), float(j));
      vec2 h = hash22(c * 1.37 + seed);
      float period = life * (1.15 + 2.4 * h.y);
      float phase = t / period + h.x;
      float n = floor(phase);
      float age = (phase - n) * period;
      if (age > life) continue;
      vec2 spot = c + 0.5 + 0.8 * (hash22(c + n * 3.17 + seed * 1.9) - 0.5);
      vec2 to = (q - spot) * cell;
      float d = length(to);
      float front = d - speed * age;
      float gone = 1.0 - age / life;
      slope += to / max(d, 0.0001) * exp(-sq(front / (lambda * 1.05))) * gone * gone * sin(front / lambda * TAU);
    }
  }
  return slope;
}

// The storm as the water sees it. v is how far above the horizon, in pixels, a facet is looking.
vec3 skyIn(float x, float v) {
  float H = uView.y;
  float up = max(v, 0.0);
  float low = exp(-sq(up / (0.2 * H)));
  float pool = exp(-sq((x / uView.x - 0.56) / 0.58));
  float band = exp(-sq(up / (0.1 * H)));
  return uSky + uGlow * (low * (0.32 + 0.68 * pool) * 0.04 + band * (0.25 + 0.75 * pool) * 0.15);
}

// Short sharp wavelets that only a clear sky shows up. Far away they are finer than a pixel and
// fade out, which is why distant water goes smooth.
vec2 wavelets(vec2 p, float t, float w) {
  vec2 slope = vec2(0.0);
  vec2 f = vec2(2.7, 8.6);
  float amp = 1.0;
  for (int i = 0; i < 4; i++) {
    float k = resolved(2.0 / f.y, w);
    if (k > 0.001) {
      float rate = 0.9 + 0.3 * float(i);
      vec3 a = noised(p * f + vec2(float(i) * 2.1, t * rate));
      vec3 b = noised(p * f * 1.13 + vec2(13.0 - t * rate * 0.6, 3.1 - t * rate * 0.7));
      slope += (a.yz + b.yz) * f * amp * k;
    }
    f *= 1.9;
    amp *= 0.52;
  }
  return slope * 0.00125;
}

// The same water under a clear sky. Close by you see into it. Far off, at a shallower angle, it
// turns to mirror. The sun lies on it as a long path broken into glitter.
vec3 clearWater(float side, float v, float w, float depth, vec2 slope, vec2 fine) {
  float H = uView.y;
  float s = uScale;
  float look = clamp(v / (0.7 * H), 0.0, 1.0);
  vec3 sky = mix(uHaze, uZenith, pow(look, 0.8));
  float grazing = pow(1.0 - clamp(w / uFocal, 0.0, 1.0), 2.6);
  vec3 col = mix(uDeep, sky, 0.2 + 0.8 * grazing);

  // The white of the far cloud bank lying on the far water.
  col = mix(col, uCloud, 0.42 * exp(-sq(v / (0.05 * H))));

  // The sun's path: a steady sheen, broken close by into hard points of glitter.
  float spread = (16.0 + 0.5 * depth) * s;
  float across = (side - uSunX) / spread;
  float path = exp(-across * across);
  float sheen = exp(-sq((side - uSunX) / (spread * 2.6)));
  float glint = smoothstep(0.016, 0.052, -(slope.y + fine.y));
  vec3 sunlight = vec3(1.0, 0.96, 0.88);
  col += sunlight * sheen * 0.16 * (1.0 + grazing);
  col += sunlight * path * glint * (3.0 + 4.0 * uGlimmer);
  // Away from the path the same wavelets only pick up a little of the sky.
  col += sky * 0.12 * smoothstep(0.0, 0.05, -fine.y);

  return mix(col, uHaze, exp(-depth / (8.0 * s)) * 0.86);
}

void main() {
  vec2 frag = gl_FragCoord.xy / uDpr;
  float s = uScale;
  float x = frag.x;
  float t = uTime;

  // The far edge breathes a little, like a long swell a long way off.
  float swell = (0.8 * sin(x * 0.0071 / s + t * 0.41) + 0.45 * sin(x * 0.0173 / s - t * 0.63 + 1.7)) * s;
  float b = uLevel + swell - frag.y;
  if (b < -1.0) {
    fragColor = vec4(0.0);
    return;
  }
  float depth = max(b, 0.0);
  float w = depth + uGap;
  vec2 p = vec2((x - uView.x * 0.5) / w, uFocal / w);
  float day = dayAt(vec2(x, uView.y - frag.y));

  vec2 slope = chop(p, t, w);

  // Rain only falls where the storm still is.
  float nearA = resolved(0.058, w) * (1.0 - day);
  float nearB = resolved(0.1, w) * (1.0 - day);
  if (nearA > 0.001) slope += rain(p, t, 0.3, 3.7, 0.058, 0.15, 0.85) * 0.11 * nearA;
  if (nearB > 0.001) slope += rain(p + 9.1, t, 0.55, 11.3, 0.1, 0.2, 1.25) * 0.13 * nearB;

  for (int i = 0; i < RINGS; i++) {
    vec4 r = uRing[i];
    if (r.w <= 0.0) continue;
    vec2 to = p - r.xy;
    float d = length(to);
    float lambda = mix(0.075, 0.2, r.w);
    float front = d - mix(0.3, 0.46, r.w) * r.z;
    if (abs(front) > lambda * 3.2) continue;
    float fade = exp(-r.z * mix(1.9, 0.92, r.w)) * smoothstep(0.0, 0.06, r.z);
    slope += to / max(d, 0.0001) * r.w * fade * exp(-sq(front / (lambda * 1.3))) * sin(front / lambda * TAU) * 0.5 * resolved(lambda, w);
  }

  // What the surface mirrors. A facet tilted away from the viewer looks lower in the sky, which
  // is where the light is, so the far side of each ring catches it.
  float v = w + 2.0 * uFocal * slope.y;
  float side = x - 2.0 * uFocal * slope.x * (w / uFocal + slope.y);
  vec3 col = vec3(0.0);
  if (day < 0.999) {
    float mirror = 0.62 + 0.38 * pow(1.0 - clamp(w / uFocal, 0.0, 1.0), 5.0);
    col = uSurface * 0.6 + skyIn(side, v) * mirror * smoothstep(-90.0 * s, 0.0, v);

    // The lights of the navigation lie on the water in long, broken paths.
    float glint = smoothstep(0.016, 0.13, -slope.y);
    for (int i = 0; i < LAMPS; i++) {
      vec4 lamp = uLamp[i];
      if (lamp.z <= 0.0) continue;
      float spread = lamp.y + (20.0 + 0.32 * depth) * s;
      float across = (side - lamp.x) / spread;
      col += mix(uGlow, uAction, lamp.w) * lamp.z * exp(-across * across) * (0.05 + 1.5 * glint);
    }

    // Lightning. For an instant every ring on the water is lit.
    if (uFlash > 0.001) {
      float column = exp(-sq((side / uView.x - uFlashX) / 0.2));
      float bright = 0.18 + 1.25 * column;
      col += uGlow * uFlash * bright * (0.1 + 0.9 * smoothstep(-0.02, 0.16, -slope.y)) * exp(-depth / (1.4 * max(uLevel, 1.0)));
    }

    // A drop still in the air is already in the water, coming up to meet itself.
    for (int i = 0; i < BEADS; i++) {
      vec4 m = uMirror[i];
      if (m.w <= 0.0 || abs(x - m.x) > 44.0 * s) continue;
      vec2 e = vec2(x + slope.x * 26.0 * s - m.x, (b - m.y) * 0.72);
      float len = length(e);
      col += uLight * m.w * exp(-sq(len / max(m.z * 1.15, 1.2))) * 0.05;
    }

    // Far off, the water dissolves into the mist.
    float mist = exp(-depth / (12.0 * s));
    col = mix(col, skyIn(x, 0.0) * 1.05, mist * 0.72);
  }
  if (day > 0.001) {
    // Far off, a clear sky shows every crest as a line, so the long swell settles down there.
    vec2 calm = slope * smoothstep(6.0 * s, 70.0 * s, depth);
    col = mix(col, clearWater(side, w + 2.0 * uFocal * calm.y, w, depth, calm, wavelets(p, t, w)), day);
  }

  float cover = smoothstep(0.0, 3.0 * s, b);
  vec3 encoded = pow(max(col, vec3(0.0)), vec3(1.0 / 2.2));
  encoded += (hash21(gl_FragCoord.xy + fract(t) * 91.0) - 0.5) / 200.0;
  fragColor = vec4(encoded * cover, cover);
}`;
