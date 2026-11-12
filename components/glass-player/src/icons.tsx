// One 24 grid, filled shapes, 1.5 corner rounding throughout.
const paths = {
  play: 'M8.2 5.3c0-1.1 1.2-1.8 2.2-1.2l9.6 5.9c.9.6.9 1.9 0 2.5l-9.6 5.9c-1 .6-2.2-.1-2.2-1.2V5.3z',
  pause:
    'M7 5.5C7 4.7 7.7 4 8.5 4h1c.8 0 1.5.7 1.5 1.5v13c0 .8-.7 1.5-1.5 1.5h-1C7.7 20 7 19.3 7 18.5v-13zM13 5.5c0-.8.7-1.5 1.5-1.5h1c.8 0 1.5.7 1.5 1.5v13c0 .8-.7 1.5-1.5 1.5h-1c-.8 0-1.5-.7-1.5-1.5v-13z',
  stop: 'M6 7.5C6 6.7 6.7 6 7.5 6h9c.8 0 1.5.7 1.5 1.5v9c0 .8-.7 1.5-1.5 1.5h-9C6.7 18 6 17.3 6 16.5v-9z',
  forward:
    'M4 6.6c0-1.1 1.2-1.8 2.1-1.2l8 5.4c.9.6.9 1.8 0 2.4l-8 5.4c-.9.6-2.1-.1-2.1-1.2V6.6zM16.5 6.25c0-.7.56-1.25 1.25-1.25h1c.69 0 1.25.56 1.25 1.25v11.5c0 .69-.56 1.25-1.25 1.25h-1c-.69 0-1.25-.56-1.25-1.25V6.25z',
};

export type GlassHeadIconName = 'play' | 'pause' | 'stop' | 'back' | 'forward';

export function GlassHeadIcon({ name }: { name: GlassHeadIconName }) {
  const d = name === 'back' ? paths.forward : paths[name];
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={d} transform={name === 'back' ? 'translate(24 0) scale(-1 1)' : name === 'play' ? 'translate(-1 0)' : undefined} />
    </svg>
  );
}
