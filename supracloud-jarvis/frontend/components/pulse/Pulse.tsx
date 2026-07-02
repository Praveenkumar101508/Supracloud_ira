"use client";

/**
 * The Pulse — IRA's one living element. A small audio-reactive glyph drawn
 * on canvas (no WebGL, no Three.js). Reads state from usePulseStore and, when
 * the voice loop shares its mic AnalyserNode, reacts to real audio.
 *
 * States: idle (breathing ring), listening (radial waveform), understanding
 * (thin rotating analysis ring), thinking (rotating inner glow), acting
 * (progress arc), permission (amber shield pulse), speaking (outward waves),
 * completed (confirmation flash), error (calm warning pulse).
 */

import { useEffect, useRef } from "react";
import { usePulseStore, type PulseState } from "@/lib/nexus";

const CORE_CYAN = "#22d3ee";
const AMBER = "#fbbf24";
const ERROR_ROSE = "#fda4af"; // calm, not aggressive red

interface Props {
  size?: number; // css pixels
  showLabel?: boolean; // agent-handoff chip under the glyph
  className?: string;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function rgba(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

/** Mic RMS 0..~0.5 → 0..1 drive for the visuals. */
function audioLevel(analyser: AnalyserNode | null, buf: Uint8Array): number {
  if (!analyser) return 0;
  analyser.getByteTimeDomainData(buf as Uint8Array<ArrayBuffer>);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i] - 128) / 128;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / buf.length) * 6);
}

export default function Pulse({ size = 36, showLabel = false, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const state = usePulseStore((s) => s.state);
  const agent = usePulseStore((s) => s.agent);

  // Completed/error are transient — decay back to idle.
  useEffect(() => {
    if (state !== "completed" && state !== "error") return;
    const t = setTimeout(
      () => {
        const s = usePulseStore.getState();
        if (s.state === state) s.setState("idle");
      },
      state === "completed" ? 1100 : 2800
    );
    return () => clearTimeout(t);
  }, [state]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const td = new Uint8Array(1024);
    const c = size / 2;
    const R = size * 0.32; // base ring radius
    let raf = 0;
    let flashStart = 0;
    let lastState: PulseState | null = null;

    const draw = () => {
      const { state: st, agent: ag, analyser } = usePulseStore.getState();
      if (st !== lastState) {
        lastState = st;
        flashStart = performance.now();
      }
      const now = performance.now();
      const t = now / 1000;
      const accent = st === "permission" ? AMBER : st === "error" ? ERROR_ROSE : ag?.accent ?? CORE_CYAN;
      const level = audioLevel(analyser, td);

      ctx.clearRect(0, 0, size, size);
      ctx.lineCap = "round";

      if (reduced) {
        // Static state dot + ring for reduced-motion users.
        ctx.strokeStyle = rgba(accent, 0.8);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(c, c, R, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = rgba(accent, 0.9);
        ctx.beginPath();
        ctx.arc(c, c, 2.2, 0, Math.PI * 2);
        ctx.fill();
        raf = requestAnimationFrame(draw);
        return;
      }

      // Soft core dot, always present.
      const coreGlow = ctx.createRadialGradient(c, c, 0, c, c, R * 0.9);
      coreGlow.addColorStop(0, rgba(accent, st === "thinking" ? 0.55 : 0.35));
      coreGlow.addColorStop(1, rgba(accent, 0));
      ctx.fillStyle = coreGlow;
      ctx.beginPath();
      ctx.arc(c, c, R * 0.9, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = rgba(accent, 0.95);
      ctx.beginPath();
      ctx.arc(c, c, 1.8 + level * 1.5, 0, Math.PI * 2);
      ctx.fill();

      switch (st) {
        case "idle": {
          const breathe = 1 + Math.sin(t * 1.5) * 0.07;
          ctx.strokeStyle = rgba(accent, 0.45 + Math.sin(t * 1.5) * 0.15);
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.arc(c, c, R * breathe, 0, Math.PI * 2);
          ctx.stroke();
          break;
        }
        case "listening": {
          // Radial waveform expanding from center, driven by mic level.
          const points = 48;
          ctx.strokeStyle = rgba(accent, 0.85);
          ctx.lineWidth = 1.3;
          ctx.beginPath();
          for (let i = 0; i <= points; i++) {
            const a = (i / points) * Math.PI * 2;
            const wob = Math.sin(a * 5 + t * 6) * (1.5 + level * size * 0.14);
            const r = R * (0.85 + level * 0.35) + wob;
            const x = c + Math.cos(a) * r;
            const y = c + Math.sin(a) * r;
            i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
          }
          ctx.closePath();
          ctx.stroke();
          break;
        }
        case "understanding": {
          // Thin analysis ring rotating; a second faint counter-arc.
          ctx.strokeStyle = rgba(accent, 0.9);
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(c, c, R * 1.05, t * 2.4, t * 2.4 + Math.PI * 0.8);
          ctx.stroke();
          ctx.strokeStyle = rgba(accent, 0.35);
          ctx.beginPath();
          ctx.arc(c, c, R * 0.8, -t * 1.6, -t * 1.6 + Math.PI * 0.5);
          ctx.stroke();
          break;
        }
        case "thinking": {
          // Inner glow rotating — an off-center highlight orbiting the core.
          const ox = Math.cos(t * 2.2) * R * 0.35;
          const oy = Math.sin(t * 2.2) * R * 0.35;
          const g = ctx.createRadialGradient(c + ox, c + oy, 0, c + ox, c + oy, R * 0.7);
          g.addColorStop(0, rgba(accent, 0.5));
          g.addColorStop(1, rgba(accent, 0));
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(c, c, R * 1.05, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = rgba(accent, 0.3);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(c, c, R, 0, Math.PI * 2);
          ctx.stroke();
          break;
        }
        case "acting": {
          // Indeterminate progress arc: sweep grows and shrinks while rotating.
          const sweep = Math.PI * (0.35 + 0.5 * (Math.sin(t * 2.1) * 0.5 + 0.5));
          ctx.strokeStyle = rgba(accent, 0.95);
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(c, c, R, t * 3.2, t * 3.2 + sweep);
          ctx.stroke();
          ctx.strokeStyle = rgba(accent, 0.2);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(c, c, R, 0, Math.PI * 2);
          ctx.stroke();
          break;
        }
        case "permission": {
          // Amber shield pulse — a small shield outline breathing inside a ring.
          const pulse = 0.6 + Math.sin(t * 3.4) * 0.3;
          ctx.strokeStyle = rgba(AMBER, pulse);
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.arc(c, c, R * 1.05, 0, Math.PI * 2);
          ctx.stroke();
          const s = R * 0.62;
          ctx.beginPath();
          ctx.moveTo(c, c - s);
          ctx.lineTo(c + s * 0.8, c - s * 0.55);
          ctx.lineTo(c + s * 0.8, c + s * 0.2);
          ctx.quadraticCurveTo(c + s * 0.8, c + s * 0.75, c, c + s);
          ctx.quadraticCurveTo(c - s * 0.8, c + s * 0.75, c - s * 0.8, c + s * 0.2);
          ctx.lineTo(c - s * 0.8, c - s * 0.55);
          ctx.closePath();
          ctx.strokeStyle = rgba(AMBER, 0.9);
          ctx.lineWidth = 1.2;
          ctx.stroke();
          break;
        }
        case "speaking": {
          // Waves radiating outward — three phased expanding rings.
          for (let k = 0; k < 3; k++) {
            const phase = ((t * 0.9 + k / 3) % 1 + 1) % 1;
            const r = R * (0.5 + phase * 1.1);
            ctx.strokeStyle = rgba(accent, (1 - phase) * 0.55);
            ctx.lineWidth = 1.3;
            ctx.beginPath();
            ctx.arc(c, c, r, 0, Math.PI * 2);
            ctx.stroke();
          }
          break;
        }
        case "completed": {
          // Quick confirmation flash: bright ring expands and fades once.
          const p = Math.min(1, (now - flashStart) / 700);
          ctx.strokeStyle = rgba(accent, (1 - p) * 0.9);
          ctx.lineWidth = 2 - p;
          ctx.beginPath();
          ctx.arc(c, c, R * (1 + p * 0.7), 0, Math.PI * 2);
          ctx.stroke();
          ctx.strokeStyle = rgba(accent, 0.5);
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(c, c, R, 0, Math.PI * 2);
          ctx.stroke();
          break;
        }
        case "error": {
          // Calm warning pulse — slow, soft rose, no strobing.
          const pulse = 0.35 + (Math.sin(t * 2.0) * 0.5 + 0.5) * 0.35;
          ctx.strokeStyle = rgba(ERROR_ROSE, pulse);
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.arc(c, c, R, 0, Math.PI * 2);
          ctx.stroke();
          break;
        }
      }

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [size]);

  return (
    <div className={`relative inline-flex flex-col items-center ${className ?? ""}`}>
      <canvas
        ref={canvasRef}
        style={{ width: size, height: size }}
        role="status"
        aria-label={`IRA is ${agent ? `${agent.label} · ` : ""}${state}`}
      />
      {showLabel && agent && (
        <span
          className="absolute -bottom-4 whitespace-nowrap text-[9px] font-medium tracking-wide"
          style={{ color: agent.accent }}
        >
          → {agent.label}
        </span>
      )}
    </div>
  );
}
