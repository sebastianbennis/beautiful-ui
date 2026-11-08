'use client';

import { useEffect, useRef, useState } from 'react';

type Way = 'up' | 'down';

/**
 * Follows the target at a pace the eye can read. Between turns the number holds
 * still, so a value that climbs ten points a second never strobes.
 */
function useCalmReading(target: number, cadenceMs: number) {
  const [reading, setReading] = useState<{ whole: number; way: Way }>({ whole: target, way: 'up' });
  const lastTurn = useRef(Number.NEGATIVE_INFINITY);

  useEffect(() => {
    if (target === reading.whole) return;
    const wait = Math.max(lastTurn.current + cadenceMs - performance.now(), 0);
    const timer = setTimeout(() => {
      lastTurn.current = performance.now();
      setReading({ whole: target, way: target > reading.whole ? 'up' : 'down' });
    }, wait);
    return () => clearTimeout(timer);
  }, [target, reading.whole, cadenceMs]);

  return reading;
}

/** One digit. When it changes, the old digit slides out and the new one takes its place. */
function Digit({ digit, way }: { digit: number; way: Way }) {
  const [slot, setSlot] = useState({ current: digit, previous: digit, turns: 0, way });
  // The way is kept with the turn. A digit that did not change must not replay when the count reverses.
  if (slot.current !== digit) setSlot({ current: digit, previous: slot.current, turns: slot.turns + 1, way });

  return (
    <span className="agent-odo__slot">
      <span key={slot.turns} className="agent-odo__turn" data-way={slot.turns > 0 ? slot.way : undefined}>
        <span className="agent-odo__digit">{slot.current}</span>
        {slot.turns > 0 && <span className="agent-odo__digit agent-odo__digit--old">{slot.previous}</span>}
      </span>
    </span>
  );
}

interface OdometerProps {
  /** The percentage, 0 to 100. Update it as often as you like. */
  value: number;
  /** The shortest time between two changes of the number. */
  cadenceMs?: number;
}

/** A percentage on rolling digits. It counts in either direction, so a plan that grows can pull it back. */
export function Odometer({ value, cadenceMs = 240 }: OdometerProps) {
  const { whole, way } = useCalmReading(Math.floor(value), cadenceMs);

  return (
    <span className="agent-odo" aria-label={`${whole}%`}>
      <span className="agent-odo__wheels" aria-hidden="true">
        <span className="agent-odo__leading" data-shown={whole >= 100}>
          <Digit digit={Math.floor(whole / 100)} way={way} />
        </span>
        <span className="agent-odo__leading" data-shown={whole >= 10}>
          <Digit digit={Math.floor(whole / 10) % 10} way={way} />
        </span>
        <Digit digit={whole % 10} way={way} />
      </span>
      <span className="agent-odo__sign" aria-hidden="true">
        %
      </span>
    </span>
  );
}
