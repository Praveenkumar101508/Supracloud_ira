"use client";

/**
 * Voice Setup v1 — status + guided owner enrolment.
 *
 * Voice is BETA. Password login is and stays the primary way in — voice is
 * never required for login, and a failed voice check never locks you out.
 *
 * Status shown here is real: enrolment state comes from
 * /api/v1/voice/profile/status; STT/TTS reachability comes from the
 * /health/detail voice pillar when the backend reports it, otherwise the
 * screen says so instead of pretending.
 *
 * Enrolment records 5 short clips in the browser, converts them to 16 kHz
 * mono WAV in memory, and uploads them with a one-time anti-replay challenge.
 * Raw audio is never stored — the backend keeps only voice embeddings.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Mic, Square, RefreshCw, ShieldCheck, Info, CheckCircle2, Circle, Ear } from "lucide-react";
import {
  getVoiceProfileStatus,
  getVoiceChallenge,
  enrollVoice,
  getHealthDetail,
  getWakeStatus,
  setWakeMode,
  type VoiceProfileStatus,
  type WakeStatus,
} from "@/lib/api";
import { WavRecorder } from "@/lib/voice/wavRecorder";

const ENROLL_CLIPS = 5;
const MIN_CLIP_SEC = 3;

// The one-time challenge phrase (anti-replay) is read first; these keep the
// remaining clips varied so the profile generalises.
const EXTRA_PHRASES = [
  "My voice is my key — verify me.",
  "IRA, this is your owner speaking clearly.",
  "Today I am enrolling my voice profile locally.",
  "Security and privacy stay on this machine.",
];

type EnrollStep = "idle" | "recording" | "processing" | "done" | "error";

export default function VoiceSetup({ token }: { token: string }) {
  const [profile, setProfile] = useState<VoiceProfileStatus | null>(null);
  const [voicePillar, setVoicePillar] = useState<string>("not reported");
  const [sttTts, setSttTts] = useState<{ stt: string; tts: string }>({
    stt: "not reported",
    tts: "not reported",
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Enrolment flow
  // Wake Mode v1 (PR #66)
  const [wake, setWake] = useState<WakeStatus | null>(null);
  const [wakeBusy, setWakeBusy] = useState(false);
  const [wakeMsg, setWakeMsg] = useState("");

  const [enrolling, setEnrolling] = useState(false);
  const [challengePhrase, setChallengePhrase] = useState("");
  const challengeIdRef = useRef("");
  const [clips, setClips] = useState<Blob[]>([]);
  const [step, setStep] = useState<EnrollStep>("idle");
  const [stepMsg, setStepMsg] = useState("");
  const recorderRef = useRef<WavRecorder | null>(null);
  const [recSeconds, setRecSeconds] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [p, detail] = await Promise.all([getVoiceProfileStatus(token), getHealthDetail()]);
      setProfile(p);
      const pillars = (detail as { pillars?: Record<string, unknown> } | null)?.pillars;
      const voice = pillars?.voice as { configured?: boolean; note?: string } | undefined;
      if (voice && typeof voice.configured === "boolean") {
        setVoicePillar(voice.configured ? "configured" : "not configured");
      }
      // STT (/voice/transcribe) and TTS (/voice/say) run in-process; the
      // health payload doesn't probe them individually, so stay honest.
      setSttTts({
        stt: "available when the API is up (faster-whisper, local)",
        tts: "available when the API is up (local TTS)",
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Voice status unavailable");
    } finally {
      setLoading(false);
    }
  }, [token]);

  const loadWake = useCallback(async () => {
    try {
      setWake(await getWakeStatus(token));
    } catch {
      setWake(null);
    }
  }, [token]);

  useEffect(() => {
    void load();
    void loadWake();
    // The mic state is live (listening/awake/processing) — poll it lightly.
    const id = setInterval(() => void loadWake(), 5_000);
    return () => {
      clearInterval(id);
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [load, loadWake]);

  const toggleWake = async () => {
    if (!wake) return;
    setWakeBusy(true);
    setWakeMsg("");
    try {
      const next = await setWakeMode(token, !wake.enabled);
      setWake(next);
      if (!wake.enabled && !next.enabled) {
        setWakeMsg(next.reason ?? "Wake Mode could not start — wake-word stack unavailable on this machine.");
      }
    } catch (e) {
      setWakeMsg(e instanceof Error ? e.message : "Wake Mode toggle failed");
    } finally {
      setWakeBusy(false);
    }
  };

  const beginEnrolment = async () => {
    setError("");
    setStep("idle");
    setStepMsg("");
    setClips([]);
    try {
      const ch = await getVoiceChallenge(token);
      challengeIdRef.current = ch.challenge_id;
      setChallengePhrase(ch.phrase);
      setEnrolling(true);
    } catch (e) {
      setError(
        e instanceof Error
          ? `Could not start enrolment: ${e.message}`
          : "Could not start enrolment"
      );
    }
  };

  const startClip = async () => {
    setError("");
    try {
      const rec = new WavRecorder();
      await rec.start();
      recorderRef.current = rec;
      setStep("recording");
      setRecSeconds(0);
      timerRef.current = setInterval(() => setRecSeconds((s) => s + 1), 1000);
    } catch {
      setError("Microphone access denied or unavailable.");
      setStep("error");
    }
  };

  const stopClip = async () => {
    if (timerRef.current) clearInterval(timerRef.current);
    const rec = recorderRef.current;
    if (!rec) return;
    recorderRef.current = null;
    const { blob, durationSec } = await rec.stop();
    if (durationSec < MIN_CLIP_SEC) {
      setStepMsg(`Clip too short (${durationSec.toFixed(1)}s) — speak for at least ${MIN_CLIP_SEC}s.`);
      setStep("idle");
      return;
    }
    setStepMsg("");
    setClips((c) => [...c, blob]);
    setStep("idle");
  };

  const submitEnrolment = async () => {
    setStep("processing");
    setStepMsg("Computing your voice profile locally…");
    try {
      const res = await enrollVoice(token, clips, challengeIdRef.current);
      setStep("done");
      setStepMsg(res.message);
      setClips([]);
      setEnrolling(false);
      await load();
    } catch (e) {
      setStep("error");
      setStepMsg(
        e instanceof Error
          ? `${e.message} — the one-time challenge may have expired; restart enrolment.`
          : "Enrolment failed"
      );
    }
  };

  const phrases = [challengePhrase, ...EXTRA_PHRASES];
  const nextPhrase = phrases[Math.min(clips.length, phrases.length - 1)];

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-2xl mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">
              Voice Setup{" "}
              <span className="text-[10px] font-medium text-amber-300 border border-amber-400/30 bg-amber-400/[0.07] rounded px-1.5 py-0.5 align-middle ml-1">
                BETA
              </span>
            </h2>
            <p className="text-xs text-neutral-500 mt-0.5">
              Speech in and out, plus optional owner voice verification.
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

        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3 flex items-start gap-3">
          <ShieldCheck className="w-4 h-4 text-cyan-400 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-neutral-400 leading-relaxed">
            <span className="text-neutral-200 font-medium">Password login stays primary.</span>{" "}
            Voice is never required to log in, and a failed voice check can never lock you out.
            Voice data stays on this machine: raw recordings are processed in memory and only
            voice embeddings are stored.
          </p>
        </div>

        {error && (
          <div className="rounded-xl border border-rose-400/25 bg-rose-400/[0.06] px-4 py-2.5 text-xs text-rose-300">
            {error}
          </div>
        )}

        {/* Status rows */}
        <div className="space-y-2">
          <StatusRow
            label="Owner voice profile"
            value={
              profile === null
                ? "loading…"
                : profile.enrolled
                  ? `enrolled${profile.enrolled_at ? ` · ${new Date(profile.enrolled_at).toLocaleDateString()}` : ""}`
                  : "not enrolled"
            }
            good={profile?.enrolled ?? null}
          />
          <StatusRow label="Voice service config" value={voicePillar} good={voicePillar === "configured" ? true : voicePillar === "not reported" ? null : false} />
          <StatusRow label="Speech-to-text (STT)" value={sttTts.stt} good={null} />
          <StatusRow label="Text-to-speech (TTS)" value={sttTts.tts} good={null} />
        </div>

        {/* Wake Mode v1 — visible, local-only, OFF by default */}
        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Ear className="w-4 h-4 text-cyan-400" />
              <h3 className="text-sm font-semibold">
                Wake Mode{" "}
                <span className="text-[10px] font-medium text-amber-300 border border-amber-400/30 bg-amber-400/[0.07] rounded px-1.5 py-0.5 align-middle ml-1">
                  BETA
                </span>
              </h3>
            </div>
            <button
              onClick={() => void toggleWake()}
              disabled={wakeBusy || wake === null}
              className={clsx(
                "text-xs font-medium px-3.5 py-1.5 rounded-lg border transition-colors disabled:opacity-40",
                wake?.enabled
                  ? "text-emerald-300 border-emerald-400/25 bg-emerald-400/[0.1] hover:bg-emerald-400/[0.18]"
                  : "text-neutral-300 border-white/10 bg-white/[0.04] hover:bg-white/[0.08]"
              )}
            >
              {wakeBusy ? "…" : wake?.enabled ? "On — turn off" : "Off — turn on"}
            </button>
          </div>

          <div className="flex items-center gap-2">
            <MicStateChip state={wake ? (wake.enabled ? wake.state : "off") : "off"} />
            <span className="text-[11px] text-neutral-500">
              Wake word: <span className="text-neutral-300">“{wake?.wake_word ?? "ira"}”</span>
              {wake && !wake.available && (
                <span className="text-amber-300"> · wake-word stack unavailable on this machine</span>
              )}
            </span>
          </div>

          {wakeMsg && <p className="text-xs text-amber-300 leading-relaxed">{wakeMsg}</p>}

          <p className="text-[11px] text-neutral-500 leading-relaxed">
            Off by default. When on, the mic scans locally for the wake word only — the
            status above is always visible, detection never leaves this machine, raw audio
            is processed in memory and never stored, and only your enrolled voice can wake
            IRA. Wake Mode cannot enable external APIs or change privacy settings.
          </p>
        </div>

        {/* Enrolment */}
        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-4 space-y-3">
          <h3 className="text-sm font-semibold">Owner voice enrolment</h3>
          <p className="text-xs text-neutral-500 leading-relaxed">
            Record {ENROLL_CLIPS} short clips (≥{MIN_CLIP_SEC}s each) reading the phrases below.
            The first phrase is a one-time anti-replay challenge from the backend. Clips are
            converted to 16 kHz WAV in your browser and uploaded once; only embeddings are kept.
          </p>

          {!enrolling ? (
            <button
              onClick={() => void beginEnrolment()}
              className="flex items-center gap-2 text-xs font-medium text-cyan-300 px-3.5 py-2 rounded-lg border border-cyan-400/25 bg-cyan-400/[0.08] hover:bg-cyan-400/[0.15] transition-colors"
            >
              <Mic className="w-3.5 h-3.5" />
              {profile?.enrolled ? "Re-enrol voice profile" : "Start enrolment"}
            </button>
          ) : (
            <div className="space-y-3">
              {/* Progress */}
              <div className="flex items-center gap-1.5">
                {Array.from({ length: ENROLL_CLIPS }).map((_, i) =>
                  i < clips.length ? (
                    <CheckCircle2 key={i} className="w-4 h-4 text-emerald-400" />
                  ) : (
                    <Circle key={i} className="w-4 h-4 text-neutral-700" />
                  )
                )}
                <span className="text-[11px] text-neutral-500 ml-1">
                  {clips.length}/{ENROLL_CLIPS} clips
                </span>
              </div>

              {clips.length < ENROLL_CLIPS && (
                <>
                  <div className="rounded-xl border border-cyan-400/20 bg-cyan-400/[0.04] px-4 py-3">
                    <p className="text-[10px] uppercase tracking-wider text-neutral-600 mb-1">
                      Read aloud — clip {clips.length + 1}
                    </p>
                    <p className="text-sm text-cyan-200 leading-relaxed">“{nextPhrase}”</p>
                  </div>

                  {step === "recording" ? (
                    <button
                      onClick={() => void stopClip()}
                      className="flex items-center gap-2 text-xs font-medium text-rose-300 px-3.5 py-2 rounded-lg border border-rose-400/30 bg-rose-400/[0.1] hover:bg-rose-400/[0.18] transition-colors"
                    >
                      <Square className="w-3.5 h-3.5" />
                      Stop ({recSeconds}s)
                    </button>
                  ) : (
                    <button
                      onClick={() => void startClip()}
                      disabled={step === "processing"}
                      className="flex items-center gap-2 text-xs font-medium text-cyan-300 px-3.5 py-2 rounded-lg border border-cyan-400/25 bg-cyan-400/[0.08] hover:bg-cyan-400/[0.15] transition-colors disabled:opacity-40"
                    >
                      <Mic className="w-3.5 h-3.5" />
                      Record clip {clips.length + 1}
                    </button>
                  )}
                </>
              )}

              {clips.length >= ENROLL_CLIPS && step !== "processing" && (
                <button
                  onClick={() => void submitEnrolment()}
                  className="flex items-center gap-2 text-xs font-medium text-emerald-300 px-3.5 py-2 rounded-lg border border-emerald-400/25 bg-emerald-400/[0.1] hover:bg-emerald-400/[0.18] transition-colors"
                >
                  <ShieldCheck className="w-3.5 h-3.5" />
                  Create voice profile ({clips.length} clips)
                </button>
              )}

              <button
                onClick={() => {
                  setEnrolling(false);
                  setClips([]);
                  setStep("idle");
                  setStepMsg("");
                }}
                className="text-[11px] text-neutral-600 hover:text-neutral-400"
              >
                Cancel enrolment (discards recorded clips)
              </button>
            </div>
          )}

          {stepMsg && (
            <p
              className={clsx(
                "text-xs leading-relaxed",
                step === "error" ? "text-rose-300" : step === "done" ? "text-emerald-300" : "text-neutral-400"
              )}
            >
              {stepMsg}
            </p>
          )}
        </div>

        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3 flex items-start gap-3">
          <Info className="w-4 h-4 text-neutral-500 flex-shrink-0 mt-0.5" />
          <p className="text-[11px] text-neutral-500 leading-relaxed">
            Once enrolled, IRA can ask you to speak a random challenge phrase before sensitive
            actions. Voice biometrics are Beta — treat them as a convenience layer on top of your
            password, not a replacement for it.
          </p>
        </div>
      </div>
    </div>
  );
}

function MicStateChip({ state }: { state: "off" | "listening" | "awake" | "processing" }) {
  const map: Record<string, { label: string; cls: string; pulse?: boolean }> = {
    off: { label: "Mic off", cls: "text-neutral-500 border-white/10 bg-white/[0.03]" },
    listening: {
      label: "Listening for wake word",
      cls: "text-cyan-300 border-cyan-400/25 bg-cyan-400/[0.07]",
      pulse: true,
    },
    awake: { label: "Awake", cls: "text-emerald-300 border-emerald-400/25 bg-emerald-400/[0.07]", pulse: true },
    processing: { label: "Processing", cls: "text-amber-300 border-amber-400/30 bg-amber-400/[0.07]", pulse: true },
  };
  const m = map[state] ?? map.off;
  return (
    <span className={clsx("inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-md border", m.cls)}>
      <span className={clsx("w-1.5 h-1.5 rounded-full bg-current", m.pulse && "animate-pulse")} />
      {m.label}
    </span>
  );
}

function StatusRow({ label, value, good }: { label: string; value: string; good: boolean | null }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl border border-white/[0.05] bg-white/[0.02]">
      <span className="text-xs text-neutral-400">{label}</span>
      <span
        className={clsx(
          "text-xs px-2 py-0.5 rounded-md border whitespace-nowrap max-w-[60%] truncate",
          good === true && "text-emerald-300 border-emerald-400/25 bg-emerald-400/[0.07]",
          good === false && "text-amber-300 border-amber-400/30 bg-amber-400/[0.07]",
          good === null && "text-neutral-500 border-white/10 bg-white/[0.03]"
        )}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}
