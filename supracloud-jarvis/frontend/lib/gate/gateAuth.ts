/**
 * Awakening Gate enrollment + unlock state.
 *
 * Credential model (honest, layered):
 *   - Real credentials: WebAuthn passkey (platform user verification) and a
 *     local PIN (salted PBKDF2 hash — never plaintext).
 *   - Convenience layers: the voice phrase resolves to passkey/PIN; it never
 *     unlocks by itself. Device authentication IS the passkey path (platform
 *     authenticator).
 *   - The backend API credential stays the core session token. It can be
 *     kept across restarts only as AES-GCM ciphertext under the PIN key, so
 *     a PIN unlock actually decrypts the session.
 */

import { create } from "zustand";
import {
  hashSecret,
  verifySecret,
  wrapSecret,
  unwrapSecret,
  type PinRecord,
  type WrappedSecret,
} from "./crypto";
import type { PasskeyRecord } from "./webauthn";

const KEYS = {
  pin: "ira:gate:pin:v1",
  passkey: "ira:gate:passkey:v1",
  voice: "ira:gate:voice:v1",
  core: "ira:gate:core:v1", // wrapped backend token (opt-in)
  owner: "ira:gate:owner:v1",
  unlocked: "ira:gate:unlocked:v1", // sessionStorage — relock on new browser session
} as const;

function readJSON<T>(storage: Storage, key: string): T | null {
  try {
    const raw = storage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

// ── Enrollment records ──────────────────────────────────────────────────────

export interface Enrollment {
  pin: PinRecord | null;
  passkey: PasskeyRecord | null;
  voice: PinRecord | null; // salted hash of the normalized phrase
  hasWrappedCore: boolean;
  ownerName: string;
}

export function getEnrollment(): Enrollment {
  return {
    pin: readJSON<PinRecord>(localStorage, KEYS.pin),
    passkey: readJSON<PasskeyRecord>(localStorage, KEYS.passkey),
    voice: readJSON<PinRecord>(localStorage, KEYS.voice),
    hasWrappedCore: !!localStorage.getItem(KEYS.core),
    ownerName: localStorage.getItem(KEYS.owner) || "Praveen Kamineti",
  };
}

export function isEnrolled(): boolean {
  const e = getEnrollment();
  return !!(e.pin || e.passkey);
}

export async function enrollPin(pin: string): Promise<void> {
  localStorage.setItem(KEYS.pin, JSON.stringify(await hashSecret(pin)));
}

export async function verifyPin(pin: string): Promise<boolean> {
  const rec = readJSON<PinRecord>(localStorage, KEYS.pin);
  return rec ? verifySecret(pin, rec) : false;
}

export function savePasskey(rec: PasskeyRecord): void {
  localStorage.setItem(KEYS.passkey, JSON.stringify(rec));
}

export function normalizePhrase(phrase: string): string {
  return phrase.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

export async function enrollVoicePhrase(phrase: string): Promise<void> {
  localStorage.setItem(KEYS.voice, JSON.stringify(await hashSecret(normalizePhrase(phrase))));
}

export async function verifyVoicePhrase(phrase: string): Promise<boolean> {
  const rec = readJSON<PinRecord>(localStorage, KEYS.voice);
  return rec ? verifySecret(normalizePhrase(phrase), rec) : false;
}

// ── Wrapped core session (opt-in "stay linked on this device") ──────────────

export async function storeWrappedCore(pin: string, token: string): Promise<void> {
  localStorage.setItem(KEYS.core, JSON.stringify(await wrapSecret(pin, token)));
}

export async function unwrapCore(pin: string): Promise<string | null> {
  const rec = readJSON<WrappedSecret>(localStorage, KEYS.core);
  return rec ? unwrapSecret(pin, rec) : null;
}

export function clearWrappedCore(): void {
  localStorage.removeItem(KEYS.core);
}

/** Full reset: removes every gate credential. Requires core re-link. */
export function resetGate(): void {
  Object.values(KEYS).forEach((k) => {
    localStorage.removeItem(k);
    sessionStorage.removeItem(k);
  });
}

// ── Lock state ──────────────────────────────────────────────────────────────

interface GateStore {
  unlocked: boolean;
  unlock: () => void;
  lock: () => void;
}

export const useGateStore = create<GateStore>()((set) => ({
  // Relock on every new browser session; a reload inside the same tab
  // session stays unlocked (the lock is a gate, not a nag).
  unlocked:
    typeof window !== "undefined" && sessionStorage.getItem(KEYS.unlocked) === "1",
  unlock: () => {
    sessionStorage.setItem(KEYS.unlocked, "1");
    set({ unlocked: true });
  },
  lock: () => {
    sessionStorage.removeItem(KEYS.unlocked);
    set({ unlocked: false });
  },
}));
