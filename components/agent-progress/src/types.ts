export type AgentStatus = 'idle' | 'running' | 'complete' | 'failed';
export type AgentStepState = 'pending' | 'current' | 'done' | 'failed';
export type AgentTheme = 'dark' | 'light';

export interface AgentStep {
  id: string;
  label: string;
  state: AgentStepState;
  /** Short text at the end of the row: a duration, a live timer, a failure reason. */
  note?: string;
  /** True for a step added after the run began. It animates in. */
  added?: boolean;
}

export type AgentEventKind = 'stage' | 'info' | 'pass' | 'fail' | 'error' | 'done';

export interface AgentEvent {
  /** Milliseconds since the run started. */
  at: number;
  kind: AgentEventKind;
  /** A trailing "+24 -9" is coloured as a diff. */
  text: string;
}
