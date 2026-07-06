"use client";

/**
 * Memory Vault v1 — owner CRUD over IRA's curated long-term memories.
 *
 * Talks to /api/v1/memory (list / save / edit / pin / forget). Forget is
 * NEVER one click: the first delete call returns a confirmation draft from
 * the backend guardrail (preview + one-time token) and only confirming that
 * exact draft executes the deletion. Memories are stored and shown verbatim
 * as the owner's data — IRA treats them as reference material, never as
 * instructions.
 */

import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import {
  Pin,
  PinOff,
  Pencil,
  Trash2,
  Plus,
  Search,
  RefreshCw,
  X,
  Check,
  AlertTriangle,
} from "lucide-react";
import {
  listMemories,
  createMemory,
  updateMemory,
  pinMemory,
  forgetMemory,
  type VaultMemory,
  type ForgetDraft,
} from "@/lib/api";
import PeopleSection from "@/components/panels/PeopleSection";

// Suggested categories from the Personal v1 plan; the backend accepts any slug.
const KINDS = [
  "profile",
  "projects",
  "job_search",
  "decisions",
  "preferences",
  "documents",
  "reminders",
  "goals",
  "note",
];

interface PendingForget {
  memoryId: string;
  draft: ForgetDraft;
}

export default function MemoryVault({ token }: { token: string }) {
  const [memories, setMemories] = useState<VaultMemory[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [kindFilter, setKindFilter] = useState("");
  const [query, setQuery] = useState("");

  // Add form
  const [adding, setAdding] = useState(false);
  const [newContent, setNewContent] = useState("");
  const [newKind, setNewKind] = useState("note");
  const [newPinned, setNewPinned] = useState(false);

  // Inline edit
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");

  // Two-step forget
  const [pendingForget, setPendingForget] = useState<PendingForget | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await listMemories(token, {
        kind: kindFilter || undefined,
        q: query || undefined,
      });
      setMemories(res.memories);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load memories");
    } finally {
      setLoading(false);
    }
  }, [token, kindFilter, query]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleAdd = async () => {
    if (!newContent.trim()) return;
    setBusyId("new");
    setError("");
    try {
      await createMemory(token, newContent.trim(), newKind, newPinned);
      setNewContent("");
      setNewPinned(false);
      setAdding(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusyId(null);
    }
  };

  const handleEditSave = async (id: string) => {
    if (!editContent.trim()) return;
    setBusyId(id);
    setError("");
    try {
      await updateMemory(token, id, editContent.trim());
      setEditingId(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Edit failed");
    } finally {
      setBusyId(null);
    }
  };

  const handlePin = async (m: VaultMemory) => {
    setBusyId(m.id);
    setError("");
    try {
      await pinMemory(token, m.id, !m.pinned);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Pin failed");
    } finally {
      setBusyId(null);
    }
  };

  /** Step 1: request a forget draft — the backend deletes nothing yet. */
  const requestForget = async (m: VaultMemory) => {
    setBusyId(m.id);
    setError("");
    try {
      const res = await forgetMemory(token, m.id);
      if ("status" in res && res.status === "confirmation_required") {
        setPendingForget({ memoryId: m.id, draft: res });
      } else {
        // Unexpected: guardrail should always demand confirmation first.
        await load();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Forget request failed");
    } finally {
      setBusyId(null);
    }
  };

  /** Step 2: confirm with the one-time token — this is what actually deletes. */
  const confirmForget = async () => {
    if (!pendingForget) return;
    setBusyId(pendingForget.memoryId);
    setError("");
    try {
      await forgetMemory(token, pendingForget.memoryId, pendingForget.draft.token);
      setPendingForget(null);
      await load();
    } catch (e) {
      setError(
        e instanceof Error
          ? `${e.message} — the confirmation may have expired; request forget again.`
          : "Confirm failed"
      );
      setPendingForget(null);
    } finally {
      setBusyId(null);
    }
  };

  const pinned = memories.filter((m) => m.pinned);
  const unpinned = memories.filter((m) => !m.pinned);

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-2xl mx-auto space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Memory Vault</h2>
            <p className="text-xs text-neutral-500 mt-0.5">
              Your curated memories — stored locally, used by IRA as reference only, never as
              instructions.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void load()}
              disabled={loading}
              className="p-2 rounded-lg border border-white/10 text-neutral-400 hover:text-white hover:bg-white/[0.06] transition-colors disabled:opacity-40"
              title="Reload"
            >
              <RefreshCw className={clsx("w-3.5 h-3.5", loading && "animate-spin")} />
            </button>
            <button
              onClick={() => setAdding((a) => !a)}
              className="flex items-center gap-1.5 text-xs font-medium text-cyan-300 px-3 py-2 rounded-lg border border-cyan-400/25 bg-cyan-400/[0.06] hover:bg-cyan-400/[0.12] transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              New memory
            </button>
          </div>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[180px]">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-600" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search memories…"
              className="w-full pl-8 pr-3 py-2 rounded-lg bg-white/[0.03] border border-white/10 text-xs text-neutral-200 placeholder-neutral-600 focus:outline-none focus:border-cyan-400/40"
            />
          </div>
          <select
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value)}
            className="px-2.5 py-2 rounded-lg bg-neutral-900 border border-white/10 text-xs text-neutral-300 focus:outline-none"
          >
            <option value="">All categories</option>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k.replace("_", " ")}
              </option>
            ))}
          </select>
        </div>

        {error && (
          <div className="rounded-xl border border-rose-400/25 bg-rose-400/[0.06] px-4 py-2.5 text-xs text-rose-300">
            {error}
          </div>
        )}

        {/* Add form */}
        {adding && (
          <div className="rounded-xl border border-cyan-400/20 bg-cyan-400/[0.03] p-3 space-y-2">
            <textarea
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              placeholder="What should IRA remember? (stored verbatim, locally)"
              rows={3}
              className="w-full px-3 py-2 rounded-lg bg-neutral-950/60 border border-white/10 text-sm text-neutral-200 placeholder-neutral-600 focus:outline-none focus:border-cyan-400/40 resize-y"
            />
            <div className="flex items-center gap-2 flex-wrap">
              <select
                value={newKind}
                onChange={(e) => setNewKind(e.target.value)}
                className="px-2.5 py-1.5 rounded-lg bg-neutral-900 border border-white/10 text-xs text-neutral-300 focus:outline-none"
              >
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k.replace("_", " ")}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-1.5 text-xs text-neutral-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={newPinned}
                  onChange={(e) => setNewPinned(e.target.checked)}
                  className="accent-cyan-400"
                />
                Pin
              </label>
              <div className="ml-auto flex items-center gap-2">
                <button
                  onClick={() => setAdding(false)}
                  className="text-xs text-neutral-500 hover:text-neutral-300 px-2 py-1.5"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void handleAdd()}
                  disabled={!newContent.trim() || busyId === "new"}
                  className="text-xs font-medium text-cyan-300 px-3 py-1.5 rounded-lg border border-cyan-400/25 bg-cyan-400/[0.08] hover:bg-cyan-400/[0.15] transition-colors disabled:opacity-40"
                >
                  Save memory
                </button>
              </div>
            </div>
          </div>
        )}

        {/* List */}
        {!loading && memories.length === 0 && !error && (
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-8 text-center">
            <p className="text-sm text-neutral-500">No memories in the vault yet.</p>
            <p className="text-xs text-neutral-700 mt-1">
              Save your first one with “New memory” — your profile, projects, preferences, goals.
            </p>
          </div>
        )}

        {[...pinned, ...unpinned].map((m) => {
          const isEditing = editingId === m.id;
          const busy = busyId === m.id;
          return (
            <div
              key={m.id}
              className={clsx(
                "rounded-xl border px-4 py-3 transition-colors",
                m.pinned
                  ? "border-violet-400/20 bg-violet-400/[0.04]"
                  : "border-white/[0.06] bg-white/[0.02]"
              )}
            >
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-[10px] px-1.5 py-0.5 rounded border border-white/10 text-neutral-500 uppercase tracking-wide">
                  {m.kind.replace("_", " ")}
                </span>
                {m.pinned && (
                  <span className="text-[10px] text-violet-300 flex items-center gap-1">
                    <Pin className="w-2.5 h-2.5" /> pinned
                  </span>
                )}
                {m.created_at && (
                  <span className="text-[10px] text-neutral-700 ml-auto">
                    {new Date(m.created_at).toLocaleDateString()}
                  </span>
                )}
              </div>

              {isEditing ? (
                <div className="space-y-2">
                  <textarea
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    rows={3}
                    className="w-full px-3 py-2 rounded-lg bg-neutral-950/60 border border-white/10 text-sm text-neutral-200 focus:outline-none focus:border-cyan-400/40 resize-y"
                  />
                  <div className="flex items-center gap-2 justify-end">
                    <button
                      onClick={() => setEditingId(null)}
                      className="text-xs text-neutral-500 hover:text-neutral-300 px-2 py-1"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => void handleEditSave(m.id)}
                      disabled={busy || !editContent.trim()}
                      className="flex items-center gap-1 text-xs font-medium text-emerald-300 px-2.5 py-1 rounded-lg border border-emerald-400/25 bg-emerald-400/[0.08] disabled:opacity-40"
                    >
                      <Check className="w-3 h-3" /> Save
                    </button>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-neutral-200 whitespace-pre-wrap break-words leading-relaxed">
                  {m.content}
                </p>
              )}

              {!isEditing && (
                <div className="flex items-center gap-1 mt-2">
                  <button
                    onClick={() => void handlePin(m)}
                    disabled={busy}
                    className="flex items-center gap-1 text-[11px] text-neutral-500 hover:text-violet-300 px-2 py-1 rounded-md hover:bg-white/[0.05] transition-colors disabled:opacity-40"
                  >
                    {m.pinned ? <PinOff className="w-3 h-3" /> : <Pin className="w-3 h-3" />}
                    {m.pinned ? "Unpin" : "Pin"}
                  </button>
                  <button
                    onClick={() => {
                      setEditingId(m.id);
                      setEditContent(m.content);
                    }}
                    disabled={busy}
                    className="flex items-center gap-1 text-[11px] text-neutral-500 hover:text-cyan-300 px-2 py-1 rounded-md hover:bg-white/[0.05] transition-colors disabled:opacity-40"
                  >
                    <Pencil className="w-3 h-3" /> Edit
                  </button>
                  <button
                    onClick={() => void requestForget(m)}
                    disabled={busy}
                    className="flex items-center gap-1 text-[11px] text-neutral-600 hover:text-rose-300 px-2 py-1 rounded-md hover:bg-rose-400/[0.06] transition-colors ml-auto disabled:opacity-40"
                  >
                    <Trash2 className="w-3 h-3" /> Forget…
                  </button>
                </div>
              )}
            </div>
          );
        })}

        {/* PR #67: relationship memory + delegated access live with the vault */}
        <PeopleSection token={token} />

        <p className="text-[10px] text-neutral-700 px-1 pb-4">
          Memories are your data: IRA reads them as labelled reference context and never executes
          them as instructions. Forgetting always requires a second, explicit confirmation.
        </p>
      </div>

      {/* Forget confirmation — renders the backend's own draft preview */}
      {pendingForget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-2xl border border-rose-400/25 bg-neutral-950 p-5 space-y-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-rose-400 flex-shrink-0 mt-0.5" />
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-rose-300">Confirm forget</h3>
                <p className="text-xs text-neutral-400 mt-1.5 leading-relaxed break-words">
                  {pendingForget.draft.preview}
                </p>
                <p className="text-[10px] text-neutral-600 mt-2">
                  This confirmation expires in {Math.round(pendingForget.draft.expires_in)}s.
                  Nothing has been deleted yet.
                </p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setPendingForget(null)}
                className="flex items-center gap-1 text-xs text-neutral-400 hover:text-white px-3 py-2 rounded-lg border border-white/10 hover:bg-white/[0.06] transition-colors"
              >
                <X className="w-3 h-3" /> Keep memory
              </button>
              <button
                onClick={() => void confirmForget()}
                disabled={busyId === pendingForget.memoryId}
                className="flex items-center gap-1 text-xs font-medium text-rose-300 px-3 py-2 rounded-lg border border-rose-400/30 bg-rose-400/[0.1] hover:bg-rose-400/[0.18] transition-colors disabled:opacity-40"
              >
                <Trash2 className="w-3 h-3" /> Forget permanently
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
