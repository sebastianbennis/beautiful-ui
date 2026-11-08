import type { CSSProperties } from 'react';
import { Bezel } from './Bezel';
import type { AgentStepState } from './types';

const RAYS = Array.from({ length: 12 }, (_, index) => index);

/**
 * The state of one step. Pending is a quiet dot, current is a small live bezel,
 * done closes a ring and draws the tick, failed closes the ring and draws a cross.
 */
export function StepMark({ state }: { state: AgentStepState }) {
  return (
    <span className="agent-mark" data-state={state} aria-hidden="true">
      <span className="agent-mark__rays">
        {RAYS.map((index) => (
          <span key={index} className="agent-mark__ray" style={{ '--i': index } as CSSProperties}>
            <i />
          </span>
        ))}
      </span>
      <span className="agent-mark__live">
        <Bezel count={18} />
      </span>
      <svg className="agent-mark__art" viewBox="0 0 32 32">
        <circle className="agent-mark__disc" cx="16" cy="16" r="13.5" />
        <circle className="agent-mark__ring" cx="16" cy="16" r="13.5" pathLength={1} />
        <circle className="agent-mark__halo" cx="16" cy="16" r="7" />
        <circle className="agent-mark__dot" cx="16" cy="16" r="2.5" />
        <path className="agent-mark__stroke agent-mark__stroke--tick" pathLength={1} d="M10 16.8 14.2 21 22.2 11.6" />
        <path className="agent-mark__stroke agent-mark__stroke--cross" pathLength={1} d="M11.2 11.2 20.8 20.8" />
        <path className="agent-mark__stroke agent-mark__stroke--cross" pathLength={1} d="M20.8 11.2 11.2 20.8" />
      </svg>
    </span>
  );
}
