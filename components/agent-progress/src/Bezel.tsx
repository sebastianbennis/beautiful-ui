import type { CSSProperties } from 'react';

/** A ring of fine graduated ticks with a sweep of light running around it. */
export function Bezel({ count = 60 }: { count?: number }) {
  return (
    <span className="agent-bezel" style={{ '--count': count } as CSSProperties} aria-hidden="true">
      <span className="agent-bezel__halo" />
      {Array.from({ length: count }, (_, index) => (
        <span key={index} className="agent-bezel__tick" style={{ '--i': index } as CSSProperties}>
          <i />
        </span>
      ))}
    </span>
  );
}
