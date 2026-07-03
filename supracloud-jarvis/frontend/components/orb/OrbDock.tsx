"use client";

/**
 * OrbDock — the LivingOrb's home inside the workspace: a floating presence in
 * the top-right corner of the conversation area. It reads the shared Pulse
 * store (state + the voice loop's mic analyser), drifts on a slow idle float,
 * and accepts one light interaction: clicking it focuses the command input
 * (via the `ira:focus-input` window event ChatInterface listens for).
 *
 * The container stays `pointer-events-none` so the transcript beneath remains
 * fully usable — only the orb itself is clickable. `data-orb-dock` marks the
 * landing target the ResonanceGate's exit flight measures, and the delayed
 * fade-in cross-fades the dock orb in as the gate orb arrives.
 *
 * The Three.js scene is heavy for an ornament, so it is dynamically imported
 * (no SSR) and only mounted on md+ screens.
 */

import dynamic from "next/dynamic";
import { motion, useReducedMotion } from "framer-motion";
import { usePulseStore } from "@/lib/nexus";
import { orbStateFromPulse } from "./orbState";

const LivingOrb = dynamic(() => import("./LivingOrb"), { ssr: false });

/** Ask the chat surface to focus its command input. */
function focusCommandInput() {
  window.dispatchEvent(new Event("ira:focus-input"));
}

export default function OrbDock({ size = 120 }: { size?: number }) {
  const pulseState = usePulseStore((s) => s.state);
  const analyser = usePulseStore((s) => s.analyser);
  const reduced = useReducedMotion();
  const state = orbStateFromPulse(pulseState);
  const resting = state === "idle";

  return (
    <motion.div
      data-orb-dock
      // Opacity-only entrance: the gate measures this element's layout box
      // right after mount, so it must never start scaled or offset.
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: reduced ? 0.2 : 0.7, delay: reduced ? 0 : 0.9, ease: "easeOut" }}
      className="pointer-events-none absolute top-2 right-2 z-20 hidden md:block"
    >
      <motion.div
        className="pointer-events-auto"
        animate={resting && !reduced ? { y: [0, -3.5, 0] } : { y: 0 }}
        transition={
          resting && !reduced
            ? { duration: 6.5, repeat: Infinity, ease: "easeInOut" }
            : { duration: 0.6, ease: "easeOut" }
        }
      >
        <LivingOrb
          state={state}
          analyser={analyser}
          size={size}
          quality="low"
          onClick={focusCommandInput}
          ariaLabel="IRA presence — focus the command input"
        />
      </motion.div>
    </motion.div>
  );
}
