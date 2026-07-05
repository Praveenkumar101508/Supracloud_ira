"use client";

/**
 * Trust Console v1 — renders GET /api/v1/trust/status verbatim.
 *
 * Every value on this screen comes from the backend probe; nothing is
 * hardcoded green. The safe state (green shield) appears only when the
 * backend itself reports status == "local_only" — external APIs off, model
 * and database local, zero security warnings.
 */

import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import {
  ShieldCheck,
  ShieldAlert,
  RefreshCw,
  Cpu,
  Database,
  Brain,
  Mic,
  Clock,
  BellRing,
} from "lucide-react";
import { getTrustStatus, type TrustStatus } from "@/lib/api";

function Row({
  icon,
  label,
  value,
  good,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  good: boolean | null; // null = unknown/unverified
  detail?: string;
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5 rounded-xl border border-white/[0.05] bg-white/[0.02]">
      <span className="text-neutral-500 flex-shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-neutral-400">{label}</p>
        {detail && <p className="text-[10px] text-neutral-600 truncate" title={detail}>{detail}</p>}
      </div>
      <span
        className={clsx(
          "text-xs font-medium px-2 py-0.5 rounded-md border whitespace-nowrap",
          good === true && "text-emerald-300 border-emerald-400/25 bg-emerald-400/[0.07]",
          good === false && "text-amber-300 border-amber-400/30 bg-amber-400/[0.07]",
          good === null && "text-neutral-500 border-white/10 bg-white/[0.03]"
        )}
      >
        {value}
      </span>
    </div>
  );
}

export default function TrustConsole({ token }: { token: string }) {
  const [status, setStatus] = useState<TrustStatus | null>(null);
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setStatus(await getTrustStatus(token));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Trust status unavailable");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const safe = status?.status === "local_only";

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-2xl mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Trust Console</h2>
            <p className="text-xs text-neutral-500 mt-0.5">
              Live report from the backend — is IRA actually local and safe right now?
            </p>
          </div>
          <button
            onClick={() => void load()}
            disabled={loading}
            className="flex items-center gap-1.5 text-xs text-neutral-400 hover:text-white px-2.5 py-1.5 rounded-lg border border-white/10 hover:bg-white/[0.06] transition-colors disabled:opacity-40"
          >
            <RefreshCw className={clsx("w-3.5 h-3.5", loading && "animate-spin")} />
            Refresh
          </button>
        </div>

        {error && (
          <div className="rounded-xl border border-rose-400/25 bg-rose-400/[0.06] px-4 py-3 text-sm text-rose-300">
            Could not reach the Trust API: {error}
          </div>
        )}

        {status && (
          <>
            {/* Overall verdict — the backend's own judgement, not the UI's */}
            <div
              className={clsx(
                "flex items-center gap-3 rounded-2xl border px-4 py-4",
                safe
                  ? "border-emerald-400/25 bg-emerald-400/[0.05]"
                  : "border-amber-400/30 bg-amber-400/[0.05]"
              )}
            >
              {safe ? (
                <ShieldCheck className="w-8 h-8 text-emerald-400 flex-shrink-0" />
              ) : (
                <ShieldAlert className="w-8 h-8 text-amber-400 flex-shrink-0" />
              )}
              <div>
                <p className={clsx("text-sm font-semibold", safe ? "text-emerald-300" : "text-amber-300")}>
                  {safe ? "Local only — nothing leaves this machine" : "Needs attention"}
                </p>
                <p className="text-xs text-neutral-500 mt-0.5">
                  {safe
                    ? "External APIs off, model and database local, no security warnings."
                    : "One or more checks below are not in the local-safe state."}
                </p>
              </div>
            </div>

            {/* Security warnings, verbatim from the backend */}
            {status.security_warnings.length > 0 && (
              <div className="rounded-xl border border-amber-400/30 bg-amber-400/[0.05] px-4 py-3 space-y-1.5">
                <p className="text-xs font-semibold text-amber-300 uppercase tracking-wide">
                  Security warnings ({status.security_warnings.length})
                </p>
                {status.security_warnings.map((w) => (
                  <p key={w} className="text-xs text-amber-200/90 leading-relaxed">
                    • {w}
                  </p>
                ))}
              </div>
            )}

            <div className="space-y-2">
              <Row
                icon={<ShieldCheck className="w-4 h-4" />}
                label="Privacy mode"
                value={status.privacy.mode}
                good={status.privacy.mode === "local_only"}
              />
              <Row
                icon={<BellRing className="w-4 h-4" />}
                label="External API access"
                value={status.privacy.external_api_allowed ? "allowed" : "off"}
                good={!status.privacy.external_api_allowed}
                detail={
                  status.privacy.api_consent_required
                    ? "consent required before any external call"
                    : "no consent gate configured"
                }
              />
              <Row
                icon={<Cpu className="w-4 h-4" />}
                label="Model"
                value={status.model.local ? "local" : "remote"}
                good={status.model.local}
                detail={`${status.model.backend} · ${status.model.base_url} · profile ${status.model.profile}`}
              />
              <Row
                icon={<Database className="w-4 h-4" />}
                label="Database"
                value={status.database.local ? "local" : "remote"}
                good={status.database.local}
                detail={status.database.host}
              />
              <Row
                icon={<Brain className="w-4 h-4" />}
                label="Memory"
                value={status.memory.local ? "local" : "remote"}
                good={status.memory.local}
                detail={`${status.memory.store} · ${status.memory.embedding_model} on ${status.memory.embedding_device}`}
              />
              <Row
                icon={<Mic className="w-4 h-4" />}
                label="Voice profile"
                value={
                  status.voice_profile.enrolled === null
                    ? "unknown"
                    : status.voice_profile.enrolled
                      ? "enrolled"
                      : "not enrolled"
                }
                good={status.voice_profile.enrolled === null ? null : status.voice_profile.enrolled}
                detail={status.voice_profile.enrolled === null ? "database unreachable" : undefined}
              />
              <Row
                icon={<BellRing className="w-4 h-4" />}
                label="Pending approvals"
                value={status.pending_actions === null ? "unknown" : String(status.pending_actions)}
                good={status.pending_actions === null ? null : status.pending_actions === 0}
                detail="side-effecting actions waiting for your confirmation"
              />
              <Row
                icon={<Clock className="w-4 h-4" />}
                label="Last login"
                value={status.last_login ? new Date(status.last_login).toLocaleString() : "not recorded"}
                good={status.last_login ? true : null}
              />
            </div>

            {status.privacy.web_search_enabled && (
              <p className="text-[11px] text-neutral-600 px-1">
                Web search is enabled — research queries can reach the internet through your
                configured local search stack.
              </p>
            )}
          </>
        )}

        {!status && !error && (
          <p className="text-sm text-neutral-600 italic px-1">Loading trust status…</p>
        )}
      </div>
    </div>
  );
}
