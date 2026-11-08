import type { CSSProperties, HTMLAttributes } from 'react';
import type { AgentTheme } from './types';
import './agent.css';

interface AgentUIProps extends HTMLAttributes<HTMLDivElement> {
  theme?: AgentTheme;
  /** Multiplies every size in the set. 1 is the full size, 0.6 suits a chat sidebar. */
  scale?: number;
}

/** The root of the set. It carries the theme and the size, so wrap your agent UI in one of these. */
export function AgentUI({ theme = 'dark', scale, className, style, ...rest }: AgentUIProps) {
  const sized = scale === undefined ? style : ({ '--agent-u': `${scale}px`, ...style } as CSSProperties);

  return <div {...rest} className={className ? `agent-ui ${className}` : 'agent-ui'} data-theme={theme} style={sized} />;
}
