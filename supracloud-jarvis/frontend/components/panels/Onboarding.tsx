"use client";

/**
 * First-run onboarding (PR #66) — phone-style setup wizard.
 *
 * Shown once, right after the first successful login, when the backend reports
 * first_run_completed=false. Collects the owner's name and preferred form of
 * address, confirms local-only privacy, runs a real system check (/health),
 * points to Voice Setup / Wake Mode, and only then marks the first run done —
 * an interrupted setup shows the wizard again next time.
 *
 * Honest by design: every status shown here comes from a real probe. The admin
 * password itself lives in .env (IRA_ADMIN_PASSWORD) and was already required
 * to log in before this screen can render.
 */

import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import {
  Sparkles,
  User,
  Crown,
  ShieldCheck,
  Activity,
  Mic,
  Ear,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ArrowRight,
  ArrowLeft,
} from "lucide-react";
import { completeOnboarding, getTrustStatus, type TrustStatus } from "@/lib/api";
import { fetchHealth, type Health } from "@/lib/systemStatus";

const TITLE_CHOICES = ["Boss", "Sir"] as const;

type Step = "welcome" | "name" | "title" | "privacy" | "system" | "voice" | "wake" | "finish";
const STEPS: Step[] = ["welcome", "name", "title", "privacy", "system", "voice", "wake", "finish"];

export default function Onboarding({
  token,
  onDone,
}: {
  token: string;
  onDone: () => void;
}) {
  const [step, setStep] = useState<Step>("welcome");
  const [ownerName, setOwnerName] = useState("");
  const [titleChoice, setTitleChoice] = useState<string>("Boss");
  const [customTitle, setCustomTitle] = useState("");
  const [useCustom, setUseCustom] = useState(false);
  const [useName, setUseName] = useState(false);
  const [wakeWord, setWakeWord] = useState("ira");
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [trust, setTrust] = useState<TrustStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const preferredTitle = useName ? ownerName : useCustom ? customTitle : titleChoice;
  const stepIndex = STEPS.indexOf(step);

  const runChecks = useCallback(async () => {
    setChecking(true);
    const [h, t] = await Promise.all([fetchHealth(), getTrustStatus(token).catch(() => null)]);
    setHealth(h);
    setTrust(t);
    setChecking(false);
  }, [token]);

  useEffect(() => {
    if (step === "system" || step === "privacy") void runChecks();
  }, [step, runChecks]);

  const finish = async () => {
    setSaving(true);
    setError("");
    try {
      await completeOnboarding(token, {
        owner_name: ownerName.trim(),
        preferred_title: preferredTitle.trim(),
        wake_word: wakeWord.trim().toLowerCase() || "ira",
        voice_enabled: voiceEnabled,
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save your setup — is the backend up?");
    } finally {
      setSaving(false);
    }
  };

  const next = () => setStep(STEPS[Math.min(stepIndex + 1, STEPS.length - 1)]);
  const back = () => setStep(STEPS[Math.max(stepIndex - 1, 0)]);

  return (
    <div className="h-screen overflow-y-auto bg-neutral-950 flex items-center justify-center p-6">
      <div className="w-full max-w-lg space-y-5">
        {/* Progress dots */}
        <div className="flex items-center justify-center gap-1.5">
          {STEPS.map((s, i) => (
            <span
              key={s}
              className={clsx(
                "h-1.5 rounded-full transition-all",
                i === stepIndex ? "w-6 bg-cyan-400" : i < stepIndex ? "w-1.5 bg-cyan-400/50" : "w-1.5 bg-neutral-800"
              )}
            />
          ))}
        </div>

        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-6 space-y-4">
          {step === "welcome" && (
            <>
              <Sparkles className="w-8 h-8 text-cyan-400" />
              <h1 className="text-xl font-semibold tracking-tight">Welcome to IRA.</h1>
              <p className="text-sm text-neutral-400 leading-relaxed">
                Let&apos;s set up your private assistant. This takes about a minute: your
                profile, how IRA should address you, a privacy check, and optional voice
                and wake-word setup. Everything stays on this machine.
              </p>
            </>
          )}

          {step === "name" && (
            <>
              <User className="w-6 h-6 text-cyan-400" />
              <h2 className="text-lg font-semibold">Create your owner profile</h2>
              <p className="text-xs text-neutral-500">
                You are the Owner Admin — full access to every IRA feature. Destructive or
                outbound actions will still ask for your confirmation, so a slip of the
                tongue can&apos;t delete anything.
              </p>
              <input
                value={ownerName}
                onChange={(e) => setOwnerName(e.target.value)}
                placeholder="Your name (e.g. Praveen)"
                maxLength={80}
                autoFocus
                className="w-full rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2.5 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-cyan-400/40 focus:outline-none"
              />
            </>
          )}

          {step === "title" && (
            <>
              <Crown className="w-6 h-6 text-cyan-400" />
              <h2 className="text-lg font-semibold">How should IRA call you?</h2>
              <p className="text-xs text-neutral-500">
                IRA uses this naturally — &ldquo;Yes {preferredTitle.toLowerCase() || "boss"}, I&apos;m
                listening.&rdquo; — not in every sentence.
              </p>
              <div className="grid grid-cols-2 gap-2">
                {TITLE_CHOICES.map((t) => (
                  <ChoiceButton
                    key={t}
                    active={!useCustom && !useName && titleChoice === t}
                    onClick={() => { setTitleChoice(t); setUseCustom(false); setUseName(false); }}
                    label={t}
                  />
                ))}
                <ChoiceButton
                  active={useName}
                  onClick={() => { setUseName(true); setUseCustom(false); }}
                  label={ownerName.trim() || "My name"}
                />
                <ChoiceButton
                  active={useCustom}
                  onClick={() => { setUseCustom(true); setUseName(false); }}
                  label="Custom…"
                />
              </div>
              {useCustom && (
                <input
                  value={customTitle}
                  onChange={(e) => setCustomTitle(e.target.value)}
                  placeholder="Custom title (e.g. Chief)"
                  maxLength={40}
                  autoFocus
                  className="w-full rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2.5 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-cyan-400/40 focus:outline-none"
                />
              )}
            </>
          )}

          {step === "privacy" && (
            <>
              <ShieldCheck className="w-6 h-6 text-emerald-400" />
              <h2 className="text-lg font-semibold">Privacy &amp; admin password</h2>
              <p className="text-xs text-neutral-500 leading-relaxed">
                Your admin password is the one you just logged in with — it lives in your
                local <code className="text-neutral-400">.env</code> (IRA_ADMIN_PASSWORD) and
                stays the primary way in. Voice is never required to log in.
              </p>
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3 text-xs space-y-1.5">
                <Row
                  label="Privacy mode"
                  ok={trust?.privacy.mode === "local_only"}
                  value={trust ? trust.privacy.mode : checking ? "checking…" : "unknown"}
                />
                <Row
                  label="External APIs"
                  ok={trust ? !trust.privacy.external_api_allowed : null}
                  value={trust ? (trust.privacy.external_api_allowed ? "allowed" : "off") : "unknown"}
                />
              </div>
              {trust && trust.privacy.mode !== "local_only" && (
                <p className="text-xs text-amber-300">
                  Privacy mode is not local_only — you can review this later in the Trust Console.
                </p>
              )}
            </>
          )}

          {step === "system" && (
            <>
              <Activity className="w-6 h-6 text-cyan-400" />
              <h2 className="text-lg font-semibold">System check</h2>
              <p className="text-xs text-neutral-500">
                Live probe of the local stack — nothing here is hardcoded green.
              </p>
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3 text-xs space-y-1.5">
                <Row label="Backend" ok={!!health} value={health ? health.status : checking ? "checking…" : "unreachable"} />
                {health?.services &&
                  Object.entries(health.services).map(([name, svc]) => (
                    <Row key={name} label={name} ok={svc.status === "ok"} value={svc.status} />
                  ))}
              </div>
              <button
                onClick={() => void runChecks()}
                disabled={checking}
                className="text-xs text-cyan-300 hover:text-cyan-200 disabled:opacity-40"
              >
                {checking ? "Checking…" : "Re-check"}
              </button>
            </>
          )}

          {step === "voice" && (
            <>
              <Mic className="w-6 h-6 text-cyan-400" />
              <h2 className="text-lg font-semibold">Voice setup</h2>
              <p className="text-xs text-neutral-500 leading-relaxed">
                Optional and Beta. IRA can speak and listen fully locally, and you can enrol
                your voice so IRA recognises its owner. Raw audio is never stored — only
                voice embeddings. You can do the actual enrolment any time in{" "}
                <span className="text-neutral-300">Voice Setup</span>.
              </p>
              <ToggleRow
                label="Enable voice features"
                sub="Turn on speech in/out; enrol later from the Voice Setup panel."
                on={voiceEnabled}
                onToggle={() => setVoiceEnabled((v) => !v)}
              />
            </>
          )}

          {step === "wake" && (
            <>
              <Ear className="w-6 h-6 text-cyan-400" />
              <h2 className="text-lg font-semibold">Wake word</h2>
              <p className="text-xs text-neutral-500 leading-relaxed">
                Say &ldquo;{wakeWord.toUpperCase()}&rdquo; to wake your assistant when Wake Mode is
                on. Wake Mode is <span className="text-neutral-300">off by default</span> — you
                turn it on from Voice Setup, the mic status is always visible, and detection
                runs locally only.
              </p>
              <input
                value={wakeWord}
                onChange={(e) => setWakeWord(e.target.value)}
                maxLength={24}
                className="w-full rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2.5 text-sm text-neutral-200 focus:border-cyan-400/40 focus:outline-none"
              />
            </>
          )}

          {step === "finish" && (
            <>
              <CheckCircle2 className="w-8 h-8 text-emerald-400" />
              <h2 className="text-lg font-semibold">
                {ownerName.trim() ? `All set, ${preferredTitle.toLowerCase() || ownerName}.` : "All set."}
              </h2>
              <p className="text-sm text-neutral-400 leading-relaxed">
                IRA is ready. You are the Owner Admin, privacy stays local-first, and
                destructive actions will always ask you first. Finish to open your dashboard.
              </p>
              <ul className="text-xs text-neutral-500 space-y-1">
                <li>Owner: <span className="text-neutral-300">{ownerName.trim() || "—"}</span></li>
                <li>Preferred address: <span className="text-neutral-300">{preferredTitle.trim() || "—"}</span></li>
                <li>Wake word: <span className="text-neutral-300">{wakeWord || "ira"}</span> (Wake Mode off until you enable it)</li>
                <li>Voice features: <span className="text-neutral-300">{voiceEnabled ? "enabled" : "off"}</span></li>
              </ul>
            </>
          )}

          {error && (
            <div className="rounded-xl border border-rose-400/25 bg-rose-400/[0.06] px-4 py-2.5 text-xs text-rose-300">
              {error}
            </div>
          )}

          {/* Navigation */}
          <div className="flex items-center justify-between pt-2">
            {stepIndex > 0 ? (
              <button
                onClick={back}
                className="flex items-center gap-1.5 text-xs text-neutral-500 hover:text-neutral-300 px-3 py-2"
              >
                <ArrowLeft className="w-3.5 h-3.5" /> Back
              </button>
            ) : (
              <span />
            )}
            {step === "finish" ? (
              <button
                onClick={() => void finish()}
                disabled={saving || !ownerName.trim()}
                className="flex items-center gap-2 text-sm font-medium text-emerald-300 px-4 py-2 rounded-xl border border-emerald-400/25 bg-emerald-400/[0.1] hover:bg-emerald-400/[0.18] transition-colors disabled:opacity-40"
              >
                {saving ? "Saving…" : "Finish — IRA is ready"}
              </button>
            ) : (
              <button
                onClick={next}
                disabled={step === "name" && !ownerName.trim()}
                className="flex items-center gap-1.5 text-sm font-medium text-cyan-300 px-4 py-2 rounded-xl border border-cyan-400/25 bg-cyan-400/[0.08] hover:bg-cyan-400/[0.15] transition-colors disabled:opacity-40"
              >
                {step === "welcome" ? "Start setup" : "Next"} <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        <p className="text-center text-[10px] text-neutral-700">
          Local-first · your hardware · your rules
        </p>
      </div>
    </div>
  );
}

function ChoiceButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        "rounded-xl border px-4 py-2.5 text-sm transition-colors",
        active
          ? "border-cyan-400/40 bg-cyan-400/[0.1] text-cyan-200 font-medium"
          : "border-white/10 bg-white/[0.02] text-neutral-400 hover:border-white/20"
      )}
    >
      {label}
    </button>
  );
}

function Row({ label, ok, value }: { label: string; ok: boolean | null; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-neutral-400">{label}</span>
      <span className="flex items-center gap-1.5">
        {ok === true ? (
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
        ) : ok === false ? (
          <XCircle className="w-3.5 h-3.5 text-rose-400" />
        ) : (
          <AlertTriangle className="w-3.5 h-3.5 text-neutral-600" />
        )}
        <span className={clsx(ok === true ? "text-emerald-300" : ok === false ? "text-rose-300" : "text-neutral-500")}>
          {value}
        </span>
      </span>
    </div>
  );
}

function ToggleRow({ label, sub, on, onToggle }: { label: string; sub: string; on: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className="w-full flex items-center justify-between gap-3 rounded-xl border border-white/[0.07] bg-white/[0.02] px-4 py-3 text-left hover:border-white/[0.15] transition-colors"
    >
      <span>
        <span className="block text-sm text-neutral-200">{label}</span>
        <span className="block text-[10.5px] text-neutral-600">{sub}</span>
      </span>
      <span
        className={clsx(
          "relative inline-flex h-5 w-9 flex-shrink-0 rounded-full transition-colors",
          on ? "bg-cyan-400/70" : "bg-neutral-700"
        )}
      >
        <span
          className={clsx(
            "absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform",
            on && "translate-x-4"
          )}
        />
      </span>
    </button>
  );
}
