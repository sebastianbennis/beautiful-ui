/** Decodes an audio file and measures its loudness over time, 0 to 1. */
export async function measurePeaks(src: string, count = 2048, signal?: AbortSignal): Promise<number[]> {
  const res = await fetch(src, { signal });
  if (!res.ok) throw new Error(`Could not load ${src}`);
  const data = await res.arrayBuffer();
  const Offline: typeof OfflineAudioContext =
    window.OfflineAudioContext ?? (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  const audio = await new Offline(1, 2, 44100).decodeAudioData(data);
  const samples = audio.getChannelData(0);
  const size = samples.length / count;
  const raw: number[] = [];
  let max = 1e-6;
  for (let k = 0; k < count; k++) {
    const a = Math.floor(k * size);
    const b = Math.max(a + 1, Math.floor((k + 1) * size));
    let sum = 0;
    let top = 0;
    for (let i = a; i < b; i++) {
      sum += samples[i] * samples[i];
      top = Math.max(top, Math.abs(samples[i]));
    }
    const v = 0.5 * Math.sqrt(sum / (b - a)) + 0.5 * top;
    raw.push(v);
    if (v > max) max = v;
  }
  return raw.map((v) => v / max);
}
