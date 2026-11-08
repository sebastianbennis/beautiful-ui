import type { CSSProperties } from 'react';
import { StepMark } from './StepMark';
import type { AgentStatus, AgentStep } from './types';

interface AgentStepsProps {
  status: AgentStatus;
  steps: readonly AgentStep[];
  /** How far through the current step the work is, 0 to 1. The rail creeps down with it. */
  within?: number;
}

/** Steps and their outcomes, on one rail that fills as the work moves down it. */
export function AgentSteps({ status, steps, within = 0 }: AgentStepsProps) {
  const reached = steps.findLastIndex((step) => step.state !== 'pending');
  const lit = status === 'complete' ? 1 : (reached + within) / Math.max(steps.length - 1, 1);

  return (
    <div className="agent-steps" data-status={status} style={{ '--lit': Math.min(Math.max(lit, 0), 1) } as CSSProperties}>
      <span className="agent-steps__rail" aria-hidden="true">
        <span className="agent-steps__fill" />
      </span>
      <ol className="agent-steps__list">
        {steps.map((step) => (
          <li
            key={step.id}
            className="agent-steps__row"
            data-state={step.state}
            data-added={step.added === true}
            aria-current={step.state === 'current' ? 'step' : undefined}
          >
            <StepMark state={step.state} />
            <span className="agent-steps__label">{step.label}</span>
            <span className="agent-steps__note">{step.note}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
