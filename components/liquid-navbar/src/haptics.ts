'use client';

/** A short tactile tick where the device offers one. Silent everywhere else. */
export function tick(): void {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    navigator.vibrate(6);
  }
}
