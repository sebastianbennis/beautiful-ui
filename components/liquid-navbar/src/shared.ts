'use client';

import { version, type ElementType, type ReactNode, type RefObject } from 'react';
import type { PendantEngine } from './engine';
import type { PendantAction, PendantItem } from './types';

/**
 * Spread this on an element to make it inert. React 19 takes true or false for `inert`, while
 * React 18 drops those and needs the attribute as text.
 */
export function inertWhen(on: boolean): object {
  if (Number.parseInt(version, 10) >= 19) return { inert: on };
  return on ? { inert: '' } : {};
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutProps {
  engine: PendantEngine | null;
  rootRef: RefObject<HTMLDivElement | null>;
  items: PendantItem[];
  activeId: string | null;
  onSelect: (itemId: string, linkId?: string) => void;
  brand?: ReactNode;
  brandHref: string;
  brandLabel: string;
  action?: PendantAction;
  navLabel: string;
  fog: boolean;
  Link: ElementType;
}

export const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

/** Where an element sits inside the nav root, in the root's own pixels. */
export function rectIn(root: HTMLElement, el: Element): Box {
  const rootRect = root.getBoundingClientRect();
  const k = rootRect.width / root.offsetWidth || 1;
  const r = el.getBoundingClientRect();
  return {
    x: (r.left - rootRect.left) / k,
    y: (r.top - rootRect.top) / k,
    w: r.width / k,
    h: r.height / k,
  };
}

export function pointIn(root: HTMLElement, clientX: number, clientY: number): { x: number; y: number } {
  const rootRect = root.getBoundingClientRect();
  const k = rootRect.width / root.offsetWidth || 1;
  return { x: (clientX - rootRect.left) / k, y: (clientY - rootRect.top) / k };
}

/** An element's distance from the top of an ancestor, ignoring any transform still animating. */
export function offsetTopIn(el: HTMLElement, ancestor: HTMLElement): number {
  let y = 0;
  let node: HTMLElement | null = el;
  while (node && node !== ancestor) {
    y += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  return y;
}

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Focusable elements that are actually reachable right now. */
export function focusablesIn(el: HTMLElement): HTMLElement[] {
  return [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (node) => !node.closest('[inert]') && node.getAttribute('aria-disabled') !== 'true' && node.tabIndex >= 0,
  );
}

const shownDay = new WeakMap<HTMLElement, number>();

/** Tells an element how far the weather has turned where it sits, so its text can follow. */
export function paintDay(el: HTMLElement | null | undefined, day: number): void {
  if (!el || Math.abs((shownDay.get(el) ?? -1) - day) < 0.004) return;
  shownDay.set(el, day);
  el.style.setProperty('--pd-day', day.toFixed(3));
}

export function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(' ');
}
