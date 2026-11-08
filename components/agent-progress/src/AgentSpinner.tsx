import type { CSSProperties } from 'react';
import { Bezel } from './Bezel';
import { StepMark } from './StepMark';
import type { AgentStatus } from './types';

const WORDS: Record<AgentStatus, string> = {
  idle: 'Ready',
  running: 'Working',
  complete: 'Complete',
  failed: 'Task failed',
};

interface AgentSpinnerProps {
  status: AgentStatus;
  /** Replace any of the words: Ready, Working, Complete, Task failed. */
  words?: Partial<Record<AgentStatus, string>>;
}

/** Activity, without detail: a bezel sweep and one word that shimmers letter by letter. */
export function AgentSpinner({ status, words }: AgentSpinnerProps) {
  const word = words?.[status] ?? WORDS[status];
  const settled = status === 'complete' || status === 'failed';

  return (
    <div className="agent-spinner" data-status={status}>
      <span className="agent-spinner__dial">
        <span className="agent-spinner__bezel">
          <Bezel />
        </span>
        <span className="agent-spinner__mark">
          <StepMark state={status === 'failed' ? 'failed' : settled ? 'done' : 'pending'} />
        </span>
      </span>
      <p className="agent-spinner__word" aria-label={word} key={status}>
        {[...word].map((letter, index) => (
          <span key={index} style={{ '--i': index } as CSSProperties}>
            {letter === ' ' ? ' ' : letter}
          </span>
        ))}
        {status === 'running' && <span className="agent-spinner__dots">…</span>}
      </p>
    </div>
  );
}
