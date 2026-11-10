'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';

const PINS = 96;

function clock(s: number): string {
  if (!Number.isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

/** The plate has become the video. Its transport is one row of the same pins. */
export function Transport({ video }: { video: RefObject<HTMLVideoElement | null> }) {
  const [playing, setPlaying] = useState(true);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const pins = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    let raf = 0;
    let lastSecond = -1;
    const loop = () => {
      const row = pins.current;
      if (row && v.duration) {
        const at = Math.round((v.currentTime / v.duration) * PINS);
        row.style.setProperty('--pinbed-at', String(at));
        for (let i = 0; i < row.children.length; i++) {
          (row.children[i] as HTMLElement).dataset.up = i < at ? '1' : '';
        }
      }
      const second = Math.floor(v.currentTime);
      if (second !== lastSecond) {
        lastSecond = second;
        setTime(v.currentTime);
        setDuration(v.duration || 0);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const sync = () => setPlaying(!v.paused);
    v.addEventListener('play', sync);
    v.addEventListener('pause', sync);
    return () => {
      cancelAnimationFrame(raf);
      v.removeEventListener('play', sync);
      v.removeEventListener('pause', sync);
    };
  }, [video]);

  const toggle = () => {
    const v = video.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => undefined);
    else v.pause();
  };

  const seek = (value: number) => {
    const v = video.current;
    if (v?.duration) v.currentTime = value * v.duration;
  };

  return (
    <div className="pinbed-transport">
      <button type="button" className="pinbed-play" aria-label={playing ? 'Pause film' : 'Play film'} onClick={toggle}>
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          {playing ? <path d="M4 2.5h3v11H4zM9 2.5h3v11H9z" /> : <path d="M4 2.2 13.5 8 4 13.8z" />}
        </svg>
      </button>
      <div className="pinbed-scrub">
        <div ref={pins} className="pinbed-scrubpins" aria-hidden="true">
          {Array.from({ length: PINS }, (_, i) => <i key={i} />)}
        </div>
        <input
          type="range"
          className="pinbed-range"
          min={0}
          max={1}
          step={0.001}
          value={duration ? time / duration : 0}
          aria-label="Position in film"
          onChange={(e) => seek(Number(e.target.value))}
        />
      </div>
      <p className="pinbed-clock">{clock(time)} / {clock(duration)}</p>
    </div>
  );
}
