// The whole bed is drawn in one pass. Every pixel asks which pin is in front
// of it, shades that surface, and asks which taller pins stand between it and
// the light. Nothing is a texture: heads, shafts and shadows are all analytic,
// so an edge is sharp at any size.

export const VERTEX = /* glsl */ `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

// Every length in here is in pin pitches. One pitch is the distance between
// two neighbouring pins in a row.
export const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uPins;   // r height, read exactly
uniform sampler2D uFields; // r open to the sky, g film arrived, b opened to the video. Smooth, one cell of border
uniform sampler2D uFilm;   // rgb the film's colour. Smooth, same border
uniform vec2  uSize;       // canvas, device pixels
uniform vec2  uOrigin;     // where the first cell starts, device pixels
uniform float uPitch;      // device pixels per pitch
uniform ivec2 uGrid;       // columns, rows
uniform float uDark;       // 0 chalk, 1 blued steel: the material no front has reached
uniform vec4  uTurns[4];   // fronts of a change of material: where each began, how far it has got, what arrives behind it
uniform int   uTurnCount;
uniform float uTurnBand;   // how wide a front is
uniform float uHead;       // head radius
uniform float uShaft;      // shaft radius
uniform float uView;       // how far up the screen a head moves per unit of height
uniform vec2  uCast;       // where a shadow falls per unit of height
uniform float uTallest;
uniform float uFilmOn;     // skip the film lookups until the finish

uniform vec3 uChalk;
uniform vec3 uGraphite;
uniform vec3 uShade;
uniform vec3 uGlint;
uniform vec3 uBlued;

out vec4 outColour;

const float ROW = 0.8660254;   // staggered rows, packed like a real pin screen

float rowY(int j) { return (float(j) + 0.5) * ROW; }
float rowX(int j) { return 0.5 + 0.5 * float(j & 1); }

bool inside(int i, int j) { return i >= 0 && j >= 0 && i < uGrid.x && j < uGrid.y; }

float heightAt(int i, int j) {
  return inside(i, j) ? texelFetch(uPins, ivec2(i, j), 0).r : 0.0;
}

// Smooth values live on a grid with one extra cell all round, so the field of
// pins fades out past its edge instead of ending in a hard line.
vec2 fieldUv(vec2 P) {
  return (vec2(P.x - 0.5, P.y / ROW - 0.5) + 1.5) / (vec2(uGrid) + 2.0);
}

// How much direct light reaches the point X at height z, walking back along
// the light. One short pin barely blocks it. A crowd of tall ones blocks it all.
float light(vec2 X, float z) {
  float reach = uCast.y * max(uTallest - z, 0.0);
  int first = int(floor((X.y - reach - uHead) / ROW - 0.5));
  int last = int(ceil((X.y + uHead) / ROW - 0.5));
  float slope = uCast.x / max(uCast.y, 0.001);
  float lit = 1.0;
  for (int j = last; j >= first; j--) {
    float back = max(X.y - rowY(j), 0.0);
    float cx = X.x - back * slope - (rowX(j) - 0.5);
    int mid = int(floor(cx));
    int side = cx - floor(cx) < 0.5 ? -1 : 1;
    for (int n = 0; n < 2; n++) {
      int i = mid + n * side;
      float h = heightAt(i, j);
      float rise = h - z;
      if (rise <= 0.012) continue;
      vec2 c = vec2(float(i) + rowX(j), rowY(j));
      vec2 ba = uCast * rise;
      vec2 pa = X - c;
      float t = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-5), 0.0, 1.0);
      float along = t * rise;
      float radius = mix(uShaft, uHead * 0.92, smoothstep(0.8, 1.0, t));
      float soft = 0.03 + 0.15 * along;
      float d = length(pa - ba * t) - radius;
      float s = 1.0 - smoothstep(-soft, soft, d);
      float fade = mix(0.92, 0.62, t);
      lit *= 1.0 - s * fade * smoothstep(0.012, 0.2, rise);
      if (lit < 0.01) return 0.0;
    }
  }
  return lit;
}

vec3 lightDir() { return normalize(vec3(-uCast, 1.0)); }

// Which material a pin is made of. While the plate is changing, a front leaves
// the point the change began at and every pin behind it has turned over. Asked
// to change again before it has crossed, a second front follows the first.
float darkAt(vec2 X) {
  float dark = uDark;
  for (int i = 0; i < 4; i++) {
    if (i >= uTurnCount) break;
    vec4 turn = uTurns[i];
    dark = mix(turn.w, dark, smoothstep(turn.z - uTurnBand, turn.z, distance(X, turn.xy)));
  }
  return dark;
}

// All light is measured against a flat, fully lit surface, so a flush pin and
// the plate around it come out the same colour and the pin disappears.
vec3 materialHead(vec2 q, float h, float lit, float dark) {
  vec3 L = lightDir();
  float rr = min(dot(q, q), 1.0);
  float ball = smoothstep(0.0, 0.45, h);
  vec3 sphere = vec3(q, sqrt(1.0 - rr));
  vec3 n = normalize(mix(vec3(0.0, 0.0, 1.0), sphere, ball));
  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
  float diff = max(dot(n, L), 0.0) / L.z;
  float nh = max(dot(n, H), 0.0);

  float sink = smoothstep(0.0, -0.55, h);
  vec3 sky = mix(uChalk, mix(uShade, uChalk, 0.5), ball);
  float keep = mix(1.0, 0.5, smoothstep(0.0, 1.0, 1.0 - n.z));
  float sun = min(diff, 1.0 + 0.16 * smoothstep(0.9, 1.7, diff));
  vec3 chalk = sky * 0.4 * keep + uChalk * 0.6 * sun * mix(0.28, 1.0, lit);
  chalk += uGlint * pow(nh, 110.0) * 0.32 * lit * ball;
  chalk = mix(chalk, uShade * 0.75, 0.82 * sink);

  // Blued steel: dark when flush, and the taller a pin stands the more of its
  // polished tip catches the raking light. The picture is made of glints.
  float tip = smoothstep(0.02, 1.7, h);
  float catchLight = mix(0.45, 1.0, lit);
  vec3 steel = uBlued * (0.34 + 0.4 * diff * lit);
  steel += uGlint * pow(nh, mix(70.0, 7.0, tip)) * catchLight * mix(0.03, 1.15, tip);
  steel += uGlint * pow(nh, 240.0) * catchLight * mix(0.1, 1.2, tip);
  steel *= 1.0 - 0.5 * sink;
  return mix(chalk, steel, dark);
}

vec3 materialShaft(float across, float fromBase, float depth, float dark) {
  vec3 L = lightDir();
  vec3 n = vec3(across, 0.25, sqrt(max(1.0 - across * across, 0.0)));
  n = normalize(n);
  float diff = max(dot(n, L), 0.0) / L.z;
  float deep = mix(0.38, 1.0, smoothstep(0.0, 1.0, fromBase));
  vec3 chalk = (mix(uShade, uChalk, 0.45) * 0.42 + uChalk * 0.5 * diff) * deep * mix(0.42, 1.0, depth);
  float line = pow(max(1.0 - abs(across + 0.4) * 2.4, 0.0), 3.0);
  vec3 steel = (uBlued * (0.3 + 0.45 * diff) + uGlint * 0.4 * line * smoothstep(0.1, 0.9, fromBase)) * deep;
  return mix(chalk, steel, dark);
}

vec3 materialPlate(float lit, float depth, float dark) {
  // the same 0.46 + 0.54 at a flat, unshadowed spot: exactly the chalk colour
  vec3 sky = mix(uGraphite, uChalk, depth * depth);
  vec3 chalk = sky * mix(0.14, 0.46, depth) + uChalk * 0.54 * lit * mix(0.1, 1.0, depth);
  vec3 steel = uBlued * (0.22 * mix(0.45, 1.0, depth) + 0.4 * lit * mix(0.55, 1.0, depth));
  return mix(chalk, steel, dark);
}

vec3 toSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(12.92 * c, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec2 px = vec2(gl_FragCoord.x, uSize.y - gl_FragCoord.y);
  vec2 P = (px - uOrigin) / uPitch;
  float aa = 0.8 / uPitch;

  vec3 col = vec3(0.0);
  float A = 0.0;       // how much of this pixel is already covered
  vec2 fieldAt = fieldUv(P);
  vec3 fields = texture(uFields, fieldAt).rgb;
  float depth = fields.r;

  // Once a spot has opened to the film underneath there is nothing left to draw.
  if (uFilmOn > 0.5 && fields.b > 0.998) {
    outColour = vec4(0.0);
    return;
  }

  // Walking the rows also gathers what the plate needs from nearby holes.
  float seamDark = 0.0;
  float seamLit = 0.0;
  float well = 0.0;

  int near = int(ceil((P.y + uHead + uView * uTallest) / ROW - 0.5));
  int far = int(floor((P.y - uHead - 1.0) / ROW - 0.5));

  for (int j = near; j >= far; j--) {
    int i = int(floor(P.x - (rowX(j) - 0.5)));
    if (!inside(i, j)) continue;
    float h = texelFetch(uPins, ivec2(i, j), 0).r;
    vec2 base = vec2(float(i) + rowX(j), rowY(j));
    float standing = max(h, 0.0);
    vec2 tip = base + vec2(0.0, -uView * standing);
    float dark = darkAt(base);

    float R = uHead * (1.0 + mix(0.04, 0.2, dark) * standing);
    float dHead = length(P - tip) - R;

    float baseDist = length(P - base);

    if (A < 0.995 && dHead < aa) {
      float a = smoothstep(aa, -aa, dHead) * (1.0 - A);
      if (a > 0.0) {
        vec2 q = (P - tip) / R;
        vec3 surf = materialHead(q, h, light(P + vec2(0.0, uView * standing), standing), dark);
        // a flush pin is only told apart from the plate by its hairline
        if (h < 0.3) {
          float rim = smoothstep(0.05, 0.0, -dHead);
          float side = dot(normalize(P - base + 1e-5), normalize(uCast));
          float flush = 1.0 - smoothstep(0.0, 0.3, h);
          vec3 line = mix(uShade, uGlint * 0.12, dark);
          surf = mix(surf, line, rim * flush * mix(0.3, 0.05, side * 0.5 + 0.5) * (1.0 - fields.b));
        }
        col += surf * a;
        A += a;
      }
    }

    if (A < 0.995 && standing > 0.01) {
      float dx = abs(P.x - base.x) - uShaft;
      float dy = max(tip.y - P.y, P.y - base.y);
      float dShaft = max(dx, dy);
      if (dShaft < aa) {
        float a = smoothstep(aa, -aa, dShaft) * (1.0 - A);
        if (a > 0.0) {
          float across = clamp((P.x - base.x) / uShaft, -1.0, 1.0);
          float fromBase = (base.y - P.y) / max(uView, 0.001);
          col += materialShaft(across, fromBase, depth, dark) * a;
          A += a;
        }
      }
    }

    // The countersink this pin lives in. Once the pin has risen the recess
    // shows as a small dark well with a lit lip on the side away from the light.
    float d = baseDist - uHead;
    if (d < 0.1) {
      float risen = smoothstep(0.02, 0.5, standing);
      if (d < 0.0) well = max(well, risen * smoothstep(0.0, -0.09, d));
      vec2 dirTo = (P - base) / max(baseDist, 1e-4);
      float side = dot(dirTo, normalize(uCast));
      float ring = smoothstep(0.08, 0.0, abs(d));
      seamDark = max(seamDark, ring * risen * smoothstep(0.3, -0.7, side));
      seamLit = max(seamLit, ring * risen * smoothstep(0.2, 1.0, side));
    }
  }

  // the plate turns over a pin at a time too, each with the patch of plate around it
  int rowHere = int(floor(P.y / ROW));
  float darkHere = darkAt(vec2(floor(P.x - (rowX(rowHere) - 0.5)) + rowX(rowHere), rowY(rowHere)));
  if (A < 0.995) {
    float lit = light(P, 0.0);
    vec3 plate = materialPlate(lit, depth, darkHere);
    plate *= 1.0 - well * mix(0.5, 0.62, darkHere);
    plate = mix(plate, uGraphite, seamDark * 0.22 * (1.0 - darkHere));
    plate += uGlint * seamLit * mix(0.1, 0.05, darkHere) * lit;

    float a = 1.0 - A;
    col += plate * a;
  }

  // The film arrives in the light itself, so the whole relief takes its colour:
  // the same shadows and glints, now in the colours of the picture.
  float alpha = 1.0;
  if (uFilmOn > 0.5) {
    if (fields.g > 0.001) {
      vec3 film = pow(texture(uFilm, fieldAt).rgb, vec3(2.2));
      vec3 luma = vec3(0.2126, 0.7152, 0.0722);
      float flat_ = dot(mix(uChalk, uBlued * 0.62, darkHere), luma);
      float shade = clamp(dot(col, luma) / flat_, 0.0, 1.5);
      col = mix(col, film * shade, fields.g);
    }
    alpha = 1.0 - fields.b;
  }
  outColour = vec4(toSrgb(col) * alpha, alpha);
}
`;
