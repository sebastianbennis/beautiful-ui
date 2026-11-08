import type { CSSProperties } from 'react';
import { StepMark } from './StepMark';
import type { AgentEvent, AgentStatus } from './types';

const MS_PER_TICK = 62;
const REACH_MS = 300;

/** How tall an event's burst stands on the tape, 0 to 1. */
function energy(event: AgentEvent): number {
  if (event.kind === 'fail' || event.kind === 'error') return 1;
  if (event.kind === 'done') return 0.86;
  const added = /\+(\d+)/.exec(event.text);
  if (added) return Math.min(1, 0.42 + Number(added[1]) / 62);
  if (event.kind === 'pass') return 0.5;
  if (event.kind === 'stage') return 0.62;
  return 0.3;
}

/** A tape of hairlines: each burst is one thing the agent did, newest on the right. */
function EventTape({ now, events, ticks }: { now: number; events: readonly AgentEvent[]; ticks: number }) {
  return (
    <div className="agent-tape" aria-hidden="true">
      {Array.from({ length: ticks }, (_, index) => {
        const age = (ticks - 1 - index) * MS_PER_TICK;
        const moment = now - age;
        let height = 0.05 + 0.035 * (Math.sin(moment * 0.021) + Math.sin(moment * 0.0083 + index));
        let failing = false;
        if (moment >= 0) {
          for (const event of events) {
            const distance = (moment - event.at) / REACH_MS;
            if (distance < -1 || distance > 1) continue;
            const ripple = 0.72 + 0.28 * Math.sin(moment * 0.05 + index * 1.7);
            const lift = energy(event) * Math.exp(-(distance * distance) * 4.2) * ripple;
            if (lift > height) {
              height = lift;
              failing = event.kind === 'fail' || event.kind === 'error';
            }
          }
        } else {
          height = 0.04;
        }
        const scale = Math.min(Math.max(height, 0.04), 1);
        return (
          <i
            key={index}
            data-failing={failing}
            style={{ transform: `scaleY(${scale.toFixed(3)})`, opacity: 0.32 + 0.68 * (index / (ticks - 1)) ** 1.4 } as CSSProperties}
          />
        );
      })}
      <span className="agent-tape__head" />
    </div>
  );
}

function RowText({ text }: { text: string }) {
  const diff = /^(.*) (\+\d+) (-\d+)$/.exec(text);
  if (!diff) return <>{text}</>;
  return (
    <>
      {diff[1]} <b className="agent-log__add">{diff[2]}</b> <b className="agent-log__del">{diff[3]}</b>
    </>
  );
}

function rowMark(event: AgentEvent) {
  if (event.kind === 'fail' || event.kind === 'error') return 'failed';
  if (event.kind === 'done' || event.kind === 'pass') return 'done';
  return null;
}

interface AgentActivityProps {
  status: AgentStatus;
  /** Every event so far, oldest first. */
  events: readonly AgentEvent[];
  /** Milliseconds since the run started. useRunClock gives you this. */
  now: number;
  /** How many log rows stay visible. */
  rows?: number;
  ticks?: number;
}

/** Detailed events as they happen: a live tape above a readable log. */
export function AgentActivity({ status, events, now, rows = 8, ticks = 110 }: AgentActivityProps) {
  return (
    <div className="agent-activity" data-status={status}>
      <EventTape now={now} events={events} ticks={ticks} />
      <ol className="agent-log" data-parity={events.length % 2} style={{ '--rows': rows } as CSSProperties}>
        {events.slice(-rows).map((event) => {
          const mark = rowMark(event);
          return (
            <li key={`${event.at}-${event.kind}`} className="agent-log__row" data-kind={event.kind}>
              <span className="agent-log__glyph">{mark ? <StepMark state={mark} /> : <span className="agent-log__pip" />}</span>
              <span className="agent-log__text">
                <RowText text={event.text} />
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
