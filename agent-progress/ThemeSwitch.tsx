import type { ButtonHTMLAttributes } from 'react';
import type { AgentTheme } from './types';

const SUN_RAYS = Array.from({ length: 8 }, (_, index) => index * 45);

function Moon() {
  return (
    <svg className="agent-theme__glyph" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M16.6 12.4A7 7 0 0 1 7.6 3.4a7 7 0 1 0 9 9Z" />
    </svg>
  );
}

function Sun() {
  return (
    <svg className="agent-theme__glyph" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="3.3" />
      {SUN_RAYS.map((angle) => (
        <path key={angle} d="M10 2.2v1.9" transform={`rotate(${angle} 10 10)`} />
      ))}
    </svg>
  );
}

interface ThemeSwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> {
  theme: AgentTheme;
  onThemeChange: (theme: AgentTheme) => void;
}

/** A switch between the dark and light themes. Hold the theme in your app and pass it to AgentUI. */
export function ThemeSwitch({ theme, onThemeChange, className, onClick, ...rest }: ThemeSwitchProps) {
  return (
    <button
      aria-label="Light theme"
      {...rest}
      type="button"
      role="switch"
      aria-checked={theme === 'light'}
      className={className ? `agent-theme ${className}` : 'agent-theme'}
      data-value={theme}
      onClick={(event) => {
        onClick?.(event);
        onThemeChange(theme === 'light' ? 'dark' : 'light');
      }}
    >
      <span className="agent-theme__rest agent-theme__rest--dark">
        <Moon />
      </span>
      <span className="agent-theme__rest agent-theme__rest--light">
        <Sun />
      </span>
      <span className="agent-theme__thumb">
        <span className="agent-theme__face agent-theme__face--dark">
          <Moon />
        </span>
        <span className="agent-theme__face agent-theme__face--light">
          <Sun />
        </span>
      </span>
    </button>
  );
}
