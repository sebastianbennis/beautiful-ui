'use client';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react';
import { GlassHeadEngine } from './engine';
import { GlassHeadIcon } from './icons';
import { createKeys } from './keys';
import { measurePeaks } from './peaks';
import { createRibbon } from './ribbon';
import { GlassHeadScrub } from './scrub';
import type { KeysRenderer } from './keys';
import type { RibbonRenderer, RibbonTracks } from './ribbon';
import type { GlassHeadHandle, GlassHeadProps, GlassHeadState, GlassHeadTrack } from './types';

const TINTS = ['oklch(0.68 0.19 45)', 'oklch(0.72 0.13 175)', 'oklch(0.6 0.2 285)', 'oklch(0.78 0.15 95)'];
const KEYS = ['back', 'stop', 'play', 'pause', 'forward'] as const;
const LATCH: (GlassHeadState | null)[] = [null, 'stopped', 'playing', 'paused', null];

function toRgb(color: string): [number, number, number] {
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return [0.6, 0.6, 0.6];
  ctx.fillStyle = '#999';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return [r / 255, g / 255, b / 255];
}

function samePeaks(a?: number[], b?: number[]) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Two lists that would play and draw the same: a new array holding the same tracks is the same queue. */
function sameQueue(a: GlassHeadTrack[], b: GlassHeadTrack[]) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((t, i) => t.src === b[i].src && t.duration === b[i].duration && t.tint === b[i].tint && samePeaks(t.peaks, b[i].peaks));
}

function clock(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const GlassHead = forwardRef<GlassHeadHandle, GlassHeadProps>(function GlassHead(
  { tracks, theme, span = 14, renderer = 'auto', scrubSound = true, label = 'Player', className, onStateChange, onTrackChange },
  ref,
) {
  // Tracks written inline arrive as a new array on every render of the page around the player.
  // The queue is only loaded again when something in it has changed.
  const held = useRef(tracks);
  if (!sameQueue(held.current, tracks)) held.current = tracks;
  const queue = held.current;
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const engine = useMemo(() => new GlassHeadEngine(), []);
  const scrub = useMemo(() => new GlassHeadScrub(), []);
  const sound = useRef(scrubSound);
  sound.current = scrubSound;
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [sec, setSec] = useState(0);
  const view = useRef({
    renderer: null as RibbonRenderer | null,
    data: null as RibbonTracks | null,
    raf: 0,
    prev: 0,
    lx: 0,
    ly: 0,
    tx: 0,
    ty: 0,
    light: false,
    jumps: 0,
    sec: -1,
    scrubbing: false,
    scrubAt: -1,
    measured: new Map<string, number[]>(),
    keys: null as KeysRenderer | null,
    keyRects: new Float32Array(20),
    keyState: new Float32Array(20),
    keyTouch: new Float32Array(20),
    unit: 8,
    primed: false,
    tints: [] as [number, number, number][],
    // The pointer as a second, close light on the keys: where it is, where it is heading, how present it is.
    px: 0,
    py: 0,
    ps: 0,
    ptx: 0,
    pty: 0,
    pt: 0,
    sim: KEYS.map(() => ({
      depth: 0,
      dv: 0,
      press: 0,
      level: 0,
      spread: 1,
      sv: 0,
      off: 0,
      ox: 0,
      oy: 0,
      held: false,
      hover: false,
      on: false,
      flash: -1,
      at: -1e9,
      css: '',
    })),
  });
  const keysRef = useRef<HTMLDivElement>(null);
  const keyCanvasRef = useRef<HTMLCanvasElement>(null);
  const keyEls = useRef<(HTMLButtonElement | null)[]>([]);
  const measureKeys = useRef<(() => void) | null>(null);
  const [glass, setGlass] = useState(false);
  const drag = useRef({ id: -1, x: 0, moved: 0, samples: [] as { t: number; x: number }[] });
  const seen = useRef({ state: 'stopped' as GlassHeadState, index: 0 });
  const handlers = useRef({ onStateChange, onTrackChange });
  handlers.current = { onStateChange, onTrackChange };

  // Each key is a slab on a spring. A held key goes all the way down, the latched one rests half way,
  // and the colour of a key that lights up spreads from where it was touched.
  const stepKeys = useCallback(
    (now: number, dt: number) => {
      const v = view.current;
      if (!v.keys) return false;
      let moving = false;
      const still = engine.reduced || !v.primed;
      const loading = engine.loading && engine.state === 'playing';
      const steps = Math.max(1, Math.ceil(dt / 0.004));
      const h = dt / steps;
      for (let i = 0; i < KEYS.length; i++) {
        const k = v.sim[i];
        const el = keyEls.current[i];
        const off = !el || el.disabled;
        const latched = LATCH[i] !== null && engine.state === LATCH[i];
        // A tap shorter than the key's travel still takes it down.
        const held = !off && (k.held || now - k.at < 110);
        let lit = latched || now < k.flash ? 1 : 0;
        if (latched && loading) lit = 0.6 + 0.4 * Math.sin(now / 290);
        if (lit > 0 && !k.on) {
          k.on = true;
          if (k.level < 0.05) {
            k.spread = 0;
            k.sv = 0;
            if (now - k.at > 600) k.ox = k.oy = 0;
          }
        } else if (lit === 0) k.on = false;
        const depth = held ? 1 : latched ? 0.5 : off ? 0.3 : k.hover ? -0.14 : 0;
        const grip = held ? 1 : 0;
        const offTo = off ? 1 : 0;
        if (still) {
          k.depth = depth;
          k.dv = 0;
          k.press = grip;
          k.spread = 1;
          k.sv = 0;
          k.off = offTo;
          k.level = v.primed ? k.level + (lit - k.level) * (1 - Math.exp(-dt * 30)) : lit;
        } else {
          const stiff = held ? 1100 : 420;
          const damp = held ? 62 : 22;
          for (let s = 0; s < steps; s++) {
            k.dv += ((depth - k.depth) * stiff - k.dv * damp) * h;
            k.depth += k.dv * h;
            k.sv += ((1 - k.spread) * 120 - k.sv * 20) * h;
            k.spread += k.sv * h;
          }
          k.press += (grip - k.press) * (1 - Math.exp(-dt * (held ? 40 : 12)));
          k.level += (lit - k.level) * (1 - Math.exp(-dt * (lit > k.level ? 26 : 9)));
          k.off += (offTo - k.off) * (1 - Math.exp(-dt * 10));
        }
        if (
          Math.abs(depth - k.depth) > 0.002 ||
          Math.abs(k.dv) > 0.02 ||
          Math.abs(lit - k.level) > 0.004 ||
          Math.abs(1 - k.spread) > 0.004 ||
          Math.abs(grip - k.press) > 0.01 ||
          Math.abs(offTo - k.off) > 0.01 ||
          now < k.flash ||
          now - k.at < 110 ||
          (latched && loading)
        )
          moving = true;
        const css = k.depth.toFixed(3);
        if (el && css !== k.css) {
          k.css = css;
          el.style.setProperty('--glasshead-kd', css);
        }
        v.keyState.set([k.depth, k.level, k.spread, k.off], i * 4);
        v.keyTouch.set([k.ox, k.oy, k.press, 0], i * 4);
      }
      v.primed = true;

      const to = engine.reduced ? 0 : v.pt;
      if (v.ps < 0.02) {
        v.px = v.ptx;
        v.py = v.pty;
      } else {
        const kq = 1 - Math.exp(-dt * 28);
        v.px += (v.ptx - v.px) * kq;
        v.py += (v.pty - v.py) * kq;
      }
      v.ps += (to - v.ps) * (1 - Math.exp(-dt * 10));
      if (Math.abs(to - v.ps) > 0.005 || Math.abs(v.ptx - v.px) + Math.abs(v.pty - v.py) > 0.3) moving = true;
      else v.ps = to;

      v.keys.draw({
        rects: v.keyRects,
        state: v.keyState,
        touch: v.keyTouch,
        unit: v.unit,
        lightX: v.lx,
        lightY: v.ly,
        light: v.light,
        tint: v.tints[engine.index] ?? [0.6, 0.6, 0.6],
        pointer: [v.px, v.py, v.ps],
      });
      return moving;
    },
    [engine],
  );

  const kick = useCallback(() => {
    const v = view.current;
    if (v.raf) return;
    engine.wake();
    v.prev = -1;
    const frame = (now: number) => {
      v.raf = 0;
      const active = engine.tick(now);
      // A thrown ribbon keeps sounding until it settles. While it is held, the pointer reports its place.
      const scrubbing = engine.scrubbing;
      if (v.scrubbing && !scrubbing) scrub.stop(now);
      if (scrubbing !== v.scrubbing) v.scrubAt = -1;
      v.scrubbing = scrubbing;
      if (scrubbing && sound.current) {
        if (!engine.held) scrub.move(engine.shown, now);
        const at = engine.locate(engine.shown).index;
        if (at !== v.scrubAt) {
          v.scrubAt = at;
          scrub.prime(at);
        }
      }
      const dt = v.prev < 0 ? 0.016 : Math.min(0.1, (now - v.prev) / 1000);
      v.prev = now;
      const k = 1 - Math.exp(-dt * 9);
      v.lx += (v.tx - v.lx) * k;
      v.ly += (v.ty - v.ly) * k;
      const moving = Math.abs(v.tx - v.lx) + Math.abs(v.ty - v.ly) > 0.003;
      if (!moving) {
        v.lx = v.tx;
        v.ly = v.ty;
      }
      const root = rootRef.current;
      if (root) {
        root.style.setProperty('--glasshead-lx', v.lx.toFixed(3));
        root.style.setProperty('--glasshead-ly', v.ly.toFixed(3));
      }
      v.renderer?.draw({
        pos: engine.shown,
        vel: engine.velocity,
        span: engine.span,
        lightX: v.lx,
        lightY: v.ly,
        light: v.light,
        dim: engine.failed.has(engine.index) ? 1 : 0,
      });
      if (engine.jumps !== v.jumps) {
        v.jumps = engine.jumps;
        canvasRef.current?.animate([{ opacity: 0.15 }, { opacity: 1 }], { duration: 240, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
      }
      const s = Math.floor(engine.displayTime());
      if (s !== v.sec) {
        v.sec = s;
        setSec(s);
      }
      const keysMoving = stepKeys(now, dt);
      if (active || moving || keysMoving) v.raf = requestAnimationFrame(frame);
    };
    v.raf = requestAnimationFrame(frame);
  }, [engine, scrub, stepKeys]);

  // The glass keys. Without WebGL2, or with the plain renderer, the keys stay as CSS draws them.
  useLayoutEffect(() => {
    const canvas = keyCanvasRef.current;
    const row = keysRef.current;
    if (!canvas || !row || renderer === '2d') return;
    const v = view.current;
    const r = createKeys(canvas);
    if (!r) return;
    v.keys = r;
    v.primed = false;
    setGlass(true);
    const size = () => {
      const box = canvas.getBoundingClientRect();
      r.resize(box.width, box.height, Math.min(3, window.devicePixelRatio || 1));
      keyEls.current.forEach((el, i) => {
        if (!el) return;
        const b = el.getBoundingClientRect();
        v.keyRects.set([b.left - box.left + b.width / 2, b.top - box.top + b.height / 2, b.width / 2, b.height / 2], i * 4);
        if (i === 0) v.unit = b.height / 8;
      });
      kick();
    };
    measureKeys.current = size;
    const observer = new ResizeObserver(size);
    observer.observe(row);
    size();
    return () => {
      observer.disconnect();
      measureKeys.current = null;
      v.keys = null;
      r.destroy();
      setGlass(false);
    };
  }, [renderer, kick]);

  // Measured again once the buttons have dropped their own CSS press offsets.
  useLayoutEffect(() => {
    measureKeys.current?.();
  }, [glass]);

  // The canvas, its size and the theme it is drawn for.
  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas) return;
    const v = view.current;
    const r = createRibbon(canvas, renderer);
    v.renderer = r;
    if (v.data) r.setTracks(v.data);
    const size = () => {
      const box = canvas.getBoundingClientRect();
      r.resize(box.width, box.height, Math.min(4, window.devicePixelRatio || 1));
      kick();
    };
    const observer = new ResizeObserver(size);
    observer.observe(canvas);
    size();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(v.raf);
      v.raf = 0;
      v.renderer = null;
      r.destroy();
    };
  }, [renderer, kick]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const scheme = window.matchMedia('(prefers-color-scheme: light)');
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const read = () => {
      view.current.light = getComputedStyle(root).getPropertyValue('--glasshead-light').trim() === '1';
      engine.reduced = motion.matches;
      if (motion.matches) view.current.tx = view.current.ty = 0;
      kick();
    };
    read();
    scheme.addEventListener('change', read);
    motion.addEventListener('change', read);
    return () => {
      scheme.removeEventListener('change', read);
      motion.removeEventListener('change', read);
    };
  }, [theme, engine, kick]);

  useEffect(() => {
    engine.span = span;
    kick();
  }, [span, engine, kick]);

  useEffect(() => {
    engine.attachAudio(audioRef.current);
    return () => engine.attachAudio(null);
  }, [engine]);

  useEffect(() => () => scrub.close(), [scrub]);

  // Tracks into the engine and the ribbon. Files with no peaks are measured once.
  useEffect(() => {
    const v = view.current;
    scrub.setTracks(
      queue.map((t) => t.src),
      queue.map((t) => t.duration),
    );
    engine.setTracks(
      queue.map((t) => t.duration),
      queue.map((t) => t.src),
    );
    const tints = queue.map((t, i) => toRgb(t.tint ?? TINTS[i % TINTS.length]));
    v.tints = tints;
    const push = () => {
      v.data = {
        offsets: engine.offsets,
        total: engine.total,
        tints,
        peaks: queue.map((t) => t.peaks ?? (t.src ? v.measured.get(t.src) : undefined)),
      };
      v.renderer?.setTracks(v.data);
      kick();
    };
    push();
    const abort = new AbortController();
    for (const t of queue) {
      if (t.peaks || !t.src || v.measured.has(t.src)) continue;
      const src = t.src;
      measurePeaks(src, 2048, abort.signal)
        .then((p) => {
          v.measured.set(src, p);
          if (!abort.signal.aborted) push();
        })
        .catch(() => {});
    }
    return () => abort.abort();
  }, [queue, engine, scrub, kick]);

  useEffect(
    () =>
      engine.subscribe(() => {
        if (engine.state !== seen.current.state) {
          seen.current.state = engine.state;
          handlers.current.onStateChange?.(engine.state);
        }
        if (engine.index !== seen.current.index) {
          seen.current.index = engine.index;
          handlers.current.onTrackChange?.(engine.index);
        }
        if (scrub.primed && sound.current) scrub.prime(engine.index);
        bump();
        kick();
      }),
    [engine, scrub, kick],
  );

  useImperativeHandle(
    ref,
    () => ({
      play: () => engine.play(),
      pause: () => engine.pause(),
      stop: () => engine.stop(),
      back: () => engine.back(),
      forward: () => engine.forward(),
      select: (i) => engine.select(i),
      seek: (s) => engine.seek(s),
    }),
    [engine],
  );

  const track = tracks[engine.index];
  const duration = track?.duration ?? 0;
  const failed = engine.failed.has(engine.index);
  const lit: GlassHeadState = engine.state;

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !tracks.length) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, x: e.clientX, moved: 0, samples: [{ t: e.timeStamp, x: e.clientX }] };
    engine.dragStart();
    if (sound.current) scrub.start(engine.shown, e.timeStamp);
    kick();
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d.id !== e.pointerId) return;
    const width = e.currentTarget.clientWidth;
    // Every report of the pointer with its own time, not only the last one of the frame,
    // so the sound moves at the true speed of the hand.
    const reports = e.nativeEvent.getCoalescedEvents?.() ?? [];
    for (const r of reports.length ? reports : [e.nativeEvent]) {
      const dx = r.clientX - d.x;
      d.x = r.clientX;
      d.moved += Math.abs(dx);
      engine.dragMove((-dx * engine.span) / width);
      scrub.move(engine.shown, r.timeStamp);
    }
    d.samples.push({ t: e.timeStamp, x: e.clientX });
    while (d.samples.length > 2 && e.timeStamp - d.samples[0].t > 90) d.samples.shift();
    kick();
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d.id !== e.pointerId) return;
    d.id = -1;
    const first = d.samples[0];
    const last = d.samples[d.samples.length - 1];
    const dt = (last.t - first.t) / 1000;
    const stale = e.timeStamp - last.t > 80;
    const pxPerSec = dt > 0.01 && !stale && d.moved > 4 ? (last.x - first.x) / dt : 0;
    engine.dragEnd((-pxPerSec * engine.span) / e.currentTarget.clientWidth);
    // Let go without a throw: the sound plays the hand out to this moment and no further.
    if (!engine.scrubbing) scrub.stop(e.timeStamp);
    kick();
  };

  const onSliderKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 5, ArrowUp: 5, ArrowLeft: -5, ArrowDown: -5, PageUp: 15, PageDown: -15 }[e.key];
    if (step !== undefined) engine.seek(engine.time + step);
    else if (e.key === 'Home') engine.seek(0);
    else if (e.key === 'End') engine.seek(duration);
    else return;
    e.preventDefault();
  };

  const onRootKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== ' ' || (e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    if (engine.state === 'playing') engine.pause();
    else engine.play();
  };

  const onLight = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch' || engine.reduced) return;
    const box = e.currentTarget.getBoundingClientRect();
    const v = view.current;
    v.tx = Math.max(-1, Math.min(1, ((e.clientX - box.left) / box.width) * 2 - 1));
    v.ty = Math.max(-1, Math.min(1, ((e.clientY - box.top) / box.height) * 2 - 1));
    const bed = keyCanvasRef.current;
    if (bed && v.keys) {
      const b = bed.getBoundingClientRect();
      v.ptx = e.clientX - b.left;
      v.pty = e.clientY - b.top;
      v.pt = 1;
    }
    kick();
  };
  const offLight = () => {
    view.current.tx = view.current.ty = 0;
    view.current.pt = 0;
    scrub.cool();
    kick();
  };

  // Decoding starts when a pointer arrives, and so does the sound, which takes a moment to wake.
  // It is unlocked by the first press.
  const nearScrub = () => {
    if (!sound.current || !tracks.length) return;
    scrub.prime(engine.index);
    scrub.warm();
  };
  const wakeScrub = (e: PointerEvent<HTMLDivElement>) => {
    if (!sound.current || !tracks.length) return;
    scrub.unlock(e.pointerType);
    scrub.prime(engine.index);
  };

  const key = (name: 'back' | 'stop' | 'play' | 'pause' | 'forward', text: string, act: () => void, disabled = false) => {
    const i = KEYS.indexOf(name);
    const latch = LATCH[i];
    const k = view.current.sim[i];
    const hold = (x: number, y: number) => {
      k.held = true;
      k.at = performance.now();
      k.ox = x;
      k.oy = y;
      kick();
    };
    const release = () => {
      k.held = false;
      kick();
    };
    return (
      <button
        ref={(el) => {
          keyEls.current[i] = el;
        }}
        type="button"
        className={`glasshead-key glasshead-key-${name}`}
        aria-label={text}
        aria-pressed={latch ? lit === latch : undefined}
        disabled={disabled || !tracks.length}
        onClick={() => {
          if (!latch) k.flash = performance.now() + 300;
          act();
          kick();
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const b = e.currentTarget.getBoundingClientRect();
          hold(e.clientX - b.left - b.width / 2, e.clientY - b.top - b.height / 2);
        }}
        onPointerUp={release}
        onPointerCancel={release}
        onPointerEnter={(e) => {
          if (e.pointerType === 'touch') return;
          k.hover = true;
          kick();
        }}
        onPointerLeave={() => {
          k.hover = false;
          release();
        }}
        onKeyDown={(e) => {
          if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) hold(0, 0);
        }}
        onKeyUp={release}
        onBlur={release}
      >
        <GlassHeadIcon name={name} />
      </button>
    );
  };

  return (
    <div
      ref={rootRef}
      className={className ? `glasshead ${className}` : 'glasshead'}
      data-theme={theme}
      data-state={engine.state}
      data-keys={glass ? 'glass' : undefined}
      data-loading={engine.loading && engine.state === 'playing' ? '' : undefined}
      role="group"
      aria-label={label}
      style={{ '--glasshead-tint': track?.tint ?? TINTS[engine.index % TINTS.length] } as CSSProperties}
      onKeyDown={onRootKey}
      onPointerEnter={nearScrub}
      onPointerDownCapture={wakeScrub}
      onPointerUpCapture={wakeScrub}
      onPointerMove={onLight}
      onPointerLeave={offLight}
    >
      <div className="glasshead-window">
        <canvas key={renderer} ref={canvasRef} aria-hidden="true" />
        <div
          className="glasshead-ribbon"
          role="slider"
          tabIndex={0}
          aria-label="Position in track"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.min(sec, Math.round(duration))}
          aria-valuetext={`${clock(sec)} of ${clock(duration)}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={onSliderKey}
        />
      </div>
      <div className="glasshead-meta">
        <div className="glasshead-names">
          <div className="glasshead-title">{track?.title ?? 'Nothing to play'}</div>
          {failed ? (
            <div className="glasshead-artist" data-error="" role="status">
              Can't play this file
            </div>
          ) : (
            <div className="glasshead-artist">{track?.artist}</div>
          )}
        </div>
        <div className="glasshead-times">
          <div className="glasshead-time">{clock(sec)}</div>
          <div className="glasshead-left">-{clock(duration - sec)}</div>
        </div>
      </div>
      <div className="glasshead-keys" ref={keysRef}>
        <canvas className="glasshead-keybed" ref={keyCanvasRef} aria-hidden="true" />
        {key('back', 'Back', () => engine.back())}
        {key('stop', 'Stop', () => engine.stop())}
        {key('play', 'Play', () => engine.play())}
        {key('pause', 'Pause', () => engine.pause(), engine.state === 'stopped')}
        {key('forward', 'Forward', () => engine.forward(), engine.index >= tracks.length - 1)}
      </div>
      <audio ref={audioRef} preload="auto" hidden />
    </div>
  );
});
