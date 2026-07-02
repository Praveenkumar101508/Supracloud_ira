/**
 * WebAuthn helpers for the Awakening Gate.
 *
 * Honest scope: without server-side challenge verification this proves
 * possession of the enrolled authenticator plus platform user verification
 * (Touch ID / Windows Hello / device PIN) on THIS device. It gates the local
 * UI; the backend API credential remains the core session token, which the
 * gate obtains separately. That is stated in the gate UI as well.
 */

import { fromB64, randomBytes, toB64 } from "./crypto";

export interface PasskeyRecord {
  credIdB64: string;
  createdAt: number;
}

export function webAuthnAvailable(): boolean {
  return typeof window !== "undefined" && !!window.PublicKeyCredential;
}

export async function platformAuthenticatorAvailable(): Promise<boolean> {
  if (!webAuthnAvailable()) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

export async function registerPasskey(displayName: string): Promise<PasskeyRecord | null> {
  try {
    const cred = (await navigator.credentials.create({
      publicKey: {
        challenge: randomBytes(32) as BufferSource,
        rp: { name: "IRA", id: window.location.hostname },
        user: {
          id: randomBytes(16) as BufferSource,
          name: displayName,
          displayName,
        },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 }, // ES256
          { type: "public-key", alg: -257 }, // RS256
        ],
        authenticatorSelection: {
          residentKey: "preferred",
          userVerification: "required",
        },
        timeout: 60_000,
        attestation: "none",
      },
    })) as PublicKeyCredential | null;
    if (!cred) return null;
    return { credIdB64: toB64(cred.rawId), createdAt: Date.now() };
  } catch {
    return null;
  }
}

export async function assertPasskey(rec: PasskeyRecord): Promise<boolean> {
  try {
    const cred = (await navigator.credentials.get({
      publicKey: {
        challenge: randomBytes(32) as BufferSource,
        allowCredentials: [{ type: "public-key", id: fromB64(rec.credIdB64) as BufferSource }],
        userVerification: "required",
        timeout: 60_000,
      },
    })) as PublicKeyCredential | null;
    return !!cred && toB64(cred.rawId) === rec.credIdB64;
  } catch {
    return false;
  }
}
