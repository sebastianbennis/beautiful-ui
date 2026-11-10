'use client';

import { useEffect, useRef } from 'react';
import type { Picture } from './picture';
import type { Uploader } from './upload';

const COLS = 42;
const ROWS = 24;

/** The same bed at a small unit, so every file in the queue shows how far it has come. */
export function MiniBed({ picture, uploader }: { picture: Picture | null; uploader: Uploader | null }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = 64 * dpr;
    canvas.height = 36 * dpr;
    const fill = new Float32Array(COLS);
    const paint = () => {
      if (uploader) uploader.columns(fill);
      else fill.fill(0);
      const ink = getComputedStyle(canvas).color;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = ink;
      const stepX = canvas.width / COLS;
      const stepY = canvas.height / ROWS;
      for (let j = 0; j < ROWS; j++) {
        for (let i = 0; i < COLS; i++) {
          let tone = 0.12;
          if (picture && fill[i] > 0) {
            const u = Math.min(picture.w - 1, Math.floor(((i + 0.5) / COLS) * picture.w));
            const v = Math.min(picture.h - 1, Math.floor(((j + 0.5) / ROWS) * picture.h));
            tone = 0.12 + 0.88 * Math.max(picture.tone[v * picture.w + u], 0) * fill[i];
          }
          ctx.globalAlpha = tone;
          ctx.beginPath();
          ctx.arc((i + 0.5) * stepX, (j + 0.5) * stepY, stepX * 0.34, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    };
    paint();
    const t = window.setInterval(paint, 700);
    return () => window.clearInterval(t);
  }, [picture, uploader]);

  return <canvas ref={ref} className="pinbed-mini" aria-hidden="true" />;
}
