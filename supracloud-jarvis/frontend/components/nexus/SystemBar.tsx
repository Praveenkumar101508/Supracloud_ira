"use client";

/**
 * Nexus system bar — Local Mode, Voice, Memory, External Access, Model.
 * Every chip reflects a real signal (/health poll, pulse state, permission
 * grants, build config); nothing is hardcoded green.
 */

import { useEffect, useState, type ReactNode } from "react";
import clsx from "clsx";
import { PanelRight } from "lucide-react";
import Pulse from "@/components/pulse/Pulse";
import { usePulseStore, usePermissionStore } from "@/lib/nexus";
import { fetchHealth, type Health } from "@/lib/systemStatus";

function Chip({
  label,
  value,
  tone,
  title,
}: {
  label: string;
  value: string;
  tone: "cyan" | "amber" | "violet" | "neutral" | "rose";
  title?: string;
}) {
  const tones: Record<string, string> = {
    cyan: "border-cyan-400/25 text-cyan-300 bg-cyan-400/[0.06]",
    amber: "border-amber-400/30 text-amber-300 bg-amber-400/[0.07]",
    violet: "border-violet-400/25 text-violet-300 bg-violet-400/[0.06]",
    neutral: "border-white/10 text-neutral-400 bg-white/[0.03]",
    rose: "border-rose-400/25 text-rose-300 bg-rose-400/[0.06]",
  };
  return (
    <span
      title={title}
      className={clsx(
        "hidden md:inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border text-[10.5px] whitespace-nowrap",
        tones[tone]
      )}
    >
      <span className="opacity-60">{label}</span>
      <span className="font-medium">{value}</span>
    </span>
  );
}

export default function SystemBar({
  token,
  right,
  onToggleRail,
}: {
  token: string;
  right?: ReactNode;
  onToggleRail?: () => void;
}) {
  const [health, setHealth] = useState<Health | null>(null);
  const pulseState = usePulseStore((s) => s.state);
  const agent = usePulseStore((s) => s.agent);
  const grants = usePermissionStore((s) => s.grants);

  useEffect(() => {
    let alive = true;
    const check = async () => {
      const h = await fetchHealth();
      if (alive) setHealth(h);
    };
    void check();
    const id = setInterval(check, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [token]);

  const remoteBase = process.env.NEXT_PUBLIC_API_BASE || "";
  const memSvc = health?.services
    ? Object.entries(health.services).find(([n]) => /(memory|vector|qdrant|chroma|store)/i.test(n))?.[1]
    : null;
  const grantCount = Object.keys(grants).length;
  const voiceLabel =
    pulseState === "idle" || pulseState === "completed" ? "standby" : pulseState;

  return (
    <header className="flex items-center justify-between gap-3 px-4 py-2 border-b border-nexus-line bg-nexus-base/70 backdrop-blur-md flex-shrink-0">
      <div className="flex items-center gap-2.5 min-w-0">
        <Pulse size={30} showLabel />
        <span className="text-sm font-semibold tracking-tight hidden sm:block">IRA</span>
        {agent && (
          <span className="text-[10px] hidden lg:block" style={{ color: agent.accent }}>
            {agent.label}
          </span>
        )}

        <Chip
          label="mode"
          value={remoteBase ? "remote api" : "local"}
          tone={remoteBase ? "amber" : "cyan"}
          title={remoteBase ? `API served from ${remoteBase}` : "Same-origin API — local-first"}
        />
        <Chip label="voice" value={voiceLabel} tone={voiceLabel === "standby" ? "neutral" : "cyan"} />
        <Chip
          label="memory"
          value={memSvc ? memSvc.status : health ? "unverified" : "offline"}
          tone={memSvc?.status === "ok" ? "violet" : "neutral"}
          title={memSvc ? undefined : "No memory service reported by /health"}
        />
        <Chip
          label="external"
          value={grantCount ? `approved ×${grantCount}` : "locked"}
          tone={grantCount ? "amber" : "cyan"}
          title={
            grantCount
              ? `Session grants: ${Object.values(grants).join(", ")}`
              : "No side-effecting or outbound scope approved this session"
          }
        />
        <Chip
          label="model"
          value={health?.model ?? (health?.version ? `core v${health.version}` : "unreachable")}
          tone={health ? "neutral" : "rose"}
          title="Reported by /health"
        />
      </div>

      <div className="flex items-center gap-2.5 flex-shrink-0">
        {right}
        {onToggleRail && (
          <button
            onClick={onToggleRail}
            title="Toggle activity rail"
            className="p-1.5 rounded-lg text-neutral-500 hover:text-neutral-200 hover:bg-white/[0.06] transition-colors"
          >
            <PanelRight className="w-4 h-4" />
          </button>
        )}
      </div>
    </header>
  );
}
