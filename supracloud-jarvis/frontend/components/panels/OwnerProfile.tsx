"use client";

/**
 * Owner Profile panel (PR #66) — who IRA serves and how it addresses you.
 *
 * Edits the singleton owner profile: name, preferred title (boss/sir/custom),
 * wake word, and voice-features flag. The role is fixed to Owner Admin — it is
 * shown, never editable — and destructive/outbound actions stay
 * confirmation-gated no matter what. Includes a "run setup again" escape hatch
 * that re-arms the first-run wizard without wiping the profile.
 */

import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import { Crown, RefreshCw, ShieldCheck, Save, RotateCcw } from "lucide-react";
import {
  getOwnerProfile,
  updateOwnerProfile,
  resetOnboarding,
  type OwnerProfile as OwnerProfileData,
} from "@/lib/api";

export default function OwnerProfile({ token }: { token: string }) {
  const [profile, setProfile] = useState<OwnerProfileData | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  // Editable fields
  const [name, setName] = useState("");
  const [preferredTitle, setPreferredTitle] = useState("");
  const [wakeWord, setWakeWord] = useState("ira");
  const [voiceEnabled, setVoiceEnabled] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const p = await getOwnerProfile(token);
      setProfile(p);
      setName(p.name);
      setPreferredTitle(p.preferred_title);
      setWakeWord(p.wake_word || "ira");
      setVoiceEnabled(p.voice_enabled);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Profile unavailable");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    setMsg("");
    setError("");
    try {
      const p = await updateOwnerProfile(token, {
        name,
        preferred_title: preferredTitle,
        wake_word: wakeWord.trim().toLowerCase() || "ira",
        voice_enabled: voiceEnabled,
      });
      setProfile(p);
      setMsg("Saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const rerunSetup = async () => {
    if (!confirm("Run the first-run setup wizard again on next reload? Your profile is kept.")) return;
    try {
      await resetOnboarding(token);
      setMsg("Setup wizard re-armed — reload IRA to run it again.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reset onboarding");
    }
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-2xl mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold tracking-tight flex items-center gap-2">
              Owner Profile
              <span className="inline-flex items-center gap-1 text-[10px] font-medium text-cyan-300 border border-cyan-400/30 bg-cyan-400/[0.07] rounded px-1.5 py-0.5">
                <Crown className="w-3 h-3" /> Owner Admin
              </span>
            </h2>
            <p className="text-xs text-neutral-500 mt-0.5">
              Who IRA serves, and how it should address you.
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
          <div className="rounded-xl border border-rose-400/25 bg-rose-400/[0.06] px-4 py-2.5 text-xs text-rose-300">
            {error}
          </div>
        )}
        {msg && (
          <div className="rounded-xl border border-emerald-400/25 bg-emerald-400/[0.06] px-4 py-2.5 text-xs text-emerald-300">
            {msg}
          </div>
        )}

        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-4 space-y-3">
          <Field label="Owner name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              className="w-full rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-2 text-sm text-neutral-200 focus:border-cyan-400/40 focus:outline-none"
            />
          </Field>
          <Field
            label="Preferred address"
            sub={`IRA replies like: “Yes ${(preferredTitle || "boss").toLowerCase()}, I’m ready.” Used naturally, not in every sentence.`}
          >
            <input
              value={preferredTitle}
              onChange={(e) => setPreferredTitle(e.target.value)}
              placeholder="Boss / Sir / your name / custom"
              maxLength={40}
              className="w-full rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-2 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-cyan-400/40 focus:outline-none"
            />
          </Field>
          <Field label="Wake word" sub="Used by Wake Mode (Voice Setup). Local-only detection.">
            <input
              value={wakeWord}
              onChange={(e) => setWakeWord(e.target.value)}
              maxLength={24}
              className="w-full rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-2 text-sm text-neutral-200 focus:border-cyan-400/40 focus:outline-none"
            />
          </Field>
          <label className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-2.5 cursor-pointer">
            <span>
              <span className="block text-sm text-neutral-200">Voice features</span>
              <span className="block text-[10.5px] text-neutral-600">
                Speech in/out; never required for login.
              </span>
            </span>
            <input
              type="checkbox"
              checked={voiceEnabled}
              onChange={(e) => setVoiceEnabled(e.target.checked)}
              className="accent-cyan-400 w-4 h-4"
            />
          </label>

          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={() => void save()}
              disabled={saving || loading}
              className="flex items-center gap-2 text-xs font-medium text-cyan-300 px-3.5 py-2 rounded-lg border border-cyan-400/25 bg-cyan-400/[0.08] hover:bg-cyan-400/[0.15] transition-colors disabled:opacity-40"
            >
              <Save className="w-3.5 h-3.5" />
              {saving ? "Saving…" : "Save profile"}
            </button>
            <button
              onClick={() => void rerunSetup()}
              className="flex items-center gap-2 text-xs text-neutral-500 hover:text-neutral-300 px-3 py-2 rounded-lg border border-white/10 hover:bg-white/[0.06] transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Run setup again
            </button>
          </div>
        </div>

        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3 flex items-start gap-3">
          <ShieldCheck className="w-4 h-4 text-cyan-400 flex-shrink-0 mt-0.5" />
          <p className="text-[11px] text-neutral-500 leading-relaxed">
            <span className="text-neutral-300 font-medium">
              Role: {profile?.role === "owner_admin" ? "Owner Admin (fixed)" : profile?.role || "Owner Admin"}
            </span>{" "}
            — you have full access to every IRA feature. One safety rule stays on for
            everyone, including you: destructive or outbound actions (delete memory, send
            email, calendar changes, file operations, security settings, external APIs)
            always ask for confirmation first.
          </p>
        </div>
      </div>
    </div>
  );
}

function Field({ label, sub, children }: { label: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-xs text-neutral-400">{label}</p>
      {children}
      {sub && <p className="text-[10.5px] text-neutral-600">{sub}</p>}
    </div>
  );
}
