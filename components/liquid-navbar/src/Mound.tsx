'use client';

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ElementType,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import { Spring } from './engine';
import { tick } from './haptics';
import { clamp, focusablesIn, inertWhen, paintDay, pointIn, rectIn, type LayoutProps } from './shared';
import type { PendantItem } from './types';

interface Column {
  cx: number;
  ride: number;
  grow: number;
  lit: number;
  shown: number;
}

interface Drag {
  id: number;
  x0: number;
  y0: number;
  mode: 'scrub' | 'sheet';
  index: number;
  pull: number;
  from: number;
}

const BODY_DEPTH = 84;

// On a phone the same banner works with the thumb: a tab bar sitting in the water at the foot of
// the screen, with the brand and the action still hanging from the top and dripping into it.
export function Mound({ engine: core, rootRef, items, activeId, onSelect, brand, brandHref, brandLabel, action, navLabel, fog, Link }: LayoutProps) {
  const water = core?.bottom ?? null;
  const air = core?.top ?? null;
  const surfaceRef = useRef<HTMLDivElement>(null);
  const moundRef = useRef<HTMLElement>(null);
  const clipRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const brandRef = useRef<HTMLElement>(null);
  const actionRef = useRef<HTMLElement>(null);
  const tabEls = useRef<Array<HTMLElement | null>>([]);
  const faceEls = useRef<Array<HTMLElement | null>>([]);
  const nameEls = useRef<Array<HTMLElement | null>>([]);
  const sheetEls = useRef(new Map<string, HTMLElement>());
  const columns = useRef<Column[]>([]);
  const geo = useRef({ w: 0, h: 0, scale: 1, depth: BODY_DEPTH, width: 0 });
  const openRef = useRef<string | null>(null);
  const activeRef = useRef(activeId);
  activeRef.current = activeId;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const drag = useRef<Drag | null>(null);
  const hovering = useRef(false);
  const clickedAt = useRef(-1000);
  const returnFocus = useRef<HTMLElement | null>(null);
  const arrived = useRef(false);

  const [sheetId, setSheetId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const baseId = useId();
  const scrim = useMemo(() => new Spring(0, 130, 24, 0.002), []);

  const paint = useCallback(() => {
    if (scrimRef.current) scrimRef.current.style.opacity = clamp(scrim.x, 0, 1).toFixed(3);
    if (!water) return;

    const { w: W, h: H, scale: s } = geo.current;
    const sheet = water.masses[2];
    const clip = clipRef.current;
    if (clip) {
      if (sheet.on.x > 0.001) {
        const l = sheet.cx.x - sheet.hw.x;
        const r = W - (sheet.cx.x + sheet.hw.x);
        const t = H - sheet.depth.x;
        const round = Math.max(sheet.r.x, 0).toFixed(2);
        clip.style.clipPath = `inset(${t.toFixed(2)}px ${r.toFixed(2)}px 0 ${l.toFixed(2)}px round ${round}px ${round}px 0 0)`;
      } else {
        clip.style.clipPath = 'inset(100%)';
      }
    }

    const hover = water.drops[0];
    const current = water.drops[1];
    const activeIndex = itemsRef.current.findIndex((item) => item.id === activeRef.current);
    const hoverReach = clamp(hover.reach.x, 0, 1.15);
    const currentReach = clamp(current.reach.x, 0, 1.1);
    const open = openRef.current !== null;

    // Each word changes colour at the moment the weather reaches it.
    if (core && air) {
      const row = 33 * s;
      paintDay(brandRef.current, core.dayAt(air.masses[0].cx.x, row));
      paintDay(actionRef.current, core.dayAt(air.action.cx.x, row));
      sheetEls.current.forEach((el) => paintDay(el, core.dayAt(W / 2, H - sheet.depth.x * 0.5)));
    }

    columns.current.forEach((column, i) => {
      const face = faceEls.current[i];
      const name = nameEls.current[i];
      if (!face) return;
      if (core) paintDay(face, core.dayAt(column.cx, H - 42 * s));
      const spread = 40 * s;
      const near = Math.exp(-Math.pow((hover.x.x - column.cx) / spread, 2)) * hoverReach;
      const here = i === activeIndex ? Math.exp(-Math.pow((current.x.x - column.cx) / spread, 2)) * currentReach : 0;
      const ride = Math.max(near * 34, here * 9) * s * (open ? 0.4 : 1);
      const grow = 1 + Math.max(near * 0.26, here * 0.06);
      const lit = Math.min(Math.max(near, here), 1);
      if (Math.abs(ride - column.ride) > 0.02 || Math.abs(grow - column.grow) > 0.0005) {
        column.ride = ride;
        column.grow = grow;
        face.style.transform = `translate3d(-50%, calc(-50% - ${ride.toFixed(2)}px), 0) scale(${grow.toFixed(4)})`;
      }
      if (Math.abs(lit - column.lit) > 0.004) {
        column.lit = lit;
        face.style.setProperty('--pd-lit', lit.toFixed(3));
      }
      if (name && Math.abs(lit - column.shown) > 0.004) {
        column.shown = lit;
        name.style.opacity = lit.toFixed(3);
      }
    });
  }, [air, core, water, scrim]);

  const placeSheet = useCallback(
    (fresh = false, snap = false) => {
      const g = geo.current;
      const s = g.scale;
      const id = openRef.current;

      sheetEls.current.forEach((sheet) => {
        sheet.style.width = `${Math.round(g.width)}px`;
        sheet.style.transform = `translate3d(0, ${Math.round(g.h - g.depth - sheet.offsetHeight)}px, 0)`;
      });

      if (water?.still || !water) scrim.snap(id ? 1 : 0);
      else scrim.to = id ? 1 : 0;
      if (!water) {
        paint();
        return;
      }

      const index = itemsRef.current.findIndex((item) => item.id === (id ?? activeRef.current));
      const originX = columns.current[index]?.cx ?? g.width / 2;
      const collapsed = { cx: originX, hw: 20 * s, depth: g.depth - 8 * s, r: 18 * s };

      if (id) {
        const sheet = sheetEls.current.get(id);
        if (!sheet) return;
        const h = sheet.offsetHeight;
        const m = water.masses[2];
        if (fresh) {
          const [x, y, a, b] = water.dropGeometry(0);
          const from = b > 2 ? { cx: x, hw: a, depth: y + b, r: b } : collapsed;
          water.setMass(2, { ...from, on: 1 }, true);
          m.depth.k = 110;
          m.depth.c = 15;
          m.hw.k = 88;
          m.hw.c = 15;
          m.cx.k = 105;
          m.cx.c = 17;
          m.r.k = 110;
          m.r.c = 18;
        } else if (!snap) {
          water.tuneMass(2, 190, 22);
        }
        // The sheet is the pool itself rising, so its sides run past the edges of the screen.
        water.setMass(2, { cx: g.width / 2, hw: g.width / 2 + 90 * s, depth: g.depth + h, r: 36 * s, on: 1 }, snap);
      } else {
        const m = water.masses[2];
        m.depth.k = 300;
        m.depth.c = 32;
        m.hw.k = 230;
        m.hw.c = 28;
        m.cx.k = 230;
        m.cx.c = 28;
        m.r.k = 300;
        m.r.c = 32;
        water.setMass(2, { ...collapsed, on: 0 }, snap);
        water.glowGain.to = 0;
      }
    },
    [water, paint, scrim],
  );

  const placeActive = useCallback(
    (snap = false) => {
      if (!water) return;
      const index = itemsRef.current.findIndex((item) => item.id === activeRef.current);
      const column = columns.current[index];
      if (column) {
        water.aim(1, column.cx, 1, 0, snap);
        water.fogClear = [{ x: column.cx, width: 42 * geo.current.scale }];
      } else {
        water.aim(1, water.drops[1].x.x, 0, 0);
      }
    },
    [water],
  );

  const placeTop = useCallback(
    (snap = false, hidden = false) => {
      const root = rootRef.current;
      if (!air || !root) return;
      const s = geo.current.scale;
      const brandEl = brandRef.current;
      if (brandEl) {
        const r = rectIn(root, brandEl);
        air.setMass(0, { cx: r.x + r.w / 2, hw: r.w / 2, depth: hidden ? 0 : r.h, r: 28 * s, on: 1 }, snap);
      } else {
        air.setMass(0, { cx: 0, hw: 1, depth: 0, r: 1, on: 0 }, true);
      }
      air.setMass(1, { cx: 0, hw: 1, depth: 0, r: 1, on: 0 }, true);
      air.setMass(2, { cx: 0, hw: 1, depth: 0, r: 1, on: 0 }, true);
      const actionEl = actionRef.current;
      const a = air.action;
      if (actionEl) {
        const r = rectIn(root, actionEl);
        const depth = hidden ? 0 : r.h;
        const far = -120 * s;
        const set = (spring: typeof a.cx, value: number): void => {
          if (snap || air.still) spring.snap(value);
          else spring.to = value;
        };
        air.actionAttached = true;
        set(a.cx, r.x + r.w / 2);
        set(a.cy, (depth + far) / 2);
        set(a.hw, r.w / 2);
        set(a.hh, (depth - far) / 2);
        set(a.r, 28 * s);
        set(a.on, 1);
      } else {
        a.on.snap(0);
      }
      air.invalidate();
    },
    [air, rootRef],
  );

  const layout = useCallback(
    (snap = false) => {
      const root = rootRef.current;
      const el = moundRef.current;
      if (!root || !el) return;
      const r = rectIn(root, el);
      const safe = parseFloat(getComputedStyle(el).paddingBottom) || 0;
      const scale = (r.h - safe) / BODY_DEPTH;
      const width = root.offsetWidth;
      geo.current = { w: width, h: root.offsetHeight, scale, depth: r.h, width };

      const pad = 14 * scale;
      const count = itemsRef.current.length;
      const columnW = (width - pad * 2) / Math.max(count, 1);
      columns.current = itemsRef.current.map((_, i) => {
        const left = pad + columnW * i;
        const tab = tabEls.current[i];
        if (tab) {
          tab.style.left = `${left.toFixed(2)}px`;
          tab.style.width = `${columnW.toFixed(2)}px`;
        }
        const face = faceEls.current[i];
        if (face) face.style.left = `${(left + columnW / 2).toFixed(2)}px`;
        const previous = columns.current[i];
        return {
          cx: left + columnW / 2,
          ride: previous?.ride ?? -1,
          grow: previous?.grow ?? -1,
          lit: previous?.lit ?? -1,
          shown: previous?.shown ?? -1,
        };
      });

      if (core && water && air) {
        core.resize(width, root.offsetHeight);
        core.scale = scale;
        core.shoulder = 36;
        core.merge = 34;
        core.waterFloor = r.h;
        core.poolBase = r.h + Math.round(root.offsetHeight * 0.17);
        core.poolMax = Math.round(root.offsetHeight * 0.1);
        if (core.still) core.level.snap(core.poolBase);

        water.dropShape = [
          { radius: 46, offset: 8 },
          { radius: 38, offset: -22 },
        ];
        water.setWaveSpan(0, width);
        water.fogLevel = fog ? 1 : 0;
        const first = !arrived.current && snap;
        water.tuneMass(0, 80, 12);
        water.setMass(0, { cx: width / 2, hw: width / 2 + 90 * scale, depth: first ? 0 : r.h, r: 36 * scale, on: 1 }, snap);
        water.setMass(1, { cx: 0, hw: 1, depth: 0, r: 1, on: 0 }, true);

        air.setWaveSpan(0, width);
        air.fogLevel = 0;
        // Coming from the desktop layout, nothing of its bar may be left hanging.
        for (const drop of air.drops) drop.reach.snap(0);
        air.dropShape = [
          { radius: 54, offset: 6 },
          { radius: 42, offset: -24 },
        ];
        placeTop(snap, first);

        const brandEl = brandRef.current;
        if (brandEl) {
          const b = rectIn(root, brandEl);
          air.setRestingDrips([
            { x: b.x + b.w * 0.3, length: 14 * scale, bulb: 4.6 * scale, neck: 1.4 * scale, every: 3.4 },
            { x: b.x + b.w * 0.72, length: 22 * scale, bulb: 5.6 * scale, neck: 1.6 * scale, every: 2.6 },
          ]);
        }

        placeActive(snap);
        placeSheet(false, snap);
      } else {
        paint();
      }
    },
    [air, core, fog, paint, placeActive, placeSheet, placeTop, rootRef, water],
  );

  useLayoutEffect(() => {
    if (!core) return;
    const release = core.adopt([scrim]);
    core.onFrame = paint;
    return () => {
      release();
      core.onFrame = null;
    };
  }, [core, paint, scrim]);

  // Only the engine's very first layout jumps. New items after that flow into place.
  const laidOut = useRef<unknown>(null);
  useLayoutEffect(() => {
    layout(laidOut.current !== core);
    laidOut.current = core;
    paint();
    const root = rootRef.current;
    if (!root) return;
    const observer = new ResizeObserver(() => layout(false));
    observer.observe(root);
    sheetEls.current.forEach((sheet) => observer.observe(sheet));
    let alive = true;
    void document.fonts?.ready.then(() => {
      if (alive) layout(false);
    });
    return () => {
      alive = false;
      observer.disconnect();
    };
  }, [core, layout, paint, rootRef, items]);

  // The arrival: the water wells up and the forms at the top pour down to meet it.
  useEffect(() => {
    if (!core || !water || !air) {
      return;
    }
    if (arrived.current) {
      setReady(true);
      return;
    }
    arrived.current = true;
    if (core.still) {
      layout(true);
      setReady(true);
      return;
    }
    air.tuneMass(0, 80, 9.5);
    const a = air.action;
    a.cy.k = a.hh.k = 90;
    a.cy.c = a.hh.c = 10.5;
    placeTop(false, false);
    const reveal = window.setTimeout(() => setReady(true), 180);
    const calm = window.setTimeout(() => {
      air.tuneMass(0, 170, 22);
      a.cy.k = a.hh.k = 200;
      a.cy.c = a.hh.c = 22;
    }, 1500);
    return () => {
      window.clearTimeout(reveal);
      window.clearTimeout(calm);
    };
  }, [air, core, layout, placeTop, water]);

  useEffect(() => {
    placeActive();
    if (water && !water.still) {
      water.drops[1].x.k = 130;
      water.drops[1].x.c = 14;
    }
  }, [activeId, water, placeActive]);

  const applySheet = useCallback(
    (id: string | null) => {
      const previous = openRef.current;
      if (previous === id) return;
      if (id && !previous) returnFocus.current = document.activeElement as HTMLElement | null;
      openRef.current = id;
      setSheetId(id);
      placeSheet(Boolean(id && !previous));
    },
    [placeSheet],
  );

  // Moves focus into a sheet opened from the keyboard, and back out when it closes.
  useEffect(() => {
    if (sheetId) {
      if (drag.current) return;
      const sheet = sheetEls.current.get(sheetId);
      if (sheet && !sheet.contains(document.activeElement)) focusablesIn(sheet)[0]?.focus({ preventScroll: true });
    } else if (returnFocus.current) {
      returnFocus.current.focus({ preventScroll: true });
      returnFocus.current = null;
    }
  }, [sheetId]);

  const choose = useCallback(
    (item: PendantItem) => {
      if (item.disabled) return;
      const reopening = openRef.current === item.id;
      onSelect(item.id);
      if (item.links?.length) applySheet(reopening ? null : item.id);
      else applySheet(null);
    },
    [applySheet, onSelect],
  );

  const nearest = (x: number): number => {
    let best = 0;
    let bestD = Infinity;
    columns.current.forEach((column, i) => {
      if (itemsRef.current[i]?.disabled) return;
      const d = Math.abs(x - column.cx);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  };

  const followThumb = (x: number, snap: boolean): void => {
    if (!water) return;
    const column = columns.current[nearest(x)];
    const leaned = column ? x + (column.cx - x) * 0.6 : x;
    water.aim(0, leaned, 1, 0, snap);
    water.tiltX.to = ((x - geo.current.w / 2) / geo.current.w) * 0.12;
  };

  const shapeForPull = (pull: number, sheetHeight: number): void => {
    if (!water) return;
    const g = geo.current;
    const s = g.scale;
    const t = clamp(pull / sheetHeight, 0, 1);
    const index = itemsRef.current.findIndex((item) => item.id === openRef.current);
    const originX = columns.current[index]?.cx ?? g.width / 2;
    const spread = Math.min(t * 1.4, 1);
    water.tuneMass(2, 700, 54);
    water.setMass(2, {
      cx: originX + (g.width / 2 - originX) * spread,
      hw: 22 * s + (g.width / 2 + 90 * s - 22 * s) * spread,
      depth: g.depth + pull,
      r: 20 * s + 16 * s * t,
      on: 1,
    });
    scrim.to = t;
    water.invalidate();
  };

  const onDown = (event: PointerEvent<HTMLElement>, mode: Drag['mode']): void => {
    if (event.button !== 0 || !rootRef.current) return;
    const p = pointIn(rootRef.current, event.clientX, event.clientY);
    const sheet = openRef.current ? sheetEls.current.get(openRef.current) : undefined;
    const index = nearest(p.x);
    drag.current = {
      id: event.pointerId,
      x0: p.x,
      y0: p.y,
      mode,
      index,
      pull: sheet ? sheet.offsetHeight : 0,
      from: sheet ? sheet.offsetHeight : 0,
    };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A pointer the browser no longer tracks. The bubbling events still drive the gesture.
    }
    if (mode === 'scrub' && water) {
      followThumb(p.x, water.drops[0].reach.x < 0.04);
      water.press(true);
      tick();
    }
  };

  const onHover = (event: PointerEvent<HTMLElement>): void => {
    if (event.pointerType !== 'mouse' || drag.current || !rootRef.current) return;
    const p = pointIn(rootRef.current, event.clientX, event.clientY);
    followThumb(p.x, !hovering.current && water !== null && water.drops[0].reach.x < 0.04);
    hovering.current = true;
  };

  const onHoverEnd = (): void => {
    hovering.current = false;
    if (!water || drag.current) return;
    water.aim(0, water.drops[0].x.to, 0, 0);
  };

  const onMove = (event: PointerEvent<HTMLElement>): void => {
    onHover(event);
    const d = drag.current;
    if (!d || d.id !== event.pointerId || !rootRef.current) return;
    const p = pointIn(rootRef.current, event.clientX, event.clientY);
    const dx = p.x - d.x0;
    const dy = p.y - d.y0;
    const s = geo.current.scale;

    if (d.mode === 'scrub' && Math.abs(dy) > 18 * s && Math.abs(dy) > Math.abs(dx) * 1.1) {
      const item = itemsRef.current[d.index];
      const goingUp = dy < 0;
      if (goingUp && !openRef.current && item?.links?.length) {
        d.mode = 'sheet';
        d.from = 0;
        d.pull = 0;
        onSelect(item.id);
        openRef.current = item.id;
        setSheetId(item.id);
      } else if (!goingUp && openRef.current) {
        d.mode = 'sheet';
      }
      if (d.mode === 'sheet' && water) {
        water.aim(0, water.drops[0].x.to, 0, 0);
        water.press(false);
      }
    }

    if (d.mode === 'scrub') {
      const index = nearest(p.x);
      if (index !== d.index) {
        d.index = index;
        tick();
      }
      followThumb(p.x, false);
    } else {
      const id = openRef.current;
      const sheet = id ? sheetEls.current.get(id) : undefined;
      if (!sheet) return;
      const height = sheet.offsetHeight;
      d.pull = clamp(d.from - dy - (d.from === 0 ? 18 * s : 0), 0, height * 1.03);
      shapeForPull(d.pull, height);
    }
  };

  const finishDrag = (event: PointerEvent<HTMLElement>): void => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    drag.current = null;
    if (water) {
      water.press(false);
      if (!(hovering.current && event.pointerType === 'mouse')) water.aim(0, water.drops[0].x.to, 0, 0);
    }
    if (d.mode === 'scrub') {
      if (event.type === 'pointercancel') return;
      if (core && water) core.splashEdge(water.drops[0].x.x, 9 * geo.current.scale);
      clickedAt.current = performance.now();
      tabEls.current[d.index]?.click();
      return;
    }
    const id = openRef.current;
    const sheet = id ? sheetEls.current.get(id) : undefined;
    if (!sheet) return;
    const keep = d.pull > sheet.offsetHeight * (d.from > 0 ? 0.72 : 0.28);
    if (keep) placeSheet(false);
    else applySheet(null);
  };

  const rowOn = (el: HTMLElement): void => {
    el.setAttribute('data-hot', '');
    if (!water || !rootRef.current) return;
    const r = rectIn(rootRef.current, el);
    const g = geo.current;
    const x = r.x + r.w / 2;
    const y = g.h - (r.y + r.h / 2);
    const half = r.w / 2 + 8 * g.scale;
    if (water.glowGain.x < 0.02 || water.still) {
      water.glowX.snap(x);
      water.glowY.snap(y);
      water.glowW.snap(half);
    } else {
      water.glowX.to = x;
      water.glowY.to = y;
      water.glowW.to = half;
    }
    water.glowHalfHeight = (r.h / 2) * 0.96;
    water.glowGain.to = 1;
    water.invalidate();
  };

  const rowOff = (el: HTMLElement): void => {
    el.removeAttribute('data-hot');
    if (water) water.glowGain.to = 0;
  };

  const onKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!openRef.current) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      applySheet(null);
    } else if (event.key === 'Tab' && surfaceRef.current) {
      const nodes = focusablesIn(surfaceRef.current);
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  const onTabClick = (event: MouseEvent, item: PendantItem): void => {
    // A real click right after a thumb release is the same press. The release already chose.
    if (event.detail > 0 && performance.now() - clickedAt.current < 500) {
      event.preventDefault();
      return;
    }
    if (!item.href) event.preventDefault();
    choose(item);
  };

  const focusTab = (event: FocusEvent<HTMLElement>, index: number): void => {
    if (!water || !event.target.matches(':focus-visible')) return;
    const column = columns.current[index];
    if (column) water.aim(0, column.cx, 1, 0, water.drops[0].reach.x < 0.04);
  };

  const blurTab = (): void => {
    if (water && !drag.current && !hovering.current) water.aim(0, water.drops[0].x.to, 0, 0);
  };

  const ActionTag: ElementType = action?.href ? Link : 'button';

  return (
    <div ref={surfaceRef} className="pd-surface" onKeyDown={onKey}>
      <div
        ref={scrimRef}
        className="pd-scrim"
        data-open={sheetId ? '' : undefined}
        aria-hidden="true"
        onClick={() => applySheet(null)}
      />

      <div className="pd-top" data-ready={ready || undefined}>
        {brand ? (
          <Link ref={brandRef} className="pd-brand" href={brandHref} aria-label={brandLabel}>
            {brand}
          </Link>
        ) : (
          <span />
        )}
        {action ? (
          <ActionTag
            ref={actionRef}
            className="pd-action"
            href={action.href}
            type={action.href ? undefined : 'button'}
            onClick={(event: MouseEvent) => {
              if (!action.href) event.preventDefault();
              core?.strike();
              action.onSelect?.();
            }}
          >
            {action.label}
          </ActionTag>
        ) : null}
      </div>

      <div ref={clipRef} className="pd-clip">
        {items.map((item) => {
          if (!item.links?.length) return null;
          const on = sheetId === item.id;
          return (
            <section
              key={item.id}
              id={`${baseId}-${item.id}`}
              ref={(node) => {
                if (node) sheetEls.current.set(item.id, node);
                else sheetEls.current.delete(item.id);
              }}
              className="pd-sheet"
              role="dialog"
              aria-modal="true"
              aria-label={item.label}
              data-state={on ? 'on' : 'off'}
              {...inertWhen(!on)}
            >
              <div
                className="pd-sheet-head"
                onPointerDown={(event) => onDown(event, 'sheet')}
                onPointerMove={onMove}
                onPointerUp={finishDrag}
                onPointerCancel={finishDrag}
              >
                <h2 className="pd-sheet-title">{item.label}</h2>
              </div>
              <ul className="pd-links">
                {item.links.map((link, i) => {
                  const RowTag: ElementType = link.href ? Link : 'button';
                  return (
                    <li key={link.id} style={{ '--pd-delay': `${Math.round(190 * (1 - Math.pow(0.7, i)))}ms` } as CSSProperties}>
                      <RowTag
                        className="pd-link"
                        href={link.href}
                        type={link.href ? undefined : 'button'}
                        onPointerEnter={(event: PointerEvent<HTMLElement>) => rowOn(event.currentTarget)}
                        onPointerLeave={(event: PointerEvent<HTMLElement>) => rowOff(event.currentTarget)}
                        onFocus={(event: FocusEvent<HTMLElement>) => {
                          if (event.currentTarget.matches(':focus-visible')) rowOn(event.currentTarget);
                        }}
                        onBlur={(event: FocusEvent<HTMLElement>) => rowOff(event.currentTarget)}
                        onClick={(event: MouseEvent) => {
                          if (!link.href) event.preventDefault();
                          onSelect(item.id, link.id);
                          applySheet(null);
                        }}
                      >
                        <span className="pd-link-label">{link.label}</span>
                        {link.detail ? <span className="pd-link-detail">{link.detail}</span> : null}
                      </RowTag>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>

      <nav
        ref={moundRef}
        className="pd-mound"
        aria-label={navLabel}
        onPointerDown={(event) => onDown(event, 'scrub')}
        onPointerMove={onMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onPointerLeave={onHoverEnd}
      >
        {items.map((item, i) => {
          const current = activeId === item.id;
          const register = (node: HTMLElement | null): void => {
            tabEls.current[i] = node;
          };
          const shared = {
            className: 'pd-tab',
            'aria-label': item.label,
            'data-disabled': item.disabled ? '' : undefined,
            onClick: (event: MouseEvent) => onTabClick(event, item),
            onFocus: (event: FocusEvent<HTMLElement>) => focusTab(event, i),
            onBlur: blurTab,
          };
          return (
            <span key={item.id} className="pd-tab-pair">
              {item.links?.length || !item.href ? (
                <button
                  ref={register}
                  type="button"
                  aria-expanded={item.links?.length ? sheetId === item.id : undefined}
                  aria-controls={item.links?.length ? `${baseId}-${item.id}` : undefined}
                  aria-current={!item.links?.length && current ? 'page' : undefined}
                  disabled={item.disabled}
                  {...shared}
                />
              ) : (
                <Link
                  ref={register}
                  href={item.href}
                  aria-current={current ? 'page' : undefined}
                  aria-disabled={item.disabled || undefined}
                  tabIndex={item.disabled ? -1 : undefined}
                  {...shared}
                />
              )}
              <span
                ref={(node) => {
                  faceEls.current[i] = node;
                }}
                className="pd-tab-face"
                aria-hidden="true"
              >
                <span className="pd-tab-icon">{item.icon}</span>
                <span
                  ref={(node) => {
                    nameEls.current[i] = node;
                  }}
                  className="pd-tab-name"
                >
                  {item.label}
                </span>
              </span>
            </span>
          );
        })}
      </nav>
    </div>
  );
}
