"use client";

/**
 * Execution timeline — replaces loading spinners. Renders the current run's
 * stages with real statuses fed by the chat/voice pipelines.
 */

import clsx from "clsx";
import { motion } from "framer-motion";
import { Check, X, Minus, Loader2, Circle } from "lucide-react";
import { useExecStore, type StageStatus } from "@/lib/nexus";

const ICON: Record<StageStatus, React.ReactNode> = {
  pending: <Circle className="w-2.5 h-2.5 text-neutral-700" />,
  active: <Loader2 className="w-3 h-3 text-cyan-300 animate-spin" />,
  done: <Check className="w-3 h-3 text-cyan-300" />,
  skipped: <Minus className="w-3 h-3 text-neutral-600" />,
  error: <X className="w-3 h-3 text-rose-300" />,
};

export default function ExecutionTimeline() {
  const { command, stages } = useExecStore();

  return (
    <section className="nx-card p-3.5">
      <h3 className="text-[11px] font-semibold tracking-wide uppercase text-neutral-500 mb-2.5">
        Execution
      </h3>

      {stages.length === 0 ? (
        <p className="text-[11.5px] text-neutral-600">Idle — the next task's steps appear here.</p>
      ) : (
        <>
          <p className="text-[11px] text-neutral-400 mb-3 truncate" title={command}>
            {command}
          </p>
          <ol className="relative space-y-2.5">
            {stages.map((s, i) => (
              <motion.li
                key={`${s.id}-${i}`}
                initial={{ opacity: 0, x: -4 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.03 }}
                className="flex items-start gap-2.5"
              >
                <span className="mt-0.5 w-4 flex justify-center flex-shrink-0">{ICON[s.status]}</span>
                <div className="min-w-0">
                  <span
                    className={clsx(
                      "text-[12px] leading-tight",
                      s.status === "active" && "text-cyan-200",
                      s.status === "done" && "text-neutral-300",
                      s.status === "pending" && "text-neutral-600",
                      s.status === "skipped" && "text-neutral-600 line-through decoration-neutral-700",
                      s.status === "error" && "text-rose-300"
                    )}
                  >
                    {s.label}
                  </span>
                  {s.detail && (
                    <p className="text-[10px] text-neutral-600 leading-tight truncate" title={s.detail}>
                      {s.detail}
                    </p>
                  )}
                </div>
              </motion.li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
