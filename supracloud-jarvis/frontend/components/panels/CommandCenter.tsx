"use client";

/**
 * Command Center (PR #68) — you command, IRA plans, you approve risk, it acts.
 *
 * Every submission shows the backend's real plan (intent, steps, risk).
 * Low-risk commands execute immediately; medium risk shows the exact preview
 * and executes only after "Approve"; access grants are never executed here —
 * the panel points to the secure wizard. History below shows honest statuses:
 * a run that didn't execute says so.
 */

import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import {
  TerminalSquare,
  Send,
  RefreshCw,
  Check,
  X,
  ShieldAlert,
  CircleSlash,
  HelpCircle,
} from "lucide-react";
import {
  runCommand,
  getCommandHistory,
  type CommandResponse,
  type CommandRun,
} from "@/lib/api";
import { useUIStore, type WorkspaceView } from "@/lib/store";

const SUGGESTIONS = [
  "Create a private database for project Aurora",
  "Create a new project called Aurora",
  "Save memory that this project is important",
  "Check if my app is running",
  "Create a backup",
  "Open memory vault",
];

const RISK_STYLE: Record<string, string> = {
  low: "text-emerald-300 border-emerald-400/25 bg-emerald-400/[0.07]",
  medium: "text-amber-300 border-amber-400/30 bg-amber-400/[0.07]",
  high: "text-rose-300 border-rose-400/30 bg-rose-400/[0.07]",
  critical: "text-rose-200 border-rose-400/50 bg-rose-400/[0.15]",
};

const STATUS_LABEL: Record<string, string> = {
  executed: "Executed",
  failed: "Failed",
  awaiting_confirmation: "Not executed — awaiting your approval",
  clarification: "Not executed — needs clarification",
  needs_wizard: "Not executed — use the secure access wizard",
  routed_people_flow: "Not executed — routed to People & Relationships",
  blocked: "Not executed — blocked by the risk engine",
};

export default function CommandCenter({ token }: { token: string }) {
  const setView = useUIStore((s) => s.setView);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [current, setCurrent] = useState<CommandResponse | null>(null);
  const [lastText, setLastText] = useState("");
  const [history, setHistory] = useState<CommandRun[]>([]);
  const [historyNote, setHistoryNote] = useState("");

  const loadHistory = useCallback(async () => {
    try {
      const h = await getCommandHistory(token);
      setHistory(h.runs);
      setHistoryNote(h.detail ?? "");
    } catch {
      setHistoryNote("History unavailable.");
    }
  }, [token]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const submit = async (confirmToken?: string) => {
    const cmd = confirmToken ? lastText : text.trim();
    if (!cmd) return;
    setBusy(true);
    setError("");
    try {
      const res = await runCommand(token, cmd, { confirmToken });
      setCurrent(res);
      setLastText(cmd);
      if (res.status === "executed") {
        setText("");
        // open_panel actually navigates
        const panel = (res.result as { panel?: string } | undefined)?.panel;
        if (panel) setView(panel as WorkspaceView);
      }
      await loadHistory();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Command failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-2xl mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold tracking-tight flex items-center gap-2">
              <TerminalSquare className="w-5 h-5 text-cyan-400" />
              Command Center
              <span className="text-[10px] font-medium text-amber-300 border border-amber-400/30 bg-amber-400/[0.07] rounded px-1.5 py-0.5">
                BETA
              </span>
            </h2>
            <p className="text-xs text-neutral-500 mt-0.5">
              Say what you want. IRA plans it, asks only when risk requires it, then reports back.
            </p>
          </div>
          <button
            onClick={() => void loadHistory()}
            className="flex items-center gap-1.5 text-xs text-neutral-400 hover:text-white px-2.5 py-1.5 rounded-lg border border-white/10 hover:bg-white/[0.06]"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
        </div>

        {/* Input */}
        <div className="flex gap-2">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !busy && void submit()}
            placeholder='e.g. "Create a private database for project Aurora"'
            maxLength={500}
            className="flex-1 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2.5 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-cyan-400/40 focus:outline-none"
          />
          <button
            onClick={() => void submit()}
            disabled={busy || !text.trim()}
            className="flex items-center gap-2 text-xs font-medium text-cyan-300 px-4 py-2.5 rounded-xl border border-cyan-400/25 bg-cyan-400/[0.08] hover:bg-cyan-400/[0.15] disabled:opacity-40"
          >
            <Send className="w-3.5 h-3.5" /> {busy ? "…" : "Run"}
          </button>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              onClick={() => setText(s)}
              className="text-[10.5px] text-neutral-500 hover:text-neutral-300 px-2.5 py-1 rounded-lg border border-white/[0.06] hover:border-white/[0.15]"
            >
              {s}
            </button>
          ))}
        </div>

        {error && (
          <div className="rounded-xl border border-rose-400/25 bg-rose-400/[0.06] px-4 py-2.5 text-xs text-rose-300">
            {error}
          </div>
        )}

        {/* Current run: plan + status */}
        {current && (
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-4 space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-neutral-300 font-medium">{current.plan.intent}</span>
              {current.plan.target && (
                <span className="text-xs text-neutral-500">→ {current.plan.target}</span>
              )}
              <span
                className={clsx(
                  "text-[10px] px-1.5 py-0.5 rounded border",
                  RISK_STYLE[current.plan.risk] ?? RISK_STYLE.high
                )}
              >
                risk: {current.plan.risk}
              </span>
              <StatusChip status={current.status} />
            </div>

            <ol className="text-[11px] text-neutral-500 space-y-0.5 list-decimal list-inside">
              {current.plan.steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>

            {current.status === "awaiting_confirmation" && current.token && (
              <div className="rounded-xl border border-amber-400/25 bg-amber-400/[0.05] px-3.5 py-3 space-y-2">
                <p className="text-xs text-amber-200 break-words">{current.preview}</p>
                <div className="flex gap-2">
                  <button
                    onClick={() => void submit(current.token)}
                    disabled={busy}
                    className="flex items-center gap-1.5 text-xs font-medium text-emerald-300 px-3.5 py-2 rounded-lg border border-emerald-400/25 bg-emerald-400/[0.1] disabled:opacity-40"
                  >
                    <Check className="w-3.5 h-3.5" /> Approve — run it
                  </button>
                  <button
                    onClick={() => setCurrent(null)}
                    className="flex items-center gap-1.5 text-xs text-neutral-400 px-3.5 py-2 rounded-lg border border-white/10"
                  >
                    <X className="w-3.5 h-3.5" /> Cancel
                  </button>
                </div>
              </div>
            )}

            {(current.result?.detail || current.detail) && (
              <p
                className={clsx(
                  "text-xs leading-relaxed",
                  current.status === "executed"
                    ? "text-emerald-300"
                    : current.status === "failed"
                      ? "text-rose-300"
                      : "text-neutral-400"
                )}
              >
                {String(current.result?.detail ?? current.detail)}
              </p>
            )}

            {current.status === "needs_wizard" && (
              <button
                onClick={() => setView("memory")}
                className="text-xs text-cyan-300 hover:text-cyan-200"
              >
                Open People &amp; Relationships →
              </button>
            )}
          </div>
        )}

        {/* History */}
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-neutral-600 px-1 mb-2">
            Recent commands
          </p>
          {historyNote && <p className="text-[11px] text-neutral-600 px-1 mb-1">{historyNote}</p>}
          {history.length === 0 ? (
            <p className="text-xs text-neutral-600 italic px-1">No commands yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {history.map((r) => (
                <li
                  key={r.id}
                  className="rounded-xl border border-white/[0.05] bg-white/[0.02] px-3.5 py-2.5"
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs text-neutral-300 truncate">{r.raw_text}</p>
                    <span
                      className={clsx(
                        "text-[10px] px-1.5 py-0.5 rounded border flex-shrink-0",
                        RISK_STYLE[r.risk] ?? RISK_STYLE.high
                      )}
                    >
                      {r.risk}
                    </span>
                  </div>
                  <p className="text-[10.5px] text-neutral-600 mt-0.5">
                    {r.intent} · {STATUS_LABEL[r.status] ?? r.status}
                    {r.created_at ? ` · ${new Date(r.created_at).toLocaleTimeString()}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="text-[10px] text-neutral-700 px-1 pb-4">
          Low risk runs automatically. Medium risk needs your approval of the exact plan. Access
          grants, deletions, outbound actions and security changes can never run from a plain
          command.
        </p>
      </div>
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  const map: Record<string, { icon: React.ReactNode; cls: string }> = {
    executed: { icon: <Check className="w-3 h-3" />, cls: "text-emerald-300 border-emerald-400/25 bg-emerald-400/[0.07]" },
    failed: { icon: <X className="w-3 h-3" />, cls: "text-rose-300 border-rose-400/30 bg-rose-400/[0.07]" },
    awaiting_confirmation: { icon: <ShieldAlert className="w-3 h-3" />, cls: "text-amber-300 border-amber-400/30 bg-amber-400/[0.07]" },
    needs_wizard: { icon: <ShieldAlert className="w-3 h-3" />, cls: "text-amber-300 border-amber-400/30 bg-amber-400/[0.07]" },
    routed_people_flow: { icon: <HelpCircle className="w-3 h-3" />, cls: "text-cyan-300 border-cyan-400/25 bg-cyan-400/[0.07]" },
    clarification: { icon: <HelpCircle className="w-3 h-3" />, cls: "text-neutral-400 border-white/10 bg-white/[0.03]" },
    blocked: { icon: <CircleSlash className="w-3 h-3" />, cls: "text-rose-200 border-rose-400/50 bg-rose-400/[0.15]" },
  };
  const m = map[status] ?? map.clarification;
  return (
    <span className={clsx("inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border", m.cls)}>
      {m.icon} {STATUS_LABEL[status] ?? status}
    </span>
  );
}
