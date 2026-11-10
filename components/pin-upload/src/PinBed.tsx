'use client';

import {
  Fragment,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { Bed } from './bed';
import { RASTER_W, couldBeVideo, isVideoFile, readDataRate, readPoster, terrainPicture, type Picture } from './picture';
import { Uploader, formatBytes, formatLeft, middleTruncate, type UploadPartFn } from './upload';
import { Transport } from './Transport';
import { MiniBed } from './MiniBed';
import './pinbed.css';

export type PinBedTheme = 'chalk' | 'steel';

export interface PinBedProps {
  /** Sends one part of the file. The only thing the kit needs from your backend. */
  uploadPart: UploadPartFn;
  theme?: PinBedTheme;
  /** What sits behind the plate, so the words and buttons can match. */
  page?: 'light' | 'dark';
  workers?: number;
  /** Bytes per part, fixed or worked out for each file. */
  partSize?: number | ((file: File) => number | undefined);
  /** Where a file can be played from. Defaults to the file on the person's own disk. */
  videoFor?: (file: File) => string | null;
  /** The link that "Copy link" copies. Leave it out and that button is not shown. */
  linkFor?: (file: File) => string;
  /** Replace the clock, for tests and demos that compress time. */
  now?: (file: File) => number;
  /** The most pixels the plate may draw. Lower it for slow devices. */
  maxPixels?: number;
  /** While a file sends, the tab's title shows the time left, then "Ready". False leaves your title alone. */
  tabTitle?: boolean;
  /** Extra controls next to "Choose a file" while the plate is empty. */
  idleActions?: ReactNode;
  onDone?: (file: File) => void;
  className?: string;
  style?: CSSProperties;
}

export interface PinBedHandle {
  add(files: File[], options?: { remember?: boolean }): void;
  reset(): void;
}

type Status = 'reading' | 'queued' | 'sending' | 'finishing' | 'done' | 'cancelled';

interface Job {
  id: number;
  file: File;
  status: Status;
  picture: Picture | null;
  uploader: Uploader | null;
  videoUrl: string | null;
  ownsUrl: boolean;
  remember: boolean;
}

const RESUME_KEY = 'pinbed:resume';

interface ResumeNote {
  name: string;
  size: number;
  lastModified: number;
  safe: number;
  tone: string;
  w: number;
  h: number;
  aspect: number;
  fill: string;
}

function encode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
}

function decode(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** A file name that may wrap after its separators, so a narrow column never strands one letter on a line. */
function wrappable(name: string): ReactNode {
  return name.split(/([_\- ])/).map((piece, i) => (i % 2 ? <Fragment key={i}>{piece}<wbr /></Fragment> : piece));
}

/** Parks a video on the frame the pins are showing, ready to carry on from there. */
function cue(video: HTMLVideoElement | null, at: number): void {
  if (!video || at <= 0) return;
  if (video.readyState >= 1) video.currentTime = at;
  else video.addEventListener('loadedmetadata', () => (video.currentTime = at), { once: true });
}

/** Walks a dropped folder, because a camera card arrives as a folder. */
async function filesFrom(items: DataTransferItemList): Promise<File[]> {
  const entries: FileSystemEntry[] = [];
  const loose: File[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
    else {
      const f = item.getAsFile();
      if (f) loose.push(f);
    }
  }
  const out = [...loose];
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      const f = await new Promise<File | null>((res) => (entry as FileSystemFileEntry).file(res, () => res(null)));
      if (f) out.push(f);
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res) => reader.readEntries(res, () => res([])));
      if (!batch.length) break;
      await Promise.all(batch.map(walk));
    }
  };
  await Promise.all(entries.map(walk));
  return out;
}

export const PinBed = forwardRef<PinBedHandle, PinBedProps>(function PinBed(props, ref) {
  const { theme = 'chalk', page = theme === 'steel' ? 'dark' : 'light', linkFor, idleActions, className, style } = props;

  const rootRef = useRef<HTMLDivElement>(null);
  const plateRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const bedRef = useRef<Bed | null>(null);
  const jobsRef = useRef<Job[]>([]);
  const selectedRef = useRef<Job | null>(null);
  const nextId = useRef(1);
  const actionsRef = useRef<HTMLDivElement>(null);
  const refocus = useRef(false);
  const dragDepth = useRef(0);
  const fillBuffer = useRef(new Float32Array(1));
  const lastSaved = useRef(0);
  const lastPress = useRef<{ x: number; y: number; at: number } | null>(null);
  const ownTitle = useRef<string | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  const [, render] = useReducer((n: number) => n + 1, 0);
  const [carrying, setCarrying] = useState<'none' | 'over' | 'refused'>('none');
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [left, setLeft] = useState('');
  const [copied, setCopied] = useState(false);
  const [resume, setResume] = useState<ResumeNote | null>(null);
  const [opened, setOpened] = useState(false);

  const job = selectedRef.current;
  const up = job?.uploader ?? null;

  // The tab is borrowed while a file is on the plate, so the time left can be read from another
  // tab. The page's own title is kept and put back when the plate is cleared.
  const setTab = useCallback((text: string | null) => {
    if (propsRef.current.tabTitle === false) return;
    if (text === null) {
      if (ownTitle.current !== null) document.title = ownTitle.current;
      ownTitle.current = null;
      return;
    }
    if (ownTitle.current === null) ownTitle.current = document.title;
    document.title = text;
  }, []);

  const refreshLeft = useCallback(() => {
    const u = selectedRef.current?.uploader;
    if (!u) return;
    const text = formatLeft(u.secondsLeft());
    setLeft(text);
    if (u.phase === 'sending') setTab(text);
  }, [setTab]);

  const syncFill = useCallback(() => {
    const bed = bedRef.current;
    const j = selectedRef.current;
    if (!bed) return;
    const f = bed.field;
    if (j?.uploader) {
      if (fillBuffer.current.length !== f.cols) fillBuffer.current = new Float32Array(f.cols);
      j.uploader.columns(fillBuffer.current);
      f.fill.set(fillBuffer.current);
      bed.wake();
    }
  }, []);

  const saveResume = useCallback((j: Job) => {
    if (!j.remember || !j.uploader || !j.picture) return;
    const t = performance.now();
    if (t - lastSaved.current < 1500) return;
    lastSaved.current = t;
    try {
      const bed = bedRef.current;
      if (!bed) return;
      const tone = new Uint8Array(j.picture.tone.length);
      for (let k = 0; k < tone.length; k++) tone[k] = Math.round(Math.max(0, j.picture.tone[k]) * 255);
      const fill = new Uint8Array(bed.field.cols);
      for (let c = 0; c < fill.length; c++) fill[c] = Math.round(bed.field.fill[c] * 255);
      const note: ResumeNote = {
        name: j.file.name,
        size: j.file.size,
        lastModified: j.file.lastModified,
        safe: j.uploader.bytesSafe,
        tone: encode(tone),
        w: j.picture.w,
        h: j.picture.h,
        aspect: j.picture.aspect,
        fill: encode(fill),
      };
      localStorage.setItem(RESUME_KEY, JSON.stringify(note));
    } catch {
      /* storage full or unavailable: resuming is a bonus */
    }
  }, []);

  const pump = useCallback(() => {
    const active = jobsRef.current.find((j) => j.status === 'sending');
    if (active) return;
    const next = jobsRef.current.find((j) => j.status === 'queued');
    if (!next?.uploader) return;
    next.status = 'sending';
    next.uploader.start();
    render();
  }, []);

  const finishJob = useCallback(
    (j: Job) => {
      const bed = bedRef.current;
      if (!bed || !j.uploader) return;
      try {
        localStorage.removeItem(RESUME_KEY);
      } catch {
        /* nothing saved */
      }
      j.status = 'finishing';
      // nothing is left to discard, so a question still open about this file goes too
      if (selectedRef.current === j) setConfirming(false);
      render();
      const complete = () => {
        j.status = 'done';
        setTab('Ready');
        propsRef.current.onDone?.(j.file);
        render();
        pump();
      };
      if (selectedRef.current !== j) {
        complete();
        return;
      }
      syncFill();
      const column = j.uploader.columnOf(Math.max(j.uploader.lastPart, 0), bed.columns());
      bed.onFinished = () => {
        if (!j.picture?.terrain) setOpened(true);
        complete();
      };
      window.setTimeout(() => bed.finish(column, j.picture?.terrain ? null : videoRef.current), 40);
    },
    [pump, setTab, syncFill],
  );

  const startUpload = useCallback(
    (j: Job) => {
      const p = propsRef.current;
      j.uploader = new Uploader(j.file, (part, signal, onBytes) => p.uploadPart(part, signal, onBytes), {
        workers: p.workers,
        partSize: typeof p.partSize === 'function' ? p.partSize(j.file) : p.partSize,
        now: p.now ? () => (p.now as (file: File) => number)(j.file) : undefined,
        persist: j.remember,
        onChange: () => {
          if (selectedRef.current === j) syncFill();
          if (j.uploader?.phase === 'done' && j.status === 'sending') finishJob(j);
          else render();
        },
        onLanded: () => {
          if (selectedRef.current === j) saveResume(j);
        },
      });
      j.status = 'queued';
      pump();
      if (selectedRef.current === j) syncFill();
      render();
    },
    [finishJob, pump, saveResume, syncFill],
  );

  const select = useCallback(
    (j: Job) => {
      const bed = bedRef.current;
      selectedRef.current = j;
      setOpened(false);
      setConfirming(false);
      if (!bed) return;
      bed.clear();
      bed.setPicture(j.picture);
      const v = videoRef.current;
      if (v && j.videoUrl && v.getAttribute('src') !== j.videoUrl) {
        v.src = j.videoUrl;
        v.load();
        if (j.picture) cue(v, j.picture.at);
      }
      syncFill();
      render();
    },
    [syncFill],
  );

  const addFiles = useCallback(
    async (files: File[], options?: { remember?: boolean; at?: [number, number] }) => {
      const videos = files.filter(isVideoFile);
      if (!videos.length) {
        setNote('Only video files');
        window.setTimeout(() => setNote(''), 1800);
        return;
      }
      setResume(null);
      const bed = bedRef.current;
      for (const file of videos) {
        const url = propsRef.current.videoFor?.(file) ?? null;
        const j: Job = {
          id: nextId.current++,
          file,
          status: 'reading',
          picture: null,
          uploader: null,
          videoUrl: url ?? URL.createObjectURL(file),
          ownsUrl: !url,
          remember: options?.remember ?? true,
        };
        jobsRef.current.push(j);
        const first = !selectedRef.current || selectedRef.current.status === 'cancelled' || selectedRef.current.status === 'done';
        if (first) {
          selectedRef.current = j;
          setOpened(false);
          if (bed) {
            bed.clear();
            const v = videoRef.current;
            if (v && j.videoUrl) {
              v.src = j.videoUrl;
              v.load();
            }
            const rect = plateRef.current?.getBoundingClientRect();
            const [x, y] = options?.at ?? (rect ? [rect.left + rect.width / 2, rect.top + rect.height / 2] : [0, 0]);
            bed.impact(x, y, file.size);
            bed.ridge(true);
          }
        }
        render();
        let picture: Picture;
        try {
          picture = await readPoster(j.videoUrl as string);
        } catch {
          picture = terrainPicture(await readDataRate(file, RASTER_W));
          j.videoUrl = null;
        }
        j.picture = picture;
        if (selectedRef.current === j && bed) {
          bed.ridge(false);
          bed.setPicture(picture);
          cue(videoRef.current, picture.at);
        }
        startUpload(j);
      }
    },
    [startUpload],
  );

  const reset = useCallback(() => {
    for (const j of jobsRef.current) {
      if (j.uploader && j.uploader.phase !== 'done') j.uploader.cancel();
      if (j.ownsUrl && j.videoUrl) URL.revokeObjectURL(j.videoUrl);
    }
    jobsRef.current = [];
    selectedRef.current = null;
    setOpened(false);
    setConfirming(false);
    setNote('');
    setLeft('');
    setResume(null);
    try {
      localStorage.removeItem(RESUME_KEY);
    } catch {
      /* nothing saved */
    }
    const v = videoRef.current;
    if (v) {
      v.pause();
      v.removeAttribute('src');
      v.load();
    }
    bedRef.current?.clear();
    setTab(null);
    render();
  }, [setTab]);

  useImperativeHandle(ref, () => ({ add: (files, options) => void addFiles(files, options), reset }), [addFiles, reset]);

  // the bed, once
  useEffect(() => {
    const plate = plateRef.current;
    const canvas = canvasRef.current;
    if (!plate || !canvas) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const bed = new Bed(plate, canvas, reduced, propsRef.current.maxPixels);
    bedRef.current = bed;
    bed.setDark(propsRef.current.theme === 'steel');
    const ro = new ResizeObserver(() => {
      bed.measure();
      syncFill();
    });
    ro.observe(plate);
    bed.wake();

    try {
      const raw = localStorage.getItem(RESUME_KEY);
      if (raw) {
        const n = JSON.parse(raw) as ResumeNote;
        const toneBytes = decode(n.tone);
        const tone = new Float32Array(toneBytes.length);
        for (let k = 0; k < tone.length; k++) tone[k] = toneBytes[k] / 255;
        bed.setPicture({ tone, rgb: new Uint8Array(tone.length * 3), w: n.w, h: n.h, aspect: n.aspect, levels: [0, 1], terrain: false, at: 0 });
        const fill = decode(n.fill);
        const f = bed.field;
        for (let c = 0; c < f.cols; c++) f.fill[c] = fill[Math.min(fill.length - 1, Math.floor((c / f.cols) * fill.length))] / 255;
        bed.wake();
        setResume(n);
      }
    } catch {
      /* a damaged note just means an empty plate */
    }

    return () => {
      ro.disconnect();
      bed.destroy();
      bedRef.current = null;
      setTab(null);
    };
  }, [setTab, syncFill]);

  // A change of material starts where the person asked for it and crosses the plate from there.
  useEffect(() => {
    const press = (e: PointerEvent) => {
      lastPress.current = { x: e.clientX, y: e.clientY, at: performance.now() };
    };
    window.addEventListener('pointerdown', press, true);
    return () => window.removeEventListener('pointerdown', press, true);
  }, []);

  useEffect(() => {
    const bed = bedRef.current;
    if (!bed) return;
    const press = lastPress.current;
    let from: [number, number] | undefined;
    if (press && performance.now() - press.at < 1500) {
      from = [press.x, press.y];
    } else if (document.activeElement && document.activeElement !== document.body) {
      const r = document.activeElement.getBoundingClientRect();
      from = [r.left + r.width / 2, r.top + r.height / 2];
    }
    bed.setDark(theme === 'steel', from);
    bed.readPalette();
  }, [theme]);

  // Buttons swap as the state changes. Keep a keyboard user's place when they do.
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    if (document.activeElement === document.body) actionsRef.current?.querySelector('button')?.focus();
  });

  // time left, on a calm one second cadence
  useEffect(() => {
    if (up?.phase !== 'sending') return;
    refreshLeft();
    const t = window.setInterval(refreshLeft, 1000);
    return () => window.clearInterval(t);
  }, [up, up?.phase, refreshLeft]);

  // a file anywhere in the window stirs the plate once
  useEffect(() => {
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current++;
      if (dragDepth.current === 1) bedRef.current?.carry('window', e.clientX, e.clientY);
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) {
        bedRef.current?.carry('none');
        setCarrying('none');
      }
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      bedRef.current?.carry('none');
      setCarrying('none');
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, []);

  const pickable = !opened && job?.status !== 'finishing';

  const onDragOver = (e: ReactDragEvent) => {
    e.preventDefault();
    let ok = true;
    const items = e.dataTransfer?.items;
    if (items?.length) {
      ok = false;
      for (let i = 0; i < items.length; i++) if (items[i].kind === 'file' && couldBeVideo(items[i].type)) ok = true;
    }
    const state = ok ? 'over' : 'refused';
    bedRef.current?.carry(state, e.clientX, e.clientY);
    setCarrying(state);
    if (e.dataTransfer) e.dataTransfer.dropEffect = ok ? 'copy' : 'none';
  };

  const onDragLeave = (e: ReactDragEvent) => {
    const related = e.relatedTarget as Node | null;
    if (related && plateRef.current?.contains(related)) return;
    bedRef.current?.carry('window', e.clientX, e.clientY);
    setCarrying('none');
  };

  const onDrop = (e: ReactDragEvent) => {
    e.preventDefault();
    const point: [number, number] = [e.clientX, e.clientY];
    const items = e.dataTransfer?.items;
    if (items?.length) void filesFrom(items).then((files) => addFiles(files, { at: point }));
    else if (e.dataTransfer?.files.length) void addFiles(Array.from(e.dataTransfer.files), { at: point });
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    if (opened) return;
    bedRef.current?.pointer(e.clientX, e.clientY, true);
  };
  const onPointerLeave = () => {
    const bed = bedRef.current;
    if (!bed) return;
    bed.field.setPointer(bed.field.pointerX, bed.field.pointerY, false);
    bed.wake();
  };
  const onPointerDown = (e: ReactPointerEvent) => {
    if (opened) return;
    bedRef.current?.pointer(e.clientX, e.clientY, true);
    bedRef.current?.press(true);
  };
  const onPointerUp = () => {
    bedRef.current?.press(false);
    bedRef.current?.wake();
  };

  const openPicker = () => {
    if (pickable) inputRef.current?.click();
  };

  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openPicker();
    }
  };

  const hoverCancel = (on: boolean) => bedRef.current?.sag(on ? 0.06 : 0);

  const askCancel = () => {
    setConfirming(true);
    bedRef.current?.sag(0);
  };

  const keepSending = () => {
    setConfirming(false);
    if (up?.phase === 'paused') up.resume();
  };

  const discard = () => {
    const j = selectedRef.current;
    const bed = bedRef.current;
    if (!j?.uploader || !bed) return;
    const b = cancelRef.current?.getBoundingClientRect();
    if (b) bed.collapse(b.left + b.width / 2, b.top);
    j.uploader.cancel();
    j.status = 'cancelled';
    setConfirming(false);
    try {
      localStorage.removeItem(RESUME_KEY);
    } catch {
      /* nothing saved */
    }
    window.setTimeout(() => {
      if (selectedRef.current !== j) return;
      selectedRef.current = null;
      bed.clear();
      setTab(null);
      render();
      pump();
    }, 1150);
    render();
  };

  const sendAnother = () => {
    selectedRef.current = null;
    setOpened(false);
    const v = videoRef.current;
    if (v) {
      v.pause();
      v.removeAttribute('src');
      v.load();
    }
    bedRef.current?.clear();
    setTab(null);
    render();
    pump();
  };

  const copyLink = () => {
    const j = selectedRef.current;
    if (!j || !linkFor) return;
    void navigator.clipboard?.writeText(linkFor(j.file)).catch(() => undefined);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  // what the words say
  const safe = up ? formatBytes(up.bytesSafe) : '';
  let line = 'Drop a video';
  let detail: ReactNode = null;
  let state = 'idle';
  const name = job ? middleTruncate(job.file.name, 46) : '';

  if (carrying === 'over') {
    line = 'Let go to start';
    state = 'carry';
  } else if (carrying === 'refused' || note) {
    line = note || 'Only video files';
    state = 'refused';
  } else if (job) {
    if (job.status === 'reading') {
      line = 'Reading your film';
      state = 'reading';
    } else if (job.status === 'cancelled') {
      line = 'Discarded';
      state = 'cancelled';
    } else if (job.status === 'finishing') {
      line = 'Putting it together';
      state = 'finishing';
    } else if (job.status === 'done') {
      line = 'Ready';
      state = 'done';
    } else if (confirming) {
      line = `Discard ${safe}?`;
      state = 'confirm';
    } else if (up?.phase === 'paused') {
      line = 'Paused';
      state = 'paused';
    } else if (up?.phase === 'failed') {
      line = 'Sending stopped';
      state = 'failed';
    } else if (up?.phase === 'offline') {
      line = 'Connection lost';
      state = 'offline';
    } else {
      line = left || 'Working out the time left';
      state = 'sending';
    }
    const size = formatBytes(job.file.size);
    if (up?.phase === 'paused') detail = <span>{safe} is safe. {wrappable(name)}</span>;
    else if (up?.phase === 'failed') detail = <span>{safe} is safe. The server keeps refusing the next part.</span>;
    else if (up?.phase === 'offline') detail = <span>{safe} is safe. Trying again in {up.retryIn} s</span>;
    else detail = <><span className="pinbed-name" title={job.file.name}>{wrappable(name)}</span><span className="pinbed-size">{size}</span></>;
  } else if (resume) {
    line = 'Drop the same file to carry on';
    detail = <span>{formatBytes(resume.safe)} is safe. {wrappable(middleTruncate(resume.name, 46))}</span>;
    state = 'resume';
  }

  useEffect(() => {
    if (state === 'failed') setTab(line);
  }, [state, line, setTab]);

  const queue = jobsRef.current.filter((j) => j.status !== 'cancelled');
  const others = queue.length > 1;

  return (
    <div
      ref={rootRef}
      className={`pinbed${className ? ` ${className}` : ''}`}
      style={style}
      data-theme={theme}
      data-page={page}
      data-state={state}
      data-opened={opened || undefined}
    >
      <div
        ref={plateRef}
        className="pinbed-plate"
        role="button"
        tabIndex={opened ? -1 : 0}
        aria-label={job ? 'Add another video' : 'Choose a video to upload'}
        onClick={openPicker}
        onKeyDown={onKey}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <video ref={videoRef} className="pinbed-video" muted playsInline loop preload="auto" />
        <canvas ref={canvasRef} className="pinbed-canvas" aria-hidden="true" />
      </div>

      {opened && <Transport video={videoRef} />}

      <div className="pinbed-deck">
        <div className="pinbed-words">
          <p className="pinbed-line" role="status" aria-live="polite">{line}</p>
          <p className="pinbed-detail">{detail}</p>
        </div>
        <div
          ref={actionsRef}
          className="pinbed-actions"
          onClick={(e) => {
            if (e.detail === 0) refocus.current = true;
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && confirming) {
              refocus.current = true;
              setConfirming(false);
            }
          }}
        >
          {state === 'idle' || state === 'resume' || state === 'carry' || state === 'refused' ? (
            !job && (
              <>
                {idleActions}
                <button type="button" className="pinbed-button pinbed-button--lead" onClick={() => inputRef.current?.click()}>
                  Choose a file
                </button>
              </>
            )
          ) : null}
          {state === 'sending' || state === 'offline' ? (
            <>
              <button type="button" className="pinbed-button" onClick={() => up?.pause()}>Pause</button>
              <button
                ref={cancelRef}
                type="button"
                className="pinbed-button"
                onPointerEnter={() => hoverCancel(true)}
                onPointerLeave={() => hoverCancel(false)}
                onFocus={() => hoverCancel(true)}
                onBlur={() => hoverCancel(false)}
                onClick={askCancel}
              >
                Cancel
              </button>
            </>
          ) : null}
          {state === 'failed' ? (
            <>
              <button type="button" className="pinbed-button pinbed-button--lead" onClick={() => up?.retry()}>Try again</button>
              <button
                ref={cancelRef}
                type="button"
                className="pinbed-button"
                onPointerEnter={() => hoverCancel(true)}
                onPointerLeave={() => hoverCancel(false)}
                onClick={askCancel}
              >
                Cancel
              </button>
            </>
          ) : null}
          {state === 'paused' ? (
            <>
              <button type="button" className="pinbed-button pinbed-button--lead" onClick={() => up?.resume()}>Keep sending</button>
              <button
                ref={cancelRef}
                type="button"
                className="pinbed-button"
                onPointerEnter={() => hoverCancel(true)}
                onPointerLeave={() => hoverCancel(false)}
                onClick={askCancel}
              >
                Cancel
              </button>
            </>
          ) : null}
          {state === 'confirm' ? (
            <>
              <button type="button" className="pinbed-button" onClick={keepSending}>{up?.phase === 'failed' ? 'Go back' : 'Keep sending'}</button>
              <button ref={cancelRef} type="button" className="pinbed-button pinbed-button--danger" onClick={discard}>Discard</button>
            </>
          ) : null}
          {state === 'done' ? (
            <>
              <button type="button" className="pinbed-button" onClick={sendAnother}>Send another</button>
              {linkFor && (
                <button type="button" className="pinbed-button pinbed-button--lead" onClick={copyLink}>{copied ? 'Link copied' : 'Copy link'}</button>
              )}
            </>
          ) : null}
        </div>
      </div>

      {others && (
        <ul className="pinbed-queue">
          {queue.map((j) => (
            <li key={j.id}>
              <button
                type="button"
                className="pinbed-row"
                aria-current={j === job || undefined}
                onClick={() => j !== job && select(j)}
              >
                <MiniBed picture={j.picture} uploader={j.uploader} />
                <span className="pinbed-rowname">{wrappable(middleTruncate(j.file.name, 40))}</span>
                <span className="pinbed-rowstate">
                  {j.status === 'done' ? 'Ready' : j.status === 'queued' ? 'Waiting' : j.status === 'reading' ? 'Reading' : j.uploader ? `${formatBytes(j.uploader.bytesSafe)} safe` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <input
        ref={inputRef}
        className="pinbed-input"
        type="file"
        accept="video/*,.mxf,.braw,.r3d,.mkv"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          if (e.target.files?.length) void addFiles(Array.from(e.target.files));
          e.target.value = '';
        }}
      />
    </div>
  );
});
