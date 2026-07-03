"use client";

/**
 * Demo Mode — a separate, opt-in cinematic route for portfolio recording.
 * Larger Pulse, longer wake animation, subtle animated background, dramatic
 * result reveal. Purely presentational: it never touches auth, never calls
 * the backend, and does not change or slow the default Work Mode at "/".
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { motion, AnimatePresence } from "framer-motion";
import { usePulseStore, type PulseState } from "@/lib/nexus";
import { orbStateFromPulse } from "@/components/orb/orbState";

const LivingOrb = dynamic(() => import("@/components/orb/LivingOrb"), { ssr: false });

const SCRIPT: Array<{ state: PulseState; label: string; hold: number }> = [
  { state: "idle", label: "Idle — breathing", hold: 3000 },
  { state: "listening", label: "Listening", hold: 3200 },
  { state: "understanding", label: "Understanding", hold: 2800 },
  { state: "thinking", label: "Thinking", hold: 3000 },
  { state: "acting", label: "Acting", hold: 3000 },
  { state: "permission", label: "Permission needed", hold: 3200 },
  { state: "speaking", label: "Speaking", hold: 3200 },
  { state: "completed", label: "Completed", hold: 2200 },
];

const BOOT_LINES = [
  "DEMO SEQUENCE — SIMULATED READOUTS",
  "IRA CORE · PRESENTATION MODE",
  "PULSE STATES · FULL CYCLE",
];

export default function DemoPage() {
  const [step, setStep] = useState(-1);
  const [bootLine, setBootLine] = useState(0);
  const [reveal, setReveal] = useState(false);

  // Longer wake: type the (clearly simulated) boot lines, then run the cycle.
  useEffect(() => {
    if (bootLine < BOOT_LINES.length) {
      const t = setTimeout(() => setBootLine((b) => b + 1), 1400);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setStep(0), 800);
    return () => clearTimeout(t);
  }, [bootLine]);

  useEffect(() => {
    if (step < 0) return;
    const cur = SCRIPT[step % SCRIPT.length];
    usePulseStore.getState().setState(cur.state);
    if (step > 0 && step % SCRIPT.length === SCRIPT.length - 1) setReveal(true);
    const t = setTimeout(() => setStep((s) => s + 1), cur.hold);
    return () => clearTimeout(t);
  }, [step]);

  // Leave the shared store clean when the route unmounts.
  useEffect(() => () => usePulseStore.getState().setState("idle"), []);

  const current = step >= 0 ? SCRIPT[step % SCRIPT.length] : null;

  return (
    <div className="fixed inset-0 overflow-hidden bg-black text-white">
      {/* Subtle animated background — demo only */}
      <div
        aria-hidden
        className="absolute inset-0 opacity-25"
        style={{
          background:
            "radial-gradient(900px 600px at 20% 15%, rgba(34,211,238,0.12), transparent 60%)," +
            "radial-gradient(800px 600px at 85% 80%, rgba(167,139,250,0.1), transparent 60%)",
          animation: "demo-drift 24s ease-in-out infinite alternate",
        }}
      />
      <style>{`@keyframes demo-drift { from { transform: scale(1) translateY(0); } to { transform: scale(1.15) translateY(-3%); } }`}</style>

      <div className="relative h-full flex flex-col items-center justify-center gap-10 px-6">
        <span className="absolute top-4 left-1/2 -translate-x-1/2 text-[10px] tracking-[0.25em] uppercase text-amber-300/80 border border-amber-400/25 bg-amber-400/[0.06] rounded-full px-3 py-1">
          Demo mode — simulated presentation
        </span>

        {step < 0 ? (
          <div className="space-y-3">
            {BOOT_LINES.slice(0, bootLine + 1).map((l) => (
              <motion.p
                key={l}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 1 }}
                className="nx-mono text-[13px] text-neutral-500 text-center"
              >
                {l}
              </motion.p>
            ))}
          </div>
        ) : (
          <>
            <LivingOrb state={orbStateFromPulse(current?.state ?? "idle")} size={320} />
            <AnimatePresence mode="wait">
              <motion.p
                key={current?.label}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.6 }}
                className="nx-display text-xl text-neutral-300"
              >
                {current?.label}
              </motion.p>
            </AnimatePresence>

            <AnimatePresence>
              {reveal && (
                <motion.div
                  initial={{ opacity: 0, y: 30, scale: 0.96 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{ duration: 1.1, ease: "easeOut" }}
                  className="nx-card max-w-md w-full p-5"
                >
                  <p className="text-[10px] uppercase tracking-wide text-neutral-500 mb-2">
                    Result reveal (sample)
                  </p>
                  <p className="text-sm text-neutral-200 leading-relaxed">
                    Voice-first, local-first, permission-gated. Every state you just watched maps
                    to a real signal in the working console.
                  </p>
                </motion.div>
              )}
            </AnimatePresence>
          </>
        )}

        <Link
          href="/"
          className="absolute bottom-5 text-[11px] text-neutral-600 hover:text-neutral-400 transition-colors"
        >
          ← back to the console
        </Link>
      </div>
    </div>
  );
}
