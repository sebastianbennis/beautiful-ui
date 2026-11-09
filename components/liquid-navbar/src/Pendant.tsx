'use client';

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Bar } from './Bar';
import { PendantEngine } from './engine';
import { Mound } from './Mound';
import { cx } from './shared';
import type { PendantProps, PendantWeather } from './types';
import './pendant.css';

/**
 * A storm banner with its navigation built in. The bar is liquid that hangs from the top edge,
 * drips fall from it, and every drip lands on the water at the foot of the banner and raises it.
 */
export function Pendant({
  items,
  activeId,
  defaultActiveId = null,
  onNavigate,
  brand,
  brandHref = '/',
  brandLabel = 'Home',
  action,
  fog = true,
  weather,
  defaultWeather = 'storm',
  onWeatherChange,
  weatherToggle = true,
  children,
  breakpoint = 900,
  label = 'Main',
  linkAs: Link = 'a',
  className,
  style,
}: PendantProps) {
  const rootRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const weatherRef = useRef<HTMLCanvasElement>(null);
  const boltRef = useRef<HTMLCanvasElement>(null);
  const orbRef = useRef<HTMLButtonElement>(null);
  const settledEngine = useRef<PendantEngine | null>(null);
  const [engine, setEngine] = useState<PendantEngine | null>(null);
  const [flat, setFlat] = useState(false);
  const [mode, setMode] = useState<'bar' | 'mound'>('bar');
  const [ownActive, setOwnActive] = useState<string | null>(defaultActiveId);
  const controlled = activeId !== undefined;
  const current = controlled ? activeId : ownActive;
  const [ownWeather, setOwnWeather] = useState<PendantWeather>(defaultWeather);
  const sky = weather ?? ownWeather;
  const opposite: PendantWeather = sky === 'storm' ? 'clear' : 'storm';

  const onSelect = useCallback(
    (itemId: string, linkId?: string) => {
      if (!controlled) setOwnActive(itemId);
      onNavigate?.(itemId, linkId);
    },
    [controlled, onNavigate],
  );

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const root = rootRef.current;
    if (!canvas || !root) return;
    const created = new PendantEngine(canvas, weatherRef.current, boltRef.current);
    if (!created.ok) {
      setFlat(true);
      return;
    }
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const applyMotion = (): void => {
      created.still = motion.matches;
      created.invalidate();
    };
    applyMotion();
    motion.addEventListener('change', applyMotion);

    const styles = getComputedStyle(root);
    const token = (name: string): string => styles.getPropertyValue(name);
    created.setTheme(token('--pd-surface'), token('--pd-light'), token('--pd-action'), token('--pd-sky'), token('--pd-glow'));
    created.setDayTheme(token('--pd-day-sky'), token('--pd-day-haze'), token('--pd-day-cloud'), token('--pd-day-shade'), token('--pd-day-water'), token('--pd-day-action'));
    setEngine(created);

    return () => {
      motion.removeEventListener('change', applyMotion);
      created.destroy();
      setEngine(null);
    };
  }, []);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = (): void => setMode(root.offsetWidth < breakpoint ? 'mound' : 'bar');
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [breakpoint]);

  // The first weather of a new engine is simply there. Every change after that is a drop falling.
  useLayoutEffect(() => {
    if (!engine) return;
    engine.orbEnabled = weatherToggle;
    engine.setWeather(sky, settledEngine.current !== engine);
    settledEngine.current = engine;
  }, [engine, sky, weatherToggle]);

  useLayoutEffect(() => {
    if (!engine) return;
    engine.onOrb = (x, y, radius, shown) => {
      const el = orbRef.current;
      if (!el) return;
      el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -50%)`;
      el.style.setProperty('--pd-orb', `${(radius * 2).toFixed(1)}px`);
      // Never hidden outright: someone on a keyboard keeps their place while the weather turns.
      el.style.pointerEvents = shown ? 'auto' : 'none';
    };
    return () => {
      engine.onOrb = null;
    };
  }, [engine]);

  const changeWeather = (): void => {
    if (engine && !engine.orbReady) return;
    if (weather === undefined) setOwnWeather(opposite);
    onWeatherChange?.(opposite);
  };

  const Layout = mode === 'bar' ? Bar : Mound;

  return (
    <section ref={rootRef} className={cx('pd', flat && 'pd--flat', className)} data-mode={mode} data-weather={sky} style={style}>
      <canvas ref={weatherRef} className="pd-weather" aria-hidden="true" />
      <canvas ref={boltRef} className="pd-bolt" aria-hidden="true" />
      {children ? <div className="pd-content">{children}</div> : null}
      <canvas ref={canvasRef} className="pd-canvas" aria-hidden="true" />
      <Layout
        key={mode}
        engine={engine}
        rootRef={rootRef as React.RefObject<HTMLDivElement | null>}
        items={items}
        activeId={current}
        onSelect={onSelect}
        brand={brand}
        brandHref={brandHref}
        brandLabel={brandLabel}
        action={action}
        navLabel={label}
        fog={fog}
        Link={Link}
      />
      {weatherToggle ? (
        <button
          ref={orbRef}
          type="button"
          className="pd-orb"
          aria-label={opposite === 'clear' ? 'Change to sunny weather' : 'Change to stormy weather'}
          onClick={changeWeather}
          onPointerEnter={() => engine?.orbHover(true)}
          onPointerLeave={() => {
            engine?.orbHover(false);
            engine?.orbPress(false);
          }}
          onPointerDown={() => engine?.orbPress(true)}
          onPointerUp={() => engine?.orbPress(false)}
          onFocus={(event) => {
            if (event.currentTarget.matches(':focus-visible')) engine?.orbHover(true);
          }}
          onBlur={() => engine?.orbHover(false)}
        >
          <svg className="pd-orb-icon" viewBox="0 0 24 24" aria-hidden="true">
            {opposite === 'clear' ? (
              <>
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5.3 5.3l1.7 1.7M17 17l1.7 1.7M5.3 18.7 7 17M17 7l1.7-1.7" />
              </>
            ) : (
              <>
                <path d="M7 15.5a4 4 0 0 1-.3-8 5.5 5.5 0 0 1 10.6 1.3 3.4 3.4 0 0 1-.3 6.7" />
                <path d="m12.5 12.5-2 4h3l-2 4" />
              </>
            )}
          </svg>
        </button>
      ) : null}
    </section>
  );
}
