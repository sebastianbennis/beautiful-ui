// The second weather. Storm and clear sky are drawn by the same three layers: the sky, the water
// and the forms of the navigation. One edge passes through all of them when the weather turns.

/** Shared by every layer, so the change passes through them as a single front. */
export const FRONT_GLSL = `
uniform vec4 uFront;
uniform vec2 uFrontEdge;
uniform float uDayBase;

float frontHash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

float frontNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(frontHash(i), frontHash(i + vec2(1.0, 0.0)), f.x), mix(frontHash(i + vec2(0.0, 1.0)), frontHash(i + vec2(1.0, 1.0)), f.x), f.y);
}

// 0 is storm and 1 is clear sky. The front opens from where the drop went in. On the water, which
// is seen from a low angle, it spreads as a flat ring. Its edge is ragged, like weather.
float dayAt(vec2 s) {
  if (uFront.z <= 0.0) return uDayBase;
  vec2 to = s - uFront.xy;
  if (to.y > 0.0) to.y *= 2.6;
  float soft = uFrontEdge.x;
  float wobble = ((frontNoise(s / soft * 1.1) - 0.5) + 0.5 * (frontNoise(s / soft * 2.9 + 7.0) - 0.5)) * uFrontEdge.y;
  float k = 1.0 - smoothstep(uFront.z - soft, uFront.z, length(to) + wobble);
  return mix(uDayBase, 1.0 - uDayBase, k);
}
`;

/** How much a distance below the landing point counts, to match the flat ring in the shaders. */
export const FRONT_SQUASH = 2.6;

export const PUFF_SIZE = 384;

let tile: Float32Array | null = null;

/**
 * Soft round lumps at three sizes, the raw material of every cloud. Worked out once and
 * kept as a texture, so a cloud as big as a phone screen costs a few lookups a pixel.
 */
export function puffTile(): Float32Array {
  if (tile) return tile;
  const size = PUFF_SIZE;
  const out = new Float32Array(size * size * 4);
  let seed = 41;
  const random = (): number => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  // Big lobes, medium lumps and fine detail each get a channel, so an edge can use the big ones
  // while a surface uses all of them.
  const octaves = [
    { cells: 7, fill: 0.98 },
    { cells: 15, fill: 0.92 },
    { cells: 31, fill: 0.86 },
  ];
  octaves.forEach(({ cells, fill }, channel) => {
    const pitch = size / cells;
    for (let j = 0; j < cells; j++) {
      for (let i = 0; i < cells; i++) {
        // Each lump is painted straight into the tile, wrapping at the edges so the tile repeats cleanly.
        const cx = (i + 0.14 + 0.72 * random()) * pitch;
        const cy = (j + 0.14 + 0.72 * random()) * pitch;
        const r = (0.66 + 0.34 * random()) * fill * pitch;
        const r2 = r * r;
        for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
          for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
            const q = ((x - cx) * (x - cx) + (y - cy) * (y - cy)) / r2;
            if (q >= 1) continue;
            const root = Math.sqrt(1 - q);
            const at = (((x + size) % size) + ((y + size) % size) * size) * 4 + channel;
            out[at] = Math.max(out[at], root * Math.sqrt(root));
          }
        }
      }
    }
  });
  tile = out;
  return out;
}
