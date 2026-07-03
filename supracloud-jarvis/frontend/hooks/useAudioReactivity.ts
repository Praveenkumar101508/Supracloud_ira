"use client";

/**
 * useAudioReactivity — clean Web Audio API layer for audio-reactive visuals.
 *
 * Two modes:
 *   1. External analyser (preferred): pass the AnalyserNode the voice loop
 *      already owns (VoiceConsole shares its mic analyser through
 *      usePulseStore) and this hook only *reads* from it — no second mic
 *      stream, no extra permission prompt.
 *   2. Own microphone: call `start()` and the hook opens a capture-only
 *      stream + AudioContext, and tears both down on `stop()`/unmount.
 *
 * Consumers get two views of the signal:
 *   - `level` / `bands` — React state, throttled to `updateHz` so component
 *     trees re-render at a sane rate (UI text, Framer Motion values).
 *   - `levelRef` — a mutable ref updated every animation frame, for
 *     per-frame consumers (Three.js useFrame, canvas loops) that must not
 *     re-render React.
 */

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";

export interface AudioBands {
  /** ~20–250 Hz energy, 0..1 */
  bass: number;
  /** ~250 Hz–2 kHz energy (voice fundamentals), 0..1 */
  mid: number;
  /** ~2–8 kHz energy (sibilance / brightness), 0..1 */
  treble: number;
}

export interface UseAudioReactivityOptions {
  /** External analyser to read from (e.g. the voice loop's shared mic node). */
  analyser?: AnalyserNode | null;
  /** FFT size used when the hook opens its own mic. Default 2048. */
  fftSize?: number;
  /** Per-frame smoothing toward a louder value (0..1, higher = snappier). */
  attack?: number;
  /** Per-frame smoothing toward a quieter value (0..1, lower = longer decay). */
  release?: number;
  /** RMS level above which `speaking` flips true. */
  speakingThreshold?: number;
  /** How often React state (`level`, `bands`, `speaking`) refreshes. */
  updateHz?: number;
}

export interface AudioReactivity {
  /** Smoothed loudness 0..1 (React state, throttled). */
  level: number;
  /** Smoothed frequency-band energies (React state, throttled). */
  bands: AudioBands;
  /** True while the smoothed level sits above `speakingThreshold`. */
  speaking: boolean;
  /** Frame-accurate smoothed level for render loops (no re-renders). */
  levelRef: MutableRefObject<number>;
  /** The analyser currently being read — external one, or the hook's own. */
  analyser: AnalyserNode | null;
  /** Open the hook's own microphone (no-op if an external analyser is set). */
  start: () => Promise<boolean>;
  /** Close the hook's own microphone and audio context. */
  stop: () => void;
  /** True while any analyser is actively being sampled. */
  active: boolean;
}

const ZERO_BANDS: AudioBands = { bass: 0, mid: 0, treble: 0 };

/** RMS of the time-domain waveform, scaled so normal speech ≈ 0.3–0.8. */
function rmsLevel(analyser: AnalyserNode, buf: Uint8Array): number {
  analyser.getByteTimeDomainData(buf as Uint8Array<ArrayBuffer>);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i] - 128) / 128;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / buf.length) * 5);
}

/** Mean byte energy of an FFT bin range, normalised to 0..1. */
function bandEnergy(freq: Uint8Array, from: number, to: number): number {
  const lo = Math.max(0, Math.min(from, freq.length - 1));
  const hi = Math.max(lo + 1, Math.min(to, freq.length));
  let sum = 0;
  for (let i = lo; i < hi; i++) sum += freq[i];
  return sum / ((hi - lo) * 255);
}

export function useAudioReactivity(options: UseAudioReactivityOptions = {}): AudioReactivity {
  const {
    analyser: externalAnalyser = null,
    fftSize = 2048,
    attack = 0.35,
    release = 0.08,
    speakingThreshold = 0.12,
    updateHz = 20,
  } = options;

  const [level, setLevel] = useState(0);
  const [bands, setBands] = useState<AudioBands>(ZERO_BANDS);
  const [speaking, setSpeaking] = useState(false);
  const [ownAnalyser, setOwnAnalyser] = useState<AnalyserNode | null>(null);

  const levelRef = useRef(0);
  const bandsRef = useRef<AudioBands>({ ...ZERO_BANDS });
  const rafRef = useRef<number | null>(null);
  const lastPushRef = useRef(0);

  // Own-mic resources (only when no external analyser is supplied).
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);

  const analyser = externalAnalyser ?? ownAnalyser;

  // ── Sampling loop — runs whenever an analyser is available ────────────────
  useEffect(() => {
    if (!analyser) {
      levelRef.current = 0;
      setLevel(0);
      setBands(ZERO_BANDS);
      setSpeaking(false);
      return;
    }

    const td = new Uint8Array(analyser.fftSize);
    const fd = new Uint8Array(analyser.frequencyBinCount);
    // Bin ranges assume the common 44.1/48 kHz context (bin ≈ rate / fftSize).
    const binHz = (analyser.context.sampleRate || 48000) / analyser.fftSize;
    const bin = (hz: number) => Math.round(hz / binHz);
    const pushEvery = 1000 / updateHz;

    const tick = () => {
      const raw = rmsLevel(analyser, td);
      const k = raw > levelRef.current ? attack : release;
      levelRef.current += (raw - levelRef.current) * k;

      analyser.getByteFrequencyData(fd as Uint8Array<ArrayBuffer>);
      const b = bandsRef.current;
      b.bass += (bandEnergy(fd, bin(20), bin(250)) - b.bass) * k;
      b.mid += (bandEnergy(fd, bin(250), bin(2000)) - b.mid) * k;
      b.treble += (bandEnergy(fd, bin(2000), bin(8000)) - b.treble) * k;

      const now = performance.now();
      if (now - lastPushRef.current >= pushEvery) {
        lastPushRef.current = now;
        setLevel(levelRef.current);
        setBands({ ...b });
        setSpeaking(levelRef.current > speakingThreshold);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [analyser, attack, release, speakingThreshold, updateHz]);

  // ── Own microphone lifecycle ───────────────────────────────────────────────
  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (ctxRef.current) {
      void ctxRef.current.close().catch(() => {});
      ctxRef.current = null;
    }
    setOwnAnalyser(null);
  }, []);

  const start = useCallback(async (): Promise<boolean> => {
    if (externalAnalyser) return true; // already fed by the shared analyser
    if (ctxRef.current) return true; // already running
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const AC = window.AudioContext || (window as any).webkitAudioContext;
      const ctx: AudioContext = new AC();
      const node = ctx.createAnalyser();
      node.fftSize = fftSize;
      node.smoothingTimeConstant = 0.55;
      ctx.createMediaStreamSource(stream).connect(node);
      streamRef.current = stream;
      ctxRef.current = ctx;
      setOwnAnalyser(node);
      return true;
    } catch {
      stop();
      return false;
    }
  }, [externalAnalyser, fftSize, stop]);

  // Release own mic on unmount.
  useEffect(() => stop, [stop]);

  return { level, bands, speaking, levelRef, analyser, start, stop, active: !!analyser };
}

export default useAudioReactivity;
