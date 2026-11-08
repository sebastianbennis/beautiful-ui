'use client';

import { useEffect, useState } from 'react';

/** Milliseconds since `running` became true, updated every frame. Pass the result to AgentActivity as `now`. */
export function useRunClock(running: boolean): number {
  const [now, setNow] = useState(0);

  useEffect(() => {
    if (!running) return;
    const startedAt = performance.now();
    let frame = requestAnimationFrame(function tick(time) {
      setNow(Math.max(time - startedAt, 0));
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [running]);

  return now;
}
