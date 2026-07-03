"use client";

/**
 * OrbDock — the LivingOrb's home inside the workspace: a floating presence in
 * the top-right corner of the conversation area. Purely ambient — it reads
 * the shared Pulse store (state + the voice loop's mic analyser) and never
 * intercepts pointer events, so the transcript beneath stays fully usable.
 *
 * The Three.js scene is heavy for a decoration, so it is dynamically imported
 * (no SSR) and only mounted on md+ screens.
 */

import dynamic from "next/dynamic";
import { motion } from "framer-motion";
import { usePulseStore } from "@/lib/nexus";
import { orbStateFromPulse } from "./orbState";

const LivingOrb = dynamic(() => import("./LivingOrb"), { ssr: false });

export default function OrbDock({ size = 120 }: { size?: number }) {
  const pulseState = usePulseStore((s) => s.state);
  const analyser = usePulseStore((s) => s.analyser);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.85 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 1.2, ease: "easeOut" }}
      className="pointer-events-none absolute top-2 right-2 z-20 hidden md:block"
      aria-hidden
    >
      <LivingOrb
        state={orbStateFromPulse(pulseState)}
        analyser={analyser}
        size={size}
        quality="low"
      />
    </motion.div>
  );
}
