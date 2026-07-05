"use client";

/**
 * Agent activity — clean status cards for the specialist agents, plus a
 * "Last run" readout of the routing metadata the backend actually reported.
 * States come from real run events; between runs everything settles to Ready.
 * Fields the backend did not report render "Not reported yet" — never invented.
 */

import clsx from "clsx";
import { AGENT_REGISTRY, useAgentStore, useLastRunStore, mapBackendAgent, agentById, type AgentStatus } from "@/lib/nexus";

const NOT_REPORTED = "Not reported yet";

function RunRow({ label, value }: { label: string; value: string | undefined }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[10px] text-neutral-600">{label}</span>
      <span
        className={clsx(
          "text-[10px] truncate text-right",
          value ? "text-neutral-300" : "text-neutral-700 italic"
        )}
        title={value}
      >
        {value ?? NOT_REPORTED}
      </span>
    </div>
  );
}

const STATUS_STYLE: Record<AgentStatus, { dot: string; text: string; label: string }> = {
  ready: { dot: "bg-neutral-600", text: "text-neutral-500", label: "Ready" },
  active: { dot: "bg-cyan-400", text: "text-cyan-300", label: "Active" },
  running: { dot: "bg-cyan-400 animate-pulse", text: "text-cyan-300", label: "Running" },
  waiting: { dot: "bg-amber-400 animate-pulse", text: "text-amber-300", label: "Waiting" },
  completed: { dot: "bg-emerald-400", text: "text-emerald-300", label: "Completed" },
  error: { dot: "bg-rose-400", text: "text-rose-300", label: "Error" },
};

export default function AgentActivityPanel() {
  const status = useAgentStore((s) => s.status);
  const run = useLastRunStore((s) => s.run);

  const activeCard = run?.backendAgent ? agentById(mapBackendAgent(run.backendAgent)) : undefined;

  return (
    <section className="nx-card p-3.5">
      <h3 className="text-[11px] font-semibold tracking-wide uppercase text-neutral-500 mb-2.5">
        Agents
      </h3>

      {/* Last run — only what the backend actually reported */}
      <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-2 mb-2.5 space-y-1">
        <p className="text-[9.5px] font-semibold uppercase tracking-wider text-neutral-600">
          Last run
        </p>
        {!run ? (
          <p className="text-[10px] text-neutral-700 italic">No runs yet this session</p>
        ) : (
          <>
            <RunRow label="Agent" value={run.backendAgent ? (activeCard?.label ?? run.backendAgent) : undefined} />
            <RunRow label="Routing" value={`${run.routedIntent} (heuristic)`} />
            <RunRow label="Model" value={run.model} />
            <RunRow
              label="Memories used"
              value={typeof run.memoryCount === "number" ? String(run.memoryCount) : undefined}
            />
            <RunRow
              label="Approval"
              value={
                run.pendingApproval === undefined
                  ? undefined
                  : run.pendingApproval
                    ? "owner approval required"
                    : "not required"
              }
            />
            {typeof run.latencyMs === "number" && (
              <RunRow label="Latency" value={`${(run.latencyMs / 1000).toFixed(1)}s`} />
            )}
          </>
        )}
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {AGENT_REGISTRY.map((a) => {
          const st = status[a.id]?.state ?? "ready";
          const style = STATUS_STYLE[st];
          return (
            <div
              key={a.id}
              className={clsx(
                "rounded-lg border px-2.5 py-2 transition-colors",
                st === "ready"
                  ? "border-white/[0.05] bg-white/[0.015]"
                  : "border-white/10 bg-white/[0.04]"
              )}
            >
              <div className="flex items-center gap-1.5">
                <span className={clsx("w-1.5 h-1.5 rounded-full flex-shrink-0", style.dot)} />
                <span className="text-[11px] text-neutral-300 truncate">{a.label}</span>
              </div>
              <div className="flex items-baseline justify-between mt-0.5">
                <span className={clsx("text-[9.5px]", style.text)}>{style.label}</span>
                {status[a.id]?.note && (
                  <span className="text-[9px] text-neutral-600 truncate max-w-[70px]" title={status[a.id]?.note}>
                    {status[a.id]?.note}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
