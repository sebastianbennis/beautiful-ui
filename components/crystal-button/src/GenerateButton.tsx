'use client';

import { forwardRef, useCallback, useEffect, useRef, useState } from 'react';
import type { FocusEvent, KeyboardEvent, MouseEvent, PointerEvent } from 'react';
import { LightEngine } from './engine';
import type { GenerateButtonProps, GenerateLabels, GenerateStatus } from './types';

const WORDS: GenerateLabels = { idle: 'Generate', working: 'Generating', stop: 'Stop', done: 'Done', failed: 'Try again' };
const SHOWN = ['idle', 'working', 'done', 'failed'] as const;
/** What is drawn when there is no WebGL2: the furrows between eight cells, and the cells in the order the light visits them. */
const FURROWS = 'M0 52 24 46 50 54 76 47 100 52M22 0 24 46 27 100M49 0 50 54 52 100M77 0 76 47 74 100';
const CELLS = [
  '0,0 22,0 24,46 0,52',
  '22,0 49,0 50,54 24,46',
  '49,0 77,0 76,47 50,54',
  '77,0 100,0 100,52 76,47',
  '76,47 100,52 100,100 74,100',
  '50,54 76,47 74,100 52,100',
  '24,46 50,54 52,100 27,100',
  '0,52 24,46 27,100 0,100',
];

export const GenerateButton = forwardRef<HTMLButtonElement, GenerateButtonProps>(function GenerateButton(props, ref) {
  const {
    onGenerate,
    onStop,
    status: given,
    progress,
    labels,
    theme,
    seed,
    settleMs = 1800,
    disabled,
    className,
    type = 'button',
    onPointerDown,
    onPointerUp,
    onPointerLeave,
    onPointerCancel,
    onKeyDown,
    onKeyUp,
    onFocus,
    onBlur,
    ...rest
  } = props;

  const [own, setOwn] = useState<GenerateStatus>('idle');
  const status = given ?? own;
  const [gl, setGl] = useState(true);
  const [pressed, setPressed] = useState(false);

  const button = useRef<HTMLButtonElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const engine = useRef<LightEngine | null>(null);
  const pressedAt = useRef<{ x: number; y: number } | null>(null);
  const run = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const before = useRef<GenerateStatus>('idle');

  const words = { ...WORDS, ...labels };
  const stoppable = !!onStop;
  const locked = status === 'working' && !stoppable;
  const shown: Record<(typeof SHOWN)[number], string> = {
    idle: words.idle,
    working: stoppable ? words.stop : words.working,
    done: words.done,
    failed: words.failed,
  };
  const spoken = status === 'working' ? words.working : status === 'idle' ? '' : shown[status];

  const setRef = useCallback(
    (node: HTMLButtonElement | null) => {
      button.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  // The engine lives as long as the button does.
  useEffect(() => {
    const host = button.current;
    const cv = canvas.current;
    if (!host || !cv) return;
    let eng: LightEngine;
    try {
      eng = new LightEngine(cv, host);
    } catch {
      setGl(false);
      return;
    }
    engine.current = eng;

    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const scheme = window.matchMedia('(prefers-color-scheme: dark)');
    const onMotion = () => eng.setReduced(motion.matches);
    const remeasure = () => eng.measure();
    const move = (e: globalThis.PointerEvent) => eng.pointer(e.clientX, e.clientY);
    const gone = () => eng.pointer(null);
    const lifted = (e: globalThis.PointerEvent) => {
      // A finger that lifts takes its lamp with it. A mouse is still there.
      if (e.pointerType !== 'mouse') eng.pointer(null);
    };
    onMotion();

    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('pointerdown', move, { passive: true });
    window.addEventListener('pointerup', lifted, { passive: true });
    window.addEventListener('pointercancel', gone, { passive: true });
    window.addEventListener('blur', gone);
    window.addEventListener('resize', remeasure);
    document.documentElement.addEventListener('pointerleave', gone);
    motion.addEventListener('change', onMotion);
    scheme.addEventListener('change', remeasure);
    const resize = new ResizeObserver(remeasure);
    resize.observe(host);
    // A theme is usually switched on the page, far above the button.
    const restyle = new MutationObserver(remeasure);
    const watch = { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] };
    restyle.observe(document.documentElement, watch);
    restyle.observe(document.body, watch);
    restyle.observe(host, watch);
    void document.fonts?.ready.then(remeasure);

    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerdown', move);
      window.removeEventListener('pointerup', lifted);
      window.removeEventListener('pointercancel', gone);
      window.removeEventListener('blur', gone);
      window.removeEventListener('resize', remeasure);
      document.documentElement.removeEventListener('pointerleave', gone);
      motion.removeEventListener('change', onMotion);
      scheme.removeEventListener('change', remeasure);
      resize.disconnect();
      restyle.disconnect();
      eng.destroy();
      engine.current = null;
    };
  }, []);

  // The job's state is the only thing that moves the light.
  useEffect(() => {
    const eng = engine.current;
    const was = before.current;
    before.current = status;
    if (!eng || was === status) return;
    if (status === 'working') eng.commit(pressedAt.current?.x ?? null, pressedAt.current?.y ?? null, seed);
    else if (was === 'working') eng.finish(status === 'done' ? 'done' : status === 'failed' ? 'failed' : 'stopped');
    else eng.rest();
  }, [status, seed]);

  useEffect(() => {
    engine.current?.setProgress(progress ?? null);
  }, [progress]);

  useEffect(() => {
    engine.current?.setDisabled(!!disabled);
  }, [disabled]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const press = (down: boolean) => {
    if (down && (disabled || locked)) return;
    setPressed(down);
    engine.current?.press(down);
  };

  const click = (event: MouseEvent<HTMLButtonElement>) => {
    if (disabled || locked) return;
    if (status === 'working') {
      onStop?.();
      if (given === undefined) {
        run.current++;
        setOwn('idle');
      }
      return;
    }
    // A click with no detail came from the keyboard, so there is no press point.
    pressedAt.current = event.detail === 0 ? null : { x: event.clientX, y: event.clientY };
    const job = onGenerate?.(event);
    if (given !== undefined) return;
    window.clearTimeout(timer.current);
    if (job && typeof job.then === 'function') {
      const id = ++run.current;
      setOwn('working');
      job
        .then(
          () => 'done' as const,
          () => 'failed' as const,
        )
        .then((end) => {
          if (run.current !== id) return;
          setOwn(end);
          timer.current = window.setTimeout(() => {
            if (run.current === id) setOwn('idle');
          }, settleMs);
        });
    }
  };

  return (
    <>
      <button
        {...rest}
        ref={setRef}
        type={type}
        className={className ? `caughtlight ${className}` : 'caughtlight'}
        data-status={status}
        data-theme={theme}
        data-gl={gl ? undefined : 'off'}
        data-pressed={pressed ? '' : undefined}
        aria-busy={status === 'working' || undefined}
        aria-disabled={locked || undefined}
        disabled={disabled}
        onClick={click}
        onPointerDown={(e: PointerEvent<HTMLButtonElement>) => {
          onPointerDown?.(e);
          if (e.button === 0) press(true);
        }}
        onPointerUp={(e: PointerEvent<HTMLButtonElement>) => {
          onPointerUp?.(e);
          press(false);
        }}
        onPointerLeave={(e: PointerEvent<HTMLButtonElement>) => {
          onPointerLeave?.(e);
          press(false);
        }}
        onPointerCancel={(e: PointerEvent<HTMLButtonElement>) => {
          onPointerCancel?.(e);
          press(false);
        }}
        onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => {
          onKeyDown?.(e);
          if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) press(true);
        }}
        onKeyUp={(e: KeyboardEvent<HTMLButtonElement>) => {
          onKeyUp?.(e);
          press(false);
        }}
        onFocus={(e: FocusEvent<HTMLButtonElement>) => {
          onFocus?.(e);
          engine.current?.setFocus(e.currentTarget.matches(':focus-visible'));
        }}
        onBlur={(e: FocusEvent<HTMLButtonElement>) => {
          onBlur?.(e);
          press(false);
          engine.current?.setFocus(false);
        }}
      >
        <canvas ref={canvas} className="caughtlight-canvas" aria-hidden="true" />
        <span className="caughtlight-drawn" aria-hidden="true">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none">
            {CELLS.map((points, i) => (
              <polygon key={points} points={points} style={{ animationDelay: `${i * 0.2}s` }} />
            ))}
            <path d={FURROWS} />
          </svg>
        </span>
        <span className="caughtlight-words">
          {SHOWN.map((key) => (
            <span key={key} className="caughtlight-word" data-word={key} aria-hidden={status === key ? undefined : true}>
              {shown[key]}
            </span>
          ))}
        </span>
      </button>
      <span className="caughtlight-status" role="status">
        {spoken}
      </span>
    </>
  );
});
