"use client";

/**
 * Permission console — every side-effecting action stops here first.
 * Shows exactly what IRA wants to access/modify, a risk level, and
 * Allow once / Allow for this scope / Deny. Nothing runs without an allow.
 */

import { motion, AnimatePresence } from "framer-motion";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import clsx from "clsx";
import { usePermissionStore } from "@/lib/nexus";

const RISK_STYLE = {
  low: "border-cyan-400/30 text-cyan-300 bg-cyan-400/[0.07]",
  medium: "border-amber-400/35 text-amber-300 bg-amber-400/[0.08]",
  high: "border-rose-400/35 text-rose-300 bg-rose-400/[0.08]",
} as const;

export default function PermissionConsole() {
  const queue = usePermissionStore((s) => s.queue);
  const decide = usePermissionStore((s) => s.decide);
  const req = queue[0];

  return (
    <AnimatePresence>
      {req && (
        <motion.div
          key={req.id}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-40 flex items-end sm:items-center justify-center bg-black/55 backdrop-blur-[2px] p-4"
          role="alertdialog"
          aria-modal="true"
          aria-label="Permission required"
        >
          <motion.div
            initial={{ y: 24, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 24, opacity: 0 }}
            transition={{ type: "spring", stiffness: 260, damping: 26 }}
            className="w-full max-w-md rounded-2xl border border-amber-400/25 bg-nexus-overlay shadow-panel shadow-glow-amber p-5"
          >
            <div className="flex items-center gap-2.5 mb-3">
              <ShieldAlert className="w-5 h-5 text-amber-300" />
              <h2 className="text-sm font-semibold text-neutral-100">{req.title}</h2>
              <span
                className={clsx(
                  "ml-auto px-2 py-0.5 rounded-md border text-[10px] font-medium uppercase tracking-wide",
                  RISK_STYLE[req.risk]
                )}
              >
                {req.risk} risk
              </span>
            </div>

            <p className="text-[12.5px] text-neutral-400 leading-relaxed mb-3">{req.description}</p>

            <div className="rounded-xl border border-white/[0.07] bg-white/[0.03] p-3 mb-4">
              <p className="text-[10px] uppercase tracking-wide text-neutral-500 mb-1.5">
                IRA wants to
              </p>
              <ul className="space-y-1">
                {req.access.map((a) => (
                  <li key={a} className="flex items-start gap-2 text-[12px] text-neutral-300">
                    <ShieldCheck className="w-3 h-3 mt-0.5 text-amber-300/70 flex-shrink-0" />
                    {a}
                  </li>
                ))}
              </ul>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <button
                onClick={() => decide(req.id, "allow-once")}
                className="rounded-xl border border-amber-400/35 bg-amber-400/10 hover:bg-amber-400/15 text-amber-200 py-2 text-[12.5px] font-medium transition-colors"
              >
                Allow once
              </button>
              <button
                onClick={() => decide(req.id, "allow-scope")}
                title={`Grants "${req.scopeLabel}" for this session`}
                className="rounded-xl border border-white/10 bg-white/[0.04] hover:bg-white/[0.08] text-neutral-300 py-2 text-[12.5px] transition-colors"
              >
                Allow: {req.scopeLabel}
              </button>
              <button
                onClick={() => decide(req.id, "deny")}
                className="rounded-xl border border-white/10 bg-white/[0.02] hover:bg-white/[0.06] text-neutral-400 py-2 text-[12.5px] transition-colors"
              >
                Deny
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
