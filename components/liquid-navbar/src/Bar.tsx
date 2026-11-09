'use client';

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ElementType,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import { clamp, focusablesIn, inertWhen, offsetTopIn, paintDay, pointIn, rectIn, type LayoutProps } from './shared';
import type { PendantItem } from './types';

interface ItemMetric {
  cx: number;
  w: number;
  labelW: number;
  ride: number;
  grow: number;
  lit: number;
}

interface Row {
  x: number;
  y: number;
  w: number;
  h: number;
}

const BODY_DEPTH = 84;
/** How far a hovered label sinks into its drop, and how much it grows. */
const RIDE = 30;
const GROW = 0.28;
const ACTIVE_RIDE = 13;
const ACTIVE_GROW = 0.07;
/** How close, below the body, the pointer has to come before the liquid starts to reach for it. */
const REACH_RANGE = 170;

/** How wide a drop has to be for its label to sit inside it at full size. */
function lengthFor(metric: ItemMetric, scale: number): number {
  return Math.max((metric.labelW * (1 + GROW)) / 2 + 26 * scale - 48.6 * scale, 0);
}

export function Bar({
  engine: core,
  rootRef,
  items,
  activeId,
  onSelect,
  brand,
  brandHref,
  brandLabel,
  action,
  navLabel,
  fog,
  Link,
}: LayoutProps) {
  const engine = core?.top ?? null;
  const barRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const brandRef = useRef<HTMLElement>(null);
  const actionRef = useRef<HTMLElement>(null);
  const clipRef = useRef<HTMLDivElement>(null);
  const itemEls = useRef<Array<HTMLElement | null>>([]);
  const faceEls = useRef<Array<HTMLElement | null>>([]);
  const labelEls = useRef<Array<HTMLElement | null>>([]);
  const panelEls = useRef(new Map<string, HTMLElement>());
  const metrics = useRef<ItemMetric[]>([]);
  const geo = useRef({ w: 0, h: 0, scale: 1, depth: BODY_DEPTH, left: 0, right: 0 });
  const rows = useRef<Row[]>([]);
  const rowEls = useRef<HTMLElement[]>([]);
  const hotRow = useRef(-1);
  const panelBox = useRef<{ x0: number; x1: number; y1: number } | null>(null);
  const openRef = useRef<string | null>(null);
  const hotRef = useRef(-1);
  const activeRef = useRef(activeId);
  activeRef.current = activeId;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const timers = useRef({ open: 0, close: 0 });
  const closing = useRef(false);
  const openedAt = useRef(0);
  const lastCx = useRef(0);
  const lastX = useRef(0);
  const focusFirst = useRef(false);
  const arrived = useRef(false);
  const swell = useRef({ brand: 0, action: 0 });
  const fogKeeps = useRef<Array<{ x: number; width: number }>>([{ x: 0, width: 1 }]);
  const pour = useRef({ timer: 0, active: false });
  const pointerInside = useRef(false);

  const [openId, setOpenId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const baseId = useId();

  const placeActive = useCallback(
    (snap = false) => {
      if (!engine) return;
      const index = itemsRef.current.findIndex((item) => item.id === activeRef.current);
      const metric = metrics.current[index];
      const s = geo.current.scale;
      if (metric) {
        engine.aim(1, metric.cx, 1, Math.max(metric.labelW / 2 + 12 * s - 37.8 * s, 0), snap);
        fogKeeps.current[0] = { x: metric.cx, width: metric.labelW * 0.6 + 26 * s };
        engine.fogClear = [...fogKeeps.current];
      } else {
        engine.aim(1, engine.drops[1].x.x, 0, 0);
      }
    },
    [engine],
  );

  const placeSides = useCallback(
    (snap = false, hidden = false) => {
      if (!engine) return;
      const root = rootRef.current;
      if (!root) return;
      const s = geo.current.scale;
      const brandEl = brandRef.current;
      if (brandEl) {
        const r = rectIn(root, brandEl);
        engine.setMass(
          1,
          { cx: r.x + r.w / 2, hw: r.w / 2, depth: hidden ? 0 : r.h + swell.current.brand * s, r: 32 * s, on: 1 },
          snap,
        );
      } else {
        engine.setMass(1, { cx: 0, hw: 1, depth: 0, r: 1, on: 0 }, true);
      }
      const actionEl = actionRef.current;
      const a = engine.action;
      if (actionEl) {
        const r = rectIn(root, actionEl);
        const depth = hidden ? 0 : r.h + swell.current.action * s;
        const far = -120 * s;
        const set = (spring: typeof a.cx, value: number): void => {
          if (snap || engine.still) spring.snap(value);
          else spring.to = value;
        };
        engine.actionAttached = true;
        set(a.cx, r.x + r.w / 2);
        set(a.cy, (depth + far) / 2);
        set(a.hw, r.w / 2);
        set(a.hh, (depth - far) / 2);
        set(a.r, 32 * s);
        set(a.on, 1);
        engine.invalidate();
      } else {
        a.on.snap(0);
      }
    },
    [engine, rootRef],
  );

  const placePanel = useCallback(
    (snap = false) => {
      const g = geo.current;
      const s = g.scale;
      const id = openRef.current;
      const margin = 24 * s;

      const left = (panel: HTMLElement, metric: ItemMetric): number =>
        clamp(metric.cx - panel.offsetWidth / 2, margin, g.w - panel.offsetWidth - margin);

      itemsRef.current.forEach((item, i) => {
        const panel = panelEls.current.get(item.id);
        const metric = metrics.current[i];
        if (panel && metric) {
          panel.style.transform = `translate3d(${Math.round(left(panel, metric))}px, ${Math.round(g.depth + 8 * s)}px, 0)`;
        }
      });

      if (!engine) return;

      if (id) {
        const index = itemsRef.current.findIndex((item) => item.id === id);
        const panel = panelEls.current.get(id);
        const metric = metrics.current[index];
        if (!panel || !metric) return;
        const w = panel.offsetWidth;
        const h = panel.offsetHeight;
        const x = left(panel, metric);
        lastCx.current = metric.cx;
        engine.setMass(2, { cx: x + w / 2, hw: w / 2, depth: g.depth + 8 * s + h, r: 44 * s, on: 1 }, snap);
        panelBox.current = { x0: x, x1: x + w, y1: g.depth + 8 * s + h };

        const links = [...panel.querySelectorAll<HTMLElement>('.pd-link')];
        rowEls.current = links;
        rows.current = links.map((link) => ({
          x: x + link.offsetLeft + (link.parentElement?.offsetLeft ?? 0),
          y: g.depth + 8 * s + offsetTopIn(link, panel),
          w: link.offsetWidth,
          h: link.offsetHeight,
        }));
      } else {
        rows.current = [];
        rowEls.current = [];
        panelBox.current = null;
        engine.glowGain.to = 0;
        engine.setMass(2, { cx: lastCx.current, hw: 30 * s, depth: g.depth - 12 * s, r: 16 * s, on: 0 }, snap);
      }
    },
    [engine],
  );

  const layout = useCallback(
    (snap = false) => {
      const root = rootRef.current;
      const list = listRef.current;
      if (!root || !list) return;
      const box = rectIn(root, list);
      const scale = box.h / BODY_DEPTH;
      geo.current = { w: root.offsetWidth, h: root.offsetHeight, scale, depth: box.h, left: box.x, right: box.x + box.w };

      metrics.current = itemsRef.current.map((_, i) => {
        const el = itemEls.current[i];
        const r = el ? rectIn(root, el) : { x: 0, w: 0 };
        const previous = metrics.current[i];
        return {
          cx: r.x + r.w / 2,
          w: r.w,
          labelW: labelEls.current[i]?.offsetWidth ?? 0,
          ride: previous?.ride ?? -1,
          grow: previous?.grow ?? -1,
          lit: previous?.lit ?? -1,
        };
      });

      if (engine && core) {
        core.resize(root.offsetWidth, root.offsetHeight);
        core.scale = scale;
        core.shoulder = 44;
        core.merge = 40;
        engine.dropShape = [
          { radius: 54, offset: 6 },
          { radius: 42, offset: -24 },
        ];
        engine.setWaveSpan(0, root.offsetWidth);
        engine.fogLevel = fog ? 1 : 0;

        // The water at the foot of the banner. Only the jets it throws up stand in this layer.
        const W = root.offsetWidth;
        const H = root.offsetHeight;
        core.poolBase = Math.round(H * 0.25);
        core.poolMax = Math.round(H * 0.13);
        core.waterFloor = 0;
        const water = core.bottom;
        water.setWaveSpan(0, W);
        water.fogLevel = 0;
        // Coming from the phone layout, nothing of its tab bar may be left standing.
        for (const drop of water.drops) drop.reach.snap(0);
        water.setMass(0, { cx: W / 2, hw: W / 2 + 170 * scale, depth: 0, r: 40 * scale, on: 0 }, true);
        water.setMass(1, { cx: 0, hw: 1, depth: 0, r: 1, on: 0 }, true);
        water.setMass(2, { cx: 0, hw: 1, depth: 0, r: 1, on: 0 }, true);
        if (engine.still) core.level.snap(core.poolBase);

        const first = !arrived.current && snap;
        engine.setMass(
          0,
          { cx: box.x + box.w / 2, hw: box.w / 2, depth: first ? 0 : box.h, r: 38 * scale, on: 1 },
          snap,
        );
        placeSides(snap, first);

        const drips = [
          { x: box.x + box.w * 0.15, length: 18, bulb: 5.2, neck: 1.5, every: 5.4 },
          { x: box.x + box.w * 0.41, length: 31, bulb: 6.6, neck: 1.7, every: 3.3 },
          { x: box.x + box.w * 0.64, length: 13, bulb: 4.5, neck: 1.4, every: 6.3 },
          { x: box.x + box.w * 0.86, length: 25, bulb: 5.8, neck: 1.6, every: 4.1 },
        ];
        const brandEl = brandRef.current;
        if (brandEl) {
          const r = rectIn(root, brandEl);
          drips.push(
            { x: r.x + r.w * 0.28, length: 12, bulb: 4.2, neck: 1.3, every: 6.9 },
            { x: r.x + r.w * 0.74, length: 20, bulb: 5.2, neck: 1.5, every: 4.8 },
          );
          fogKeeps.current[1] = { x: r.x + r.w / 2, width: r.w * 0.62 };
        }
        engine.setRestingDrips(drips.map((d) => ({ ...d, length: d.length * scale, bulb: d.bulb * scale, neck: d.neck * scale })));

        placeActive(snap);
        placePanel(snap);
      }
    },
    [core, engine, fog, rootRef, placeActive, placeSides, placePanel],
  );

  const frame = useCallback(() => {
    if (!engine) return;
    const { w: W, scale: s, depth } = geo.current;
    const clip = clipRef.current;
    const panel = engine.masses[2];
    if (clip) {
      if (panel.on.x > 0.001) {
        const b = geo.current.h - panel.depth.x;
        const l = panel.cx.x - panel.hw.x;
        const r = W - (panel.cx.x + panel.hw.x);
        const round = Math.max(panel.r.x, 0).toFixed(2);
        clip.style.clipPath = `inset(${(depth * 0.5).toFixed(2)}px ${r.toFixed(2)}px ${b.toFixed(2)}px ${l.toFixed(2)}px round 0 0 ${round}px ${round}px)`;
      } else {
        clip.style.clipPath = 'inset(100%)';
      }
    }

    const hover = engine.drops[0];
    const current = engine.drops[1];
    const open = openRef.current !== null;
    const activeIndex = itemsRef.current.findIndex((item) => item.id === activeRef.current);
    const hoverReach = clamp(hover.reach.x, 0, 1.15);
    const currentReach = clamp(current.reach.x, 0, 1.1);

    // Each word changes colour at the moment the weather reaches it.
    if (core) {
      const row = geo.current.depth * 0.5;
      paintDay(brandRef.current, core.dayAt(engine.masses[1].cx.x, row));
      paintDay(actionRef.current, core.dayAt(engine.action.cx.x, row));
      panelEls.current.forEach((el) => paintDay(el, core.dayAt(panel.cx.x, panel.depth.x * 0.55)));
    }

    metrics.current.forEach((metric, i) => {
      const face = faceEls.current[i];
      const el = itemEls.current[i];
      if (!face || !el) return;
      if (core) paintDay(el, core.dayAt(metric.cx, geo.current.depth * 0.5));
      const spread = metric.w * 0.5 + 30 * s;
      const near = Math.exp(-Math.pow((hover.x.x - metric.cx) / spread, 2)) * hoverReach;
      const here = i === activeIndex ? Math.exp(-Math.pow((current.x.x - metric.cx) / spread, 2)) * currentReach : 0;
      const sink = open ? 0.28 : 1;
      const ride = Math.max(near * RIDE, here * ACTIVE_RIDE) * s * sink + hover.press.x * near * 6 * s;
      const grow = 1 + Math.max(near * GROW * (open ? 0.5 : 1), here * ACTIVE_GROW);
      const lit = Math.min(Math.max(near, here), 1);
      if (Math.abs(ride - metric.ride) > 0.02 || Math.abs(grow - metric.grow) > 0.0005) {
        metric.ride = ride;
        metric.grow = grow;
        face.style.transform = `translate3d(0, ${ride.toFixed(2)}px, 0) scale(${grow.toFixed(4)})`;
      }
      if (Math.abs(lit - metric.lit) > 0.004) {
        metric.lit = lit;
        el.style.setProperty('--pd-lit', lit.toFixed(3));
      }
    });
  }, [core, engine]);

  useLayoutEffect(() => {
    if (!core) return;
    core.onFrame = frame;
    return () => {
      core.onFrame = null;
    };
  }, [core, frame]);

  // Only the engine's very first layout jumps. New items after that flow into place.
  const laidOut = useRef<unknown>(null);
  useLayoutEffect(() => {
    layout(laidOut.current !== core);
    laidOut.current = core;
    frame();
    const root = rootRef.current;
    if (!root) return;
    const observer = new ResizeObserver(() => layout(false));
    observer.observe(root);
    if (listRef.current) observer.observe(listRef.current);
    panelEls.current.forEach((panel) => observer.observe(panel));
    let alive = true;
    void document.fonts?.ready.then(() => {
      if (alive) layout(false);
    });
    return () => {
      alive = false;
      observer.disconnect();
    };
  }, [core, layout, frame, rootRef, items]);

  // The arrival: the liquid pours down out of the edge of the screen and settles with its weight.
  useEffect(() => {
    if (!engine || arrived.current) {
      if (engine) setReady(true);
      return;
    }
    arrived.current = true;
    const list = listRef.current;
    if (!list || engine.still) {
      layout(true);
      setReady(true);
      return;
    }
    const heavy = (index: number): void => engine.tuneMass(index, 80, 9.5);
    const settled = (index: number): void => engine.tuneMass(index, 170, 22);
    heavy(0);
    engine.masses[0].depth.to = list.offsetHeight;
    const reveal = window.setTimeout(() => setReady(true), 180);
    const sides = window.setTimeout(() => {
      heavy(1);
      const a = engine.action;
      a.cy.k = a.hh.k = 90;
      a.cy.c = a.hh.c = 10.5;
      placeSides(false, false);
    }, 150);
    const calm = window.setTimeout(() => {
      settled(0);
      settled(1);
      const a = engine.action;
      a.cy.k = a.hh.k = 200;
      a.cy.c = a.hh.c = 22;
    }, 1500);
    return () => {
      window.clearTimeout(reveal);
      window.clearTimeout(sides);
      window.clearTimeout(calm);
    };
  }, [engine, layout, placeSides]);

  useEffect(() => {
    placeActive();
    if (engine && !engine.still) {
      engine.drops[1].x.k = 130;
      engine.drops[1].x.c = 14;
    }
  }, [activeId, engine, placeActive]);

  const applyOpen = useCallback(
    (id: string | null) => {
      const previous = openRef.current;
      if (previous === id) return;
      openRef.current = id;
      setOpenId(id);
      if (engine) {
        const m = engine.masses[2];
        if (id && !previous) {
          openedAt.current = performance.now();
          const [x, y, a, b] = engine.dropGeometry(0);
          const s = geo.current.scale;
          const from = b > 2 ? { cx: x, hw: a, depth: y + b, r: b } : { cx: x, hw: 40 * s, depth: geo.current.depth, r: 30 * s };
          engine.setMass(2, { ...from, on: 1 }, true);
          m.depth.k = 118;
          m.depth.c = 15;
          m.hw.k = 84;
          m.hw.c = 14;
          m.cx.k = 130;
          m.cx.c = 19;
          m.r.k = 120;
          m.r.c = 18;
        } else if (id) {
          engine.tuneMass(2, 190, 22);
        } else {
          m.depth.k = 320;
          m.depth.c = 32;
          m.hw.k = 250;
          m.hw.c = 29;
          m.cx.k = 280;
          m.cx.c = 32;
          m.r.k = 280;
          m.r.c = 32;
        }
      }
      placePanel();
    },
    [engine, placePanel],
  );

  const cancelClose = useCallback(() => {
    closing.current = false;
    window.clearTimeout(timers.current.close);
  }, []);

  const requestOpen = useCallback(
    (id: string, immediately = false) => {
      const t = timers.current;
      cancelClose();
      window.clearTimeout(t.open);
      if (immediately || openRef.current) applyOpen(id);
      else t.open = window.setTimeout(() => applyOpen(id), 130);
    },
    [applyOpen, cancelClose],
  );

  // A moving mouse calls this constantly, so a close already on its way is left to finish.
  const requestClose = useCallback(
    (delay: number) => {
      if (closing.current) return;
      const t = timers.current;
      window.clearTimeout(t.open);
      closing.current = true;
      t.close = window.setTimeout(() => {
        closing.current = false;
        applyOpen(null);
      }, delay);
    },
    [applyOpen],
  );

  useEffect(() => {
    const t = timers.current;
    return () => {
      window.clearTimeout(t.open);
      window.clearTimeout(t.close);
    };
  }, []);

  const setHot = useCallback((index: number): void => {
    if (hotRef.current === index) return;
    const previous = itemEls.current[hotRef.current];
    previous?.removeAttribute('data-hot');
    hotRef.current = index;
    itemEls.current[index]?.setAttribute('data-hot', '');
  }, []);

  const setHotRow = useCallback(
    (index: number): void => {
      if (hotRow.current === index) return;
      rowEls.current[hotRow.current]?.removeAttribute('data-hot');
      hotRow.current = index;
      rowEls.current[index]?.setAttribute('data-hot', '');
      if (!engine) return;
      const row = rows.current[index];
      if (row) {
        const fresh = engine.glowGain.x < 0.02;
        const x = row.x + row.w / 2;
        const y = row.y + row.h / 2;
        const half = row.w / 2 + 10 * geo.current.scale;
        if (fresh || engine.still) {
          engine.glowX.snap(x);
          engine.glowY.snap(y);
          engine.glowW.snap(half);
        } else {
          engine.glowX.to = x;
          engine.glowY.to = y;
          engine.glowW.to = half;
        }
        engine.glowHalfHeight = (row.h / 2) * 0.96;
        engine.glowGain.to = 1;
      } else {
        engine.glowGain.to = 0;
      }
      engine.invalidate();
    },
    [engine],
  );

  // The liquid follows the pointer anywhere on the page: it reaches for it from a distance and
  // swells into a drop under it. Reading position from the window keeps that reach continuous.
  const aimAt = useCallback(
    (px: number, py: number) => {
      if (!engine) return;
      const g = geo.current;
      const s = g.scale;
      const list = metrics.current;
      if (list.length === 0) return;

      const box = panelBox.current;
      const inPanel = box !== null && px >= box.x0 && px <= box.x1 && py >= 0 && py <= box.y1;
      const withinX = px > g.left - 8 * s && px < g.right + 8 * s;
      const limit = g.depth + (hotRef.current >= 0 ? 54 * s : 0);
      const overBody = withinX && py >= 0 && py < limit;

      let nearest = 0;
      let bestD = Infinity;
      list.forEach((metric, i) => {
        const d = Math.abs(px - metric.cx);
        if (d < bestD) {
          bestD = d;
          nearest = i;
        }
      });
      const metric = list[nearest];

      // Far from the nav there is nothing to answer, so the surface rests and nothing redraws.
      const lowest = Math.max(g.depth + REACH_RANGE * s, box ? box.y1 : 0) + 60 * s;
      if (py > lowest && hotRef.current < 0 && !box) {
        engine.aim(0, lastX.current, 0, 0);
        if (engine.tiltX.to !== 0 || engine.tiltY.to !== 0) {
          engine.tiltX.to = 0;
          engine.tiltY.to = 0;
          engine.invalidate();
        }
        return;
      }

      engine.tiltX.to = ((px - g.w / 2) / g.w) * 0.09;
      engine.tiltY.to = clamp((py - g.depth) / 900, -0.1, 0.12) * 0.18;
      engine.invalidate();

      if (inPanel && !overBody) {
        setHot(-1);
        cancelClose();
        const index = rows.current.findIndex((row) => py >= row.y && py < row.y + row.h && px >= row.x && px <= row.x + row.w);
        setHotRow(index);
        const openIndex = itemsRef.current.findIndex((item) => item.id === openRef.current);
        const openMetric = list[openIndex];
        if (openMetric) engine.aim(0, openMetric.cx, 1, lengthFor(openMetric, s));
        return;
      }

      setHotRow(-1);

      if (overBody && !itemsRef.current[nearest]?.disabled) {
        pointerInside.current = true;
        const changed = hotRef.current !== nearest;
        setHot(nearest);
        const x = px + (metric.cx - px) * 0.84;
        lastX.current = x;
        engine.aim(0, x, 1, lengthFor(metric, s), engine.drops[0].reach.x < 0.04);
        const item = itemsRef.current[nearest];
        if (item?.links?.length) {
          if (changed) requestOpen(item.id);
          else cancelClose();
        } else if (changed) {
          window.clearTimeout(timers.current.open);
          if (openRef.current) requestClose(160);
        }
        return;
      }

      pointerInside.current = false;
      setHot(-1);
      window.clearTimeout(timers.current.open);
      if (openRef.current) requestClose(220);

      // Below the body, the liquid leans toward a pointer that comes close, before any hover.
      const below = py - g.depth;
      const range = REACH_RANGE * s;
      const sideways = Math.max(g.left - px, px - g.right, 0);
      if (below >= 0 && below < range && sideways < 40 * s) {
        const t = (1 - below / range) * (1 - sideways / (40 * s));
        const reach = t * t * 0.66;
        const x = clamp(px + (metric.cx - px) * 0.24, g.left + 40 * s, g.right - 40 * s);
        lastX.current = x;
        engine.aim(0, x, reach, 0, engine.drops[0].reach.x < 0.03);
      } else {
        engine.aim(0, lastX.current, 0, 0);
      }
    },
    [cancelClose, engine, requestClose, requestOpen, setHot, setHotRow],
  );

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !engine) return;
    const onMove = (event: globalThis.PointerEvent): void => {
      if (event.pointerType === 'touch') return;
      const p = pointIn(root, event.clientX, event.clientY);
      aimAt(p.x, p.y);
      if (!core) return;

      // A pointer moving over the water trails rings behind it.
      core.wake(p.x, p.y);
    };
    const onLeave = (): void => {
      setHot(-1);
      setHotRow(-1);
      engine.aim(0, lastX.current, 0, 0);
      if (openRef.current) requestClose(260);
    };
    const onDown = (event: globalThis.PointerEvent): void => {
      if (!core || hotRef.current >= 0 || panelBox.current) return;
      const p = pointIn(root, event.clientX, event.clientY);
      if (p.y >= core.poolSurface()) core.splashAt(p.x, p.y, 11 * geo.current.scale);
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerdown', onDown, { passive: true });
    document.documentElement.addEventListener('pointerleave', onLeave);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onDown);
      document.documentElement.removeEventListener('pointerleave', onLeave);
    };
  }, [aimAt, core, engine, requestClose, rootRef, setHot, setHotRow]);

  const onPressDown = (event: PointerEvent): void => {
    if (event.button !== 0 || hotRef.current < 0) return;
    engine?.press(true);
    // Keep holding and the drip becomes an unbroken stream down to the water.
    window.clearTimeout(pour.current.timer);
    pour.current.timer = window.setTimeout(() => {
      pour.current.active = true;
      engine?.beginPour();
    }, 380);
  };

  const onPressUp = (event: PointerEvent): void => {
    if (!engine) return;
    engine.press(false);
    window.clearTimeout(pour.current.timer);
    if (pour.current.active) {
      pour.current.active = false;
      engine.endPour();
      return;
    }
    if (hotRef.current < 0 || event.type === 'pointercancel') return;
    engine.release();
  };

  const dentAtFocus = (event: FocusEvent<HTMLElement>, index: number): void => {
    if (!engine || !event.target.matches(':focus-visible')) return;
    const metric = metrics.current[index];
    if (!metric) return;
    lastX.current = metric.cx;
    engine.aim(0, metric.cx, 1, lengthFor(metric, geo.current.scale), engine.drops[0].reach.x < 0.04);
  };

  const releaseFocus = (): void => {
    if (!engine || pointerInside.current) return;
    engine.aim(0, lastX.current, 0, 0);
  };

  const onBlurSurface = (event: FocusEvent<HTMLDivElement>): void => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    if (openRef.current && !pointerInside.current && !panelBox.current) requestClose(0);
  };

  useEffect(() => {
    if (!openId || !focusFirst.current) return;
    focusFirst.current = false;
    const panel = panelEls.current.get(openId);
    if (panel) focusablesIn(panel)[0]?.focus();
  }, [openId]);

  const closeAndReturn = (id: string): void => {
    applyOpen(null);
    const index = itemsRef.current.findIndex((item) => item.id === id);
    itemEls.current[index]?.focus();
  };

  const onTriggerKey = (event: KeyboardEvent, item: PendantItem): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (openRef.current === item.id) {
        const panel = panelEls.current.get(item.id);
        if (panel) focusablesIn(panel)[0]?.focus();
      } else {
        focusFirst.current = true;
        requestOpen(item.id, true);
      }
    } else if (event.key === 'Escape' && openRef.current) {
      event.preventDefault();
      closeAndReturn(openRef.current);
    }
  };

  const onPanelKey = (event: KeyboardEvent<HTMLElement>, id: string): void => {
    const links = focusablesIn(event.currentTarget);
    const index = links.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      closeAndReturn(id);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      links[(index + 1) % links.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (index <= 0) {
        const itemIndex = itemsRef.current.findIndex((item) => item.id === id);
        itemEls.current[itemIndex]?.focus();
      } else {
        links[index - 1]?.focus();
      }
    } else if (event.key === 'Home') {
      event.preventDefault();
      links[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      links[links.length - 1]?.focus();
    }
  };

  const onTriggerClick = (item: PendantItem): void => {
    const justOpened = performance.now() - openedAt.current < 420;
    if (openRef.current === item.id) {
      if (!justOpened) applyOpen(null);
    } else {
      requestOpen(item.id, true);
    }
  };

  const setSwell = (side: 'brand' | 'action', amount: number): void => {
    swell.current[side] = amount;
    placeSides();
  };

  const swellHandlers = (side: 'brand' | 'action') => ({
    onPointerEnter: () => setSwell(side, 7),
    onPointerLeave: () => setSwell(side, 0),
    onPointerDown: () => setSwell(side, -5),
    onPointerUp: () => setSwell(side, 7),
  });

  const openIndex = items.findIndex((item) => item.id === openId);
  const ActionTag: ElementType = action?.href ? Link : 'button';

  return (
    <div className="pd-surface" onPointerDown={onPressDown} onPointerUp={onPressUp} onPointerCancel={onPressUp} onBlur={onBlurSurface}>
      <nav ref={barRef} className="pd-bar" aria-label={navLabel} data-ready={ready || undefined}>
        <div className="pd-side">
          {brand ? (
            <Link ref={brandRef} className="pd-brand" href={brandHref} aria-label={brandLabel} {...swellHandlers('brand')}>
              {brand}
            </Link>
          ) : null}
        </div>

        <ul ref={listRef} className="pd-items">
          {items.map((item, i) => {
            const current = activeId === item.id;
            const register = (node: HTMLElement | null): void => {
              itemEls.current[i] = node;
            };
            const body = (
              <span
                ref={(node) => {
                  faceEls.current[i] = node;
                }}
                className="pd-item-in"
              >
                <span
                  ref={(node) => {
                    labelEls.current[i] = node;
                  }}
                  className="pd-label"
                >
                  {item.label}
                </span>
                {item.links?.length ? (
                  <svg className="pd-caret" viewBox="0 0 10 6" aria-hidden="true" data-open={openId === item.id || undefined}>
                    <path d="M1 1.2 5 4.8 9 1.2" />
                  </svg>
                ) : null}
              </span>
            );

            if (item.disabled) {
              return (
                <li key={item.id} style={{ '--pd-i': i } as CSSProperties}>
                  <span ref={register} className="pd-item" aria-disabled="true" data-disabled="">
                    {body}
                  </span>
                </li>
              );
            }

            if (item.links?.length) {
              return (
                <li key={item.id} style={{ '--pd-i': i } as CSSProperties}>
                  <button
                    ref={register}
                    type="button"
                    className="pd-item"
                    aria-expanded={openId === item.id}
                    aria-controls={`${baseId}-${item.id}`}
                    data-current={current || undefined}
                    onClick={() => onTriggerClick(item)}
                    onKeyDown={(event) => onTriggerKey(event, item)}
                    onFocus={(event) => dentAtFocus(event, i)}
                    onBlur={releaseFocus}
                  >
                    {body}
                  </button>
                </li>
              );
            }

            const LeafTag: ElementType = item.href ? Link : 'button';
            return (
              <li key={item.id} style={{ '--pd-i': i } as CSSProperties}>
                <LeafTag
                  ref={register}
                  className="pd-item"
                  href={item.href}
                  type={item.href ? undefined : 'button'}
                  aria-current={current ? 'page' : undefined}
                  data-current={current || undefined}
                  onClick={(event: MouseEvent) => {
                    if (!item.href) event.preventDefault();
                    onSelect(item.id);
                    applyOpen(null);
                  }}
                  onFocus={(event: FocusEvent<HTMLElement>) => dentAtFocus(event, i)}
                  onBlur={releaseFocus}
                >
                  {body}
                </LeafTag>
              </li>
            );
          })}
        </ul>

        <div className="pd-side pd-side--end">
          {action ? (
            <ActionTag
              ref={actionRef}
              className="pd-action"
              href={action.href}
              type={action.href ? undefined : 'button'}
              {...swellHandlers('action')}
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
      </nav>

      <div ref={clipRef} className="pd-clip">
        {items.map((item, index) => {
          if (!item.links?.length) return null;
          const on = openId === item.id;
          const offset = openIndex < 0 ? 0 : Math.sign(index - openIndex) * 18;
          return (
            <section
              key={item.id}
              id={`${baseId}-${item.id}`}
              ref={(node) => {
                if (node) panelEls.current.set(item.id, node);
                else panelEls.current.delete(item.id);
              }}
              className="pd-panel"
              aria-label={item.label}
              data-state={on ? 'on' : 'off'}
              data-wide={item.links.length > 2 || undefined}
              {...inertWhen(!on)}
              onKeyDown={(event) => onPanelKey(event, item.id)}
            >
              <ul className="pd-links" style={{ '--pd-off': `${offset}px` } as CSSProperties}>
                {item.links.map((link, i) => {
                  const RowTag: ElementType = link.href ? Link : 'button';
                  return (
                    <li key={link.id} style={{ '--pd-delay': `${Math.round(170 * (1 - Math.pow(0.7, i)))}ms` } as CSSProperties}>
                      <RowTag
                        className="pd-link"
                        href={link.href}
                        type={link.href ? undefined : 'button'}
                        onClick={(event: MouseEvent) => {
                          if (!link.href) event.preventDefault();
                          onSelect(item.id, link.id);
                          applyOpen(null);
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
    </div>
  );
}
