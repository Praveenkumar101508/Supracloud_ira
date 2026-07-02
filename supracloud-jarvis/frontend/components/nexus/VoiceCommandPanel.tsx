"use client";

/**
 * Voice command panel — mic control (host passes the transport component),
 * live transcript, detected intent + confidence, suggested action.
 * Intent is the local keyword heuristic and is labeled as such.
 */

import type { ReactNode } from "react";
import { useVoicePanelStore } from "@/lib/nexus";

export default function VoiceCommandPanel({ micControl }: { micControl?: ReactNode }) {
  const { transcript, origin, intent } = useVoicePanelStore();

  return (
    <section className="nx-card p-3.5">
      <div className="flex items-center justify-between mb-2.5">
        <h3 className="text-[11px] font-semibold tracking-wide uppercase text-neutral-500">
          Voice command
        </h3>
        {micControl}
      </div>

      {transcript ? (
        <>
          <p className="text-[13px] text-neutral-200 leading-snug">
            “{transcript}”
            {origin && (
              <span className="ml-1.5 text-[9.5px] text-neutral-600 align-middle">{origin}</span>
            )}
          </p>
          {intent && (
            <div className="mt-3 space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-cyan-300 font-medium">{intent.label}</span>
                <span className="nx-mono text-[10px] text-neutral-500">
                  {(intent.confidence * 100) | 0}%
                </span>
                <span className="text-[9px] px-1 py-px rounded bg-white/[0.05] border border-white/10 text-neutral-500">
                  {intent.source}
                </span>
              </div>
              <div className="h-1 rounded-full bg-white/[0.05] overflow-hidden">
                <div
                  className="h-full rounded-full bg-cyan-400/70 transition-all duration-500"
                  style={{ width: `${intent.confidence * 100}%` }}
                />
              </div>
              <p className="text-[11px] text-neutral-500 leading-snug">→ {intent.suggestion}</p>
            </div>
          )}
        </>
      ) : (
        <p className="text-[11.5px] text-neutral-600">
          No command yet — speak or type, and the transcript, intent and suggested action appear
          here.
        </p>
      )}
    </section>
  );
}
