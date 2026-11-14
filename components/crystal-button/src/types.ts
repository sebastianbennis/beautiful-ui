import type { ButtonHTMLAttributes, MouseEvent } from 'react';

/** Where the job is. */
export type GenerateStatus = 'idle' | 'working' | 'done' | 'failed';

export interface GenerateLabels {
  /** At rest. */
  idle: string;
  /** While the job runs and cannot be stopped. */
  working: string;
  /** While the job runs and pressing again stops it. */
  stop: string;
  done: string;
  failed: string;
}

export interface GenerateButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'onClick'> {
  /**
   * Called when the button is pressed at rest. Return the job's promise and the button
   * runs itself: working until it settles, then done or failed, then back to rest.
   */
  onGenerate?: (event: MouseEvent<HTMLButtonElement>) => void | Promise<unknown>;
  /** Called when the button is pressed while working. Give this and the working word becomes "Stop". */
  onStop?: () => void;
  /** Set this to drive the button yourself. Leave it out and the button follows `onGenerate`'s promise. */
  status?: GenerateStatus;
  /** From 0 to 1, if your job can say: that share of the cells stays lit. Leave it out and they fill slowly on their own. */
  progress?: number;
  /** The words. Any you leave out keep their default. */
  labels?: Partial<GenerateLabels>;
  /** Follows the system unless set. */
  theme?: 'light' | 'dark';
  /** The same seed always gives the same cells. Left out, it comes from where the button was pressed. */
  seed?: number;
  /** How long done and failed stay up before the button rests again, in ms. Only when the button runs itself. */
  settleMs?: number;
}
