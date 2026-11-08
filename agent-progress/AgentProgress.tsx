import type { CSSProperties, ReactNode } from 'react';
import { Odometer } from './Odometer';
import type { AgentStatus } from './types';

interface AgentProgressProps {
  status: AgentStatus;
  /** How far through the plan, 0 to 1. */
  progress: number;
  /** How many steps the plan has. Each step boundary is a tall graduation on the scale. */
  steps?: number;
  /** A short reading beside the number, such as "Step 2 of 5". */
  detail?: ReactNode;
  /** The name of the bar for screen readers. */
  label?: string;
  ticks?: number;
}

/** Position in a known plan, read off a graduated scale. */
export function AgentProgress({ status, progress, steps = 1, detail, label = 'Task progress', ticks = 88 }: AgentProgressProps) {
  const percent = progress * 100;
  const head = Math.round(progress * (ticks - 1));
  const boundary = (ticks - 1) / Math.max(steps, 1);

  return (
    <div className="agent-progress" data-status={status}>
      <div className="agent-progress__reading">
        <Odometer value={percent} />
        {detail !== undefined && <p className="agent-progress__detail">{detail}</p>}
      </div>
      <div
        className="agent-scale"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.floor(percent)}
        style={{ '--p': progress } as CSSProperties}
      >
        <span className="agent-scale__glow" />
        {Array.from({ length: ticks }, (_, index) => {
          const fromBoundary = Math.abs(index / boundary - Math.round(index / boundary));
          return (
            <i
              key={index}
              className="agent-scale__tick"
              style={{ '--i': index } as CSSProperties}
              data-lit={index <= head && progress > 0}
              data-head={status === 'running' && index === head}
              data-major={fromBoundary * boundary < 0.5}
            />
          );
        })}
      </div>
    </div>
  );
}
