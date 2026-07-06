"use client";

/**
 * Daily Dashboard v1 — the landing view for daily use.
 *
 * Readiness comes from real probes: /health for the core services and
 * /api/v1/trust/status for the privacy posture. Quick actions jump to the
 * other Personal v1 panels. Nothing on this screen is hardcoded green.
 */

import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import {
  MessageSquare,
  Brain,
  ShieldCheck,
  Mic,
  Activity,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  XCircle,
} from "lucide-react";
import { getTrustStatus, getOwnerProfile, type TrustStatus, type OwnerProfile } from "@/lib/api";
import { fetchHealth, type Health } from "@/lib/systemStatus";
import { useUIStore, type WorkspaceView } from "@/lib/store";

const QUICK_ACTIONS: {
  view: WorkspaceView;
  label: string;
  desc: string;
  icon: React.ReactNode;
}[] = [
  { view: "chat", label: "Start chat", desc: "Talk to IRA", icon: <MessageSquare className="w-4 h-4" /> },
  { view: "memory", label: "Memory Vault", desc: "Save & manage memories", icon: <Brain className="w-4 h-4" /> },
  { view: "trust", label: "Trust Console", desc: "Privacy & security state", icon: <ShieldCheck className="w-4 h-4" /> },
  { view: "voice", label: "Voice Setup", desc: "STT, TTS & enrolment", icon: <Mic className="w-4 h-4" /> },
];

function ServiceDot({ status }: { status: string | undefined }) {
  if (status === "ok") return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />;
  if (status === "degraded") return <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />;
  return <XCircle className="w-3.5 h-3.5 text-rose-400" />;
}

export default function Dashboard({ token }: { token: string }) {
  const setView = useUIStore((s) => s.setView);
  const [health, setHealth] = useState<Health | null>(null);
  const [trust, setTrust] = useState<TrustStatus | null>(null);
  const [profile, setProfile] = useState<OwnerProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [h, t, p] = await Promise.all([
      fetchHealth(),
      getTrustStatus(token).catch(() => null),
      getOwnerProfile(token).catch(() => null),
    ]);
    setHealth(h);
    setTrust(t);
    setProfile(p);
    setCheckedAt(new Date());
    setLoading(false);
  }, [token]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 30_000);
    return () => clearInterval(id);
  }, [load]);

  const ready = health?.status === "ok";
  const degraded = health?.status === "degraded";

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-2xl mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold tracking-tight flex items-center gap-2">
              {profile?.first_run_completed && (profile.preferred_title || profile.name)
                ? `Welcome back, ${(profile.preferred_title || profile.name).toLowerCase()}.`
                : "IRA"}
              {profile?.role === "owner_admin" && profile.first_run_completed && (
                <span className="text-[10px] font-medium text-cyan-300 border border-cyan-400/30 bg-cyan-400/[0.07] rounded px-1.5 py-0.5">
                  Owner Admin
                </span>
              )}
            </h2>
            <p className="text-xs text-neutral-500 mt-0.5">Your assistant. Your hardware. Your rules.</p>
          </div>
          <button
            onClick={() => void load()}
            disabled={loading}
            className="flex items-center gap-1.5 text-xs text-neutral-400 hover:text-white px-2.5 py-1.5 rounded-lg border border-white/10 hover:bg-white/[0.06] transition-colors disabled:opacity-40"
          >
            <RefreshCw className={clsx("w-3.5 h-3.5", loading && "animate-spin")} />
            Check now
          </button>
        </div>

        {/* Readiness */}
        <div
          className={clsx(
            "rounded-2xl border px-4 py-4 flex items-center gap-3",
            ready
              ? "border-emerald-400/25 bg-emerald-400/[0.05]"
              : degraded
                ? "border-amber-400/30 bg-amber-400/[0.05]"
                : "border-rose-400/25 bg-rose-400/[0.05]"
          )}
        >
          {ready ? (
            <CheckCircle2 className="w-7 h-7 text-emerald-400 flex-shrink-0" />
          ) : degraded ? (
            <AlertTriangle className="w-7 h-7 text-amber-400 flex-shrink-0" />
          ) : (
            <XCircle className="w-7 h-7 text-rose-400 flex-shrink-0" />
          )}
          <div className="min-w-0">
            <p
              className={clsx(
                "text-sm font-semibold",
                ready ? "text-emerald-300" : degraded ? "text-amber-300" : "text-rose-300"
              )}
            >
              {ready ? "IRA is ready" : degraded ? "IRA is partially up" : "IRA backend unreachable"}
            </p>
            <p className="text-xs text-neutral-500 mt-0.5">
              {checkedAt ? `Checked ${checkedAt.toLocaleTimeString()}` : "Checking…"}
              {trust?.privacy.mode && (
                <>
                  {" · privacy "}
                  <span className={trust.privacy.mode === "local_only" ? "text-emerald-400" : "text-amber-400"}>
                    {trust.privacy.mode}
                  </span>
                </>
              )}
              {trust && (
                <>
                  {" · external APIs "}
                  <span className={trust.privacy.external_api_allowed ? "text-amber-400" : "text-emerald-400"}>
                    {trust.privacy.external_api_allowed ? "allowed" : "off"}
                  </span>
                </>
              )}
            </p>
          </div>
        </div>

        {/* Services, exactly as /health reports them */}
        {health?.services && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {Object.entries(health.services).map(([name, svc]) => (
              <div
                key={name}
                className="rounded-xl border border-white/[0.05] bg-white/[0.02] px-3 py-2.5 flex items-center gap-2"
              >
                <ServiceDot status={svc.status} />
                <div className="min-w-0">
                  <p className="text-[11px] text-neutral-300 truncate">{name}</p>
                  <p className="text-[9.5px] text-neutral-600">
                    {svc.status}
                    {typeof svc.latency_ms === "number" ? ` · ${svc.latency_ms}ms` : ""}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}

        {!health && (
          <p className="text-xs text-neutral-600 px-1">
            /health did not respond — start the backend with <code className="text-neutral-400">./start-ira.sh</code>{" "}
            and check again.
          </p>
        )}

        {/* Quick actions */}
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-neutral-600 px-1 mb-2">
            Quick actions
          </p>
          <div className="grid grid-cols-2 gap-2">
            {QUICK_ACTIONS.map((a) => (
              <button
                key={a.view}
                onClick={() => setView(a.view)}
                className="flex items-center gap-3 rounded-xl border border-white/[0.07] bg-white/[0.02] px-4 py-3.5 text-left hover:border-cyan-400/30 hover:bg-cyan-400/[0.04] transition-colors group"
              >
                <span className="text-neutral-500 group-hover:text-cyan-300 transition-colors">{a.icon}</span>
                <span>
                  <span className="block text-sm text-neutral-200">{a.label}</span>
                  <span className="block text-[10.5px] text-neutral-600">{a.desc}</span>
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Agent activity pointer — the live panels sit in the right rail */}
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3 flex items-start gap-3">
          <Activity className="w-4 h-4 text-neutral-500 flex-shrink-0 mt-0.5" />
          <p className="text-[11px] text-neutral-500 leading-relaxed">
            Live agent activity — routing, model used, memories used, approvals — appears in the
            right rail during every chat or voice run, and pending approvals always interrupt in
            the Permission Console.
          </p>
        </div>

        {trust && trust.security_warnings.length > 0 && (
          <button
            onClick={() => setView("trust")}
            className="w-full rounded-xl border border-amber-400/30 bg-amber-400/[0.05] px-4 py-3 text-left hover:bg-amber-400/[0.1] transition-colors"
          >
            <p className="text-xs font-semibold text-amber-300">
              {trust.security_warnings.length} security warning
              {trust.security_warnings.length > 1 ? "s" : ""} — open Trust Console
            </p>
          </button>
        )}
      </div>
    </div>
  );
}
