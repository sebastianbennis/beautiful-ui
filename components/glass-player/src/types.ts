export type GlassHeadTrack = {
  /** Audio file. Leave it out and the player runs silently on its own clock. */
  src?: string;
  title: string;
  artist?: string;
  /** Length in seconds. */
  duration: number;
  /** Any CSS colour. The ribbon and the lit key take it. */
  tint?: string;
  /** Loudness over time, 0 to 1, any length. Measured from the file when missing. */
  peaks?: number[];
};

export type GlassHeadState = 'stopped' | 'playing' | 'paused';

export type GlassHeadHandle = {
  play(): void;
  pause(): void;
  stop(): void;
  back(): void;
  forward(): void;
  /** Jump to a track by its place in the list. */
  select(index: number): void;
  /** Move to a time in the current track, in seconds. */
  seek(seconds: number): void;
};

export type GlassHeadProps = {
  tracks: GlassHeadTrack[];
  /** Follows the system when left out. */
  theme?: 'light' | 'dark';
  /** Seconds of music visible across the window. */
  span?: number;
  /** '2d' skips WebGL and draws the plain canvas version. */
  renderer?: 'auto' | '2d';
  /** Dragging the ribbon plays the music under the lens, at the speed and in the direction of the hand. On unless set to false. */
  scrubSound?: boolean;
  label?: string;
  className?: string;
  onStateChange?(state: GlassHeadState): void;
  onTrackChange?(index: number): void;
};
