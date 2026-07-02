"use client";

/**
 * Awakening Gate — replaces the login page.
 *
 * Sequence: black void → breathing dot → typed diagnostic readouts (driven by
 * real subsystem probes, never hardcoded positives) → welcome line → unlock.
 *
 * Credential model:
 *   - Passkey (WebAuthn, platform user verification) and local PIN (salted
 *     PBKDF2 hash) are the real credentials.
 *   - The voice phrase is a convenience layer: a match only routes to the
 *     passkey/PIN step, it never unlocks by itself.
 *   - The backend session (core link) is obtained once and can be kept across
 *     restarts only as AES-GCM ciphertext under the PIN key.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence, useMotionValue, useSpring, useTransform } from "framer-motion";
import { Fingerprint, KeyRound, Mic, ShieldCheck, RotateCcw, Loader2 } from "lucide-react";
import { probeSystems, READOUT_TEXT, type Readout } from "@/lib/systemStatus";
import {
  getEnrollment,
  isEnrolled,
  enrollPin,
  verifyPin,
  savePasskey,
  enrollVoicePhrase,
  verifyVoicePhrase,
  storeWrappedCore,
  unwrapCore,
  resetGate,
  useGateStore,
  type Enrollment,
} from "@/lib/gate/gateAuth";
import {
  webAuthnAvailable,
  platformAuthenticatorAvailable,
  registerPasskey,
  assertPasskey,
} from "@/lib/gate/webauthn";
import { useAuthStore } from "@/lib/store";

type Phase = "void" | "boot" | "welcome" | "auth";

const STATE_COLOR: Record<Readout["state"], string> = {
  online: "text-cyan-300",
  ready: "text-cyan-300",
  active: "text-cyan-300",
  standby: "text-neutral-400",
  offline: "text-rose-300",
};

// ── Typed diagnostic line ────────────────────────────────────────────────────

function TypedLine({
  readout,
  onDone,
  instant,
}: {
  readout: Readout;
  onDone: () => void;
  instant: boolean;
}) {
  const full = readout.label;
  const [chars, setChars] = useState(instant ? full.length : 0);
  const [showState, setShowState] = useState(instant);
  const doneRef = useRef(false);

  useEffect(() => {
    if (instant) {
      if (!doneRef.current) {
        doneRef.current = true;
        onDone();
      }
      return;
    }
    const id = setInterval(() => {
      setChars((c) => {
        if (c >= full.length) {
          clearInterval(id);
          setShowState(true);
          setTimeout(() => {
            if (!doneRef.current) {
              doneRef.current = true;
              onDone();
            }
          }, 240);
          return c;
        }
        return c + 1;
      });
    }, 22);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="nx-mono text-[12px] sm:text-[13px] flex items-baseline gap-2 whitespace-nowrap">
      <span className="text-neutral-500 flex-shrink-0">{full.slice(0, chars)}</span>
      {showState && (
        <>
          <span className="text-neutral-700 select-none">·</span>
          <span className={`flex-shrink-0 ${STATE_COLOR[readout.state]}`}>
            {READOUT_TEXT[readout.state]}
          </span>
          {readout.detail && (
            <span className="text-neutral-600 text-[10px] hidden sm:inline truncate">
              {readout.detail}
            </span>
          )}
        </>
      )}
    </div>
  );
}

// ── Gate ─────────────────────────────────────────────────────────────────────

export default function AwakeningGate({ onUnlocked }: { onUnlocked?: (token: string) => void }) {
  const { token, setToken } = useAuthStore();
  const unlockGate = useGateStore((s) => s.unlock);

  const [phase, setPhase] = useState<Phase>("void");
  const [readouts, setReadouts] = useState<Readout[]>([]);
  const [lineIdx, setLineIdx] = useState(0);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [platformAuth, setPlatformAuth] = useState(false);
  const reducedMotion = useMemo(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    []
  );

  // Unlock state
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState<"" | "passkey" | "pin" | "voice" | "core">("");
  const [notice, setNotice] = useState("");
  const [voiceOk, setVoiceOk] = useState(false); // phrase matched → real credential step
  const [needsRelink, setNeedsRelink] = useState(false);

  // Setup state (first run)
  const [setupStep, setSetupStep] = useState<"core" | "credentials">("core");
  const [username, setUsername] = useState("admin");
  const [coreKey, setCoreKey] = useState("");
  const [setupPin, setSetupPin] = useState("");
  const [setupPin2, setSetupPin2] = useState("");
  const [voicePhrase, setVoicePhrase] = useState("");
  const [stayLinked, setStayLinked] = useState(true);
  const [passkeyDone, setPasskeyDone] = useState(false);

  // Subtle parallax — layers drift a few px against the pointer.
  const mx = useMotionValue(0);
  const my = useMotionValue(0);
  const sx = useSpring(mx, { stiffness: 50, damping: 20 });
  const sy = useSpring(my, { stiffness: 50, damping: 20 });
  const glowX = useTransform(sx, (v) => v * 14);
  const glowY = useTransform(sy, (v) => v * 14);
  const cardX = useTransform(sx, (v) => v * -6);
  const cardY = useTransform(sy, (v) => v * -6);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const { innerWidth: w, innerHeight: h } = window;
      mx.set((e.clientX / w - 0.5) * 2);
      my.set((e.clientY / h - 0.5) * 2);
    },
    [mx, my]
  );

  // Boot: probe subsystems, then type readouts.
  useEffect(() => {
    setEnrollment(getEnrollment());
    void platformAuthenticatorAvailable().then(setPlatformAuth);
    const t = setTimeout(() => setPhase("boot"), reducedMotion ? 100 : 700);
    void probeSystems().then(setReadouts);
    return () => clearTimeout(t);
  }, [reducedMotion]);

  const lineDone = useCallback(() => setLineIdx((i) => i + 1), []);

  useEffect(() => {
    if (phase !== "boot" || readouts.length === 0 || lineIdx < readouts.length) return;
    const t1 = setTimeout(() => setPhase("welcome"), 500);
    return () => clearTimeout(t1);
  }, [phase, lineIdx, readouts.length]);

  useEffect(() => {
    if (phase !== "welcome") return;
    const t = setTimeout(() => setPhase("auth"), reducedMotion ? 300 : 1800);
    return () => clearTimeout(t);
  }, [phase, reducedMotion]);

  // ── Core link (backend session — the actual API credential) ───────────────
  const linkCore = useCallback(
    async (user: string, key: string): Promise<string | null> => {
      const form = new FormData();
      form.append("username", user);
      form.append("password", key);
      try {
        const res = await fetch("/auth/token", { method: "POST", body: form });
        if (!res.ok) {
          setNotice("Core rejected the credentials. Try again.");
          return null;
        }
        const data = await res.json();
        return (data.access_token as string) ?? null;
      } catch {
        setNotice("Core unreachable — is IRA running?");
        return null;
      }
    },
    []
  );

  const finish = useCallback(
    (authToken: string) => {
      setToken(authToken);
      unlockGate();
      onUnlocked?.(authToken);
    },
    [setToken, unlockGate, onUnlocked]
  );

  // ── Unlock paths ───────────────────────────────────────────────────────────
  const unlockWithPasskey = useCallback(async () => {
    if (!enrollment?.passkey) return;
    setBusy("passkey");
    setNotice("");
    const ok = await assertPasskey(enrollment.passkey);
    setBusy("");
    if (!ok) {
      setNotice("Passkey verification failed.");
      return;
    }
    if (token) return finish(token);
    if (enrollment.hasWrappedCore) {
      setNotice("Core session is sealed under your PIN — enter it to decrypt.");
      return;
    }
    setNeedsRelink(true);
  }, [enrollment, token, finish]);

  const unlockWithPin = useCallback(async () => {
    if (pin.length < 4) return;
    setBusy("pin");
    setNotice("");
    const ok = await verifyPin(pin);
    if (!ok) {
      setBusy("");
      setNotice("Incorrect PIN.");
      return;
    }
    if (token) {
      setBusy("");
      return finish(token);
    }
    if (enrollment?.hasWrappedCore) {
      const core = await unwrapCore(pin);
      setBusy("");
      if (core) return finish(core);
      setNotice("Stored session could not be decrypted — relink the core.");
      setNeedsRelink(true);
      return;
    }
    setBusy("");
    setNeedsRelink(true);
  }, [pin, token, enrollment, finish]);

  const listenForPhrase = useCallback(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      setNotice("Voice unlock needs the browser speech engine — use passkey or PIN.");
      return;
    }
    setBusy("voice");
    setNotice("");
    const r = new SR();
    r.continuous = false;
    r.interimResults = false;
    r.lang = "en-US";
    r.onresult = async (e: any) => {
      const said = e.results[0][0].transcript as string;
      const match = await verifyVoicePhrase(said);
      setBusy("");
      if (match) {
        setVoiceOk(true);
        setNotice("Phrase recognized — confirm with passkey or PIN to unlock.");
        if (enrollment?.passkey) void unlockWithPasskey();
      } else {
        setNotice("Phrase not recognized.");
      }
    };
    r.onerror = () => {
      setBusy("");
      setNotice("Didn't catch that — try again.");
    };
    r.onend = () => setBusy((b) => (b === "voice" ? "" : b));
    try {
      r.start();
    } catch {
      setBusy("");
    }
  }, [enrollment, unlockWithPasskey]);

  const relink = useCallback(async () => {
    setBusy("core");
    const t = await linkCore(username, coreKey);
    setBusy("");
    if (!t) return;
    // Re-seal under the PIN when the user just proved it and opted in before.
    if (enrollment?.pin && pin && (await verifyPin(pin))) {
      await storeWrappedCore(pin, t);
    }
    finish(t);
  }, [linkCore, username, coreKey, enrollment, pin, finish]);

  // ── First-run setup ────────────────────────────────────────────────────────
  const setupLinkCore = useCallback(async () => {
    setBusy("core");
    const t = await linkCore(username, coreKey);
    setBusy("");
    if (!t) return;
    setToken(t);
    setNotice("");
    setSetupStep("credentials");
  }, [linkCore, username, coreKey, setToken]);

  const setupEnrollPasskey = useCallback(async () => {
    setBusy("passkey");
    const rec = await registerPasskey(enrollment?.ownerName ?? "Praveen Kamineti");
    setBusy("");
    if (rec) {
      savePasskey(rec);
      setPasskeyDone(true);
      setNotice("");
    } else {
      setNotice("Passkey registration was cancelled or failed.");
    }
  }, [enrollment]);

  const completeSetup = useCallback(async () => {
    const wantsPin = setupPin.length > 0;
    if (!wantsPin && !passkeyDone) {
      setNotice("Enroll at least one real credential — a PIN or a passkey.");
      return;
    }
    if (wantsPin) {
      if (setupPin.length < 6) {
        setNotice("PIN must be at least 6 digits.");
        return;
      }
      if (setupPin !== setupPin2) {
        setNotice("PINs don't match.");
        return;
      }
      await enrollPin(setupPin);
      if (stayLinked && token) await storeWrappedCore(setupPin, token);
    }
    if (voicePhrase.trim().split(/\s+/).length >= 3) {
      await enrollVoicePhrase(voicePhrase);
    }
    if (!token) {
      setNotice("Core link missing — go back and link the core first.");
      return;
    }
    finish(token);
  }, [setupPin, setupPin2, passkeyDone, voicePhrase, stayLinked, token, finish]);

  const doReset = useCallback(() => {
    if (!window.confirm("Reset the gate? All local credentials are removed and the core must be relinked.")) return;
    resetGate();
    setEnrollment(getEnrollment());
    setNeedsRelink(false);
    setVoiceOk(false);
    setPin("");
    setNotice("Gate reset — set up new credentials.");
    setSetupStep("core");
  }, []);

  const enrolled = enrollment ? isEnrolledFrom(enrollment) : false;
  const showSetup = phase === "auth" && !enrolled;
  const showUnlock = phase === "auth" && enrolled;

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-black text-white"
      onPointerMove={onPointerMove}
    >
      {/* Depth layer 1 — faint drifting glow, parallax-linked */}
      <motion.div
        aria-hidden
        className="pointer-events-none fixed inset-0"
        style={{ x: glowX, y: glowY }}
      >
        <div
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[60vmax] h-[60vmax] rounded-full opacity-[0.06]"
          style={{ background: "radial-gradient(circle, #22d3ee 0%, transparent 60%)" }}
        />
      </motion.div>

      <div className="min-h-full flex flex-col items-center justify-center px-6 py-12">
        {/* The dot */}
        <AnimatePresence>
          {phase !== "auth" && (
            <motion.div
              key="dot"
              exit={{ opacity: 0, scale: 0.6 }}
              transition={{ duration: 0.6 }}
              className="mb-10"
            >
              <div className="w-2.5 h-2.5 rounded-full bg-cyan-300 animate-gate-dot">
                <div className="w-full h-full rounded-full bg-cyan-300 animate-breathe shadow-glow-cyan" />
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Diagnostics */}
        {(phase === "boot" || phase === "welcome") && (
          <div className="space-y-2 min-h-[130px] w-full max-w-sm">
            {readouts.length === 0 && (
              <div className="nx-mono text-[12px] text-neutral-600 animate-pulse">
                PROBING SUBSYSTEMS…
              </div>
            )}
            {readouts.slice(0, lineIdx + 1).map((r) => (
              <TypedLine key={r.key} readout={r} onDone={lineDone} instant={reducedMotion} />
            ))}
          </div>
        )}

        {/* Welcome */}
        <AnimatePresence>
          {(phase === "welcome" || phase === "auth") && (
            <motion.h1
              key="welcome"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 1.1, ease: "easeOut" }}
              className="nx-display text-2xl sm:text-3xl text-neutral-100 text-center mt-4 mb-2"
            >
              Welcome, {enrollment?.ownerName ?? "Praveen Kamineti"}.{" "}
              <span className="text-cyan-200">IRA is awake.</span>
            </motion.h1>
          )}
        </AnimatePresence>

        {/* Skip control during boot */}
        {phase === "boot" && (
          <button
            onClick={() => setPhase("auth")}
            className="mt-8 text-[11px] text-neutral-600 hover:text-neutral-400 transition-colors"
          >
            skip
          </button>
        )}

        {/* ── Unlock panel ── */}
        <AnimatePresence>
          {showUnlock && (
            <motion.div
              key="unlock"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, ease: "easeOut", delay: 0.15 }}
              style={{ x: cardX, y: cardY }}
              className="w-full max-w-sm mt-8"
            >
              <div className="nx-card p-6 space-y-4">
                {notice && (
                  <p role="status" className="text-[12px] text-amber-300/90">{notice}</p>
                )}

                {!needsRelink ? (
                  <>
                    {enrollment?.passkey && webAuthnAvailable() && (
                      <button
                        onClick={unlockWithPasskey}
                        disabled={busy !== ""}
                        className="w-full flex items-center justify-center gap-2.5 rounded-xl border border-cyan-400/30 bg-cyan-400/10 hover:bg-cyan-400/15 text-cyan-100 py-3 text-sm font-medium transition-colors disabled:opacity-50"
                      >
                        {busy === "passkey" ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Fingerprint className="w-4 h-4" />
                        )}
                        Unlock with passkey · device authentication
                      </button>
                    )}

                    {enrollment?.pin && (
                      <div className="flex gap-2">
                        <input
                          type="password"
                          inputMode="numeric"
                          autoComplete="off"
                          placeholder="Local PIN"
                          value={pin}
                          onChange={(e) => setPin(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && unlockWithPin()}
                          className={`flex-1 bg-white/[0.04] rounded-xl px-4 py-2.5 text-sm border transition-colors focus:outline-none ${
                            voiceOk ? "border-cyan-400/50" : "border-white/10 focus:border-cyan-400/40"
                          }`}
                        />
                        <button
                          onClick={unlockWithPin}
                          disabled={busy !== "" || pin.length < 4}
                          className="px-4 rounded-xl border border-white/10 bg-white/[0.05] hover:bg-white/[0.09] text-sm text-neutral-200 transition-colors disabled:opacity-40"
                        >
                          {busy === "pin" ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
                        </button>
                      </div>
                    )}

                    {enrollment?.voice && (
                      <button
                        onClick={listenForPhrase}
                        disabled={busy !== ""}
                        className="w-full flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] hover:bg-white/[0.06] text-neutral-300 py-2.5 text-[13px] transition-colors disabled:opacity-50"
                      >
                        {busy === "voice" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mic className="w-4 h-4" />}
                        {busy === "voice" ? "Listening…" : "Speak your unlock phrase"}
                      </button>
                    )}

                    <p className="text-[10.5px] leading-relaxed text-neutral-600">
                      Passkey and PIN are the real credentials. The voice phrase only routes to
                      them — a voice match alone never opens the gate.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-[12px] text-neutral-400">
                      Identity confirmed — the core session has expired. Relink to continue.
                    </p>
                    <input
                      type="text"
                      autoComplete="username"
                      placeholder="Core user"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      className="w-full bg-white/[0.04] rounded-xl px-4 py-2.5 text-sm border border-white/10 focus:border-cyan-400/40 focus:outline-none"
                    />
                    <input
                      type="password"
                      autoComplete="current-password"
                      placeholder="Core access key"
                      value={coreKey}
                      onChange={(e) => setCoreKey(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && relink()}
                      className="w-full bg-white/[0.04] rounded-xl px-4 py-2.5 text-sm border border-white/10 focus:border-cyan-400/40 focus:outline-none"
                    />
                    <button
                      onClick={relink}
                      disabled={busy !== "" || !coreKey}
                      className="w-full rounded-xl bg-cyan-400/15 border border-cyan-400/30 hover:bg-cyan-400/20 text-cyan-100 py-2.5 text-sm font-medium transition-colors disabled:opacity-50"
                    >
                      {busy === "core" ? "Linking…" : "Relink core"}
                    </button>
                  </>
                )}
              </div>

              <button
                onClick={doReset}
                className="mt-4 mx-auto flex items-center gap-1.5 text-[10.5px] text-neutral-700 hover:text-neutral-500 transition-colors"
              >
                <RotateCcw className="w-3 h-3" /> Reset gate credentials
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── First-run setup ── */}
        <AnimatePresence>
          {showSetup && (
            <motion.div
              key="setup"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, ease: "easeOut", delay: 0.15 }}
              style={{ x: cardX, y: cardY }}
              className="w-full max-w-sm mt-8"
            >
              <div className="nx-card p-6 space-y-4">
                {notice && <p role="status" className="text-[12px] text-amber-300/90">{notice}</p>}

                {setupStep === "core" ? (
                  <>
                    <div className="flex items-center gap-2 text-neutral-300 text-sm font-medium">
                      <ShieldCheck className="w-4 h-4 text-cyan-300" /> Link the IRA core
                    </div>
                    <p className="text-[11.5px] text-neutral-500 leading-relaxed">
                      One-time step: the core issues the session this device will hold. Afterwards
                      you unlock with a passkey, PIN or voice phrase — this form never returns.
                    </p>
                    <input
                      type="text"
                      autoComplete="username"
                      placeholder="Core user"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      className="w-full bg-white/[0.04] rounded-xl px-4 py-2.5 text-sm border border-white/10 focus:border-cyan-400/40 focus:outline-none"
                    />
                    <input
                      type="password"
                      autoComplete="current-password"
                      placeholder="Core access key"
                      value={coreKey}
                      onChange={(e) => setCoreKey(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && setupLinkCore()}
                      autoFocus
                      className="w-full bg-white/[0.04] rounded-xl px-4 py-2.5 text-sm border border-white/10 focus:border-cyan-400/40 focus:outline-none"
                    />
                    <button
                      onClick={setupLinkCore}
                      disabled={busy !== "" || !coreKey}
                      className="w-full rounded-xl bg-cyan-400/15 border border-cyan-400/30 hover:bg-cyan-400/20 text-cyan-100 py-2.5 text-sm font-medium transition-colors disabled:opacity-50"
                    >
                      {busy === "core" ? "Linking…" : "Link core"}
                    </button>
                  </>
                ) : (
                  <>
                    <div className="flex items-center gap-2 text-neutral-300 text-sm font-medium">
                      <ShieldCheck className="w-4 h-4 text-cyan-300" /> Set your unlock credentials
                    </div>

                    {webAuthnAvailable() && platformAuth && (
                      <button
                        onClick={setupEnrollPasskey}
                        disabled={busy !== "" || passkeyDone}
                        className="w-full flex items-center justify-center gap-2 rounded-xl border border-cyan-400/30 bg-cyan-400/10 hover:bg-cyan-400/15 text-cyan-100 py-2.5 text-sm transition-colors disabled:opacity-60"
                      >
                        {busy === "passkey" ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Fingerprint className="w-4 h-4" />
                        )}
                        {passkeyDone ? "Passkey enrolled ✓" : "Create passkey (device authentication)"}
                      </button>
                    )}

                    <div className="grid grid-cols-2 gap-2">
                      <input
                        type="password"
                        inputMode="numeric"
                        placeholder="PIN (6+ digits)"
                        value={setupPin}
                        onChange={(e) => setSetupPin(e.target.value)}
                        className="bg-white/[0.04] rounded-xl px-4 py-2.5 text-sm border border-white/10 focus:border-cyan-400/40 focus:outline-none"
                      />
                      <input
                        type="password"
                        inputMode="numeric"
                        placeholder="Repeat PIN"
                        value={setupPin2}
                        onChange={(e) => setSetupPin2(e.target.value)}
                        className="bg-white/[0.04] rounded-xl px-4 py-2.5 text-sm border border-white/10 focus:border-cyan-400/40 focus:outline-none"
                      />
                    </div>

                    <input
                      type="text"
                      placeholder="Voice phrase — optional, 3+ words"
                      value={voicePhrase}
                      onChange={(e) => setVoicePhrase(e.target.value)}
                      className="w-full bg-white/[0.04] rounded-xl px-4 py-2.5 text-sm border border-white/10 focus:border-cyan-400/40 focus:outline-none"
                    />

                    <label className="flex items-start gap-2 text-[11px] text-neutral-500 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={stayLinked}
                        onChange={(e) => setStayLinked(e.target.checked)}
                        className="mt-0.5 accent-cyan-400"
                      />
                      Keep the core session on this device, sealed with AES-GCM under the PIN
                      (requires a PIN).
                    </label>

                    <button
                      onClick={completeSetup}
                      disabled={busy !== ""}
                      className="w-full rounded-xl bg-cyan-400/15 border border-cyan-400/30 hover:bg-cyan-400/20 text-cyan-100 py-2.5 text-sm font-medium transition-colors disabled:opacity-50"
                    >
                      Enter the console
                    </button>

                    <p className="text-[10.5px] leading-relaxed text-neutral-600">
                      The PIN is stored only as a salted hash. The voice phrase is a convenience
                      layer that resolves to your passkey or PIN.
                    </p>
                  </>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function isEnrolledFrom(e: Enrollment): boolean {
  return !!(e.pin || e.passkey);
}
