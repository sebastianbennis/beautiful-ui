'use client';

// Draws a Field with WebGL2, in a single fragment pass.
import { FRAGMENT, VERTEX } from './shader';
import type { Field } from './field';
import { MAX_TURNS, ROW, TALLEST, TURN_BAND } from './field';

export interface Palette {
  chalk: [number, number, number];
  graphite: [number, number, number];
  shade: [number, number, number];
  glint: [number, number, number];
  blued: [number, number, number];
}

export interface PinShape {
  head: number;
  shaft: number;
  view: number;
  castX: number;
  castY: number;
}

export const PIN: PinShape = { head: 0.2, shaft: 0.11, view: 0.3, castX: 0.95, castY: 0.62 };

export interface Renderer {
  resize(cssW: number, cssH: number, dpr: number, pitchCss: number, cols: number, rows: number): void;
  palette(p: Palette): void;
  /** For a renderer that cannot show a material travelling across the bed. */
  dark(on: boolean): void;
  draw(f: Field): void;
  film(rgb: Uint8Array, cols: number, rows: number): void;
  destroy(): void;
}

type U = WebGLUniformLocation | null;

export function createWebGlRenderer(canvas: HTMLCanvasElement): Renderer | null {
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
  });
  if (!gl) return null;

  const compile = (type: number, src: string) => {
    const s = gl.createShader(type);
    if (!s) return null;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      console.error(gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  };

  const vs = compile(gl.VERTEX_SHADER, VERTEX);
  const fs = compile(gl.FRAGMENT_SHADER, FRAGMENT);
  const program = gl.createProgram();
  if (!vs || !fs || !program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.bindAttribLocation(program, 0, 'aPos');
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error(gl.getProgramInfoLog(program));
    return null;
  }
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const u: Record<string, U> = {};
  for (const name of [
    'uPins', 'uFields', 'uFilm', 'uSize', 'uOrigin', 'uPitch', 'uGrid', 'uDark', 'uTurns', 'uTurnCount', 'uTurnBand', 'uHead', 'uShaft', 'uView',
    'uCast', 'uTallest', 'uFilmOn', 'uChalk', 'uGraphite', 'uShade', 'uGlint', 'uBlued',
  ]) {
    u[name] = gl.getUniformLocation(program, name);
  }

  const nearest = () => {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  };

  const smooth = () => {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  };

  const pins = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, pins);
  nearest();
  const film = gl.createTexture();
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, film);
  smooth();
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  const fields = gl.createTexture();
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, fields);
  smooth();

  gl.uniform1i(u.uPins, 0);
  gl.uniform1i(u.uFilm, 1);
  gl.uniform1i(u.uFields, 2);
  gl.uniform1f(u.uHead, PIN.head);
  gl.uniform1f(u.uShaft, PIN.shaft);
  gl.uniform1f(u.uView, PIN.view);
  gl.uniform2f(u.uCast, PIN.castX, PIN.castY);
  gl.uniform1f(u.uTallest, TALLEST + 0.9);
  gl.uniform1f(u.uTurnBand, TURN_BAND);

  let data = new Float32Array(0);
  let fieldData = new Uint8Array(0);
  let filmData = new Uint8Array(0);
  let drawn = new Float32Array(0);
  let allocated = false;
  let cols = 0;
  let rows = 0;
  let full = true;
  let wasDark: boolean | null = null;
  let wasTurning = false;
  let wasFinishing = false;
  const turnData = new Float32Array(MAX_TURNS * 4);
  let pitch = 1;
  let originX = 0;
  let originY = 0;

  return {
    resize(cssW, cssH, dpr, pitchCss, c, r) {
      const w = Math.round(cssW * dpr);
      const h = Math.round(cssH * dpr);
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      gl.viewport(0, 0, w, h);
      gl.uniform2f(u.uSize, w, h);
      const p = pitchCss * dpr;
      pitch = p;
      originX = (w - (c + 0.5) * p) / 2;
      originY = (h - r * ROW * p) / 2 + 0.35 * p;
      gl.uniform1f(u.uPitch, p);
      gl.uniform2i(u.uGrid, c, r);
      gl.uniform2f(u.uOrigin, originX, originY);
      full = true;
      if (c !== cols || r !== rows || !allocated) {
        cols = c;
        rows = r;
        data = new Float32Array(c * r);
        drawn = new Float32Array(c * r).fill(-99);
        fieldData = new Uint8Array((c + 2) * (r + 2) * 4);
        filmData = new Uint8Array((c + 2) * (r + 2) * 4);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, pins);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, c, r, 0, gl.RED, gl.FLOAT, null);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, fields);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, c + 2, r + 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        allocated = true;
      }
    },
    palette(p) {
      full = true;
      gl.uniform3fv(u.uChalk, p.chalk);
      gl.uniform3fv(u.uGraphite, p.graphite);
      gl.uniform3fv(u.uShade, p.shade);
      gl.uniform3fv(u.uGlint, p.glint);
      gl.uniform3fv(u.uBlued, p.blued);
    },
    dark() {
      // the material is read from the field on every draw
      full = true;
    },
    film(rgb, c, r) {
      // one cell of border, copied from the nearest pin, so the margin goes with it
      const W = c + 2;
      const H = r + 2;
      if (filmData.length !== W * H * 4) filmData = new Uint8Array(W * H * 4);
      for (let y = 0; y < H; y++) {
        const j = Math.max(0, Math.min(r - 1, y - 1));
        for (let x = 0; x < W; x++) {
          const i = Math.max(0, Math.min(c - 1, x - 1));
          const from = (j * c + i) * 3;
          const to = (y * W + x) * 4;
          filmData[to] = rgb[from];
          filmData[to + 1] = rgb[from + 1];
          filmData[to + 2] = rgb[from + 2];
          filmData[to + 3] = 255;
        }
      }
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, film);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, filmData);
    },
    draw(f) {
      // Only what moved is redrawn. A four hour upload changes one thin band of
      // columns at a time, so the rest of the plate costs nothing.
      let c0 = cols;
      let c1 = -1;
      let r0 = rows;
      let r1 = -1;
      const turning = f.turns.length > 0;
      const finishing = !!f.finish;
      // The material, a turn and the finish all change pixels that no pin's height accounts for,
      // so the frame they start on and the frame they end on are drawn whole.
      if (f.dark !== wasDark || wasTurning !== turning || wasFinishing !== finishing) {
        wasDark = f.dark;
        wasTurning = turning;
        wasFinishing = finishing;
        full = true;
      }
      gl.uniform1f(u.uDark, f.dark ? 1 : 0);
      for (let i = 0; i < f.turns.length; i++) {
        const turn = f.turns[i];
        turnData.set([turn.x, turn.y, (f.now - turn.born) * turn.speed, turn.to ? 1 : 0], i * 4);
      }
      gl.uniform4fv(u.uTurns, turnData);
      gl.uniform1i(u.uTurnCount, f.turns.length);
      const everything = full || finishing || turning;
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const k = j * cols + i;
          data[k] = f.h[k];
          if (Math.abs(f.h[k] - drawn[k]) > 0.0015) {
            drawn[k] = f.h[k];
            if (i < c0) c0 = i;
            if (i > c1) c1 = i;
            if (j < r0) r0 = j;
            if (j > r1) r1 = j;
          }
        }
      }
      if (!everything && c1 < 0) return;

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, pins);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, f.cols, f.rows, gl.RED, gl.FLOAT, data);
      const W = cols + 2;
      const H = rows + 2;
      for (let y = 0; y < H; y++) {
        const j = Math.max(0, Math.min(rows - 1, y - 1));
        const edgeY = y === 0 || y === H - 1;
        for (let x = 0; x < W; x++) {
          const i = Math.max(0, Math.min(cols - 1, x - 1));
          const k = j * cols + i;
          const o = (y * W + x) * 4;
          fieldData[o] = edgeY || x === 0 || x === W - 1 ? 255 : f.depth[k] * 255;
          fieldData[o + 1] = f.film[k] * 255;
          fieldData[o + 2] = f.opened[k] * 255;
          fieldData[o + 3] = 255;
        }
      }
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, fields);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, fieldData);
      gl.uniform1f(u.uFilmOn, f.finish?.film ? 1 : 0);

      if (everything) {
        gl.disable(gl.SCISSOR_TEST);
      } else {
        // the box around what moved, plus how far its shadows and light can reach
        const left = c0 <= 4 ? 0 : originX + (c0 - 4) * pitch;
        const right = c1 >= cols - 6 ? canvas.width : originX + (c1 + 7) * pitch;
        const top = r0 <= 6 ? 0 : originY + (r0 - 6) * ROW * pitch;
        const bottom = r1 >= rows - 7 ? canvas.height : originY + (r1 + 8) * ROW * pitch;
        const x = Math.max(0, Math.floor(left));
        const y = Math.max(0, Math.floor(canvas.height - bottom));
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(x, y, Math.ceil(right - x), Math.ceil(bottom - top));
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      full = false;
    },
    destroy() {
      gl.deleteTexture(pins);
      gl.deleteTexture(film);
      gl.deleteTexture(fields);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
