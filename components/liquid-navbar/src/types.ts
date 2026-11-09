import type { CSSProperties, ElementType, ReactNode } from 'react';

export interface PendantLink {
  id: string;
  label: string;
  /** A short line under the label. */
  detail?: string;
  href?: string;
}

export interface PendantItem {
  id: string;
  label: string;
  href?: string;
  /** Drawn on the phone bar. Give it a 24 by 24 SVG that uses currentColor. */
  icon?: ReactNode;
  disabled?: boolean;
  /** Links that pour out as a panel on desktop and a sheet on a phone. */
  links?: PendantLink[];
}

export interface PendantAction {
  label: string;
  href?: string;
  onSelect?: () => void;
}

/** The two themes: the dark one is a storm, the light one is a clear sunny day. */
export type PendantWeather = 'storm' | 'clear';

export interface PendantProps {
  items: PendantItem[];
  /** Controls the current page. Leave it out and use defaultActiveId to let the nav track it. */
  activeId?: string | null;
  defaultActiveId?: string | null;
  onNavigate?: (itemId: string, linkId?: string) => void;
  brand?: ReactNode;
  brandHref?: string;
  /** Spoken name of the brand link. */
  brandLabel?: string;
  action?: PendantAction;
  /** Mist on the surface that the pointer wipes clear. On by default. */
  fog?: boolean;
  /** Controls the weather. Leave it out and use defaultWeather to let the drop change it. */
  weather?: PendantWeather;
  defaultWeather?: PendantWeather;
  onWeatherChange?: (weather: PendantWeather) => void;
  /** The drop that holds the other weather and switches to it. On by default. */
  weatherToggle?: boolean;
  /** Anything you want standing in the storm, between the rain and the liquid. */
  children?: ReactNode;
  /** Below this width in pixels the tabs sit in the water at the foot of the banner. */
  breakpoint?: number;
  /** Accessible name of the navigation landmark. */
  label?: string;
  /** Render links with your router, for example next/link. */
  linkAs?: ElementType;
  className?: string;
  style?: CSSProperties;
}
